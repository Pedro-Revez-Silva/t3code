import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_SERVER_SETTINGS, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { claudeSessionSyncTestExports, launchClaudeSessionSync } from "./claudeSessionSync.ts";
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
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";

function createClaudeFixture(homeDir: string): {
  readonly projectsRoot: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessionFilePath: string;
} {
  const workspaceRoot = "/Users/pedrosilva/Repos/demo-project";
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const projectsRoot = join(homeDir, ".claude", "projects");
  const projectKey = claudeSessionSyncTestExports.makeClaudeProjectKey(workspaceRoot);
  const projectDir = join(projectsRoot, projectKey);
  const sessionFilePath = join(projectDir, `${sessionId}.jsonl`);
  const indexFilePath = join(projectDir, "sessions-index.json");

  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    sessionFilePath,
    [
      JSON.stringify({
        type: "permission-mode",
        permissionMode: "default",
        sessionId,
      }),
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        promptId: "prompt-1",
        type: "user",
        message: {
          role: "user",
          content: "Review the login flow and summarize the bug.",
        },
        uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        timestamp: "2026-04-21T10:00:00.000Z",
        permissionMode: "default",
        userType: "external",
        entrypoint: "cli",
        cwd: workspaceRoot,
        sessionId,
        version: "2.1.112",
        gitBranch: "main",
      }),
      JSON.stringify({
        parentUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-6",
          id: "msg_01fixture",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "I should inspect the login route first.",
            },
            {
              type: "tool_use",
              id: "toolu_01fixture",
              name: "Read",
              input: {
                file_path: "/Users/pedrosilva/Repos/demo-project/app/routes.ts",
              },
            },
            {
              type: "text",
              text: "The login flow fails because the CSRF token is not forwarded.",
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
          },
        },
        requestId: "req_01fixture",
        type: "assistant",
        uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        timestamp: "2026-04-21T10:00:05.000Z",
        userType: "external",
        entrypoint: "cli",
        cwd: workspaceRoot,
        sessionId,
        version: "2.1.112",
        gitBranch: "main",
      }),
      "",
    ].join("\n"),
  );

  writeFileSync(
    indexFilePath,
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            sessionId,
            fullPath: sessionFilePath,
            fileMtime: Date.now(),
            firstPrompt: "Review the login flow and summarize the bug.",
            summary: "Investigated login flow bug",
            messageCount: 2,
            created: "2026-04-21T10:00:00.000Z",
            modified: "2026-04-21T10:00:05.000Z",
            gitBranch: "main",
            projectPath: workspaceRoot,
            isSidechain: false,
          },
        ],
        originalPath: workspaceRoot,
      },
      null,
      2,
    ),
  );

  return {
    projectsRoot,
    workspaceRoot,
    sessionId,
    sessionFilePath,
  };
}

describe("claudeSessionSync", () => {
  it("ignores self-exported Claude mirrors until they advance past the export time", () => {
    expect(
      claudeSessionSyncTestExports.shouldImportClaudeSession("2026-04-23T09:00:00.000Z", {
        lastExportedAt: "2026-04-23T09:00:01.000Z",
        runtimePayload: {
          exportedFromT3: true,
        },
      } as never),
    ).toBe(false);

    expect(
      claudeSessionSyncTestExports.shouldImportClaudeSession("2026-04-23T09:00:02.000Z", {
        lastExportedAt: "2026-04-23T09:00:01.000Z",
        runtimePayload: {
          exportedFromT3: true,
        },
      } as never),
    ).toBe(true);
  });

  it("loads Claude sessions from the local project store", () => {
    const homeDir = join(tmpdir(), `claude-sync-load-${Date.now()}`);
    const fixture = createClaudeFixture(homeDir);

    const sessions = claudeSessionSyncTestExports.loadClaudeSessions(fixture.projectsRoot);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      externalThreadId: fixture.sessionId,
      threadId: fixture.sessionId,
      workspaceRoot: fixture.workspaceRoot,
      title: "Investigated login flow bug",
      model: "claude-sonnet-4-6",
      runtimeMode: "approval-required",
      interactionMode: "default",
      lastAssistantUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(sessions[0]?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Review the login flow and summarize the bug.",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "The login flow fails because the CSRF token is not forwarded.",
      }),
    ]);
    expect(sessions[0]?.activities).toEqual([
      expect.objectContaining({
        kind: "claude.reasoning",
        summary: "I should inspect the login route first.",
      }),
      expect.objectContaining({
        kind: "claude.tool_use.Read",
      }),
    ]);
  });

  it("imports Claude sessions during startup and refreshes the read model", async () => {
    const homeDir = join(tmpdir(), `claude-sync-import-${Date.now()}`);
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    const fixture = createClaudeFixture(homeDir);

    const projects: Array<Parameters<ProjectionProjectRepositoryShape["upsert"]>[0]> = [];
    const threads: Array<Parameters<ProjectionThreadRepositoryShape["upsert"]>[0]> = [];
    const messages: Array<Parameters<ProjectionThreadMessageRepositoryShape["upsert"]>[0]> = [];
    const activities: Array<Parameters<ProjectionThreadActivityRepositoryShape["upsert"]>[0]> = [];
    const sessions: Array<Parameters<ProjectionThreadSessionRepositoryShape["upsert"]>[0]> = [];
    const providerBindings: Array<Parameters<ProviderSessionDirectoryShape["upsert"]>[0]> = [];
    const providerMirrors: Array<Parameters<ProviderThreadMirrorRepositoryShape["upsert"]>[0]> = [];
    let refreshCount = 0;

    const projectRepo: ProjectionProjectRepositoryShape = {
      upsert: (row) => Effect.sync(() => void projects.push(row)),
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
      upsert: (row) => Effect.sync(() => void messages.push(row)),
      getByMessageId: () => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const activityRepo: ProjectionThreadActivityRepositoryShape = {
      upsert: (row) => Effect.sync(() => void activities.push(row)),
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
    };
    const sessionRepo: ProjectionThreadSessionRepositoryShape = {
      upsert: (row) => Effect.sync(() => void sessions.push(row)),
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
      upsert: (mirror) => Effect.sync(() => void providerMirrors.push(mirror)),
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
          launchClaudeSessionSync.pipe(
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
                Layer.succeed(ServerSettingsService, serverSettings),
              ),
            ),
          ),
        ),
      );
    } finally {
      process.env.HOME = previousHome;
    }

    expect(projects).toHaveLength(1);
    expect(threads).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(activities).toHaveLength(2);
    expect(sessions).toHaveLength(1);
    expect(providerBindings).toHaveLength(1);
    expect(providerMirrors).toHaveLength(1);
    expect(refreshCount).toBe(1);
    expect(providerBindings[0]).toMatchObject({
      threadId: fixture.sessionId,
      provider: "claudeAgent",
      resumeCursor: {
        sessionId: fixture.sessionId,
        resume: fixture.sessionId,
        resumeSessionAt: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
    expect(providerMirrors[0]).toMatchObject({
      threadId: fixture.sessionId,
      providerName: "claudeAgent",
      externalThreadId: fixture.sessionId,
    });
  });

  it("exports stale T3 threads into Claude's native session store and records a mirror", async () => {
    const homeDir = join(tmpdir(), `claude-sync-export-${Date.now()}`);
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    const threadId = ThreadId.make("thread-1");
    const projectId = ProjectId.make("project-1");
    const userMessageId = MessageId.make("msg-user");
    const assistantMessageId = MessageId.make("msg-assistant");
    const workspaceRoot = "/tmp/demo-project";
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
              workspaceRoot,
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
              workspaceRoot,
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
              title: "Login flow bug",
              modelSelection: {
                provider: "codex",
                model: "gpt-5.4",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
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
            workspaceRoot,
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
            title: "Login flow bug",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
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
                text: "Review the login flow and summarize the bug.",
                turnId: null,
                streaming: false,
                createdAt: "2026-04-21T10:00:00.000Z",
                updatedAt: "2026-04-21T10:00:00.000Z",
              },
              {
                id: assistantMessageId,
                role: "assistant",
                text: "The login flow fails because the CSRF token is not forwarded.",
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
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: () => Effect.die("not implemented"),
      streamChanges: Stream.empty,
    };

    try {
      await Effect.runPromise(
        Effect.scoped(
          launchClaudeSessionSync.pipe(
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
                Layer.succeed(ServerSettingsService, serverSettings),
              ),
            ),
          ),
        ),
      );
    } finally {
      process.env.HOME = previousHome;
    }

    expect(providerMirrors).toHaveLength(1);
    expect(providerMirrors[0]).toMatchObject({
      threadId,
      providerName: "claudeAgent",
      lastSeenAt: "2026-04-21T10:05:00.000Z",
      metadata: {
        source: "t3-export",
        title: "Login flow bug",
      },
    });
    expect(providerMirrors[0]?.externalThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const projectKey = claudeSessionSyncTestExports.makeClaudeProjectKey(workspaceRoot);
    const indexFilePath = join(homeDir, ".claude", "projects", projectKey, "sessions-index.json");
    expect(existsSync(indexFilePath)).toBe(true);

    const index = JSON.parse(readFileSync(indexFilePath, "utf8")) as {
      entries: Array<{ sessionId: string; fullPath: string; summary: string }>;
    };
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      sessionId: providerMirrors[0]?.externalThreadId,
      summary: "The login flow fails because the CSRF token is not forwarded.",
    });
    expect(readFileSync(index.entries[0]?.fullPath ?? "", "utf8")).toContain(
      "Review the login flow and summarize the bug.",
    );
    expect(
      claudeSessionSyncTestExports.loadClaudeSessions(join(homeDir, ".claude", "projects")),
    ).toEqual([
      expect.objectContaining({
        externalThreadId: providerMirrors[0]?.externalThreadId,
        messages: [
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ],
      }),
    ]);
  });
});
