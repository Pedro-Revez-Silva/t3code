import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import os from "node:os";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, Ref, Scope } from "effect";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadActivityRepository } from "./persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "./persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepository } from "./persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "./persistence/Services/ProjectionThreads.ts";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const SESSION_SYNC_INTERVAL = "3 seconds";
const DESKTOP_RUNNING_SESSION_FRESHNESS_MS = 2 * 60 * 1000;

interface SessionIndexEntry {
  readonly threadName: string | null;
  readonly updatedAt: string | null;
}

interface ImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnId: TurnId | null;
}

interface ImportedActivity {
  readonly tone: "info" | "tool" | "approval" | "error";
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly turnId: TurnId | null;
}

interface ImportedSession {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly latestTurnId: TurnId | null;
  readonly activeTurnId: TurnId | null;
  readonly status: "idle" | "running";
  readonly messages: ReadonlyArray<ImportedMessage>;
  readonly activities: ReadonlyArray<ImportedActivity>;
}

interface SyncState {
  readonly sessionIndexMtimeMs: number | null;
  readonly sessionFileMtimes: ReadonlyMap<string, number>;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function makeProjectId(workspaceRoot: string): ProjectId {
  const digest = createHash("sha1").update(workspaceRoot).digest("hex");
  return ProjectId.make(`codex-project-${digest.slice(0, 16)}`);
}

function makeProjectTitle(workspaceRoot: string): string {
  return basename(workspaceRoot) || "project";
}

function makeMessageId(threadId: ThreadId, ordinal: number): MessageId {
  return MessageId.make(`codex-msg-${threadId}-${ordinal}`);
}

function makeActivityId(threadId: ThreadId, ordinal: number): EventId {
  return EventId.make(`codex-activity-${threadId}-${ordinal}`);
}

function listJsonlFiles(root: string): ReadonlyArray<string> {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const nextPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(nextPath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function parseSessionIndex(filePath: string): Map<string, SessionIndexEntry> {
  if (!existsSync(filePath)) {
    return new Map();
  }

  const entries = new Map<string, SessionIndexEntry>();
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        id?: unknown;
        thread_name?: unknown;
        updated_at?: unknown;
      };
      const threadId = trimToUndefined(parsed.id);
      if (!threadId) continue;
      entries.set(threadId, {
        threadName: trimToUndefined(parsed.thread_name) ?? null,
        updatedAt: normalizeIsoTimestamp(parsed.updated_at) ?? null,
      });
    } catch {
      continue;
    }
  }

  return entries;
}

function resolveRuntimeMode(payload: Record<string, unknown>): RuntimeMode | undefined {
  const approvalPolicy = trimToUndefined(payload.approval_policy);
  if (approvalPolicy === "on-request") {
    return "approval-required";
  }

  const sandboxPolicy =
    payload.sandbox_policy && typeof payload.sandbox_policy === "object"
      ? (payload.sandbox_policy as { type?: unknown })
      : undefined;
  const sandboxType = trimToUndefined(sandboxPolicy?.type);
  if (sandboxType === "workspace-write" || sandboxType === "read-only") {
    return "approval-required";
  }
  if (sandboxType === "danger-full-access") {
    return "full-access";
  }

  return undefined;
}

function resolveInteractionMode(
  payload: Record<string, unknown>,
): ProviderInteractionMode | undefined {
  const collaborationMode =
    payload.collaboration_mode && typeof payload.collaboration_mode === "object"
      ? (payload.collaboration_mode as { mode?: unknown })
      : undefined;
  const mode = trimToUndefined(collaborationMode?.mode);
  if (mode === "plan" || mode === "default") {
    return mode;
  }
  return undefined;
}

function truncateSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function maxIsoTimestamp(...values: Array<string | null | undefined>): string | undefined {
  let latest: string | undefined;
  for (const value of values) {
    if (!value) continue;
    if (latest === undefined || value > latest) {
      latest = value;
    }
  }
  return latest;
}

function shouldTreatDesktopSessionAsRunning(input: {
  activeTurnId: TurnId | null;
  updatedAt: string;
  now?: Date;
}): boolean {
  if (input.activeTurnId === null) {
    return false;
  }

  const updatedAtMs = Date.parse(input.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }

  const nowMs = (input.now ?? new Date()).getTime();
  return nowMs - updatedAtMs <= DESKTOP_RUNNING_SESSION_FRESHNESS_MS;
}

function parseSessionFile(
  filePath: string,
  sessionIndex: ReadonlyMap<string, SessionIndexEntry>,
): ImportedSession | undefined {
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  let threadId: ThreadId | undefined;
  let workspaceRoot: string | undefined;
  let projectId: ProjectId | undefined;
  let projectTitle: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let model = "gpt-5-codex";
  let runtimeMode: RuntimeMode = "full-access";
  let interactionMode: ProviderInteractionMode = DEFAULT_PROVIDER_INTERACTION_MODE;
  let latestTurnId: TurnId | null = null;
  let activeTurnId: TurnId | null = null;
  const messages: ImportedMessage[] = [];
  const activities: ImportedActivity[] = [];

  const registerTimestamp = (timestamp: string | undefined) => {
    if (!timestamp) return;
    createdAt = createdAt === undefined || timestamp < createdAt ? timestamp : createdAt;
    updatedAt = updatedAt === undefined || timestamp > updatedAt ? timestamp : updatedAt;
  };

  for (const line of lines) {
    let parsed: { type?: unknown; timestamp?: unknown; payload?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const lineTimestamp = normalizeIsoTimestamp(parsed.timestamp);
    registerTimestamp(lineTimestamp);

    if (!parsed.payload || typeof parsed.payload !== "object" || Array.isArray(parsed.payload)) {
      continue;
    }
    const payload = parsed.payload as Record<string, unknown>;
    const type = trimToUndefined(parsed.type);

    if (type === "session_meta") {
      const rawThreadId = trimToUndefined(payload.id);
      const rawWorkspaceRoot = trimToUndefined(payload.cwd);
      if (!rawThreadId || !rawWorkspaceRoot) {
        continue;
      }

      threadId = ThreadId.make(rawThreadId);
      workspaceRoot = rawWorkspaceRoot;
      projectId = makeProjectId(rawWorkspaceRoot);
      projectTitle = makeProjectTitle(rawWorkspaceRoot);
      registerTimestamp(normalizeIsoTimestamp(payload.timestamp));
      continue;
    }

    if (type === "turn_context") {
      model = trimToUndefined(payload.model) ?? model;
      runtimeMode = resolveRuntimeMode(payload) ?? runtimeMode;
      interactionMode = resolveInteractionMode(payload) ?? interactionMode;
      continue;
    }

    if (type !== "event_msg") {
      continue;
    }

    const eventType = trimToUndefined(payload.type);
    if (!eventType) {
      continue;
    }

    if (eventType === "task_started") {
      const nextTurnId = trimToUndefined(payload.turn_id);
      if (nextTurnId) {
        latestTurnId = TurnId.make(nextTurnId);
        activeTurnId = latestTurnId;
      }
      continue;
    }

    if (eventType === "task_complete") {
      const completedTurnId = trimToUndefined(payload.turn_id);
      if (completedTurnId) {
        latestTurnId = TurnId.make(completedTurnId);
      }
      activeTurnId = null;
      continue;
    }

    if (eventType === "user_message") {
      const text = trimToUndefined(payload.message);
      if (text && lineTimestamp) {
        messages.push({
          role: "user",
          text,
          createdAt: lineTimestamp,
          updatedAt: lineTimestamp,
          turnId: activeTurnId,
        });
      }
      continue;
    }

    if (eventType === "agent_message") {
      const text = trimToUndefined(payload.message);
      if (!text || !lineTimestamp) {
        continue;
      }

      const phase = trimToUndefined(payload.phase);
      if (phase === "final_answer") {
        messages.push({
          role: "assistant",
          text,
          createdAt: lineTimestamp,
          updatedAt: lineTimestamp,
          turnId: activeTurnId,
        });
      } else {
        activities.push({
          tone: "info",
          kind: `codex.${phase ?? "commentary"}`,
          summary: truncateSummary(text),
          payload: {
            phase: phase ?? "commentary",
            message: text,
          },
          createdAt: lineTimestamp,
          turnId: activeTurnId,
        });
      }
    }
  }

  if (!threadId || !workspaceRoot || !projectId || !projectTitle) {
    return undefined;
  }

  const sessionIndexEntry = sessionIndex.get(threadId);
  const title =
    sessionIndexEntry?.threadName ??
    messages.find((message) => message.role === "user")?.text ??
    projectTitle;

  const normalizedCreatedAt = createdAt ?? new Date().toISOString();
  const normalizedUpdatedAt =
    maxIsoTimestamp(sessionIndexEntry?.updatedAt, updatedAt) ?? normalizedCreatedAt;
  const importedSessionIsRunning = shouldTreatDesktopSessionAsRunning({
    activeTurnId,
    updatedAt: normalizedUpdatedAt,
  });
  const normalizedActiveTurnId = importedSessionIsRunning ? activeTurnId : null;

  return {
    threadId,
    projectId,
    projectTitle,
    workspaceRoot,
    title: truncateSummary(title),
    createdAt: normalizedCreatedAt,
    updatedAt: normalizedUpdatedAt,
    model,
    runtimeMode,
    interactionMode,
    latestTurnId,
    activeTurnId: normalizedActiveTurnId,
    status: importedSessionIsRunning ? "running" : "idle",
    messages,
    activities,
  };
}

function appendSessionIndexUpdates(
  sessionIndexPath: string,
  sessionIndex: Map<string, SessionIndexEntry>,
  sessions: ReadonlyArray<ImportedSession>,
): boolean {
  const pendingEntries = sessions
    .filter((session) => {
      const existing = sessionIndex.get(session.threadId);
      return existing?.threadName !== session.title || existing?.updatedAt !== session.updatedAt;
    })
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

  if (pendingEntries.length === 0) {
    return false;
  }

  const lines = pendingEntries.map((session) => {
    sessionIndex.set(session.threadId, {
      threadName: session.title,
      updatedAt: session.updatedAt,
    });
    return JSON.stringify({
      id: session.threadId,
      thread_name: session.title,
      updated_at: session.updatedAt,
    });
  });

  appendFileSync(sessionIndexPath, `${lines.join("\n")}\n`, "utf8");
  return true;
}

function resolveCodexHomePath(homePath: string): string {
  const trimmed = homePath.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return process.env.CODEX_HOME || join(os.homedir(), ".codex");
}

export const codexDesktopSessionSyncTestExports = {
  appendSessionIndexUpdates,
  maxIsoTimestamp,
  parseSessionFile,
  parseSessionIndex,
  resolveCodexHomePath,
  shouldTreatDesktopSessionAsRunning,
};

export const launchCodexDesktopSessionSync: Effect.Effect<
  void,
  never,
  | ProjectionProjectRepository
  | ProjectionThreadRepository
  | ProjectionThreadMessageRepository
  | ProjectionThreadActivityRepository
  | ProjectionThreadSessionRepository
  | ProviderSessionDirectory
  | OrchestrationEngineService
  | ServerSettingsService
  | Scope.Scope
> = Effect.gen(function* () {
  const projectionProjects = yield* ProjectionProjectRepository;
  const projectionThreads = yield* ProjectionThreadRepository;
  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
  const projectionThreadActivities = yield* ProjectionThreadActivityRepository;
  const projectionThreadSessions = yield* ProjectionThreadSessionRepository;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;

  const syncState = yield* Ref.make<SyncState>({
    sessionIndexMtimeMs: null,
    sessionFileMtimes: new Map(),
  });

  const importSession = (session: ImportedSession) =>
    Effect.gen(function* () {
      yield* projectionProjects.upsert({
        projectId: session.projectId,
        title: session.projectTitle,
        workspaceRoot: session.workspaceRoot,
        defaultModelSelection: {
          provider: "codex",
          model: session.model,
        },
        scripts: [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        deletedAt: null,
      });

      yield* projectionThreads.upsert({
        threadId: session.threadId,
        projectId: session.projectId,
        title: session.title,
        modelSelection: {
          provider: "codex",
          model: session.model,
        },
        runtimeMode: session.runtimeMode,
        interactionMode: session.interactionMode,
        branch: null,
        worktreePath: null,
        latestTurnId: session.latestTurnId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archivedAt: null,
        latestUserMessageAt:
          session.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      yield* projectionThreadMessages.deleteByThreadId({ threadId: session.threadId });
      yield* Effect.forEach(session.messages, (message, index) =>
        projectionThreadMessages.upsert({
          messageId: makeMessageId(session.threadId, index + 1),
          threadId: session.threadId,
          turnId: message.turnId,
          role: message.role,
          text: message.text,
          isStreaming: false,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        }),
      );

      yield* projectionThreadActivities.deleteByThreadId({ threadId: session.threadId });
      yield* Effect.forEach(session.activities, (activity, index) =>
        projectionThreadActivities.upsert({
          activityId: makeActivityId(session.threadId, index + 1),
          threadId: session.threadId,
          turnId: activity.turnId,
          tone: activity.tone,
          kind: activity.kind,
          summary: activity.summary,
          payload: activity.payload,
          sequence: index,
          createdAt: activity.createdAt,
        }),
      );

      yield* projectionThreadSessions.upsert({
        threadId: session.threadId,
        status: session.status,
        providerName: "codex",
        runtimeMode: session.runtimeMode,
        activeTurnId: session.activeTurnId,
        lastError: null,
        updatedAt: session.updatedAt,
      });

      yield* providerSessionDirectory.upsert({
        threadId: session.threadId,
        provider: "codex",
        runtimeMode: session.runtimeMode,
        status: session.status === "running" ? "running" : "stopped",
        resumeCursor: {
          threadId: session.threadId,
        },
        runtimePayload: {
          cwd: session.workspaceRoot,
          model: session.model,
          modelSelection: {
            provider: "codex",
            model: session.model,
          },
          importedFromDesktopCodex: true,
        },
      });
    });

  const syncOnce = Effect.gen(function* () {
    const codexHome = resolveCodexHomePath(
      (yield* serverSettings.getSettings).providers.codex.homePath,
    );
    const sessionIndexPath = join(codexHome, "session_index.jsonl");
    const sessionsRoot = join(codexHome, "sessions");

    if (!existsSync(sessionIndexPath) || !existsSync(sessionsRoot)) {
      return false;
    }

    const nextSessionIndexMtimeMs = statSync(sessionIndexPath).mtimeMs;
    const sessionFiles = listJsonlFiles(sessionsRoot);
    const fileStats = new Map<string, number>();
    for (const filePath of sessionFiles) {
      fileStats.set(filePath, statSync(filePath).mtimeMs);
    }

    const currentState = yield* Ref.get(syncState);
    const sessionIndexChanged = currentState.sessionIndexMtimeMs !== nextSessionIndexMtimeMs;
    const filesToImport = sessionIndexChanged
      ? sessionFiles
      : sessionFiles.filter(
          (filePath) => currentState.sessionFileMtimes.get(filePath) !== fileStats.get(filePath),
        );

    if (filesToImport.length === 0) {
      yield* Ref.set(syncState, {
        sessionIndexMtimeMs: nextSessionIndexMtimeMs,
        sessionFileMtimes: fileStats,
      });
      return false;
    }

    const sessionIndex = parseSessionIndex(sessionIndexPath);
    const importedSessions = filesToImport
      .map((filePath) => parseSessionFile(filePath, sessionIndex))
      .filter((value): value is ImportedSession => value !== undefined);

    const sessionIndexUpdated = appendSessionIndexUpdates(
      sessionIndexPath,
      sessionIndex,
      importedSessions,
    );

    yield* Effect.forEach(importedSessions, (session) => importSession(session));
    yield* Ref.set(syncState, {
      sessionIndexMtimeMs: sessionIndexUpdated
        ? statSync(sessionIndexPath).mtimeMs
        : nextSessionIndexMtimeMs,
      sessionFileMtimes: fileStats,
    });

    return importedSessions.length > 0;
  });

  const refreshImportedReadModel = (engine: OrchestrationEngineShape) =>
    syncOnce.pipe(
      Effect.flatMap((changed) => (changed ? engine.refreshReadModel() : Effect.void)),
      Effect.catch((cause) =>
        Effect.logWarning("failed to import desktop Codex sessions during startup", { cause }),
      ),
    );

  yield* refreshImportedReadModel(orchestrationEngine);

  yield* Effect.forkScoped(
    Effect.forever(
      syncOnce.pipe(
        Effect.flatMap((changed) =>
          changed ? orchestrationEngine.refreshReadModel().pipe(Effect.asVoid) : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("failed to sync desktop Codex sessions", { cause }),
        ),
        Effect.andThen(Effect.sleep(SESSION_SYNC_INTERVAL)),
      ),
    ),
  );
});
