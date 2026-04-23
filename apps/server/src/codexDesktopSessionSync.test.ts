import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  codexDesktopSessionSyncTestExports,
  launchCodexDesktopSessionSync,
} from "./codexDesktopSessionSync.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
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

describe("codexDesktopSessionSync", () => {
  it("parses the latest session index entry per thread and ignores invalid lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sync-index-"));
    const filePath = join(dir, "session_index.jsonl");

    writeFileSync(
      filePath,
      [
        "not-json",
        JSON.stringify({
          id: "thread-1",
          thread_name: "Old title",
          updated_at: "2026-04-07T19:00:00.000Z",
        }),
        JSON.stringify({
          id: "thread-1",
          thread_name: "New title",
          updated_at: "2026-04-07T20:00:00.000Z",
        }),
        JSON.stringify({
          id: "thread-2",
          thread_name: "Second thread",
          updated_at: "2026-04-07T18:00:00.000Z",
        }),
      ].join("\n"),
      "utf8",
    );

    const sessionIndex = codexDesktopSessionSyncTestExports.parseSessionIndex(filePath);

    expect(sessionIndex.get("thread-1")).toEqual({
      threadName: "New title",
      updatedAt: "2026-04-07T20:00:00.000Z",
    });
    expect(sessionIndex.get("thread-2")).toEqual({
      threadName: "Second thread",
      updatedAt: "2026-04-07T18:00:00.000Z",
    });
  });

  it("imports Codex session files and prefers the newest timestamp from the rollout", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sync-session-"));
    const filePath = join(dir, "thread.jsonl");
    const sessionIndex = new Map([
      [
        "thread-1",
        {
          threadName: "Indexed title",
          updatedAt: "2026-04-07T18:05:00.000Z",
        },
      ],
    ]);

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-07T18:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-1",
            cwd: "/Users/pedrosilva/project-a",
            timestamp: "2026-04-07T18:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:00.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4",
            approval_policy: "on-request",
            collaboration_mode: { mode: "plan" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:10.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:20.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "hello from codex",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:30.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "working on it",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:06:00.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "done",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:06:10.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const session = codexDesktopSessionSyncTestExports.parseSessionFile(filePath, sessionIndex);

    expect(session).toMatchObject({
      threadId: "thread-1",
      workspaceRoot: "/Users/pedrosilva/project-a",
      title: "Indexed title",
      model: "gpt-5.4",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      latestTurnId: "turn-1",
      activeTurnId: null,
      status: "idle",
      updatedAt: "2026-04-07T18:06:10.000Z",
    });
    expect(session?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "hello from codex",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "done",
        turnId: "turn-1",
      }),
    ]);
    expect(session?.activities).toEqual([
      expect.objectContaining({
        kind: "codex.commentary",
        summary: "working on it",
      }),
    ]);
  });

  it("downgrades stale imported running desktop sessions to idle", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sync-stale-running-"));
    const filePath = join(dir, "thread.jsonl");

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-07T18:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-stale",
            cwd: "/Users/pedrosilva/project-a",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:10.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-stale",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const session = codexDesktopSessionSyncTestExports.parseSessionFile(filePath, new Map());

    expect(session).toMatchObject({
      threadId: "thread-stale",
      latestTurnId: "turn-stale",
      activeTurnId: null,
      status: "idle",
    });
  });

  it("treats recently updated imported desktop sessions as still running", () => {
    expect(
      codexDesktopSessionSyncTestExports.shouldTreatDesktopSessionAsRunning({
        activeTurnId: "turn-live" as never,
        updatedAt: "2026-04-07T18:00:00.000Z",
        now: new Date("2026-04-07T18:01:30.000Z"),
      }),
    ).toBe(true);

    expect(
      codexDesktopSessionSyncTestExports.shouldTreatDesktopSessionAsRunning({
        activeTurnId: "turn-stale" as never,
        updatedAt: "2026-04-07T18:00:00.000Z",
        now: new Date("2026-04-07T18:03:30.000Z"),
      }),
    ).toBe(false);
  });

  it("appends only changed session index entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sync-append-"));
    const filePath = join(dir, "session_index.jsonl");

    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: "thread-1",
        thread_name: "Current title",
        updated_at: "2026-04-07T18:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const sessionIndex = codexDesktopSessionSyncTestExports.parseSessionIndex(filePath);
    const changed = codexDesktopSessionSyncTestExports.appendSessionIndexUpdates(
      filePath,
      sessionIndex,
      [
        {
          threadId: "thread-1",
          title: "Current title",
          updatedAt: "2026-04-07T18:00:00.000Z",
        },
        {
          threadId: "thread-2",
          title: "New thread",
          updatedAt: "2026-04-07T18:01:00.000Z",
        },
      ] as never,
    );

    expect(changed).toBe(true);
    expect(sessionIndex.get("thread-2")).toEqual({
      threadName: "New thread",
      updatedAt: "2026-04-07T18:01:00.000Z",
    });
    const lines = readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      id: "thread-2",
      thread_name: "New thread",
      updated_at: "2026-04-07T18:01:00.000Z",
    });
  });

  it("imports desktop Codex sessions during startup and refreshes the read model", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-sync-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "04", "07");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(
      join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({
        id: "thread-1",
        thread_name: "Imported thread",
        updated_at: "2026-04-07T18:00:00.000Z",
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(sessionsDir, "thread-1.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-04-07T18:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-1",
            cwd: "/Users/pedrosilva/demo-project",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:00:05.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4",
            sandbox_policy: { type: "danger-full-access" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:00:10.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:00:12.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "hello",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:00:15.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "world",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:00:16.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
          },
        }),
      ].join("\n"),
      "utf8",
    );

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
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            homePath: codexHome,
          },
        },
      }),
      updateSettings: () => Effect.die("not implemented"),
      streamChanges: Stream.empty,
    };
    const projectionSnapshotQuery = {
      getSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-04-07T18:00:16.000Z",
        }),
      getShellSnapshot: () => Effect.die("not implemented"),
      getCounts: () => Effect.die("not implemented"),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.succeed(Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      getThreadCheckpointContext: () => Effect.succeed(Option.none()),
      getThreadShellById: () => Effect.succeed(Option.none()),
      getThreadDetailById: () => Effect.succeed(Option.none()),
    } as const;
    const sqlClient = {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } as const;

    await Effect.runPromise(
      Effect.scoped(
        launchCodexDesktopSessionSync.pipe(
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

    expect(projects).toHaveLength(1);
    expect(threads).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(activities).toHaveLength(0);
    expect(sessions).toHaveLength(1);
    expect(providerBindings).toHaveLength(1);
    expect(providerMirrors).toHaveLength(1);
    expect(refreshCount).toBe(1);
    expect(messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({ role: "assistant", text: "world" }),
    ]);
    expect(providerMirrors[0]).toMatchObject({
      threadId: "thread-1",
      providerName: "codex",
      externalThreadId: "thread-1",
      metadata: expect.objectContaining({
        source: "desktop-codex",
        title: "Imported thread",
      }),
    });
  });
});
