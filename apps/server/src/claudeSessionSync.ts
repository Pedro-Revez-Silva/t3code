import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

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

interface ImportedClaudeSession {
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
  readonly lastAssistantUuid: string | null;
}

interface ClaudeSessionIndexEntry {
  readonly sessionId: string;
  readonly fullPath: string;
  readonly summary: string;
  readonly firstPrompt: string;
  readonly created: string | null;
  readonly modified: string | null;
  readonly gitBranch: string;
  readonly projectPath: string;
  readonly isSidechain: boolean;
}

interface SyncState {
  readonly indexFileMtimes: ReadonlyMap<string, number>;
  readonly sessionFileMtimes: ReadonlyMap<string, number>;
}

interface ClaudeExportSessionIndexEntry {
  readonly sessionId: string;
  readonly fullPath: string;
  readonly fileMtime: number;
  readonly firstPrompt: string;
  readonly summary: string;
  readonly messageCount: number;
  readonly created: string;
  readonly modified: string;
  readonly gitBranch: string;
  readonly projectPath: string;
  readonly isSidechain: boolean;
}

interface ClaudeExportArtifacts {
  readonly sessionFileContents: string;
  readonly sessionIndexEntry: ClaudeExportSessionIndexEntry;
  readonly resumeCursor: {
    readonly sessionId: string;
    readonly resume: string;
    readonly resumeSessionAt?: string;
    readonly turnCount: number;
  };
  readonly model: string;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function makeMessageId(threadId: ThreadId, ordinal: number): MessageId {
  return MessageId.make(`claude-msg-${threadId}-${ordinal}`);
}

function makeActivityId(threadId: ThreadId, ordinal: number): EventId {
  return EventId.make(`claude-activity-${threadId}-${ordinal}`);
}

function makeClaudeProjectKey(workspaceRoot: string): string {
  const parts = workspaceRoot.split("/").filter((segment) => segment.length > 0);
  return parts.length > 0 ? `-${parts.join("-")}` : "-root";
}

function resolveClaudeHome(): string {
  return join(os.homedir(), ".claude");
}

function resolveClaudeProjectsRoot(): string {
  return join(resolveClaudeHome(), "projects");
}

function resolveClaudeProjectDir(workspaceRoot: string): string {
  return join(resolveClaudeProjectsRoot(), makeClaudeProjectKey(workspaceRoot));
}

function listClaudeSessionIndexFiles(projectsRoot: string): ReadonlyArray<string> {
  if (!existsSync(projectsRoot)) {
    return [];
  }

  const indexFiles: string[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(projectsRoot, entry.name, "sessions-index.json");
    if (existsSync(candidate)) {
      indexFiles.push(candidate);
    }
  }

  indexFiles.sort((left, right) => left.localeCompare(right));
  return indexFiles;
}

function parseClaudeSessionIndex(filePath: string): ReadonlyArray<ClaudeSessionIndexEntry> {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      return [];
    }

    return parsed.entries.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const sessionId = trimToUndefined(entry.sessionId);
      const fullPath = trimToUndefined(entry.fullPath);
      const projectPath =
        trimToUndefined(entry.projectPath) ?? trimToUndefined(parsed.originalPath) ?? undefined;
      if (!sessionId || !fullPath || !projectPath) {
        return [];
      }

      return [
        {
          sessionId,
          fullPath,
          summary: trimToUndefined(entry.summary) ?? "Claude session",
          firstPrompt: trimToUndefined(entry.firstPrompt) ?? "No prompt",
          created: normalizeIsoTimestamp(entry.created) ?? null,
          modified: normalizeIsoTimestamp(entry.modified) ?? null,
          gitBranch: trimToUndefined(entry.gitBranch) ?? "",
          projectPath,
          isSidechain: entry.isSidechain === true,
        },
      ] satisfies ReadonlyArray<ClaudeSessionIndexEntry>;
    });
  } catch {
    return [];
  }
}

function resolveClaudeRuntimeMode(permissionMode: string | undefined): RuntimeMode {
  switch (permissionMode) {
    case "bypassPermissions":
    case "dontAsk":
      return "full-access";
    case "acceptEdits":
      return "auto-accept-edits";
    default:
      return "approval-required";
  }
}

function resolveClaudeInteractionMode(permissionMode: string | undefined): ProviderInteractionMode {
  return permissionMode === "plan" ? "plan" : DEFAULT_PROVIDER_INTERACTION_MODE;
}

function resolveClaudePermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "bypassPermissions";
    case "auto-accept-edits":
      return "acceptEdits";
    case "approval-required":
    default:
      return "default";
  }
}

function extractNestedClaudeText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return trimToUndefined(content);
  }
  if (Array.isArray(content)) {
    const text = content
      .flatMap((entry) => {
        if (typeof entry === "string") {
          return [entry];
        }
        if (!isRecord(entry)) {
          return [];
        }
        const nestedText =
          trimToUndefined(entry.text) ??
          trimToUndefined(entry.thinking) ??
          extractNestedClaudeText(entry.content);
        return nestedText ? [nestedText] : [];
      })
      .join("\n\n")
      .trim();
    return text.length > 0 ? text : undefined;
  }
  if (isRecord(content)) {
    return (
      trimToUndefined(content.text) ??
      trimToUndefined(content.thinking) ??
      extractNestedClaudeText(content.content)
    );
  }
  return undefined;
}

function buildClaudeToolSummary(name: string, input: unknown): string {
  const inputSummary = extractNestedClaudeText(input);
  return truncateSessionSummary(inputSummary ? `${name}: ${inputSummary}` : name);
}

function parseClaudeSessionFile(entry: ClaudeSessionIndexEntry): ImportedClaudeSession | undefined {
  if (!existsSync(entry.fullPath)) {
    return undefined;
  }

  const lines = readFileSync(entry.fullPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const messages: ImportedMessage[] = [];
  const activities: ImportedActivity[] = [];
  let createdAt = entry.created ?? undefined;
  let updatedAt = entry.modified ?? undefined;
  let permissionMode: string | undefined;
  let latestModel = DEFAULT_MODEL_BY_PROVIDER.claudeAgent;
  let lastAssistantUuid: string | null = null;

  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) {
      continue;
    }

    const recordType = trimToUndefined(record.type);
    const timestamp = normalizeIsoTimestamp(record.timestamp);
    if (timestamp) {
      createdAt = createdAt ?? timestamp;
      updatedAt = updatedAt && updatedAt > timestamp ? updatedAt : timestamp;
    }

    if (recordType === "permission-mode") {
      permissionMode = trimToUndefined(record.permissionMode) ?? permissionMode;
      continue;
    }

    if (recordType !== "user" && recordType !== "assistant") {
      continue;
    }

    const message = isRecord(record.message) ? record.message : undefined;
    if (!message) {
      continue;
    }

    if (recordType === "user") {
      if (record.isMeta === true) {
        continue;
      }
      permissionMode = trimToUndefined(record.permissionMode) ?? permissionMode;
      const content = message.content;
      const text =
        typeof content === "string"
          ? trimToUndefined(content)
          : !Array.isArray(content)
            ? undefined
            : undefined;
      if (text && timestamp) {
        messages.push({
          role: "user",
          text,
          createdAt: timestamp,
          updatedAt: timestamp,
          turnId: null,
        });
        continue;
      }

      if (Array.isArray(content) && timestamp) {
        for (const block of content) {
          if (!isRecord(block) || trimToUndefined(block.type) !== "tool_result") {
            continue;
          }
          const summary = extractNestedClaudeText(block.content);
          if (!summary) {
            continue;
          }
          activities.push({
            tone: "tool",
            kind: "claude.tool_result",
            summary: truncateSessionSummary(summary),
            payload: block,
            createdAt: timestamp,
            turnId: null,
          });
        }
      }
      continue;
    }

    const assistantUuid = trimToUndefined(record.uuid);
    if (assistantUuid) {
      lastAssistantUuid = assistantUuid;
    }

    const model = trimToUndefined(message.model);
    if (model) {
      latestModel = model;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const textBlocks: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      const blockType = trimToUndefined(block.type);
      if (blockType === "text") {
        const text = trimToUndefined(block.text);
        if (text) {
          textBlocks.push(text);
        }
        continue;
      }
      if (blockType === "thinking") {
        const thinking = trimToUndefined(block.thinking);
        if (thinking && timestamp) {
          activities.push({
            tone: "info",
            kind: "claude.reasoning",
            summary: truncateSessionSummary(thinking),
            payload: block,
            createdAt: timestamp,
            turnId: null,
          });
        }
        continue;
      }
      if (blockType === "tool_use") {
        const toolName = trimToUndefined(block.name) ?? "tool_use";
        if (timestamp) {
          activities.push({
            tone: "tool",
            kind: `claude.tool_use.${toolName}`,
            summary: buildClaudeToolSummary(toolName, block.input),
            payload: block,
            createdAt: timestamp,
            turnId: null,
          });
        }
      }
    }

    if (record.error && timestamp) {
      const errorText =
        trimToUndefined(record.error) ?? extractNestedClaudeText(message.content) ?? "Claude error";
      activities.push({
        tone: "error",
        kind: "claude.error",
        summary: truncateSessionSummary(errorText),
        payload: record,
        createdAt: timestamp,
        turnId: null,
      });
    }

    const text = textBlocks.join("\n\n").trim();
    if (text.length > 0 && timestamp) {
      messages.push({
        role: "assistant",
        text,
        createdAt: timestamp,
        updatedAt: timestamp,
        turnId: null,
      });
    }
  }

  const effectiveCreatedAt =
    createdAt ?? messages[0]?.createdAt ?? normalizeIsoTimestamp(new Date().toISOString());
  const effectiveUpdatedAt =
    updatedAt ??
    messages.findLast((message) => message.role === "assistant")?.updatedAt ??
    effectiveCreatedAt;
  if (!effectiveCreatedAt || !effectiveUpdatedAt) {
    return undefined;
  }

  const firstPrompt = messages.find((message) => message.role === "user")?.text;
  const titleCandidate =
    trimToUndefined(entry.summary) ??
    truncateSessionSummary(firstPrompt ?? entry.firstPrompt) ??
    "Claude session";

  return {
    externalThreadId: entry.sessionId,
    threadId: ThreadId.make(entry.sessionId),
    projectId: makeHashedProjectId("claude-project", entry.projectPath),
    projectTitle: makeProjectTitleFromRoot(entry.projectPath),
    workspaceRoot: entry.projectPath,
    title: titleCandidate,
    createdAt: effectiveCreatedAt,
    updatedAt: effectiveUpdatedAt,
    model: latestModel,
    runtimeMode: resolveClaudeRuntimeMode(permissionMode),
    interactionMode: resolveClaudeInteractionMode(permissionMode),
    latestTurnId: null,
    activeTurnId: null,
    status: "idle",
    messages,
    activities: activities.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    lastAssistantUuid,
  };
}

function loadClaudeSessions(
  projectsRoot = resolveClaudeProjectsRoot(),
): ReadonlyArray<ImportedClaudeSession> {
  return listClaudeSessionIndexFiles(projectsRoot)
    .flatMap((indexFile) => parseClaudeSessionIndex(indexFile))
    .filter((entry) => entry.isSidechain === false)
    .flatMap((entry) => {
      const parsed = parseClaudeSessionFile(entry);
      return parsed ? [parsed] : [];
    });
}

function resolveClaudeExportModel(modelSelection: ModelSelection): string {
  return modelSelection.provider === "claudeAgent"
    ? modelSelection.model
    : DEFAULT_MODEL_BY_PROVIDER.claudeAgent;
}

function buildClaudeMirrorRuntimePayload(input: {
  readonly workspaceRoot: string;
  readonly model: string;
  readonly importedFromClaude: boolean;
  readonly exportedFromT3: boolean;
}): Record<string, unknown> {
  return {
    cwd: input.workspaceRoot,
    model: input.model,
    modelSelection: {
      provider: "claudeAgent",
      model: input.model,
    },
    importedFromClaude: input.importedFromClaude,
    exportedFromT3: input.exportedFromT3,
  };
}

function wasMirrorExportedFromT3(mirror: ProviderThreadMirror | undefined): boolean {
  if (!isRecord(mirror?.runtimePayload)) {
    return false;
  }
  return mirror.runtimePayload.exportedFromT3 === true;
}

function readMirrorSource(mirror: ProviderThreadMirror | undefined): string {
  if (!isRecord(mirror?.metadata)) {
    return "local-claude";
  }
  return typeof mirror.metadata.source === "string" ? mirror.metadata.source : "local-claude";
}

function shouldImportClaudeSession(
  sessionUpdatedAt: string,
  existingMirror: ProviderThreadMirror | undefined,
): boolean {
  if (!existingMirror || !wasMirrorExportedFromT3(existingMirror)) {
    return true;
  }

  return existingMirror.lastExportedAt === null || sessionUpdatedAt > existingMirror.lastExportedAt;
}

function makeClaudeStableId(prefix: string, threadId: ThreadId, suffix: string): string {
  const digest = createHash("sha1").update(`${threadId}:${suffix}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function buildClaudeExportArtifacts(input: {
  readonly thread: OrchestrationThread;
  readonly workspaceRoot: string;
  readonly externalThreadId: string;
  readonly sessionFilePath: string;
}): ClaudeExportArtifacts | null {
  const permissionMode = resolveClaudePermissionMode(input.thread.runtimeMode);
  const model = resolveClaudeExportModel(input.thread.modelSelection);
  const gitBranch = input.thread.branch ?? "";
  const lines: string[] = [
    JSON.stringify({
      type: "permission-mode",
      permissionMode,
      sessionId: input.externalThreadId,
    }),
  ];

  let previousUuid: string | null = null;
  let lastAssistantUuid: string | undefined;
  let firstPrompt: string | undefined;
  let lastAssistantSummary: string | undefined;
  let messageCount = 0;

  for (const [index, message] of input.thread.messages.entries()) {
    if (message.role === "system") {
      continue;
    }
    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }

    if (message.role === "user") {
      const userUuid = randomUUID();
      firstPrompt = firstPrompt ?? truncateSessionSummary(text, 200);
      lines.push(
        JSON.stringify({
          type: "file-history-snapshot",
          messageId: userUuid,
          snapshot: {
            messageId: userUuid,
            trackedFileBackups: {},
            timestamp: message.createdAt,
          },
          isSnapshotUpdate: false,
        }),
      );
      lines.push(
        JSON.stringify({
          parentUuid: previousUuid,
          isSidechain: false,
          promptId: input.thread.id,
          type: "user",
          message: {
            role: "user",
            content: text,
          },
          uuid: userUuid,
          timestamp: message.createdAt,
          permissionMode,
          userType: "external",
          entrypoint: "cli",
          cwd: input.workspaceRoot,
          sessionId: input.externalThreadId,
          version: "t3code",
          gitBranch,
        }),
      );
      previousUuid = userUuid;
      messageCount += 1;
      continue;
    }

    const assistantUuid = randomUUID();
    lastAssistantUuid = assistantUuid;
    lastAssistantSummary = truncateSessionSummary(text);
    const requestId = makeClaudeStableId("req", input.thread.id, `${message.id}:${index}`);
    const assistantMessageId = makeClaudeStableId("msg", input.thread.id, `${message.id}:${index}`);
    lines.push(
      JSON.stringify({
        parentUuid: previousUuid,
        isSidechain: false,
        message: {
          model,
          id: assistantMessageId,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "text",
              text,
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: {
              web_search_requests: 0,
              web_fetch_requests: 0,
            },
            service_tier: null,
            cache_creation: {
              ephemeral_1h_input_tokens: 0,
              ephemeral_5m_input_tokens: 0,
            },
            inference_geo: null,
          },
        },
        requestId,
        type: "assistant",
        uuid: assistantUuid,
        timestamp: message.updatedAt,
        userType: "external",
        entrypoint: "cli",
        cwd: input.workspaceRoot,
        sessionId: input.externalThreadId,
        version: "t3code",
        gitBranch,
      }),
    );
    previousUuid = assistantUuid;
    messageCount += 1;
  }

  if (messageCount === 0) {
    return null;
  }

  return {
    sessionFileContents: `${lines.join("\n")}\n`,
    sessionIndexEntry: {
      sessionId: input.externalThreadId,
      fullPath: input.sessionFilePath,
      fileMtime: Date.now(),
      firstPrompt: firstPrompt ?? "No prompt",
      summary: lastAssistantSummary ?? truncateSessionSummary(input.thread.title),
      messageCount,
      created: input.thread.createdAt,
      modified: input.thread.updatedAt,
      gitBranch,
      projectPath: input.workspaceRoot,
      isSidechain: false,
    },
    resumeCursor: {
      sessionId: input.externalThreadId,
      resume: input.externalThreadId,
      ...(lastAssistantUuid ? { resumeSessionAt: lastAssistantUuid } : {}),
      turnCount: input.thread.messages.filter((message) => message.role !== "system").length,
    },
    model,
  };
}

function writeClaudeSessionIndex(
  indexFilePath: string,
  workspaceRoot: string,
  nextEntry: ClaudeExportSessionIndexEntry,
): void {
  let existingEntries: ReadonlyArray<ClaudeExportSessionIndexEntry> = [];
  let originalPath = workspaceRoot;

  if (existsSync(indexFilePath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexFilePath, "utf8")) as unknown;
      if (isRecord(parsed)) {
        if (typeof parsed.originalPath === "string" && parsed.originalPath.trim().length > 0) {
          originalPath = parsed.originalPath;
        }
        if (Array.isArray(parsed.entries)) {
          existingEntries = parsed.entries.flatMap((entry) =>
            isRecord(entry) &&
            typeof entry.sessionId === "string" &&
            typeof entry.fullPath === "string" &&
            typeof entry.firstPrompt === "string" &&
            typeof entry.summary === "string" &&
            typeof entry.messageCount === "number" &&
            typeof entry.created === "string" &&
            typeof entry.modified === "string" &&
            typeof entry.gitBranch === "string" &&
            typeof entry.projectPath === "string" &&
            typeof entry.isSidechain === "boolean"
              ? [
                  {
                    sessionId: entry.sessionId,
                    fullPath: entry.fullPath,
                    fileMtime: typeof entry.fileMtime === "number" ? entry.fileMtime : Date.now(),
                    firstPrompt: entry.firstPrompt,
                    summary: entry.summary,
                    messageCount: entry.messageCount,
                    created: entry.created,
                    modified: entry.modified,
                    gitBranch: entry.gitBranch,
                    projectPath: entry.projectPath,
                    isSidechain: entry.isSidechain,
                  } satisfies ClaudeExportSessionIndexEntry,
                ]
              : [],
          );
        }
      }
    } catch {
      existingEntries = [];
    }
  }

  const nextEntries = [
    ...existingEntries.filter((entry) => entry.sessionId !== nextEntry.sessionId),
    nextEntry,
  ].toSorted((left, right) => right.modified.localeCompare(left.modified));

  writeFileSync(
    indexFilePath,
    JSON.stringify(
      {
        version: 1,
        entries: nextEntries,
        originalPath,
      },
      null,
      2,
    ),
  );
}

function shouldExportThread(thread: OrchestrationThreadShell, lastSeenAt: string | null): boolean {
  if (thread.archivedAt !== null) {
    return false;
  }
  if (thread.session?.providerName === "claudeAgent") {
    return false;
  }
  return lastSeenAt === null || thread.updatedAt > lastSeenAt;
}

export const claudeSessionSyncTestExports = {
  buildClaudeExportArtifacts,
  loadClaudeSessions,
  makeClaudeProjectKey,
  resolveClaudeProjectsRoot,
  resolveClaudeRuntimeMode,
  shouldImportClaudeSession,
};

export const launchClaudeSessionSync: Effect.Effect<
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
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettingsService;

  const syncState = yield* Ref.make<SyncState>({
    indexFileMtimes: new Map(),
    sessionFileMtimes: new Map(),
  });

  const importSession = (
    session: ImportedClaudeSession,
    canonicalThreadId: ThreadId,
    existingMirror: ProviderThreadMirror | undefined,
  ) =>
    Effect.gen(function* () {
      const canonicalProjectId = yield* ensureCanonicalWorkspaceProject({
        workspaceRoot: session.workspaceRoot,
        projectTitle: session.projectTitle,
        defaultModelSelection: {
          provider: "claudeAgent",
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
          provider: "claudeAgent",
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
        providerName: "claudeAgent",
        runtimeMode: session.runtimeMode,
        activeTurnId: session.activeTurnId,
        lastError: null,
        updatedAt: session.updatedAt,
      });

      const resumeCursor = {
        sessionId: session.externalThreadId,
        resume: session.externalThreadId,
        ...(session.lastAssistantUuid ? { resumeSessionAt: session.lastAssistantUuid } : {}),
        turnCount: session.messages.filter((message) => message.role !== "assistant").length,
      };

      yield* providerSessionDirectory.upsert({
        threadId: canonicalThreadId,
        provider: "claudeAgent",
        runtimeMode: session.runtimeMode,
        status: "stopped",
        resumeCursor,
        runtimePayload: buildClaudeMirrorRuntimePayload({
          workspaceRoot: session.workspaceRoot,
          model: session.model,
          importedFromClaude: true,
          exportedFromT3: wasMirrorExportedFromT3(existingMirror),
        }),
      });

      yield* providerThreadMirrorRepository.upsert({
        threadId: canonicalThreadId,
        providerName: "claudeAgent",
        externalThreadId: session.externalThreadId,
        lastSeenAt: session.updatedAt,
        lastImportedAt: new Date().toISOString(),
        lastExportedAt: existingMirror?.lastExportedAt ?? null,
        resumeCursor,
        runtimePayload: buildClaudeMirrorRuntimePayload({
          workspaceRoot: session.workspaceRoot,
          model: session.model,
          importedFromClaude: true,
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
    existingMirror: ProviderThreadMirror | undefined,
  ) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
      if (Option.isNone(threadOption)) {
        return false;
      }

      const projectDir = resolveClaudeProjectDir(workspaceRoot);
      const indexFilePath = join(projectDir, "sessions-index.json");
      const sessionFilePath = join(projectDir, `${externalThreadId}.jsonl`);
      const exportArtifacts = buildClaudeExportArtifacts({
        thread: threadOption.value,
        workspaceRoot,
        externalThreadId,
        sessionFilePath,
      });
      if (!exportArtifacts) {
        return false;
      }

      yield* Effect.sync(() => {
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(sessionFilePath, exportArtifacts.sessionFileContents);
        const fileMtime = statSync(sessionFilePath).mtimeMs;
        writeClaudeSessionIndex(indexFilePath, workspaceRoot, {
          ...exportArtifacts.sessionIndexEntry,
          fileMtime,
        });
      });

      const thread = threadOption.value;
      const now = new Date().toISOString();
      yield* providerThreadMirrorRepository.upsert({
        threadId: thread.id,
        providerName: "claudeAgent",
        externalThreadId,
        lastSeenAt: thread.updatedAt,
        lastImportedAt: existingMirror?.lastImportedAt ?? null,
        lastExportedAt: now,
        resumeCursor: exportArtifacts.resumeCursor,
        runtimePayload: buildClaudeMirrorRuntimePayload({
          workspaceRoot,
          model: exportArtifacts.model,
          importedFromClaude: false,
          exportedFromT3: true,
        }),
        metadata: {
          source: existingMirror
            ? readMirrorSource(existingMirror) === "local-claude"
              ? "local-claude"
              : "t3-export"
            : "t3-export",
          title: thread.title,
          status: thread.session?.status ?? "idle",
        },
      });

      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to export T3 thread to Claude", {
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

      const projectsRoot = resolveClaudeProjectsRoot();
      const indexFiles = listClaudeSessionIndexFiles(projectsRoot);
      const nextIndexMtimes = new Map<string, number>();
      const nextSessionMtimes = new Map<string, number>();

      for (const indexFile of indexFiles) {
        nextIndexMtimes.set(indexFile, statSync(indexFile).mtimeMs);
        for (const entry of parseClaudeSessionIndex(indexFile)) {
          if (existsSync(entry.fullPath)) {
            nextSessionMtimes.set(entry.fullPath, statSync(entry.fullPath).mtimeMs);
          }
        }
      }

      const currentState = yield* Ref.get(syncState);
      const indexMtimesUnchanged =
        currentState.indexFileMtimes.size === nextIndexMtimes.size &&
        [...nextIndexMtimes.entries()].every(
          ([filePath, mtime]) => currentState.indexFileMtimes.get(filePath) === mtime,
        );
      const sessionMtimesUnchanged =
        currentState.sessionFileMtimes.size === nextSessionMtimes.size &&
        [...nextSessionMtimes.entries()].every(
          ([filePath, mtime]) => currentState.sessionFileMtimes.get(filePath) === mtime,
        );
      if (indexMtimesUnchanged && sessionMtimesUnchanged) {
        return false;
      }

      const mirrors = (yield* providerThreadMirrorRepository.list()).filter(
        (mirror) => mirror.providerName === "claudeAgent",
      );
      const mirrorsByThreadId = new Map(
        mirrors.map((mirror) => [mirror.threadId, mirror] as const),
      );
      const mirrorsByExternalThreadId = new Map(
        mirrors
          .filter((mirror) => typeof mirror.externalThreadId === "string")
          .map((mirror) => [mirror.externalThreadId as string, mirror] as const),
      );

      const importedSessions = loadClaudeSessions(projectsRoot);
      const importedChanged = yield* sql.withTransaction(
        Effect.gen(function* () {
          const importedResults = yield* Effect.forEach(importedSessions, (session) => {
            const existingMirror =
              mirrorsByExternalThreadId.get(session.externalThreadId) ??
              mirrorsByThreadId.get(session.threadId);
            if (!shouldImportClaudeSession(session.updatedAt, existingMirror)) {
              return Effect.succeed(false);
            }
            const canonicalThreadId = existingMirror?.threadId ?? session.threadId;
            return importSession(session, canonicalThreadId, existingMirror).pipe(Effect.as(true));
          });
          yield* reconcileWorkspaceProjectDuplicates();
          yield* Ref.set(syncState, {
            indexFileMtimes: nextIndexMtimes,
            sessionFileMtimes: nextSessionMtimes,
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

      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const projectsById = new Map(
        snapshot.projects.map((project) => [project.id, project] as const),
      );
      const mirrors = (yield* providerThreadMirrorRepository.list()).filter(
        (mirror) => mirror.providerName === "claudeAgent",
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

        const externalThreadId = existingMirror?.externalThreadId ?? randomUUID();
        return exportThread(thread.id, project.workspaceRoot, externalThreadId, existingMirror);
      });

      return results.some(Boolean);
    });

  const syncOnce = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const enabled = settings.providers.claudeAgent.enabled;
    const imported = yield* syncImports(enabled);
    yield* syncExports(enabled);
    return imported;
  });

  const refreshImportedReadModel = (engine: OrchestrationEngineShape) =>
    syncOnce.pipe(
      Effect.flatMap((changed) => (changed ? engine.refreshReadModel() : Effect.void)),
      Effect.catch((cause) =>
        Effect.logWarning("failed to import Claude sessions during startup", { cause }),
      ),
    );

  yield* refreshImportedReadModel(orchestrationEngine);

  yield* Effect.forkScoped(
    Effect.forever(
      syncOnce.pipe(
        Effect.flatMap((changed) =>
          changed ? orchestrationEngine.refreshReadModel().pipe(Effect.asVoid) : Effect.void,
        ),
        Effect.catch((cause) => Effect.logWarning("failed to sync Claude sessions", { cause })),
        Effect.andThen(Effect.sleep(SESSION_SYNC_INTERVAL)),
      ),
    ),
  );
});
