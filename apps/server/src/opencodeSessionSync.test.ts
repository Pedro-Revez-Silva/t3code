import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_SERVER_SETTINGS, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  openCodeSessionSyncTestExports,
  launchOpenCodeSessionSync,
} from "./opencodeSessionSync.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "./persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "./persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "./persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
} from "./persistence/Services/ProjectionThreadSessions.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "./persistence/Services/ProjectionThreads.ts";
import {
  ProviderThreadMirrorRepository,
  type ProviderThreadMirrorRepositoryShape,
} from "./persistence/Services/ProviderThreadMirrors.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "./provider/Services/ProviderSessionDirectory.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "./provider/opencodeRuntime.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";

function createOpenCodeFixtureDatabase(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);

  try {
    database.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        name TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        workspace_id TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    database
      .prepare(
        `
        INSERT INTO project (id, worktree, name, time_created, time_updated)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run("global", "/", "Imported Project", 1776781195000, 1776781198790);

    database
      .prepare(
        `
        INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, permission,
          time_created, time_updated, time_archived
        )
        VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL)
      `,
      )
      .run(
        "ses_fixture",
        "global",
        "fixture-thread",
        "/Users/pedrosilva/Repos/demo-project",
        "Imported OpenCode Thread",
        "1.14.19",
        1776781195104,
        1776781198790,
      );

    database
      .prepare(
        `
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        "msg_user",
        "ses_fixture",
        1776781195123,
        1776781195123,
        JSON.stringify({
          role: "user",
          time: { created: 1776781195123 },
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-5",
          },
        }),
      );
    database
      .prepare(
        `
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        "msg_assistant",
        "ses_fixture",
        1776781195138,
        1776781198788,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          time: {
            created: 1776781195138,
            completed: 1776781198788,
          },
        }),
      );

    database
      .prepare(
        `
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "prt_user",
        "msg_user",
        "ses_fixture",
        1776781195129,
        1776781195129,
        JSON.stringify({ type: "text", text: "This is a test" }),
      );
    database
      .prepare(
        `
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "prt_reasoning",
        "msg_assistant",
        "ses_fixture",
        1776781197517,
        1776781198254,
        JSON.stringify({
          type: "reasoning",
          text: "The user says this is a test and expects a simple response.",
          time: { start: 1776781197517, end: 1776781198254 },
        }),
      );
    database
      .prepare(
        `
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "prt_assistant",
        "msg_assistant",
        "ses_fixture",
        1776781198256,
        1776781198783,
        JSON.stringify({
          type: "text",
          text: "Hello! This is a test response. How can I help you today?",
        }),
      );
  } finally {
    database.close();
  }
}

describe("openCodeSessionSync", () => {
  it("ignores self-exported OpenCode mirrors until they advance past the export time", () => {
    expect(
      openCodeSessionSyncTestExports.shouldImportOpenCodeSession("2026-04-23T09:00:00.000Z", {
        lastExportedAt: "2026-04-23T09:00:01.000Z",
        runtimePayload: {
          exportedFromT3: true,
        },
      } as never),
    ).toBe(false);

    expect(
      openCodeSessionSyncTestExports.shouldImportOpenCodeSession("2026-04-23T09:00:02.000Z", {
        lastExportedAt: "2026-04-23T09:00:01.000Z",
        runtimePayload: {
          exportedFromT3: true,
        },
      } as never),
    ).toBe(true);
  });

  it("loads OpenCode sessions from the local database", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-sync-load-"));
    const databasePath = join(root, "opencode.db");
    createOpenCodeFixtureDatabase(databasePath);

    const sessions = openCodeSessionSyncTestExports.loadOpenCodeSessions(databasePath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      threadId: "ses_fixture",
      workspaceRoot: "/Users/pedrosilva/Repos/demo-project",
      title: "Imported OpenCode Thread",
      model: "openai/gpt-5",
      runtimeMode: "full-access",
      status: "idle",
    });
    expect(sessions[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "This is a test" }),
      expect.objectContaining({
        role: "assistant",
        text: "Hello! This is a test response. How can I help you today?",
      }),
    ]);
    expect(sessions[0]?.activities).toEqual([
      expect.objectContaining({
        kind: "opencode.reasoning",
        summary: "The user says this is a test and expects a simple response.",
      }),
    ]);
  });

  it("imports OpenCode sessions during startup and refreshes the read model", async () => {
    const xdgDataHome = mkdtempSync(join(tmpdir(), "opencode-sync-home-"));
    const openCodeHome = join(xdgDataHome, "opencode");
    const databasePath = join(openCodeHome, "opencode.db");
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDataHome;

    createOpenCodeFixtureDatabase(databasePath);

    const projects: Array<Parameters<ProjectionProjectRepositoryShape["upsert"]>[0]> = [];
    const threads: Array<Parameters<ProjectionThreadRepositoryShape["upsert"]>[0]> = [];
    const messages: Array<Parameters<ProjectionThreadMessageRepositoryShape["upsert"]>[0]> = [];
    const activities: Array<Parameters<ProjectionThreadActivityRepositoryShape["upsert"]>[0]> = [];
    const sessions: Array<Parameters<ProjectionThreadSessionRepositoryShape["upsert"]>[0]> = [];
    const providerBindings: Array<Parameters<ProviderSessionDirectoryShape["upsert"]>[0]> = [];
    const providerMirrors: Array<Parameters<ProviderThreadMirrorRepositoryShape["upsert"]>[0]> = [];
    let refreshCount = 0;

    const projectRepo: ProjectionProjectRepositoryShape = {
      upsert: (row: Parameters<ProjectionProjectRepositoryShape["upsert"]>[0]) =>
        Effect.sync(() => void projects.push(row)),
      getById: () => Effect.succeed(Option.none()),
      listAll: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    };
    const threadRepo: ProjectionThreadRepositoryShape = {
      upsert: (row: Parameters<ProjectionThreadRepositoryShape["upsert"]>[0]) =>
        Effect.sync(() => void threads.push(row)),
      getById: () => Effect.succeed(Option.none()),
      listByProjectId: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    };
    const messageRepo: ProjectionThreadMessageRepositoryShape = {
      upsert: (row: Parameters<ProjectionThreadMessageRepositoryShape["upsert"]>[0]) =>
        Effect.sync(() => void messages.push(row)),
      getByMessageId: () => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const activityRepo: ProjectionThreadActivityRepositoryShape = {
      upsert: (row: Parameters<ProjectionThreadActivityRepositoryShape["upsert"]>[0]) =>
        Effect.sync(() => void activities.push(row)),
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const sessionRepo: ProjectionThreadSessionRepositoryShape = {
      upsert: (row: Parameters<ProjectionThreadSessionRepositoryShape["upsert"]>[0]) =>
        Effect.sync(() => void sessions.push(row)),
      getByThreadId: () => Effect.succeed(Option.none()),
      deleteByThreadId: () => Effect.void,
    };
    const providerSessionDirectory: ProviderSessionDirectoryShape = {
      upsert: (binding: Parameters<ProviderSessionDirectoryShape["upsert"]>[0]) =>
        Effect.sync(() => void providerBindings.push(binding)),
      getProvider: () => Effect.die("not implemented"),
      getBinding: () => Effect.succeed(Option.none()),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
    };
    const providerThreadMirrorRepository: ProviderThreadMirrorRepositoryShape = {
      upsert: (mirror: Parameters<ProviderThreadMirrorRepositoryShape["upsert"]>[0]) =>
        Effect.sync(() => void providerMirrors.push(mirror)),
      getByThreadAndProvider: () => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
      deleteByThreadAndProvider: () => Effect.void,
    };
    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      getSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
      getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.die("not implemented"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("not implemented"),
      getThreadCheckpointContext: () => Effect.die("not implemented"),
      getThreadShellById: () => Effect.die("not implemented"),
      getThreadDetailById: () => Effect.succeed(Option.none()),
    };
    const sqlClient = {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } as const;
    const openCodeRuntime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () => Effect.die("not implemented"),
      connectToOpenCodeServer: () => Effect.die("not implemented"),
      runOpenCodeCommand: () => Effect.die("not implemented"),
      createOpenCodeSdkClient: () => {
        throw new Error("not implemented");
      },
      loadOpenCodeInventory: () => Effect.die("not implemented"),
    };
    const orchestrationEngine: OrchestrationEngineShape = {
      getReadModel: () => Effect.die("not implemented"),
      refreshReadModel: () =>
        Effect.sync(() => {
          refreshCount += 1;
          return {} as never;
        }),
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("not implemented"),
      streamDomainEvents: Stream.empty,
    };
    const serverSettings: ServerSettingsShape = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: () => Effect.die("not implemented"),
      streamChanges: Stream.empty,
    };

    try {
      await Effect.runPromise(
        Effect.scoped(
          launchOpenCodeSessionSync.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(ProjectionProjectRepository, projectRepo),
                Layer.succeed(ProjectionThreadRepository, threadRepo),
                Layer.succeed(ProjectionThreadMessageRepository, messageRepo),
                Layer.succeed(ProjectionThreadActivityRepository, activityRepo),
                Layer.succeed(ProjectionThreadSessionRepository, sessionRepo),
                Layer.succeed(ProviderSessionDirectory, providerSessionDirectory),
                Layer.succeed(ProviderThreadMirrorRepository, providerThreadMirrorRepository),
                Layer.succeed(OrchestrationEngineService, orchestrationEngine),
                Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery),
                Layer.succeed(SqlClient.SqlClient, sqlClient as SqlClient.SqlClient),
                Layer.succeed(OpenCodeRuntime, openCodeRuntime),
                Layer.succeed(ServerSettingsService, serverSettings),
              ),
            ),
          ),
        ),
      );
    } finally {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }

    expect(projects).toHaveLength(1);
    expect(threads).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(activities).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(providerBindings).toHaveLength(1);
    expect(providerMirrors).toHaveLength(1);
    expect(refreshCount).toBe(1);
    expect(providerBindings[0]).toMatchObject({
      threadId: "ses_fixture",
      provider: "opencode",
      resumeCursor: {
        sessionID: "ses_fixture",
        directory: "/Users/pedrosilva/Repos/demo-project",
      },
    });
    expect(providerMirrors[0]).toMatchObject({
      threadId: "ses_fixture",
      externalThreadId: "ses_fixture",
      resumeCursor: {
        sessionID: "ses_fixture",
        directory: "/Users/pedrosilva/Repos/demo-project",
      },
    });
  });

  it("re-imports exported OpenCode sessions into the existing T3 thread", async () => {
    const xdgDataHome = mkdtempSync(join(tmpdir(), "opencode-sync-reimport-"));
    const openCodeHome = join(xdgDataHome, "opencode");
    const databasePath = join(openCodeHome, "opencode.db");
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDataHome;

    createOpenCodeFixtureDatabase(databasePath);

    const threads: Array<Parameters<ProjectionThreadRepositoryShape["upsert"]>[0]> = [];
    const providerBindings: Array<Parameters<ProviderSessionDirectoryShape["upsert"]>[0]> = [];
    const providerMirrors: Array<Parameters<ProviderThreadMirrorRepositoryShape["upsert"]>[0]> = [
      {
        threadId: ThreadId.make("thread-existing"),
        providerName: "opencode",
        externalThreadId: "ses_fixture",
        lastSeenAt: "2026-04-20T00:00:00.000Z",
        lastImportedAt: null,
        lastExportedAt: "2026-04-20T00:00:00.000Z",
        resumeCursor: {
          sessionID: "ses_fixture",
          directory: "/Users/pedrosilva/Repos/demo-project",
        },
        runtimePayload: {
          cwd: "/Users/pedrosilva/Repos/demo-project",
          importedFromOpenCode: false,
          exportedFromT3: true,
        },
        metadata: {
          source: "t3-export",
          title: "Existing thread",
        },
      },
    ];

    const projectRepo: ProjectionProjectRepositoryShape = {
      upsert: () => Effect.void,
      getById: () => Effect.succeed(Option.none()),
      listAll: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    };
    const threadRepo: ProjectionThreadRepositoryShape = {
      upsert: (row) => Effect.sync(() => void threads.push(row)),
      getById: () => Effect.succeed(Option.none()),
      listByProjectId: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    };
    const messageRepo: ProjectionThreadMessageRepositoryShape = {
      upsert: () => Effect.void,
      getByMessageId: () => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const activityRepo: ProjectionThreadActivityRepositoryShape = {
      upsert: () => Effect.void,
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const sessionRepo: ProjectionThreadSessionRepositoryShape = {
      upsert: () => Effect.void,
      getByThreadId: () => Effect.succeed(Option.none()),
      deleteByThreadId: () => Effect.void,
    };
    const providerSessionDirectory: ProviderSessionDirectoryShape = {
      upsert: (binding) => Effect.sync(() => void providerBindings.push(binding)),
      getProvider: () => Effect.die("not implemented"),
      getBinding: () => Effect.succeed(Option.none()),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
    };
    const providerThreadMirrorRepository: ProviderThreadMirrorRepositoryShape = {
      upsert: (mirror) =>
        Effect.sync(() => {
          const existingIndex = providerMirrors.findIndex(
            (entry) =>
              entry.threadId === mirror.threadId && entry.providerName === mirror.providerName,
          );
          if (existingIndex >= 0) {
            providerMirrors.splice(existingIndex, 1, mirror);
            return;
          }
          providerMirrors.push(mirror);
        }),
      getByThreadAndProvider: () => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
      list: () => Effect.succeed(providerMirrors),
      deleteByThreadId: () => Effect.void,
      deleteByThreadAndProvider: () => Effect.void,
    };
    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      getSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
      getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.die("not implemented"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("not implemented"),
      getThreadCheckpointContext: () => Effect.die("not implemented"),
      getThreadShellById: () => Effect.die("not implemented"),
      getThreadDetailById: () => Effect.succeed(Option.none()),
    };
    const sqlClient = {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } as const;
    const openCodeRuntime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () => Effect.die("not implemented"),
      connectToOpenCodeServer: () => Effect.die("not implemented"),
      runOpenCodeCommand: () => Effect.die("not implemented"),
      createOpenCodeSdkClient: () => {
        throw new Error("not implemented");
      },
      loadOpenCodeInventory: () => Effect.die("not implemented"),
    };
    const orchestrationEngine: OrchestrationEngineShape = {
      getReadModel: () => Effect.die("not implemented"),
      refreshReadModel: () => Effect.sync(() => ({}) as never),
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("not implemented"),
      streamDomainEvents: Stream.empty,
    };
    const serverSettings: ServerSettingsShape = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: () => Effect.die("not implemented"),
      streamChanges: Stream.empty,
    };

    try {
      await Effect.runPromise(
        Effect.scoped(
          launchOpenCodeSessionSync.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(ProjectionProjectRepository, projectRepo),
                Layer.succeed(ProjectionThreadRepository, threadRepo),
                Layer.succeed(ProjectionThreadMessageRepository, messageRepo),
                Layer.succeed(ProjectionThreadActivityRepository, activityRepo),
                Layer.succeed(ProjectionThreadSessionRepository, sessionRepo),
                Layer.succeed(ProviderSessionDirectory, providerSessionDirectory),
                Layer.succeed(ProviderThreadMirrorRepository, providerThreadMirrorRepository),
                Layer.succeed(OrchestrationEngineService, orchestrationEngine),
                Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery),
                Layer.succeed(SqlClient.SqlClient, sqlClient as SqlClient.SqlClient),
                Layer.succeed(OpenCodeRuntime, openCodeRuntime),
                Layer.succeed(ServerSettingsService, serverSettings),
              ),
            ),
          ),
        ),
      );
    } finally {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }

    expect(threads).toHaveLength(1);
    expect(threads[0]?.threadId).toBe("thread-existing");
    expect(providerBindings).toHaveLength(1);
    expect(providerBindings[0]?.threadId).toBe("thread-existing");
    expect(providerMirrors[0]).toMatchObject({
      threadId: "thread-existing",
      externalThreadId: "ses_fixture",
    });
  });

  it("renders a T3 thread into an OpenCode import payload", () => {
    const threadId = ThreadId.make("thread-1");
    const projectId = ProjectId.make("project-1");
    const userMessageId = MessageId.make("msg-user");
    const assistantMessageId = MessageId.make("msg-assistant");

    const payload = openCodeSessionSyncTestExports.buildOpenCodeExportPayload({
      externalThreadId: "ses_thread_export",
      workspaceRoot: "/tmp/demo-project",
      thread: {
        id: threadId,
        projectId,
        title: "Landing page polish",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-04-21T10:00:00.000Z",
        updatedAt: "2026-04-21T10:05:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: [
          {
            id: userMessageId,
            role: "user",
            text: "Polish the homepage hero copy.",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-21T10:00:00.000Z",
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: "Updated the hero copy and tightened the CTA.",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-21T10:04:00.000Z",
            updatedAt: "2026-04-21T10:05:00.000Z",
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    });

    expect(payload).toMatchObject({
      info: {
        id: "ses_thread_export",
        directory: "/tmp/demo-project",
        title: "Landing page polish",
      },
      messages: [
        {
          info: {
            role: "user",
            sessionID: "ses_thread_export",
          },
        },
        {
          info: {
            role: "assistant",
            parentID: expect.any(String),
            sessionID: "ses_thread_export",
          },
        },
      ],
    });
    expect(payload?.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: "step-start" }),
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "step-finish" }),
    ]);
  });

  it("exports stale T3 threads into OpenCode and records a mirror", async () => {
    const threadId = ThreadId.make("thread-1");
    const projectId = ProjectId.make("project-1");
    const userMessageId = MessageId.make("msg-user");
    const assistantMessageId = MessageId.make("msg-assistant");
    let capturedImport: {
      readonly binaryPath: string;
      readonly args: ReadonlyArray<string>;
      readonly payload: unknown;
    } | null = null;
    const providerMirrors: Array<Parameters<ProviderThreadMirrorRepositoryShape["upsert"]>[0]> = [];

    const projectRepo: ProjectionProjectRepositoryShape = {
      upsert: () => Effect.void,
      getById: () => Effect.succeed(Option.none()),
      listAll: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    };
    const threadRepo: ProjectionThreadRepositoryShape = {
      upsert: () => Effect.void,
      getById: () => Effect.succeed(Option.none()),
      listByProjectId: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    };
    const messageRepo: ProjectionThreadMessageRepositoryShape = {
      upsert: () => Effect.void,
      getByMessageId: () => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const activityRepo: ProjectionThreadActivityRepositoryShape = {
      upsert: () => Effect.void,
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const sessionRepo: ProjectionThreadSessionRepositoryShape = {
      upsert: () => Effect.void,
      getByThreadId: () => Effect.succeed(Option.none()),
      deleteByThreadId: () => Effect.void,
    };
    const providerThreadMirrorRepository: ProviderThreadMirrorRepositoryShape = {
      upsert: (mirror) =>
        Effect.sync(() => {
          const existingIndex = providerMirrors.findIndex(
            (entry) =>
              entry.threadId === mirror.threadId && entry.providerName === mirror.providerName,
          );
          if (existingIndex >= 0) {
            providerMirrors.splice(existingIndex, 1, mirror);
            return;
          }
          providerMirrors.push(mirror);
        }),
      getByThreadAndProvider: () => Effect.succeed(Option.none()),
      listByThreadId: (input) =>
        Effect.succeed(providerMirrors.filter((mirror) => mirror.threadId === input.threadId)),
      list: () => Effect.succeed(providerMirrors),
      deleteByThreadId: () => Effect.void,
      deleteByThreadAndProvider: () => Effect.void,
    };
    const providerSessionDirectory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => Effect.die("not implemented"),
      getBinding: () => Effect.succeed(Option.none()),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
    };
    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      getSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [
            {
              id: projectId,
              title: "Demo",
              workspaceRoot: "/tmp/demo-project",
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-04-21T10:00:00.000Z",
              updatedAt: "2026-04-21T10:00:00.000Z",
              deletedAt: null,
            },
          ],
          threads: [],
          updatedAt: "2026-04-21T10:05:00.000Z",
        }),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [
            {
              id: projectId,
              title: "Demo",
              workspaceRoot: "/tmp/demo-project",
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-04-21T10:00:00.000Z",
              updatedAt: "2026-04-21T10:00:00.000Z",
            },
          ],
          threads: [
            {
              id: threadId,
              projectId,
              title: "Landing page polish",
              modelSelection: {
                provider: "codex",
                model: "gpt-5.4",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              latestTurn: null,
              createdAt: "2026-04-21T10:00:00.000Z",
              updatedAt: "2026-04-21T10:05:00.000Z",
              archivedAt: null,
              session: null,
              latestUserMessageAt: "2026-04-21T10:00:00.000Z",
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            },
          ],
          updatedAt: "2026-04-21T10:05:00.000Z",
        }),
      getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
      getActiveProjectByWorkspaceRoot: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Demo",
            workspaceRoot: "/tmp/demo-project",
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-04-21T10:00:00.000Z",
            updatedAt: "2026-04-21T10:00:00.000Z",
            deletedAt: null,
          }),
        ),
      getProjectShellById: () => Effect.die("not implemented"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("not implemented"),
      getThreadCheckpointContext: () => Effect.die("not implemented"),
      getThreadShellById: () => Effect.die("not implemented"),
      getThreadDetailById: () =>
        Effect.succeed(
          Option.some({
            id: threadId,
            projectId,
            title: "Landing page polish",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: "2026-04-21T10:00:00.000Z",
            updatedAt: "2026-04-21T10:05:00.000Z",
            archivedAt: null,
            deletedAt: null,
            messages: [
              {
                id: userMessageId,
                role: "user",
                text: "Polish the homepage hero copy.",
                turnId: null,
                streaming: false,
                createdAt: "2026-04-21T10:00:00.000Z",
                updatedAt: "2026-04-21T10:00:00.000Z",
              },
              {
                id: assistantMessageId,
                role: "assistant",
                text: "Updated the hero copy and tightened the CTA.",
                turnId: null,
                streaming: false,
                createdAt: "2026-04-21T10:04:00.000Z",
                updatedAt: "2026-04-21T10:05:00.000Z",
              },
            ],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
          }),
        ),
    };
    const sqlClient = {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } as const;
    const openCodeRuntime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () => Effect.die("not implemented"),
      connectToOpenCodeServer: () => Effect.die("not implemented"),
      runOpenCodeCommand: (input) =>
        Effect.sync(() => {
          capturedImport = {
            binaryPath: input.binaryPath,
            args: input.args,
            payload: JSON.parse(readFileSync(input.args[1] ?? "", "utf8")),
          };
          return {
            stdout: "",
            stderr: "",
            code: 0,
          };
        }),
      createOpenCodeSdkClient: () => {
        throw new Error("not implemented");
      },
      loadOpenCodeInventory: () => Effect.die("not implemented"),
    };
    const orchestrationEngine: OrchestrationEngineShape = {
      getReadModel: () => Effect.die("not implemented"),
      refreshReadModel: () => Effect.die("should not refresh on export-only startup"),
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("not implemented"),
      streamDomainEvents: Stream.empty,
    };
    const serverSettings: ServerSettingsShape = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencode: {
            ...DEFAULT_SERVER_SETTINGS.providers.opencode,
            enabled: true,
            binaryPath: "/tmp/mock-opencode",
          },
        },
      }),
      updateSettings: () => Effect.die("not implemented"),
      streamChanges: Stream.empty,
    };

    await Effect.runPromise(
      Effect.scoped(
        launchOpenCodeSessionSync.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ProjectionProjectRepository, projectRepo),
              Layer.succeed(ProjectionThreadRepository, threadRepo),
              Layer.succeed(ProjectionThreadMessageRepository, messageRepo),
              Layer.succeed(ProjectionThreadActivityRepository, activityRepo),
              Layer.succeed(ProjectionThreadSessionRepository, sessionRepo),
              Layer.succeed(ProviderSessionDirectory, providerSessionDirectory),
              Layer.succeed(ProviderThreadMirrorRepository, providerThreadMirrorRepository),
              Layer.succeed(OrchestrationEngineService, orchestrationEngine),
              Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery),
              Layer.succeed(SqlClient.SqlClient, sqlClient as SqlClient.SqlClient),
              Layer.succeed(OpenCodeRuntime, openCodeRuntime),
              Layer.succeed(ServerSettingsService, serverSettings),
            ),
          ),
        ),
      ),
    );

    expect(capturedImport).not.toBeNull();
    expect(capturedImport).toMatchObject({
      binaryPath: "/tmp/mock-opencode",
      args: ["import", expect.any(String)],
      payload: {
        info: {
          title: "Landing page polish",
          directory: "/tmp/demo-project",
        },
      },
    });
    expect(providerMirrors).toHaveLength(1);
    expect(providerMirrors[0]).toMatchObject({
      threadId,
      providerName: "opencode",
      lastSeenAt: "2026-04-21T10:05:00.000Z",
      metadata: {
        source: "t3-export",
        title: "Landing page polish",
      },
    });
    expect(providerMirrors[0]?.externalThreadId).toMatch(/^ses_/);
  });
});
