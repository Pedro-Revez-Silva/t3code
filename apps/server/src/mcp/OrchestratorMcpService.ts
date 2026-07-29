import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpGoalCreateInput,
  type OrchestratorMcpGoalListInput,
  type OrchestratorMcpGoalListResult,
  type OrchestratorMcpGoalReadInput,
  type OrchestratorMcpGoalResult,
  type OrchestratorMcpGoalTaskStartInput,
  type OrchestratorMcpGoalTaskStartResult,
  type OrchestratorMcpGoalCancelInput,
  type OrchestratorMcpProjectListResult,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRespondInput,
  type OrchestratorMcpThreadRespondResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadStartInput,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ProjectId,
  type ProjectExecutionProfile,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type SupervisorTaskAttempt,
  type SupervisorTaskAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isBuiltInProviderAdapterDriverV2 } from "../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { subagentResultForRun } from "../orchestration-v2/SubagentProjection.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import {
  isActiveRun,
  latestActiveRun,
  latestRun,
  ThreadManagementError,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type {
  RuntimeMutationAuthority,
  SupervisorMutationAuthority,
} from "../supervisor/SupervisorAuthority.ts";
import { SupervisorControlPlaneService } from "../supervisor/SupervisorControlPlaneService.ts";
import { SupervisorGoalCancellationService } from "../supervisor/SupervisorGoalCancellationService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_POLL_INTERVAL_MS = 50;
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
}

function executionProfileDefaults(
  input: Pick<OrchestratorMcpDelegateTaskInput, "target" | "runtimeMode" | "interactionMode">,
  profile: ProjectExecutionProfile | null,
) {
  return {
    target:
      input.target ??
      (profile?.modelSelection === null || profile?.modelSelection === undefined
        ? undefined
        : {
            providerInstanceId: profile.modelSelection.instanceId,
            model: profile.modelSelection.model,
            ...(profile.modelSelection.options === undefined
              ? {}
              : { options: profile.modelSelection.options }),
          }),
    runtimeMode: input.runtimeMode ?? profile?.runtimeMode ?? undefined,
    interactionMode: input.interactionMode ?? profile?.interactionMode ?? undefined,
  };
}

function delegatedTaskProviderInstanceId(
  task: OrchestrationV2ThreadProjection["subagents"][number],
) {
  return task.providerInstanceId;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
    authority?: SupervisorMutationAuthority,
    supervisorAttemptId?: SupervisorTaskAttemptId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
    authority?: SupervisorMutationAuthority,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly listProjects: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpProjectListResult, OrchestratorMcpFailure>;
  readonly startThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadStartInput,
  ) => Effect.Effect<OrchestratorMcpCreatedThread, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  readonly createGoal: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGoalCreateInput,
  ) => Effect.Effect<OrchestratorMcpGoalResult, OrchestratorMcpFailure>;
  readonly listGoals: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGoalListInput,
  ) => Effect.Effect<OrchestratorMcpGoalListResult, OrchestratorMcpFailure>;
  readonly readGoal: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGoalReadInput,
  ) => Effect.Effect<OrchestratorMcpGoalResult, OrchestratorMcpFailure>;
  readonly startGoalTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGoalTaskStartInput,
  ) => Effect.Effect<OrchestratorMcpGoalTaskStartResult, OrchestratorMcpFailure>;
  readonly cancelGoal: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGoalCancelInput,
  ) => Effect.Effect<OrchestratorMcpGoalResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly respondToThreadRequest: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadRespondInput,
  ) => Effect.Effect<OrchestratorMcpThreadRespondResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

const supervisorFailure = (error: { readonly message: string }) =>
  failure("orchestration_error", error.message);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Workspace strategy for a scheduled task created/updated over MCP: bound runs
 * post into the existing thread (the strategy is unused, keep root); unbound
 * runs launch a fresh worktree per run.
 */
function scheduledTaskWorkspaceStrategy(
  boundToThread: boolean,
): ScheduledTask["workspaceStrategy"] {
  return boundToThread
    ? { type: "root" }
    : { type: "worktree", baseRef: "main", startFromOrigin: true };
}

function scheduledTaskSummary(task: ScheduledTask): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
  };
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!provider.enabled) constraints.push("Provider instance is disabled.");
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * Checks requested option selections for duplicates and, when the model
 * advertises option descriptors, against those descriptors. Models without
 * descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always
 * fail: downstream consumers disagree on whether the first or last value of
 * a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run: OrchestrationV2Run | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run?.status) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return runtimeModeRank(resolved) > runtimeModeRank(parentMode)
    ? Effect.fail(
        failure(
          "runtime_mode_escalation_denied",
          `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        failure(
          "interaction_mode_escalation_denied",
          `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.threadId),
      ...(input.projectId === undefined ? [] : [stablePart(input.projectId)]),
      ...(input.threadId === undefined ? [] : [stablePart(input.threadId)]),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      stablePart(input.scope.threadId),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.threadId),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.threadId),
      ...(input.projectId === undefined ? [] : [stablePart(input.projectId)]),
      ...(input.threadId === undefined ? [] : [stablePart(input.threadId)]),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function supervisorAttemptDelegationCommandId(attemptId: SupervisorTaskAttemptId): CommandId {
  return CommandId.make(`command:supervisor-goal-attempt:${stablePart(attemptId)}:delegate-task`);
}

function activeCallerRunForScope(
  scope: McpInvocationScope,
  parent: OrchestrationV2ThreadProjection,
): OrchestrationV2Run | undefined {
  const activeRun = latestActiveRun(parent);
  const activeProviderThread =
    activeRun?.providerThreadId === null || activeRun?.providerThreadId === undefined
      ? undefined
      : parent.providerThreads.find((thread) => thread.id === activeRun.providerThreadId);
  return activeRun !== undefined &&
    activeRun.providerInstanceId === scope.providerInstanceId &&
    activeProviderThread?.providerSessionId === scope.runtimeProviderSessionId
    ? activeRun
    : undefined;
}

function supervisorMutationAuthority(scope: McpInvocationScope): SupervisorMutationAuthority {
  return {
    threadId: scope.threadId,
    runtimeProviderSessionId: scope.runtimeProviderSessionId,
    providerInstanceId: scope.providerInstanceId,
    runtimeGeneration: scope.runtimeGeneration ?? 0,
  };
}

function runtimeMutationAuthority(scope: McpInvocationScope): RuntimeMutationAuthority {
  return supervisorMutationAuthority(scope);
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

function listItemFromShell(shell: OrchestrationV2ThreadShell): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    title: shell.title,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(projection: OrchestrationV2ThreadProjection): OrchestratorMcpThreadDetail {
  const latest = latestRun(projection);
  const active = latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount: projection.visibleTurnItems.length,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return item.prompt ?? item.requestKind;
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const textTruncated = text !== null && text.length > input.maxChars;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    runId: input.row.item.runId,
    messageId,
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: textTruncated ? `${text.slice(0, input.maxChars)}\n…[truncated]` : text,
    textTruncated,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

function pendingRequests(
  projection: OrchestrationV2ThreadProjection,
): OrchestratorMcpThreadReadResult["pendingRequests"] {
  return projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .map((request) => {
      const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
      const items = projection.turnItems.filter(
        (candidate) =>
          (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
          candidate.requestId === request.id,
      );
      const item = items.length === 1 ? items[0] : undefined;
      return {
        requestId: request.id,
        kind: request.kind,
        status: request.status,
        respondable:
          request.responseCapability.type === "live" &&
          request.responseCommandId === undefined &&
          item !== undefined,
        notResumableReason:
          request.responseCapability.type === "not_resumable"
            ? request.responseCapability.reason
            : null,
        runId: node?.runId ?? null,
        nodeId: request.nodeId,
        approvalPrompt: item?.type === "approval_request" ? (item.prompt ?? null) : null,
        approvalRequestKind: item?.type === "approval_request" ? item.requestKind : null,
        questions: item?.type === "user_input_request" ? item.questions : null,
      };
    });
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService;
  const providerRegistry = yield* ProviderRegistry;
  const projectService = yield* ProjectService;
  const scheduledTasks = yield* ScheduledTaskService;
  const supervisor = yield* SupervisorControlPlaneService;
  const supervisorCancellation = yield* SupervisorGoalCancellationService;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const requireGlobalOrchestration = (scope: McpInvocationScope) =>
    supervisor.isDesignatedSupervisor(scope.threadId).pipe(
      Effect.mapError((error) => failure("orchestration_error", error.message)),
      Effect.flatMap((designated) =>
        designated
          ? Effect.void
          : Effect.fail(
              failure(
                "capability_denied",
                "This thread is not the current persisted global supervisor.",
              ),
            ),
      ),
    );

  const requireActiveCallerRun = (
    scope: McpInvocationScope,
    parent: OrchestrationV2ThreadProjection,
  ) => {
    const activeRun = activeCallerRunForScope(scope, parent);
    return activeRun !== undefined
      ? Effect.succeed(activeRun)
      : Effect.fail(
          failure(
            "parent_not_active",
            "Global orchestration requires an active caller run owned by this MCP provider session.",
          ),
        );
  };

  const requireActiveGlobalOrchestration = (
    scope: McpInvocationScope,
    parent: OrchestrationV2ThreadProjection,
  ) =>
    Effect.gen(function* () {
      yield* requireGlobalOrchestration(scope);
      yield* requireActiveCallerRun(scope, parent);
    });

  const revalidateGlobalMutation = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      const currentParent = yield* loadProjection(scope.threadId);
      yield* requireActiveGlobalOrchestration(scope, currentParent);
      return currentParent;
    });

  const loadProjection = (threadId: ThreadId) =>
    threadManagement
      .getThreadProjection(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ): Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorMcpFailure> =>
    threadManagement
      .getProjectThread({ projectId, threadId })
      .pipe(
        Effect.mapError(() =>
          failure("thread_not_found", `Thread ${threadId} was not found in the selected project.`),
        ),
      );

  const resolveSelectedProjectId = (
    scope: McpInvocationScope,
    parent: OrchestrationV2ThreadProjection,
    requestedProjectId: ProjectId | undefined,
  ): Effect.Effect<ProjectId, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const parentProjectId = parent.thread.projectId;
      if (requestedProjectId === undefined || requestedProjectId === parentProjectId) {
        return parentProjectId;
      }
      yield* requireActiveGlobalOrchestration(scope, parent);
      const snapshot = yield* projectService.snapshot.pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Unable to list projects: ${errorMessage(error)}`),
        ),
      );
      if (!snapshot.projects.some((project) => project.id === requestedProjectId)) {
        return yield* failure("project_not_found", `Project ${requestedProjectId} was not found.`);
      }
      return requestedProjectId;
    });

  const loadScopedThread = (
    scope: McpInvocationScope,
    threadId: ThreadId,
    requestedProjectId?: ProjectId,
  ) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const parent = yield* loadProjection(scope.threadId);
      const projectId = yield* resolveSelectedProjectId(scope, parent, requestedProjectId);
      const target =
        threadId === scope.threadId && projectId === parent.thread.projectId
          ? parent
          : yield* loadProjectThread(projectId, threadId);
      return { parent, projectId, target } as const;
    });

  const loadProviders = providerRegistry.getProviders;

  const resolveTarget = (input: {
    readonly parent: OrchestrationV2ThreadProjection;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
  }): Effect.Effect<ResolvedTarget, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const requestedInstanceId = input.target?.providerInstanceId;
      const requestedDriver = input.target?.driverKind;
      let instanceId = requestedInstanceId;

      if (instanceId === undefined && requestedDriver !== undefined) {
        const candidates = input.providers.filter(
          (provider) =>
            provider.driver === requestedDriver &&
            isBuiltInProviderAdapterDriverV2(provider.driver),
        );
        if (candidates.length === 0) {
          return yield* failure(
            "provider_unavailable",
            `No V2 provider adapter is registered for driver ${requestedDriver}.`,
          );
        }
        const inheritedCandidate = candidates.find(
          (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
        );
        const availableCandidate = candidates.find((candidate) => {
          return (
            providerConstraints(candidate, isBuiltInProviderAdapterDriverV2(candidate.driver))
              .length === 0
          );
        });
        instanceId = inheritedCandidate?.instanceId ?? availableCandidate?.instanceId;
      }
      instanceId ??= input.parent.thread.modelSelection.instanceId;

      const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${instanceId} is not registered.`,
        );
      }
      if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
        return yield* failure(
          "invalid_request",
          `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
        );
      }
      const constraints = providerConstraints(
        provider,
        isBuiltInProviderAdapterDriverV2(provider.driver),
      );
      if (constraints.length > 0) {
        return yield* failure(
          "provider_unavailable",
          `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
        );
      }

      const inheritedSelection = input.parent.thread.modelSelection;
      const requestedModel = input.target?.model;
      const model =
        requestedModel ??
        (instanceId === inheritedSelection.instanceId
          ? inheritedSelection.model
          : provider?.models[0]?.slug);
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Provider ${instanceId} has no model available for inheritance.`,
        );
      }
      if (
        requestedModel !== undefined &&
        provider !== undefined &&
        provider.models.length > 0 &&
        !provider.models.some((candidate) => candidate.slug === requestedModel)
      ) {
        return yield* failure(
          "model_unavailable",
          `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
        );
      }

      const requestedOptions = input.target?.options;
      if (requestedOptions !== undefined) {
        const descriptors = provider.models.find((candidate) => candidate.slug === model)
          ?.capabilities?.optionDescriptors;
        const invalid = invalidOptionSelections(requestedOptions, descriptors);
        if (invalid.length > 0) {
          return yield* failure(
            "invalid_request",
            `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
          );
        }
      }

      return {
        modelSelection:
          instanceId === inheritedSelection.instanceId &&
          model === inheritedSelection.model &&
          requestedOptions === undefined
            ? inheritedSelection
            : requestedOptions === undefined
              ? { instanceId, model }
              : { instanceId, model, options: requestedOptions },
      };
    });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4.pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTask = (
    scope: McpInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
  ): Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const parentProjection = yield* loadProjection(scope.threadId);
      const task = parentProjection.subagents.find(
        (candidate) =>
          candidate.id === taskId &&
          candidate.origin === "app_owned" &&
          candidate.threadId === scope.threadId,
      );
      if (task === undefined || task.childThreadId === null) {
        return yield* failure(
          "task_not_found",
          `Delegated task ${taskId} does not belong to thread ${scope.threadId}.`,
        );
      }
      const childProjection = yield* loadProjection(task.childThreadId);
      if (childProjection.thread.projectId !== parentProjection.thread.projectId) {
        yield* requireActiveGlobalOrchestration(scope, parentProjection);
      }
      const childRun = childProjection.runs[0];
      const status = taskStatusForRun(childRun);
      const derivedResult =
        task.result !== null
          ? task.result
          : childRun !== undefined && isTerminalTaskStatus(status)
            ? subagentResultForRun(childProjection, childRun).text
            : null;
      const resultTransfer =
        parentProjection.contextTransfers.find(
          (transfer) =>
            transfer.type === "subagent_result" &&
            transfer.sourceThreadId === task.childThreadId &&
            transfer.targetThreadId === scope.threadId,
        ) ?? null;
      return {
        taskId: task.id,
        childThreadId: task.childThreadId,
        childRunId: childRun?.id ?? null,
        childNodeId: task.id,
        status,
        providerInstanceId: delegatedTaskProviderInstanceId(task),
        model: task.model,
        summary: derivedResult,
        resultContextTransferId: resultTransfer?.id ?? null,
        waitTimedOut,
      };
    });

  const readLinkedGoalAttempt = (
    attempt: SupervisorTaskAttempt,
  ): Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      if (attempt.nodeId === null || attempt.threadId === null) {
        return yield* failure(
          "orchestration_error",
          `Supervisor attempt ${attempt.id} is not linked to delegated work.`,
        );
      }
      const childProjection = yield* loadProjection(attempt.threadId);
      const parentThreadId = childProjection.thread.lineage.parentThreadId;
      if (parentThreadId === null) {
        return yield* failure(
          "orchestration_error",
          `Supervisor attempt ${attempt.id} has no delegated parent thread.`,
        );
      }
      const parentProjection = yield* loadProjection(parentThreadId);
      const task = parentProjection.subagents.find(
        (candidate) =>
          candidate.id === attempt.nodeId &&
          candidate.origin === "app_owned" &&
          candidate.childThreadId === attempt.threadId,
      );
      if (task === undefined) {
        return yield* failure(
          "orchestration_error",
          `Supervisor attempt ${attempt.id} is linked to missing delegated task ${attempt.nodeId}.`,
        );
      }
      const childRun = childProjection.runs[0];
      const status = taskStatusForRun(childRun);
      const derivedResult =
        task.result !== null
          ? task.result
          : childRun !== undefined && isTerminalTaskStatus(status)
            ? subagentResultForRun(childProjection, childRun).text
            : null;
      const resultTransfer =
        parentProjection.contextTransfers.find(
          (transfer) =>
            transfer.type === "subagent_result" &&
            transfer.sourceThreadId === task.childThreadId &&
            transfer.targetThreadId === parentThreadId,
        ) ?? null;
      return {
        taskId: task.id,
        childThreadId: task.childThreadId!,
        childRunId: childRun?.id ?? null,
        childNodeId: task.id,
        status,
        providerInstanceId: delegatedTaskProviderInstanceId(task),
        model: task.model,
        summary: derivedResult,
        resultContextTransferId: resultTransfer?.id ?? null,
        waitTimedOut: false,
      };
    });

  const waitForTask = (scope: McpInvocationScope, taskId: NodeId, timeoutMs: number) =>
    Effect.gen(function* () {
      while (true) {
        const result = yield* readTask(scope, taskId);
        if (isTerminalTaskStatus(result.status)) return result;
        yield* Effect.sleep(Duration.millis(TASK_POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.succeed(null),
      }),
    );

  // Load a single scheduled task and enforce that it belongs to the calling
  // thread's project, so agents can only read/mutate tasks in their own scope.
  const loadScopedScheduledTask = (
    projectId: ScheduledTask["projectId"],
    scheduledTaskId: ScheduledTask["id"],
  ): Effect.Effect<ScheduledTask, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const { tasks } = yield* scheduledTasks
        .list()
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
          ),
        );
      const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
      if (task === undefined || task.projectId !== projectId) {
        return yield* failure(
          "task_not_found",
          `Scheduled task ${scheduledTaskId} was not found in the calling project.`,
        );
      }
      return task;
    });

  const service = OrchestratorMcpService.of({
    createGoal: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadProjection(scope.threadId);
        yield* requireActiveGlobalOrchestration(scope, parent);
        yield* revalidateGlobalMutation(scope);
        return yield* supervisor
          .updateGoal(input, supervisorMutationAuthority(scope))
          .pipe(Effect.mapError(supervisorFailure));
      }),
    listGoals: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadProjection(scope.threadId);
        yield* requireActiveGlobalOrchestration(scope, parent);
        return yield* supervisor.listGoals(input).pipe(Effect.mapError(supervisorFailure));
      }),
    readGoal: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadProjection(scope.threadId);
        yield* requireActiveGlobalOrchestration(scope, parent);
        let goal = (yield* supervisor
          .readGoal(input.goalId)
          .pipe(Effect.mapError(supervisorFailure))).goal;
        for (const task of goal.tasks) {
          const attempt = task.attempts.findLast((candidate) => candidate.nodeId !== null);
          if (attempt?.nodeId === null || attempt?.nodeId === undefined) continue;
          const delegated = yield* readLinkedGoalAttempt(attempt).pipe(Effect.option);
          if (delegated._tag === "None") continue;
          const status = delegated.value.status;
          const attemptStatus =
            status === "completed" ||
            status === "failed" ||
            status === "cancelled" ||
            status === "interrupted"
              ? status
              : status === "queued"
                ? "delegated"
                : "running";
          if (attemptStatus !== attempt.status) {
            yield* revalidateGlobalMutation(scope);
            yield* supervisor
              .updateAttemptStatus(
                { attemptId: attempt.id, status: attemptStatus },
                supervisorMutationAuthority(scope),
              )
              .pipe(Effect.mapError(supervisorFailure));
          }
        }
        goal = (yield* supervisor.readGoal(input.goalId).pipe(Effect.mapError(supervisorFailure)))
          .goal;
        return { goal };
      }),
    startGoalTask: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadProjection(scope.threadId);
        yield* requireActiveGlobalOrchestration(scope, parent);
        const goal = (yield* supervisor
          .readGoal(input.goalId)
          .pipe(Effect.mapError(supervisorFailure))).goal;
        const task = goal.tasks.find((candidate) => candidate.taskKey === input.taskKey);
        if (task === undefined) {
          return yield* failure("task_not_found", `Goal task ${input.taskKey} was not found.`);
        }
        yield* resolveSelectedProjectId(scope, parent, task.projectId);
        const profile = yield* supervisor
          .getProfile(task.projectId)
          .pipe(Effect.mapError(supervisorFailure));
        const providers = yield* loadProviders;
        const resolvedTarget = yield* resolveTarget({
          parent,
          target:
            profile?.modelSelection === null || profile?.modelSelection === undefined
              ? undefined
              : {
                  providerInstanceId: profile.modelSelection.instanceId,
                  model: profile.modelSelection.model,
                  ...(profile.modelSelection.options === undefined
                    ? {}
                    : { options: profile.modelSelection.options }),
                },
          providers,
        });
        const runtimeMode = yield* resolveRuntimeMode(
          parent.thread.runtimeMode,
          profile?.runtimeMode ?? undefined,
        );
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          profile?.interactionMode ?? undefined,
        );
        yield* revalidateGlobalMutation(scope);
        const prepared = yield* supervisor
          .prepareAttempt(
            {
              goalId: input.goalId,
              taskKey: input.taskKey,
              modelSelection: resolvedTarget.modelSelection,
              runtimeMode,
              interactionMode,
            },
            supervisorMutationAuthority(scope),
          )
          .pipe(Effect.mapError(supervisorFailure));
        const existing =
          prepared.attempt.nodeId === null ? null : yield* readLinkedGoalAttempt(prepared.attempt);
        const delegatedTask =
          existing ??
          (yield* service.delegateTask(
            scope,
            {
              projectId: task.projectId,
              task: task.prompt,
              title: task.title,
              role: task.role,
              mode: "async",
              clientRequestId: prepared.attempt.clientRequestId,
              target: {
                providerInstanceId: prepared.attempt.modelSelection.instanceId,
                model: prepared.attempt.modelSelection.model,
                ...(prepared.attempt.modelSelection.options === undefined
                  ? {}
                  : { options: prepared.attempt.modelSelection.options }),
              },
              runtimeMode: prepared.attempt.runtimeMode,
              interactionMode: prepared.attempt.interactionMode,
            },
            supervisorMutationAuthority(scope),
            prepared.attempt.id,
          ));
        if (prepared.attempt.nodeId === null) {
          yield* supervisor
            .linkAttempt(
              {
                attemptId: prepared.attempt.id,
                nodeId: delegatedTask.taskId,
                threadId: delegatedTask.childThreadId,
                runId: delegatedTask.childRunId,
              },
              supervisorMutationAuthority(scope),
            )
            .pipe(Effect.mapError(supervisorFailure));
        }
        if (
          delegatedTask.status === "completed" ||
          delegatedTask.status === "failed" ||
          delegatedTask.status === "cancelled" ||
          delegatedTask.status === "interrupted"
        ) {
          yield* revalidateGlobalMutation(scope);
          yield* supervisor
            .reconcileAttemptByNodeId(
              {
                nodeId: delegatedTask.taskId,
                status: delegatedTask.status,
              },
              supervisorMutationAuthority(scope),
            )
            .pipe(Effect.mapError(supervisorFailure));
        }
        const updated = (yield* supervisor
          .readGoal(input.goalId)
          .pipe(Effect.mapError(supervisorFailure))).goal;
        return {
          goal: updated,
          taskKey: input.taskKey,
          attemptId: prepared.attempt.id,
          delegatedTask,
        };
      }),
    cancelGoal: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadProjection(scope.threadId);
        yield* requireActiveGlobalOrchestration(scope, parent);
        yield* revalidateGlobalMutation(scope);
        return yield* supervisorCancellation
          .cancelGoal(input, supervisorMutationAuthority(scope))
          .pipe(Effect.mapError(supervisorFailure));
      }),
    scheduleTask: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const bindToCurrentThread = input.bindToCurrentThread ?? true;
        const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
        const title =
          input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
        const upsertInput: ScheduledTaskUpsertInput = {
          title,
          prompt: input.prompt,
          enabled: input.enabled ?? true,
          schedule: input.schedule,
          projectId: parent.thread.projectId,
          threadId: bindToCurrentThread ? scope.threadId : null,
          workspaceStrategy: scheduledTaskWorkspaceStrategy(bindToCurrentThread),
          modelSelection: parent.thread.modelSelection,
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
          createdBy: "agent",
          creationSource: "mcp",
          // Scope the idempotency key by caller thread so retries survive MCP
          // credential rotation without colliding across callers.
          ...(input.clientRequestId === undefined
            ? {}
            : {
                commandId: stableCommandId({
                  scope,
                  requestKey: input.clientRequestId,
                  operation: "schedule-task",
                }),
              }),
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput, runtimeMutationAuthority(scope))
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not schedule task: ${error.message}`),
            ),
          );
        return scheduledTaskSummary(task);
      }),
    listScheduledTasks: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        // Only expose tasks belonging to the calling thread's project.
        return {
          tasks: tasks
            .filter((task) => task.projectId === parent.thread.projectId)
            .map(scheduledTaskSummary),
        };
      }),
    updateScheduledTask: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const existing = yield* loadScopedScheduledTask(
          parent.thread.projectId,
          input.scheduledTaskId,
        );
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread
              ? scope.threadId
              : null;
        // Rebinding changes where runs execute, so the workspace strategy must
        // follow: unbinding a root-strategy task would otherwise run loose
        // prompts in the shared project checkout.
        const workspaceStrategy =
          input.bindToCurrentThread === undefined
            ? existing.workspaceStrategy
            : scheduledTaskWorkspaceStrategy(input.bindToCurrentThread);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput, runtimeMutationAuthority(scope))
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
            ),
          );
        return scheduledTaskSummary(task);
      }),
    deleteScheduledTask: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const existing = yield* loadScopedScheduledTask(
          parent.thread.projectId,
          input.scheduledTaskId,
        );
        yield* scheduledTasks
          .delete({ id: existing.id }, runtimeMutationAuthority(scope))
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      }),
    capabilities: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const providers = yield* loadProviders;
        return {
          parentThreadId: scope.threadId,
          inheritedProviderInstanceId: parent.thread.modelSelection.instanceId,
          inheritedModel: parent.thread.modelSelection.model,
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
          providers: providers.map((provider) => {
            const constraints = providerConstraints(
              provider,
              isBuiltInProviderAdapterDriverV2(provider.driver),
            );
            return {
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider?.displayName ?? null,
              models:
                provider?.models.map((model) => ({
                  id: model.slug,
                  label: model.name ?? null,
                  ...(model.capabilities?.optionDescriptors === undefined
                    ? {}
                    : { options: model.capabilities.optionDescriptors }),
                })) ?? [],
              canRunChildTask: constraints.length === 0,
              canRunCrossProviderChildTask: constraints.length === 0,
              constraints: [...constraints],
            };
          }),
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: true,
            threadManagement: true,
            incrementalThreadRead: true,
            scheduledTasks: true,
            globalProjectSupervision: yield* supervisor
              .isDesignatedSupervisor(scope.threadId)
              .pipe(Effect.mapError((error) => failure("orchestration_error", error.message))),
            maxBatchThreads: 20,
          },
        };
      }),
    delegateTask: (scope, input, requiredAuthority, supervisorAttemptId) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const parentRun = parent.runs
          .filter(isActiveRun)
          .toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Delegated tasks require an active run owned by this MCP provider session.",
          );
        }
        const projectId = yield* resolveSelectedProjectId(scope, parent, input.projectId);
        const profile = yield* supervisor
          .getProfile(projectId)
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        const defaults = executionProfileDefaults(input, profile);
        const providers = yield* loadProviders;
        const target = yield* resolveTarget({
          parent,
          target: defaults.target,
          providers,
        });
        const runtimeMode = yield* resolveRuntimeMode(
          parent.thread.runtimeMode,
          defaults.runtimeMode,
        );
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          defaults.interactionMode,
        );
        const key = yield* requestKey(input.clientRequestId);
        const commandId =
          supervisorAttemptId === undefined
            ? stableCommandId({
                scope,
                requestKey: key,
                operation: "delegate-task",
                projectId,
              })
            : supervisorAttemptDelegationCommandId(supervisorAttemptId);
        const authority =
          requiredAuthority ??
          (projectId === parent.thread.projectId ? undefined : supervisorMutationAuthority(scope));
        if (authority !== undefined) {
          yield* revalidateGlobalMutation(scope);
        }
        const result = yield* threadManagement
          .dispatch(
            {
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId,
              parentThreadId: scope.threadId,
              parentRunId: parentRun.id,
              parentNodeId: parentRun.rootNodeId,
              task: taskPrompt(input),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(projectId === parent.thread.projectId ? {} : { targetProjectId: projectId }),
              modelSelection: target.modelSelection,
              runtimeMode,
              interactionMode,
            },
            {
              runtimeAuthority: runtimeMutationAuthority(scope),
              ...(authority === undefined ? {} : { supervisorAuthority: authority }),
              ...(supervisorAttemptId === undefined ? {} : { supervisorAttemptId }),
            },
          )
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to create delegated task: ${errorMessage(error)}`,
              ),
            ),
          );
        const taskEvent = result.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
        );
        if (taskEvent?.event.type !== "subagent.updated") {
          return yield* failure(
            "orchestration_error",
            "Delegated task command did not produce a task projection.",
          );
        }

        if (input.mode !== "wait") {
          return yield* readTask(scope, taskEvent.event.payload.id);
        }
        const timeoutMs = Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        );
        const response =
          (yield* waitForTask(scope, taskEvent.event.payload.id, timeoutMs)) ??
          (yield* readTask(scope, taskEvent.event.payload.id, true));
        return response;
      }),
    taskStatus: (scope, taskId) => readTask(scope, taskId),
    cancelTask: (scope, input, requiredAuthority) =>
      Effect.gen(function* () {
        const current = yield* readTask(scope, input.taskId);
        if (isTerminalTaskStatus(current.status)) {
          return {
            taskId: input.taskId,
            status: current.status,
          } satisfies OrchestratorMcpTaskCancelResult;
        }
        const child = yield* loadProjection(current.childThreadId);
        const activeRun = child.runs.find(isActiveRun);
        if (activeRun === undefined) {
          return yield* failure(
            "task_not_cancellable",
            `Delegated task ${input.taskId} has no interruptible child run.`,
          );
        }
        const key = yield* requestKey(input.clientRequestId);
        const currentParent = yield* loadProjection(scope.threadId);
        const authority =
          requiredAuthority ??
          (child.thread.projectId === currentParent.thread.projectId
            ? undefined
            : supervisorMutationAuthority(scope));
        if (authority !== undefined) {
          yield* revalidateGlobalMutation(scope);
        }
        yield* threadManagement
          .dispatch(
            {
              type: "run.interrupt",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: "cancel-task",
              }),
              threadId: current.childThreadId,
              runId: activeRun.id,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
            {
              runtimeAuthority: runtimeMutationAuthority(scope),
              ...(authority === undefined ? {} : { supervisorAuthority: authority }),
            },
          )
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Unable to interrupt delegated task ${input.taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
        return {
          taskId: input.taskId,
          status: "cancel_requested",
        };
      }),
    createThreads: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const parentRun = latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const target = yield* resolveTarget({
                parent,
                target: request.target,
                providers,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* threadManagement
                .dispatch(
                  {
                    type: "thread.create",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "create-thread",
                      index,
                    }),
                    threadId,
                    projectId: parent.thread.projectId,
                    title,
                    modelSelection: target.modelSelection,
                    runtimeMode,
                    interactionMode,
                    branch: parent.thread.branch,
                    worktreePath: parent.thread.worktreePath,
                  },
                  { runtimeAuthority: runtimeMutationAuthority(scope) },
                )
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              if (request.prompt !== undefined) {
                yield* threadManagement
                  .dispatch(
                    {
                      type: "message.dispatch",
                      createdBy: "agent",
                      creationSource: "mcp",
                      commandId: stableCommandId({
                        scope,
                        requestKey: key,
                        operation: "dispatch-thread",
                        index,
                      }),
                      threadId,
                      messageId: stableMessageId({
                        scope,
                        requestKey: key,
                        index,
                      }),
                      text: request.prompt,
                      attachments: [],
                      modelSelection: target.modelSelection,
                      dispatchMode: { type: "start_immediately" },
                    },
                    { runtimeAuthority: runtimeMutationAuthority(scope) },
                  )
                  .pipe(
                    Effect.mapError((error) =>
                      failure(
                        "orchestration_error",
                        `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                      ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.at(-1);
              yield* threadManagement
                .dispatch(
                  {
                    type: "thread.created.record",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "record-created-thread",
                      index,
                    }),
                    parentThreadId: scope.threadId,
                    parentRunId: parentRun.id,
                    parentNodeId,
                    targetThreadId: threadId,
                    targetRunId: run?.id ?? null,
                  },
                  { runtimeAuthority: runtimeMutationAuthority(scope) },
                )
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: target.modelSelection.instanceId,
                model: target.modelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      }),
    listProjects: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        yield* requireActiveGlobalOrchestration(scope, parent);
        const snapshot = yield* projectService.snapshot.pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to list projects: ${errorMessage(error)}`),
          ),
        );
        return {
          currentProjectId: parent.thread.projectId,
          projects: snapshot.projects.map((project) => ({
            projectId: project.id,
            title: project.title,
          })),
        } satisfies OrchestratorMcpProjectListResult;
      }),
    startThread: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const projectId = yield* resolveSelectedProjectId(scope, parent, input.projectId);
        if (projectId === parent.thread.projectId) {
          const createInput: OrchestratorMcpCreateThreadsInput = {
            ...(input.clientRequestId === undefined
              ? {}
              : { clientRequestId: input.clientRequestId }),
            threads: [
              {
                prompt: input.prompt,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.target === undefined ? {} : { target: input.target }),
                ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
                ...(input.interactionMode === undefined
                  ? {}
                  : { interactionMode: input.interactionMode }),
              },
            ],
          };
          const result = yield* service.createThreads(scope, createInput);
          return result.threads[0]!;
        }

        const parentRun = latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const providers = yield* loadProviders;
        const target = yield* resolveTarget({ parent, target: input.target, providers });
        const runtimeMode = yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode);
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          input.interactionMode,
        );
        const key = yield* requestKey(input.clientRequestId);
        yield* revalidateGlobalMutation(scope);
        const launch = yield* threadLaunch
          .launch({
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "start-thread",
              projectId,
            }),
            projectId,
            title: threadTitle({
              parentTitle: parent.thread.title,
              prompt: input.prompt,
              title: input.title,
              index: 0,
            }),
            modelSelection: target.modelSelection,
            runtimeMode,
            interactionMode,
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: stableOperationMessageId({
                scope,
                requestKey: key,
                operation: "start-thread",
                projectId,
              }),
              text: input.prompt,
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "mcp",
            dispatchOptions: {
              runtimeAuthority: runtimeMutationAuthority(scope),
              supervisorAuthority: supervisorMutationAuthority(scope),
            },
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to start thread in project ${projectId}: ${errorMessage(error)}`,
              ),
            ),
          );
        const run = latestRun(launch.projection);
        return {
          threadId: launch.threadId,
          runId: run?.id ?? null,
          status: run?.status ?? "idle",
          title: launch.projection.thread.title,
          createdBy: launch.projection.thread.createdBy,
          creationSource: launch.projection.thread.creationSource,
          providerInstanceId: target.modelSelection.instanceId,
          model: target.modelSelection.model,
        } satisfies OrchestratorMcpCreatedThread;
      }),
    listThreads: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const projectId = yield* resolveSelectedProjectId(scope, parent, input.projectId);
        const projectThreads = yield* threadManagement
          .listProjectThreads({
            projectId,
            includeSubagents: input.includeSubagents !== false,
          })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
            ),
          );
        const statuses = input.statuses === undefined ? null : new Set(input.statuses);
        const titleContains = input.titleContains?.toLocaleLowerCase();
        const filtered = projectThreads
          .filter((thread) => statuses === null || statuses.has(thread.status))
          .filter(
            (thread) =>
              titleContains === undefined ||
              thread.title.toLocaleLowerCase().includes(titleContains),
          );
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
        const page = filtered.slice(cursor, cursor + limit);
        const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
        return {
          projectId,
          currentThreadId: scope.threadId,
          threads: page.map(listItemFromShell),
          nextCursor,
          total: filtered.length,
        } satisfies OrchestratorMcpThreadListResult;
      }),
    readThread: (scope, input) =>
      Effect.gen(function* () {
        const { target } = yield* loadScopedThread(scope, input.threadId, input.projectId);
        const view = input.view ?? "messages";
        const afterPosition = input.afterPosition ?? -1;
        const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
        const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
        const matching = target.visibleTurnItems
          .filter((row) => row.position > afterPosition)
          .filter(
            (row) =>
              view === "activity" ||
              row.item.type === "user_message" ||
              row.item.type === "assistant_message" ||
              row.item.type === "proposed_plan",
          );
        const page = matching.slice(0, limit);
        const sourceThreadIds = [
          ...new Set(
            page
              .filter(
                (row) => row.item.type === "user_message" || row.item.type === "assistant_message",
              )
              .map((row) => row.sourceThreadId)
              .filter((threadId) => threadId !== target.thread.id),
          ),
        ];
        const sourceProjections = yield* Effect.forEach(
          sourceThreadIds,
          (sourceThreadId) => loadProjectThread(target.thread.projectId, sourceThreadId),
          { concurrency: 8 },
        );
        const messagesByThreadId = new Map<ThreadId, OrchestrationV2ThreadProjection["messages"]>([
          [target.thread.id, target.messages],
          ...sourceProjections.map(
            (projection) => [projection.thread.id, projection.messages] as const,
          ),
        ]);
        return {
          thread: threadDetail(target),
          recentRuns: target.runs
            .toSorted((left, right) => right.ordinal - left.ordinal)
            .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
            .map(threadRun),
          pendingRequests: pendingRequests(target),
          items: page.map((row) => timelineItem({ row, maxChars, messagesByThreadId })),
          nextPosition: page.at(-1)?.position ?? null,
          hasMore: page.length < matching.length,
        } satisfies OrchestratorMcpThreadReadResult;
      }),
    respondToThreadRequest: (scope, input) =>
      Effect.gen(function* () {
        const { parent, projectId, target } = yield* loadScopedThread(
          scope,
          input.threadId,
          input.projectId,
        );
        yield* resolveRuntimeMode(parent.thread.runtimeMode, target.thread.runtimeMode);
        yield* resolveInteractionMode(parent.thread.interactionMode, target.thread.interactionMode);
        const request = target.runtimeRequests.find(
          (candidate) => candidate.id === input.requestId,
        );
        if (request === undefined) {
          return yield* failure(
            "invalid_request",
            `Runtime request ${input.requestId} was not found in thread ${input.threadId}.`,
          );
        }
        const requestItems = target.turnItems.filter(
          (item) =>
            (item.type === "approval_request" || item.type === "user_input_request") &&
            item.requestId === input.requestId,
        );
        if (requestItems.length !== 1) {
          return yield* failure(
            "invalid_request",
            `Runtime request ${input.requestId} does not have one unambiguous request item.`,
          );
        }
        const requestItem = requestItems[0]!;
        const hasDecision = input.decision !== undefined;
        const hasAnswers = input.answers !== undefined;
        if (requestItem.type === "approval_request" && (!hasDecision || hasAnswers)) {
          return yield* failure(
            "invalid_request",
            `Approval request ${input.requestId} requires decision and does not accept answers.`,
          );
        }
        if (requestItem.type === "user_input_request" && (!hasAnswers || hasDecision)) {
          return yield* failure(
            "invalid_request",
            `User-input request ${input.requestId} requires answers and does not accept decision.`,
          );
        }
        if (request.status === "pending" && request.responseCapability.type !== "live") {
          return yield* failure("invalid_request", request.responseCapability.reason);
        }

        const key = yield* requestKey(input.clientRequestId);
        if (projectId !== parent.thread.projectId) {
          yield* revalidateGlobalMutation(scope);
        }
        yield* threadManagement
          .dispatch(
            {
              type: "runtime-request.respond",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `thread-respond:${input.requestId}:attempt:${request.responseAttempt ?? 0}`,
                projectId,
                threadId: input.threadId,
              }),
              threadId: input.threadId,
              requestId: input.requestId,
              ...(input.decision === undefined ? {} : { decision: input.decision }),
              ...(input.answers === undefined ? {} : { answers: input.answers }),
            },
            {
              runtimeAuthority: runtimeMutationAuthority(scope),
              ...(projectId === parent.thread.projectId
                ? {}
                : { supervisorAuthority: supervisorMutationAuthority(scope) }),
            },
          )
          .pipe(
            Effect.mapError((error) =>
              failure(
                "invalid_request",
                `Unable to respond to runtime request ${input.requestId}: ${errorMessage(error)}`,
              ),
            ),
          );
        return {
          threadId: input.threadId,
          requestId: input.requestId,
          status: "accepted_for_delivery",
        } satisfies OrchestratorMcpThreadRespondResult;
      }),
    sendToThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, projectId, target } = yield* loadScopedThread(
          scope,
          input.threadId,
          input.projectId,
        );
        yield* resolveRuntimeMode(parent.thread.runtimeMode, target.thread.runtimeMode);
        yield* resolveInteractionMode(parent.thread.interactionMode, target.thread.interactionMode);

        const mode = input.mode ?? "auto";
        const key = yield* requestKey(input.clientRequestId);
        const messageId = stableOperationMessageId({
          scope,
          requestKey: key,
          operation: "thread-send",
          projectId,
          threadId: input.threadId,
        });
        if (projectId !== parent.thread.projectId) {
          yield* revalidateGlobalMutation(scope);
        }
        const result = yield* threadManagement
          .sendToThread({
            projectId,
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "thread-send",
              projectId,
              threadId: input.threadId,
            }),
            threadId: input.threadId,
            messageId,
            text: input.message,
            attachments: [],
            mode,
            createdBy: "agent",
            creationSource: "mcp",
            dispatchOptions: {
              runtimeAuthority: runtimeMutationAuthority(scope),
              ...(projectId === parent.thread.projectId
                ? {}
                : { supervisorAuthority: supervisorMutationAuthority(scope) }),
            },
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "thread_not_sendable",
                `Unable to send to thread ${input.threadId}: ${errorMessage(error)}`,
              ),
            ),
          );
        return {
          threadId: input.threadId,
          messageId,
          runId: result.run.id,
          status: result.run.status,
          delivery: result.delivery,
        } satisfies OrchestratorMcpThreadSendResult;
      }),
    waitForThread: (scope, input) =>
      Effect.gen(function* () {
        const { projectId } = yield* loadScopedThread(scope, input.threadId, input.projectId);
        const result = yield* threadManagement
          .waitForThread({
            projectId,
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            timeoutMs: Math.min(
              MAX_WAIT_TIMEOUT_MS,
              Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
            ),
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                error.code === "run_not_found" ? "run_not_found" : "orchestration_error",
                error.message,
              ),
            ),
          );
        return {
          threadId: input.threadId,
          runId: result.run?.id ?? null,
          status: result.run?.status ?? "idle",
          timedOut: result.timedOut,
        } satisfies OrchestratorMcpThreadWaitResult;
      }),
    interruptThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, projectId } = yield* loadScopedThread(
          scope,
          input.threadId,
          input.projectId,
        );
        const key = yield* requestKey(input.clientRequestId);
        if (projectId !== parent.thread.projectId) {
          yield* revalidateGlobalMutation(scope);
        }
        const result = yield* threadManagement
          .interruptThread({
            projectId,
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "thread-interrupt",
              projectId,
              threadId: input.threadId,
            }),
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            dispatchOptions: {
              runtimeAuthority: runtimeMutationAuthority(scope),
              ...(projectId === parent.thread.projectId
                ? {}
                : { supervisorAuthority: supervisorMutationAuthority(scope) }),
            },
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                isThreadManagementError(error) && error.code === "run_not_found"
                  ? "run_not_found"
                  : "thread_not_interruptible",
                isThreadManagementError(error)
                  ? error.message
                  : `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
              ),
            ),
          );
        if (result.type === "no_active_run") {
          return {
            threadId: input.threadId,
            runId: null,
            status: "no_active_run",
          } satisfies OrchestratorMcpThreadInterruptResult;
        }
        return {
          threadId: input.threadId,
          runId: result.run.id,
          status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }),
  });
  return service;
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService
  | ThreadLaunchService
  | ProviderRegistry
  | ProjectService
  | ScheduledTaskService
  | SupervisorControlPlaneService
  | SupervisorGoalCancellationService
> = Layer.effect(OrchestratorMcpService, make);

/** Exposed for focused idempotency tests. */
export const __testing = {
  stableCommandId,
  stableThreadId,
  stableMessageId,
  stableOperationMessageId,
  activeCallerRunForScope,
  executionProfileDefaults,
  delegatedTaskProviderInstanceId,
  supervisorAttemptDelegationCommandId,
};
