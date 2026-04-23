import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ThreadId,
  TurnId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, Option, Ref, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadActivityRepository } from "./persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "./persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepository } from "./persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "./persistence/Services/ProjectionThreads.ts";
import {
  ProviderThreadMirrorRepository,
  type ProviderThreadMirror,
} from "./persistence/Services/ProviderThreadMirrors.ts";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { OpenCodeRuntime, parseOpenCodeModelSlug } from "./provider/opencodeRuntime.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import {
  ensureCanonicalWorkspaceProject,
  makeHashedProjectId,
  makeProjectTitleFromRoot,
  reconcileWorkspaceProjectDuplicates,
  truncateSessionSummary,
} from "./sessionSyncShared.ts";

const SESSION_SYNC_INTERVAL = "3 seconds";

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

interface ImportedOpenCodeSession {
  readonly externalThreadId: string;
  readonly threadId: ThreadId;
  readonly projectId: ReturnType<typeof makeHashedProjectId>;
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
  readonly databaseMtimeMs: number | null;
  readonly walMtimeMs: number | null;
}

interface SessionRow {
  readonly id: string;
  readonly projectId: string;
  readonly directory: string;
  readonly title: string;
  readonly permission: string | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly projectName: string | null;
}

interface MessageRow {
  readonly id: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly data: string;
}

interface PartRow {
  readonly id: string;
  readonly messageId: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly data: string;
}

interface OpenCodeExportModel {
  readonly slug: string;
  readonly providerID: string;
  readonly modelID: string;
}

interface OpenCodeExportMessage {
  readonly info: Record<string, unknown>;
  readonly parts: ReadonlyArray<Record<string, unknown>>;
}

interface OpenCodeExportPayload {
  readonly info: {
    readonly id: string;
    readonly slug: string;
    readonly projectID: string;
    readonly directory: string;
    readonly title: string;
    readonly version: string;
    readonly summary: {
      readonly additions: number;
      readonly deletions: number;
      readonly files: number;
    };
    readonly time: {
      readonly created: number;
      readonly updated: number;
    };
  };
  readonly messages: ReadonlyArray<OpenCodeExportMessage>;
}

function resolveOpenCodeDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  return xdgDataHome
    ? join(xdgDataHome, "opencode")
    : join(os.homedir(), ".local", "share", "opencode");
}

function resolveOpenCodeDatabasePath(): string {
  return join(resolveOpenCodeDataDir(), "opencode.db");
}

function resolveOpenCodeWalPath(databasePath: string): string {
  return `${databasePath}-wal`;
}

function normalizeEpochTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
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

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveOpenCodeRuntimeMode(permission: string | null): RuntimeMode {
  const trimmed = permission?.trim();
  if (!trimmed) {
    return "full-access";
  }

  try {
    const parsed = JSON.parse(trimmed) as Array<{
      action?: unknown;
      permission?: unknown;
      pattern?: unknown;
    }>;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return "full-access";
    }

    const hasGlobalAllow = parsed.some(
      (rule) =>
        rule.action === "allow" &&
        rule.permission === "*" &&
        (rule.pattern === "*" || !rule.pattern),
    );
    if (hasGlobalAllow) {
      return "full-access";
    }
  } catch {
    return "approval-required";
  }

  return "approval-required";
}

function resolveOpenCodeModelSlug(payload: Record<string, unknown>): string | undefined {
  const nestedModel =
    payload.model && typeof payload.model === "object" && !Array.isArray(payload.model)
      ? (payload.model as { providerID?: unknown; modelID?: unknown })
      : undefined;

  const providerID =
    trimToUndefined(payload.providerID) ?? trimToUndefined(nestedModel?.providerID);
  const modelID = trimToUndefined(payload.modelID) ?? trimToUndefined(nestedModel?.modelID);
  if (!providerID || !modelID) {
    return undefined;
  }
  return `${providerID}/${modelID}`;
}

function isoToEpochTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function makeStableOpenCodeId(
  prefix: "msg" | "prt" | "ses",
  threadId: ThreadId,
  suffix: string,
): string {
  const digest = createHash("sha1").update(`${threadId}:${suffix}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function normalizeOpenCodeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "t3-thread";
}

function resolveOpenCodeExportModel(modelSelection: ModelSelection): OpenCodeExportModel {
  if (modelSelection.provider === "opencode") {
    const parsedCurrent = parseOpenCodeModelSlug(modelSelection.model);
    if (parsedCurrent) {
      return {
        slug: modelSelection.model,
        providerID: parsedCurrent.providerID,
        modelID: parsedCurrent.modelID,
      };
    }
  }

  const parsedDefault = parseOpenCodeModelSlug(DEFAULT_MODEL_BY_PROVIDER.opencode);
  if (parsedDefault) {
    return {
      slug: DEFAULT_MODEL_BY_PROVIDER.opencode,
      providerID: parsedDefault.providerID,
      modelID: parsedDefault.modelID,
    };
  }

  return {
    slug: "openai/gpt-5",
    providerID: "openai",
    modelID: "gpt-5",
  };
}

function buildOpenCodeMirrorRuntimePayload(input: {
  readonly workspaceRoot: string;
  readonly model: string;
  readonly importedFromOpenCode: boolean;
  readonly exportedFromT3: boolean;
}): Record<string, unknown> {
  return {
    cwd: input.workspaceRoot,
    model: input.model,
    modelSelection: {
      provider: "opencode",
      model: input.model,
    },
    importedFromOpenCode: input.importedFromOpenCode,
    exportedFromT3: input.exportedFromT3,
  };
}

function wasMirrorExportedFromT3(mirror: ProviderThreadMirror | undefined): boolean {
  if (!mirror?.runtimePayload || typeof mirror.runtimePayload !== "object") {
    return false;
  }

  const payload = mirror.runtimePayload as { exportedFromT3?: unknown };
  return payload.exportedFromT3 === true;
}

function readMirrorSource(mirror: ProviderThreadMirror | undefined): string {
  if (!mirror?.metadata || typeof mirror.metadata !== "object") {
    return "local-opencode";
  }

  const metadata = mirror.metadata as { source?: unknown };
  return typeof metadata.source === "string" ? metadata.source : "local-opencode";
}

function shouldImportOpenCodeSession(
  sessionUpdatedAt: string,
  existingMirror: ProviderThreadMirror | undefined,
): boolean {
  if (!existingMirror || !wasMirrorExportedFromT3(existingMirror)) {
    return true;
  }

  return existingMirror.lastExportedAt === null || sessionUpdatedAt > existingMirror.lastExportedAt;
}

function buildOpenCodeExportPayload(input: {
  readonly thread: OrchestrationThread;
  readonly workspaceRoot: string;
  readonly externalThreadId: string;
}): OpenCodeExportPayload | null {
  const model = resolveOpenCodeExportModel(input.thread.modelSelection);
  const root = parse(input.workspaceRoot).root || "/";
  const messages: OpenCodeExportMessage[] = [];
  let latestUserMessageId: string | undefined;

  for (const [index, message] of input.thread.messages.entries()) {
    if (message.role === "system") {
      continue;
    }

    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }

    const createdAt = isoToEpochTimestamp(message.createdAt);
    const updatedAt = isoToEpochTimestamp(message.updatedAt);
    const messageId = makeStableOpenCodeId("msg", input.thread.id, `${message.id}:${index}`);
    const textPartId = makeStableOpenCodeId("prt", input.thread.id, `${message.id}:${index}:text`);

    if (message.role === "user") {
      latestUserMessageId = messageId;
      messages.push({
        info: {
          role: "user",
          time: { created: createdAt },
          agent: "build",
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
          },
          summary: {
            diffs: [],
          },
          id: messageId,
          sessionID: input.externalThreadId,
        },
        parts: [
          {
            type: "text",
            text,
            id: textPartId,
            sessionID: input.externalThreadId,
            messageID: messageId,
          },
        ],
      });
      continue;
    }

    const stepStartId = makeStableOpenCodeId(
      "prt",
      input.thread.id,
      `${message.id}:${index}:step-start`,
    );
    const stepFinishId = makeStableOpenCodeId(
      "prt",
      input.thread.id,
      `${message.id}:${index}:step-finish`,
    );
    messages.push({
      info: {
        ...(latestUserMessageId ? { parentID: latestUserMessageId } : {}),
        role: "assistant",
        mode: "build",
        agent: "build",
        path: {
          cwd: input.workspaceRoot,
          root,
        },
        cost: 0,
        tokens: {
          total: 0,
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            write: 0,
            read: 0,
          },
        },
        modelID: model.modelID,
        providerID: model.providerID,
        time: {
          created: createdAt,
          completed: updatedAt,
        },
        finish: "stop",
        id: messageId,
        sessionID: input.externalThreadId,
      },
      parts: [
        {
          type: "step-start",
          id: stepStartId,
          sessionID: input.externalThreadId,
          messageID: messageId,
        },
        {
          type: "text",
          text,
          time: {
            start: createdAt,
            end: updatedAt,
          },
          id: textPartId,
          sessionID: input.externalThreadId,
          messageID: messageId,
        },
        {
          type: "step-finish",
          reason: "stop",
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: {
              write: 0,
              read: 0,
            },
          },
          cost: 0,
          id: stepFinishId,
          sessionID: input.externalThreadId,
          messageID: messageId,
        },
      ],
    });
  }

  if (messages.length === 0) {
    return null;
  }

  return {
    info: {
      id: input.externalThreadId,
      slug: normalizeOpenCodeSlug(input.thread.title),
      projectID: input.thread.projectId,
      directory: input.workspaceRoot,
      title: input.thread.title,
      version: "t3code",
      summary: {
        additions: 0,
        deletions: 0,
        files: 0,
      },
      time: {
        created: isoToEpochTimestamp(input.thread.createdAt),
        updated: isoToEpochTimestamp(input.thread.updatedAt),
      },
    },
    messages,
  };
}

function shouldExportThread(thread: OrchestrationThreadShell, lastSeenAt: string | null): boolean {
  if (thread.archivedAt !== null) {
    return false;
  }

  if (thread.session?.providerName === "opencode") {
    return false;
  }

  return lastSeenAt === null || thread.updatedAt > lastSeenAt;
}

function queryAllRows<T extends object>(
  database: DatabaseSync,
  sql: string,
  ...params: ReadonlyArray<string>
): ReadonlyArray<T> {
  return database.prepare(sql).all(...params) as unknown as ReadonlyArray<T>;
}

function loadOpenCodeSessions(databasePath: string): ReadonlyArray<ImportedOpenCodeSession> {
  const database = new DatabaseSync(databasePath, { readOnly: true });

  try {
    const sessions = queryAllRows<SessionRow>(
      database,
      `
        SELECT
          s.id AS id,
          s.project_id AS projectId,
          s.directory AS directory,
          s.title AS title,
          s.permission AS permission,
          s.time_created AS timeCreated,
          s.time_updated AS timeUpdated,
          p.name AS projectName
        FROM session s
        LEFT JOIN project p ON p.id = s.project_id
        WHERE s.time_archived IS NULL
        ORDER BY s.time_updated ASC, s.id ASC
      `,
    );

    const importedSessions: ImportedOpenCodeSession[] = [];

    for (const session of sessions) {
      const workspaceRoot = trimToUndefined(session.directory);
      const createdAt = normalizeEpochTimestamp(session.timeCreated);
      const updatedAt = normalizeEpochTimestamp(session.timeUpdated);
      if (!workspaceRoot || !createdAt || !updatedAt) {
        continue;
      }

      const messages = queryAllRows<MessageRow>(
        database,
        `
            SELECT
              id AS id,
              time_created AS timeCreated,
              time_updated AS timeUpdated,
              data AS data
            FROM message
            WHERE session_id = ?
            ORDER BY time_created ASC, id ASC
          `,
        session.id,
      );
      const parts = queryAllRows<PartRow>(
        database,
        `
            SELECT
              id AS id,
              message_id AS messageId,
              time_created AS timeCreated,
              time_updated AS timeUpdated,
              data AS data
            FROM part
            WHERE session_id = ?
            ORDER BY time_created ASC, id ASC
          `,
        session.id,
      );

      const partsByMessageId = new Map<string, Array<PartRow>>();
      for (const part of parts) {
        const existing = partsByMessageId.get(part.messageId);
        if (existing) {
          existing.push(part);
        } else {
          partsByMessageId.set(part.messageId, [part]);
        }
      }

      const importedMessages: ImportedMessage[] = [];
      const importedActivities: ImportedActivity[] = [];
      let latestModel = DEFAULT_MODEL_BY_PROVIDER.opencode;

      for (const message of messages) {
        const payload = parseJsonRecord(message.data);
        if (!payload) {
          continue;
        }

        const modelSlug = resolveOpenCodeModelSlug(payload);
        if (modelSlug) {
          latestModel = modelSlug;
        }

        const role = trimToUndefined(payload.role);
        if (role !== "user" && role !== "assistant") {
          continue;
        }

        const createdAtValue =
          normalizeEpochTimestamp(
            payload.time && typeof payload.time === "object" && !Array.isArray(payload.time)
              ? (payload.time as { created?: unknown }).created
              : undefined,
          ) ?? normalizeEpochTimestamp(message.timeCreated);
        const updatedAtValue =
          normalizeEpochTimestamp(
            payload.time && typeof payload.time === "object" && !Array.isArray(payload.time)
              ? ((payload.time as { completed?: unknown; created?: unknown }).completed ??
                  (payload.time as { created?: unknown }).created)
              : undefined,
          ) ?? normalizeEpochTimestamp(message.timeUpdated);
        if (!createdAtValue || !updatedAtValue) {
          continue;
        }

        const textParts: string[] = [];
        for (const part of partsByMessageId.get(message.id) ?? []) {
          const parsedPart = parseJsonRecord(part.data);
          const partType = parsedPart ? trimToUndefined(parsedPart.type) : undefined;
          if (partType === "text") {
            const text = trimToUndefined(parsedPart?.text);
            if (text) {
              textParts.push(text);
            }
            continue;
          }

          if (partType === "reasoning") {
            const reasoning = trimToUndefined(parsedPart?.text);
            if (reasoning) {
              importedActivities.push({
                tone: "info",
                kind: "opencode.reasoning",
                summary: truncateSessionSummary(reasoning),
                payload: parsedPart,
                createdAt:
                  normalizeEpochTimestamp(
                    parsedPart?.time && typeof parsedPart.time === "object"
                      ? (parsedPart.time as { start?: unknown }).start
                      : undefined,
                  ) ?? createdAtValue,
                turnId: null,
              });
            }
          }
        }

        const text = textParts.join("\n\n").trim();
        if (text.length === 0) {
          continue;
        }

        importedMessages.push({
          role,
          text,
          createdAt: createdAtValue,
          updatedAt: updatedAtValue,
          turnId: null,
        });
      }

      importedSessions.push({
        externalThreadId: session.id,
        threadId: ThreadId.make(session.id),
        projectId: makeHashedProjectId("opencode-project", workspaceRoot),
        projectTitle: session.projectName ?? makeProjectTitleFromRoot(workspaceRoot),
        workspaceRoot,
        title: truncateSessionSummary(trimToUndefined(session.title) ?? "OpenCode session"),
        createdAt,
        updatedAt,
        model: latestModel,
        runtimeMode: resolveOpenCodeRuntimeMode(session.permission),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        latestTurnId: null,
        activeTurnId: null,
        status: "idle",
        messages: importedMessages,
        activities: importedActivities.toSorted((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        ),
      });
    }

    return importedSessions;
  } finally {
    database.close();
  }
}

function makeMessageId(threadId: ThreadId, ordinal: number): MessageId {
  return MessageId.make(`opencode-msg-${threadId}-${ordinal}`);
}

function makeActivityId(threadId: ThreadId, ordinal: number): EventId {
  return EventId.make(`opencode-activity-${threadId}-${ordinal}`);
}

export const openCodeSessionSyncTestExports = {
  buildOpenCodeExportPayload,
  loadOpenCodeSessions,
  resolveOpenCodeDataDir,
  resolveOpenCodeDatabasePath,
  resolveOpenCodeRuntimeMode,
  shouldImportOpenCodeSession,
};

export const launchOpenCodeSessionSync: Effect.Effect<
  void,
  never,
  | ProjectionProjectRepository
  | ProjectionThreadRepository
  | ProjectionThreadMessageRepository
  | ProjectionThreadActivityRepository
  | ProjectionThreadSessionRepository
  | ProviderThreadMirrorRepository
  | ProviderSessionDirectory
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | SqlClient.SqlClient
  | OpenCodeRuntime
  | ServerSettingsService
  | Scope.Scope
> = Effect.gen(function* () {
  const projectionThreads = yield* ProjectionThreadRepository;
  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
  const projectionThreadActivities = yield* ProjectionThreadActivityRepository;
  const projectionThreadSessions = yield* ProjectionThreadSessionRepository;
  const providerThreadMirrorRepository = yield* ProviderThreadMirrorRepository;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const openCodeRuntime = yield* OpenCodeRuntime;
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettingsService;

  const syncState = yield* Ref.make<SyncState>({
    databaseMtimeMs: null,
    walMtimeMs: null,
  });

  const importSession = (
    session: ImportedOpenCodeSession,
    canonicalThreadId: ThreadId,
    existingMirror: ProviderThreadMirror | undefined,
  ) =>
    Effect.gen(function* () {
      const canonicalProjectId = yield* ensureCanonicalWorkspaceProject({
        workspaceRoot: session.workspaceRoot,
        projectTitle: session.projectTitle,
        defaultModelSelection: {
          provider: "opencode",
          model: session.model,
        },
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });

      yield* projectionThreads.upsert({
        threadId: canonicalThreadId,
        projectId: canonicalProjectId,
        title: session.title,
        modelSelection: {
          provider: "opencode",
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

      yield* projectionThreadMessages.deleteByThreadId({ threadId: canonicalThreadId });
      yield* Effect.forEach(session.messages, (message, index) =>
        projectionThreadMessages.upsert({
          messageId: makeMessageId(canonicalThreadId, index + 1),
          threadId: canonicalThreadId,
          turnId: message.turnId,
          role: message.role,
          text: message.text,
          isStreaming: false,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        }),
      );

      yield* projectionThreadActivities.deleteByThreadId({ threadId: canonicalThreadId });
      yield* Effect.forEach(session.activities, (activity, index) =>
        projectionThreadActivities.upsert({
          activityId: makeActivityId(canonicalThreadId, index + 1),
          threadId: canonicalThreadId,
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
        threadId: canonicalThreadId,
        status: session.status,
        providerName: "opencode",
        runtimeMode: session.runtimeMode,
        activeTurnId: session.activeTurnId,
        lastError: null,
        updatedAt: session.updatedAt,
      });

      yield* providerSessionDirectory.upsert({
        threadId: canonicalThreadId,
        provider: "opencode",
        runtimeMode: session.runtimeMode,
        status: "stopped",
        resumeCursor: {
          sessionID: session.externalThreadId,
          directory: session.workspaceRoot,
        },
        runtimePayload: buildOpenCodeMirrorRuntimePayload({
          workspaceRoot: session.workspaceRoot,
          model: session.model,
          importedFromOpenCode: true,
          exportedFromT3: wasMirrorExportedFromT3(existingMirror),
        }),
      });

      yield* providerThreadMirrorRepository.upsert({
        threadId: canonicalThreadId,
        providerName: "opencode",
        externalThreadId: session.externalThreadId,
        lastSeenAt: session.updatedAt,
        lastImportedAt: new Date().toISOString(),
        lastExportedAt:
          existingMirror && "lastExportedAt" in existingMirror
            ? (existingMirror.lastExportedAt ?? null)
            : null,
        resumeCursor: {
          sessionID: session.externalThreadId,
          directory: session.workspaceRoot,
        },
        runtimePayload: buildOpenCodeMirrorRuntimePayload({
          workspaceRoot: session.workspaceRoot,
          model: session.model,
          importedFromOpenCode: true,
          exportedFromT3: wasMirrorExportedFromT3(existingMirror),
        }),
        metadata: {
          source: readMirrorSource(existingMirror),
          title: session.title,
          status: session.status,
        },
      });
    });

  const exportThread = (
    threadId: ThreadId,
    workspaceRoot: string,
    externalThreadId: string,
    binaryPath: string,
    existingMirror: ProviderThreadMirror | undefined,
  ) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
      if (Option.isNone(threadOption)) {
        return false;
      }

      const thread = threadOption.value;
      const exportPayload = buildOpenCodeExportPayload({
        thread,
        workspaceRoot,
        externalThreadId,
      });
      if (!exportPayload) {
        return false;
      }

      const tempDir = yield* Effect.sync(() =>
        mkdtempSync(join(os.tmpdir(), "t3-opencode-export-")),
      );
      const exportFilePath = join(tempDir, "session.json");
      yield* Effect.sync(() => {
        writeFileSync(exportFilePath, JSON.stringify(exportPayload, null, 2));
      });

      const cleanupTempDir = Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.ignore);
      const result = yield* openCodeRuntime
        .runOpenCodeCommand({
          binaryPath,
          args: ["import", exportFilePath],
        })
        .pipe(Effect.ensuring(cleanupTempDir));
      if (result.code !== 0) {
        yield* Effect.logWarning("failed to export T3 thread to OpenCode", {
          threadId,
          externalThreadId,
          stderr: result.stderr,
          stdout: result.stdout,
          code: result.code,
        });
        return false;
      }

      const now = new Date().toISOString();
      const exportModel = resolveOpenCodeExportModel(thread.modelSelection);
      yield* providerThreadMirrorRepository.upsert({
        threadId: thread.id,
        providerName: "opencode",
        externalThreadId,
        lastSeenAt: thread.updatedAt,
        lastImportedAt: existingMirror?.lastImportedAt ?? null,
        lastExportedAt: now,
        resumeCursor: {
          sessionID: externalThreadId,
          directory: workspaceRoot,
        },
        runtimePayload: buildOpenCodeMirrorRuntimePayload({
          workspaceRoot,
          model: exportModel.slug,
          importedFromOpenCode: false,
          exportedFromT3: true,
        }),
        metadata: {
          source: existingMirror
            ? readMirrorSource(existingMirror) === "local-opencode"
              ? "local-opencode"
              : "t3-export"
            : "t3-export",
          title: thread.title,
          status: thread.session?.status ?? "idle",
        },
      });

      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to export T3 thread to OpenCode", {
          threadId,
          externalThreadId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  const syncImports = (enabled: boolean) =>
    Effect.gen(function* () {
      if (!enabled) {
        return false;
      }

      const databasePath = resolveOpenCodeDatabasePath();
      const walPath = resolveOpenCodeWalPath(databasePath);
      if (!existsSync(databasePath)) {
        return false;
      }

      const nextDatabaseMtimeMs = statSync(databasePath).mtimeMs;
      const nextWalMtimeMs = existsSync(walPath) ? statSync(walPath).mtimeMs : null;
      const currentState = yield* Ref.get(syncState);
      if (
        currentState.databaseMtimeMs === nextDatabaseMtimeMs &&
        currentState.walMtimeMs === nextWalMtimeMs
      ) {
        return false;
      }

      const mirrors = (yield* providerThreadMirrorRepository.list()).filter(
        (mirror) => mirror.providerName === "opencode",
      );
      const mirrorsByThreadId = new Map(
        mirrors.map((mirror) => [mirror.threadId, mirror] as const),
      );
      const mirrorsByExternalThreadId = new Map(
        mirrors
          .filter((mirror) => typeof mirror.externalThreadId === "string")
          .map((mirror) => [mirror.externalThreadId as string, mirror] as const),
      );
      const importedSessions = loadOpenCodeSessions(databasePath);
      const importedChanged = yield* sql.withTransaction(
        Effect.gen(function* () {
          const importedResults = yield* Effect.forEach(importedSessions, (session) => {
            const existingMirror =
              mirrorsByExternalThreadId.get(session.externalThreadId) ??
              mirrorsByThreadId.get(session.threadId);
            if (!shouldImportOpenCodeSession(session.updatedAt, existingMirror)) {
              return Effect.succeed(false);
            }
            const canonicalThreadId = existingMirror?.threadId ?? session.threadId;
            return importSession(session, canonicalThreadId, existingMirror).pipe(Effect.as(true));
          });
          yield* reconcileWorkspaceProjectDuplicates();
          yield* Ref.set(syncState, {
            databaseMtimeMs: nextDatabaseMtimeMs,
            walMtimeMs: nextWalMtimeMs,
          });
          return importedResults.some(Boolean);
        }),
      );

      return importedChanged;
    });

  const syncExports = (enabled: boolean) =>
    Effect.gen(function* () {
      if (!enabled) {
        return false;
      }

      const settings = yield* serverSettings.getSettings;
      const binaryPath = settings.providers.opencode.binaryPath?.trim() || "opencode";
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const projectsById = new Map(
        snapshot.projects.map((project) => [project.id, project] as const),
      );
      const mirrors = (yield* providerThreadMirrorRepository.list()).filter(
        (mirror) => mirror.providerName === "opencode",
      );
      const mirrorsByThreadId = new Map(
        mirrors.map((mirror) => [mirror.threadId, mirror] as const),
      );

      const results = yield* Effect.forEach(snapshot.threads, (thread) => {
        const project = projectsById.get(thread.projectId);
        if (!project) {
          return Effect.succeed(false);
        }

        const existingMirror = mirrorsByThreadId.get(thread.id);
        if (!shouldExportThread(thread, existingMirror?.lastSeenAt ?? null)) {
          return Effect.succeed(false);
        }

        const externalThreadId =
          existingMirror?.externalThreadId ?? makeStableOpenCodeId("ses", thread.id, thread.id);
        return exportThread(
          thread.id,
          project.workspaceRoot,
          externalThreadId,
          binaryPath,
          existingMirror,
        );
      });

      return results.some(Boolean);
    });

  const syncOnce = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const imported = yield* syncImports(settings.providers.opencode.enabled);
    yield* syncExports(settings.providers.opencode.enabled);
    return imported;
  });

  const refreshImportedReadModel = (engine: OrchestrationEngineShape) =>
    syncOnce.pipe(
      Effect.flatMap((changed) => (changed ? engine.refreshReadModel() : Effect.void)),
      Effect.catch((cause) =>
        Effect.logWarning("failed to import OpenCode sessions during startup", { cause }),
      ),
    );

  yield* refreshImportedReadModel(orchestrationEngine);

  yield* Effect.forkScoped(
    Effect.forever(
      syncOnce.pipe(
        Effect.flatMap((changed) =>
          changed ? orchestrationEngine.refreshReadModel().pipe(Effect.asVoid) : Effect.void,
        ),
        Effect.catch((cause) => Effect.logWarning("failed to sync OpenCode sessions", { cause })),
        Effect.andThen(Effect.sleep(SESSION_SYNC_INTERVAL)),
      ),
    ),
  );
});
