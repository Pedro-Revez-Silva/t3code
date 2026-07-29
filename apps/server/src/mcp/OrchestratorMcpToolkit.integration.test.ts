import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpCreatedThread,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpProjectListResult,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadRespondResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  SupervisorControlPlaneError,
  SupervisorGoalId,
  SupervisorGoalTaskId,
  SupervisorTaskAttemptId,
  type SupervisorTaskAttempt,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2, type OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import {
  type ThreadLaunchInput,
  ThreadLaunchService,
} from "../orchestration-v2/ThreadLaunchService.ts";
import { layer as threadManagementServiceLayer } from "../orchestration-v2/ThreadManagementService.ts";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  layer as supervisorWakeLayer,
  SupervisorWakeService,
} from "../orchestration-v2/SupervisorWakeService.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SupervisorControlPlaneService } from "../supervisor/SupervisorControlPlaneService.ts";
import { SupervisorGoalCancellationService } from "../supervisor/SupervisorGoalCancellationService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const foreignProjectId = ProjectId.make("project:mcp-foreign");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexModel = "gpt-5.4";
const claudeModel = "claude-sonnet-4-6";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const createdThreadPrompt = "Complete the newly created ordinary thread.";
const approvalRequestPrompt = "Request approval for the deployment command.";
const userInputRequestPrompt = "Request structured deployment settings.";
const staleApprovalRequestPrompt = "Create a stale deployment approval.";

const decodeCreateThreadsResult = Schema.decodeUnknownEffect(OrchestratorMcpCreateThreadsResult);
const decodeCreatedThread = Schema.decodeUnknownEffect(OrchestratorMcpCreatedThread);
const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeProjectListResult = Schema.decodeUnknownEffect(OrchestratorMcpProjectListResult);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeTaskCancelResult = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadRespondResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadRespondResult);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const claudeSelection = {
  instanceId: claudeInstanceId,
  model: claudeModel,
} satisfies ModelSelection;

interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
}

interface CapturedRuntimeResponse {
  readonly requestId: RuntimeRequestId;
  readonly decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  readonly answers?: Readonly<Record<string, unknown>>;
}

function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));
}

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapterV2TurnInput) => boolean;
  readonly response: (turn: ProviderAdapterV2TurnInput) => string;
  readonly runtimeRequestForTurn?: (
    turn: ProviderAdapterV2TurnInput,
  ) => "approval" | "user_input" | "stale_approval" | undefined;
  readonly capturedRuntimeResponses?: Ref.Ref<ReadonlyArray<CapturedRuntimeResponse>>;
  readonly failRuntimeResponses?: Ref.Ref<boolean>;
}): ProviderAdapterV2Shape {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              const runtimeRequestType = input.runtimeRequestForTurn?.(turnInput);
              if (runtimeRequestType !== undefined) {
                const requestId = RuntimeRequestId.make(
                  `runtime-request:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
                );
                const nodeId = NodeId.make(`node:${requestId}`);
                const requestNode = {
                  id: nodeId,
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  parentNodeId: turnInput.rootNodeId,
                  rootNodeId: turnInput.rootNodeId,
                  kind:
                    runtimeRequestType === "user_input"
                      ? ("user_input_request" as const)
                      : ("approval_request" as const),
                  status: "waiting" as const,
                  countsForRun: false,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  runtimeRequestId: requestId,
                  checkpointScopeId: null,
                  startedAt: eventTime,
                  completedAt: null,
                };
                const runtimeRequest = {
                  id: requestId,
                  nodeId,
                  providerTurnId,
                  nativeRequestRef: null,
                  kind:
                    runtimeRequestType === "user_input"
                      ? ("user_input" as const)
                      : ("command" as const),
                  status: "pending" as const,
                  responseCapability:
                    runtimeRequestType === "stale_approval"
                      ? ({
                          type: "not_resumable" as const,
                          reason: "The provider session no longer owns this request.",
                        } as const)
                      : ({
                          type: "live" as const,
                          providerSessionId: sessionInput.providerSessionId,
                        } as const),
                  createdAt: eventTime,
                  resolvedAt: null,
                };
                const requestItem =
                  runtimeRequestType === "user_input"
                    ? ({
                        id: TurnItemId.make(`turn-item:${requestId}`),
                        threadId: turnInput.threadId,
                        runId: turnInput.runId,
                        nodeId,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: turnInput.runOrdinal * 100 + 1,
                        status: "waiting" as const,
                        title: null,
                        startedAt: eventTime,
                        completedAt: null,
                        updatedAt: eventTime,
                        type: "user_input_request" as const,
                        requestId,
                        questions: [
                          {
                            id: "environment",
                            header: "Environment",
                            question: "Which environment should receive the deployment?",
                            options: [
                              { label: "Staging", description: "Deploy to staging." },
                              { label: "Production", description: "Deploy to production." },
                            ],
                          },
                        ],
                      } as const)
                    : ({
                        id: TurnItemId.make(`turn-item:${requestId}`),
                        threadId: turnInput.threadId,
                        runId: turnInput.runId,
                        nodeId,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: turnInput.runOrdinal * 100 + 1,
                        status: "waiting" as const,
                        title: null,
                        startedAt: eventTime,
                        completedAt: null,
                        updatedAt: eventTime,
                        type: "approval_request" as const,
                        requestId,
                        requestKind: "command" as const,
                        prompt: "Allow the deployment command?",
                      } as const);
                yield* publish([
                  { type: "node.updated", driver: input.driver, node: requestNode },
                  {
                    type: "runtime_request.updated",
                    driver: input.driver,
                    threadId: turnInput.threadId,
                    runtimeRequest,
                  },
                  { type: "turn_item.updated", driver: input.driver, turnItem: requestItem },
                ]);
                return;
              }
              if (!input.shouldComplete(turnInput)) {
                return;
              }
              const response = input.response(turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            PubSub.publish(events, {
              type: "turn.terminal",
              driver: input.driver,
              providerThreadId: providerThread.id,
              providerTurnId,
              runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            }).pipe(Effect.asVoid),
          respondToRuntimeRequest: (responseInput) =>
            Effect.gen(function* () {
              if (
                input.failRuntimeResponses !== undefined &&
                (yield* Ref.get(input.failRuntimeResponses))
              ) {
                return yield* unsupported(input.driver, "simulated runtime response failure");
              }
              if (input.capturedRuntimeResponses !== undefined) {
                yield* Ref.update(input.capturedRuntimeResponses, (responses) => [
                  ...responses,
                  responseInput,
                ]);
              }
            }),
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: () => unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

function waitForProjection(
  orchestrator: OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (predicate(projection)) {
        return projection;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for orchestration projection ${threadId}.`),
    );
  });
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** Build a persisted-looking ScheduledTask from an upsert input for the in-memory stub. */
function scheduledTaskFromUpsert(input: ScheduledTaskUpsertInput): ScheduledTask {
  const timestamp = IsoDateTime.make("2026-07-01T09:00:00.000Z");
  return {
    id: input.id ?? ScheduledTaskId.make(`scheduled-task:${input.commandId ?? "stub"}`),
    title: input.title,
    prompt: input.prompt,
    enabled: input.enabled,
    schedule: input.schedule,
    projectId: input.projectId,
    threadId: input.threadId ?? null,
    workspaceStrategy: input.workspaceStrategy,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
}

describe("orchestrator MCP toolkit", () => {
  it.live(
    "delegates cross-provider tasks, polls and cancels children, and creates ordinary threads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("orchestrator-mcp-toolkit");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const capturedRuntimeResponses = yield* Ref.make<ReadonlyArray<CapturedRuntimeResponse>>(
            [],
          );
          const failRuntimeResponses = yield* Ref.make(false);
          const registryLayer = makeProviderAdapterRegistryLayer([
            makeDeterministicAdapter({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              capabilities: CodexProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: (turn) =>
                turn.threadId !== parentThreadId && turn.message.text !== cancellationPrompt,
              response: (turn) => `Codex completed: ${turn.message.text}`,
              runtimeRequestForTurn: (turn) => {
                switch (turn.message.text) {
                  case approvalRequestPrompt:
                    return "approval";
                  case userInputRequestPrompt:
                    return "user_input";
                  case staleApprovalRequestPrompt:
                    return "stale_approval";
                  default:
                    return undefined;
                }
              },
              capturedRuntimeResponses,
              failRuntimeResponses,
            }),
            makeDeterministicAdapter({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              capabilities: ClaudeProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: () => true,
              response: (turn) =>
                turn.message.text === delegatedPrompt
                  ? delegatedResult
                  : `Claude completed: ${turn.message.text}`,
            }),
          ]);
          const databaseLayer = SqlitePersistenceMemory;
          const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
            {
              name: "orchestrator-mcp-toolkit",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            registryLayer,
            { databaseLayer },
          );
          const orchestrationLayer = Layer.merge(
            orchestratorLayer,
            threadManagementServiceLayer.pipe(Layer.provide(orchestratorLayer)),
          );
          const wakeLayer = supervisorWakeLayer.pipe(Layer.provide(orchestrationLayer));
          const projectRepositoryLayer = ProjectionProjectRepositoryLive.pipe(
            Layer.provide(databaseLayer),
          );
          const providerRegistryLayer = makeProviderRegistryLayer([
            makeProviderSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: codexModel,
              optionDescriptors: [
                {
                  id: "reasoning",
                  label: "Reasoning effort",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            }),
            makeProviderSnapshot({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              model: claudeModel,
            }),
            makeProviderSnapshot({
              instanceId: ProviderInstanceId.make("opencode"),
              driver: ProviderDriverKind.make("opencode"),
              model: "opencode/test",
            }),
          ]);
          // In-memory ScheduledTaskService stub so the schedule/list/update/
          // delete tools can be exercised without SQL/launch wiring.
          const scheduledStore = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
          const scheduledTaskStubLayer = Layer.succeed(
            ScheduledTaskService,
            ScheduledTaskService.of({
              list: () => Ref.get(scheduledStore).pipe(Effect.map((tasks) => ({ tasks }))),
              subscribeList: () => Stream.empty,
              upsert: (input) =>
                Effect.gen(function* () {
                  const task = scheduledTaskFromUpsert(input);
                  yield* Ref.update(scheduledStore, (all) => [
                    ...all.filter((candidate) => candidate.id !== task.id),
                    task,
                  ]);
                  return { task };
                }),
              setEnabled: () =>
                Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
              delete: (input) =>
                Ref.update(scheduledStore, (all) =>
                  all.filter((candidate) => candidate.id !== input.id),
                ).pipe(Effect.as({ id: input.id })),
              runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
            }),
          );
          const projectServiceStubLayer = Layer.mock(ProjectService)({
            snapshot: Effect.succeed({
              projects: [
                {
                  id: projectId,
                  title: "MCP project",
                  workspaceRoot: cwd,
                  repositoryIdentity: null,
                  faviconPath: null,
                  defaultModelSelection: codexSelection,
                  scripts: [],
                  createdAt: IsoDateTime.make("2026-06-17T00:00:00.000Z"),
                  updatedAt: IsoDateTime.make("2026-06-17T00:00:00.000Z"),
                  deletedAt: null,
                },
                {
                  id: foreignProjectId,
                  title: "Foreign project",
                  workspaceRoot: `${cwd}/foreign`,
                  repositoryIdentity: null,
                  faviconPath: null,
                  defaultModelSelection: codexSelection,
                  scripts: [],
                  createdAt: IsoDateTime.make("2026-06-17T00:00:00.000Z"),
                  updatedAt: IsoDateTime.make("2026-06-17T00:00:00.000Z"),
                  deletedAt: null,
                },
              ],
              updatedAt: IsoDateTime.make("2026-06-17T00:00:00.000Z"),
            }),
          });
          const goalId = SupervisorGoalId.make("goal:mcp:link-recovery");
          const goalTaskId = SupervisorGoalTaskId.make("goal-task:mcp:link-recovery");
          const goalAttemptId = SupervisorTaskAttemptId.make("goal-attempt:mcp:link-recovery:1");
          const goalAttempt = yield* Ref.make<SupervisorTaskAttempt>({
            id: goalAttemptId,
            goalId,
            taskId: goalTaskId,
            attemptNumber: 1,
            clientRequestId: "goal-task:link-recovery:attempt:1",
            status: "reserved",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            nodeId: null,
            threadId: null,
            runId: null,
            error: null,
            createdAt: "2026-07-26T00:00:00.000Z",
            updatedAt: "2026-07-26T00:00:00.000Z",
          });
          const goalLinkAttempts = yield* Ref.make(0);
          const goalSuccessfulLinks = yield* Ref.make(0);
          const takeoverRaceEnabled = yield* Ref.make(false);
          const takeoverRaceEntered = yield* Deferred.make<void>();
          const releaseTakeoverRace = yield* Deferred.make<void>();
          const goalSnapshot = (attempt: SupervisorTaskAttempt) => ({
            id: goalId,
            title: "Recover attempt linkage",
            prompt: "Delegate once and recover linkage.",
            status: "running" as const,
            revision: 1,
            tasks: [
              {
                id: goalTaskId,
                goalId,
                projectId,
                taskKey: "recover-link",
                title: "Recover link",
                prompt: "Complete the goal linkage recovery task.",
                role: "implementation" as const,
                priority: 1,
                dependencies: [],
                status: attempt.nodeId === null ? ("reserved" as const) : ("running" as const),
                attempts: [attempt],
                createdAt: "2026-07-26T00:00:00.000Z",
                updatedAt: "2026-07-26T00:00:00.000Z",
              },
            ],
            createdAt: "2026-07-26T00:00:00.000Z",
            updatedAt: "2026-07-26T00:00:00.000Z",
            cancelledAt: null,
          });
          const supervisorStubLayer = Layer.mock(SupervisorControlPlaneService)({
            readConfiguration: () =>
              Effect.succeed({
                configuration: {
                  threadId: parentThreadId,
                  revision: 1,
                  updatedAt: "2026-07-26T00:00:00.000Z",
                },
              }),
            isDesignatedSupervisor: () => Effect.succeed(true),
            getProfile: () =>
              Effect.gen(function* () {
                if (yield* Ref.get(takeoverRaceEnabled)) {
                  yield* Deferred.succeed(takeoverRaceEntered, undefined);
                  yield* Deferred.await(releaseTakeoverRace);
                }
                return null;
              }),
            readGoal: () =>
              Ref.get(goalAttempt).pipe(Effect.map((attempt) => ({ goal: goalSnapshot(attempt) }))),
            prepareAttempt: () =>
              Ref.get(goalAttempt).pipe(
                Effect.map((attempt) => ({
                  goal: goalSnapshot(attempt),
                  task: goalSnapshot(attempt).tasks[0]!,
                  attempt,
                })),
              ),
            linkAttempt: (input) =>
              Effect.gen(function* () {
                const linkAttempt = yield* Ref.updateAndGet(goalLinkAttempts, (count) => count + 1);
                if (linkAttempt === 1) {
                  return yield* new SupervisorControlPlaneError({
                    message: "Simulated crash after delegated work committed.",
                  });
                }
                const current = yield* Ref.get(goalAttempt);
                if (current.nodeId !== null) return current;
                const linked: SupervisorTaskAttempt = {
                  ...current,
                  status: "delegated",
                  nodeId: input.nodeId,
                  threadId: input.threadId,
                  runId: input.runId,
                };
                yield* Ref.set(goalAttempt, linked);
                yield* Ref.update(goalSuccessfulLinks, (count) => count + 1);
                return linked;
              }),
            reconcileAttemptByNodeId: () => Effect.void,
          });
          const supervisorCancellationStubLayer = Layer.mock(SupervisorGoalCancellationService)({
            cancelGoal: () => Effect.die("Goal cancellation is unused in this test"),
            reconcileCancelledGoals: Effect.succeed(0),
          });
          const capturedLaunches = yield* Ref.make<ReadonlyArray<ThreadLaunchInput>>([]);
          const threadLaunchStubLayer = Layer.effect(
            ThreadLaunchService,
            Effect.gen(function* () {
              const orchestrator = yield* OrchestratorV2;
              return ThreadLaunchService.of({
                launch: (input) =>
                  Effect.gen(function* () {
                    yield* Ref.update(capturedLaunches, (launches) => [...launches, input]);
                    const threadId = ThreadId.make("thread:mcp-cross-project-start");
                    yield* orchestrator
                      .dispatch({
                        type: "thread.create",
                        commandId: input.commandId,
                        threadId,
                        projectId: input.projectId,
                        title: input.title,
                        modelSelection: input.modelSelection,
                        runtimeMode: input.runtimeMode,
                        interactionMode: input.interactionMode,
                        branch: null,
                        worktreePath: null,
                        createdBy: input.createdBy,
                        creationSource: input.creationSource,
                      })
                      .pipe(Effect.orDie);
                    if (input.initialMessage !== undefined) {
                      yield* orchestrator
                        .dispatch({
                          type: "message.dispatch",
                          commandId: CommandId.make(`${input.commandId}:initial-message`),
                          threadId,
                          messageId: input.initialMessage.messageId!,
                          text: input.initialMessage.text,
                          attachments: input.initialMessage.attachments,
                          modelSelection: input.modelSelection,
                          dispatchMode: { type: "start_immediately" },
                          createdBy: input.createdBy,
                          creationSource: input.creationSource,
                        })
                        .pipe(Effect.orDie);
                    }
                    const projection = yield* orchestrator
                      .getThreadProjection(threadId)
                      .pipe(Effect.orDie);
                    return { threadId, projection, resumed: false };
                  }),
              });
            }),
          ).pipe(Layer.provide(orchestrationLayer));
          const testLayer = Layer.merge(
            McpHttpServer.OrchestratorToolkitRegistrationLive.pipe(
              Layer.provideMerge(McpServer.McpServer.layer),
              Layer.provideMerge(wakeLayer),
              Layer.provideMerge(orchestrationLayer),
              Layer.provideMerge(projectRepositoryLayer),
              Layer.provide(providerRegistryLayer),
              Layer.provide(scheduledTaskStubLayer),
              Layer.provide(projectServiceStubLayer),
              Layer.provide(threadLaunchStubLayer),
              Layer.provide(supervisorStubLayer),
              Layer.provide(supervisorCancellationStubLayer),
              Layer.provide(NodeServices.layer),
            ),
            databaseLayer,
          );

          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const projects = yield* ProjectionProjectRepository;
            const server = yield* McpServer.McpServer;
            const projectTimestamp = IsoDateTime.make("2026-06-17T00:00:00.000Z");
            yield* projects.upsert({
              projectId,
              title: "MCP project",
              workspaceRoot: cwd,
              defaultModelSelection: codexSelection,
              scripts: [],
              createdAt: projectTimestamp,
              updatedAt: projectTimestamp,
              deletedAt: null,
            });
            yield* projects.upsert({
              projectId: foreignProjectId,
              title: "Foreign project",
              workspaceRoot: `${cwd}/foreign`,
              defaultModelSelection: codexSelection,
              scripts: [],
              createdAt: projectTimestamp,
              updatedAt: projectTimestamp,
              deletedAt: null,
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "feature/supervisor-parent",
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("message:mcp-parent:start"),
              text: parentPrompt,
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const parent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some((run) =>
                  ["starting", "running", "waiting"].includes(run.status),
                ) && projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const parentRun = parent.runs[0];
            expect(parentRun?.status).toBe("running");
            const runtimeProviderSessionId = parent.providerThreads.find(
              (thread) => thread.id === parentRun?.providerThreadId,
            )?.providerSessionId;
            expect(runtimeProviderSessionId).toBeDefined();
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
              INSERT INTO supervisor_designation(
                singleton_id, thread_id, revision, created_at, updated_at
              ) VALUES (
                1, ${parentThreadId}, 1,
                '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'
              )
              ON CONFLICT(singleton_id) DO UPDATE SET
                thread_id = excluded.thread_id,
                revision = supervisor_designation.revision + 1,
                updated_at = excluded.updated_at
            `;
            yield* sql`
              INSERT INTO supervisor_goals(
                goal_id, title, prompt, status, revision, created_at, updated_at, cancelled_at
              ) VALUES (
                ${goalId}, 'Recover attempt linkage', 'Delegate once and recover linkage.',
                'running', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', NULL
              )
            `;
            yield* sql`
              INSERT INTO supervisor_goal_tasks(
                task_id, goal_id, project_id, task_key, title, prompt, role, priority,
                status, created_at, updated_at
              ) VALUES (
                ${goalTaskId}, ${goalId}, ${projectId}, 'recover-link', 'Recover link',
                'Complete the goal linkage recovery task.', 'implementation', 1,
                'reserved', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'
              )
            `;
            yield* sql`
              INSERT INTO supervisor_task_attempts(
                attempt_id, goal_id, task_id, attempt_number, client_request_id, status,
                model_selection_json, runtime_mode, interaction_mode, node_id, thread_id,
                run_id, error, created_at, updated_at
              ) VALUES (
                ${goalAttemptId}, ${goalId}, ${goalTaskId}, 1,
                'goal-task:link-recovery:attempt:1', 'reserved',
                ${encodeUnknownJsonString(codexSelection)}, 'full-access', 'default', NULL, NULL,
                NULL, NULL, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'
              )
            `;

            const invocation: McpInvocationContext.McpInvocationScope = {
              environmentId: EnvironmentId.make("environment:mcp-orchestrator"),
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-parent",
              runtimeProviderSessionId: runtimeProviderSessionId!,
              providerInstanceId: codexInstanceId,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            };
            const invokeAs = (
              invocationScope: McpInvocationContext.McpInvocationScope,
              name: string,
              args: Record<string, unknown>,
            ) =>
              server
                .callTool({ name, arguments: args })
                .pipe(
                  Effect.provideService(McpInvocationContext.McpInvocationContext, invocationScope),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );
            const invoke = (name: string, args: Record<string, unknown>) =>
              invokeAs(invocation, name, args);
            const globalInvocation: McpInvocationContext.McpInvocationScope = {
              ...invocation,
              capabilities: new Set(["orchestration", "global-orchestration"]),
            };
            const staleGlobalInvocation: McpInvocationContext.McpInvocationScope = {
              ...globalInvocation,
              providerSessionId: "mcp-provider-session-stale-global",
              runtimeProviderSessionId: ProviderSessionId.make("runtime-provider-session-stale"),
            };

            const capabilitiesTool = server.tools.find(
              ({ tool }) => tool.name === "orchestrator_capabilities",
            );
            expect(capabilitiesTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(capabilitiesTool?.tool.annotations?.idempotentHint).toBe(true);
            const delegateTool = server.tools.find(({ tool }) => tool.name === "delegate_task");
            expect(delegateTool?.tool.annotations?.destructiveHint).toBe(true);
            expect(delegateTool?.tool.annotations?.openWorldHint).toBe(true);
            const createThreadsTool = server.tools.find(
              ({ tool }) => tool.name === "create_threads",
            );
            expect(createThreadsTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadListTool = server.tools.find(({ tool }) => tool.name === "t3_thread_list");
            expect(threadListTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(threadListTool?.tool.annotations?.idempotentHint).toBe(true);
            const projectListTool = server.tools.find(
              ({ tool }) => tool.name === "t3_project_list",
            );
            expect(projectListTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(projectListTool?.tool.annotations?.idempotentHint).toBe(true);
            const threadReadTool = server.tools.find(({ tool }) => tool.name === "t3_thread_read");
            expect(threadReadTool?.tool.annotations?.readOnlyHint).toBe(true);
            const threadRespondTool = server.tools.find(
              ({ tool }) => tool.name === "t3_thread_respond",
            );
            expect(threadRespondTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadSendTool = server.tools.find(({ tool }) => tool.name === "t3_thread_send");
            expect(threadSendTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadWaitTool = server.tools.find(({ tool }) => tool.name === "t3_thread_wait");
            expect(threadWaitTool?.tool.annotations?.readOnlyHint).toBe(true);
            const threadInterruptTool = server.tools.find(
              ({ tool }) => tool.name === "t3_thread_interrupt",
            );
            expect(threadInterruptTool?.tool.annotations?.destructiveHint).toBe(true);

            const capabilities = yield* invoke("orchestrator_capabilities", {});
            expect(capabilities.isError).toBe(false);
            expect(capabilities.structuredContent).toMatchObject({
              inheritedProviderInstanceId: codexInstanceId,
              inheritedModel: codexModel,
              features: {
                appOwnedSubagents: true,
                asyncPolling: true,
                cancellation: true,
                batchThreadCreation: true,
                threadManagement: true,
                incrementalThreadRead: true,
                globalProjectSupervision: true,
              },
              providers: expect.arrayContaining([
                expect.objectContaining({
                  providerInstanceId: claudeInstanceId,
                  canRunCrossProviderChildTask: true,
                }),
                expect.objectContaining({
                  providerInstanceId: "opencode",
                  canRunChildTask: true,
                }),
                // Models advertise their option descriptors so agents can
                // discover valid target.options ids and values.
                expect.objectContaining({
                  providerInstanceId: codexInstanceId,
                  models: [
                    expect.objectContaining({
                      id: codexModel,
                      options: [expect.objectContaining({ id: "reasoning", type: "select" })],
                    }),
                  ],
                }),
              ]),
            });

            const interruptedGoalStart = yield* invokeAs(globalInvocation, "goal_task_start", {
              goalId,
              taskKey: "recover-link",
            });
            expect(interruptedGoalStart.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "orchestration_error",
            });
            const taskAfterInterruptedLink = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).subagents.find(
              (task) =>
                task.prompt ===
                "Act as the implementation sub-agent for this task.\n\nComplete the goal linkage recovery task.",
            )!;
            expect(taskAfterInterruptedLink).toBeDefined();
            expect((yield* Ref.get(goalAttempt)).nodeId).toBeNull();
            const durableAttemptLink = yield* sql<{ readonly node_id: string | null }>`
              SELECT node_id FROM supervisor_task_attempts WHERE attempt_id = ${goalAttemptId}
            `;
            expect(durableAttemptLink[0]?.node_id).toBe(taskAfterInterruptedLink.id);

            const recoveredGoalStart = yield* invokeAs(globalInvocation, "goal_task_start", {
              goalId,
              taskKey: "recover-link",
            });
            expect(recoveredGoalStart.isError).toBe(false);
            expect(recoveredGoalStart.structuredContent).toMatchObject({
              attemptId: goalAttemptId,
              taskKey: "recover-link",
              delegatedTask: { taskId: taskAfterInterruptedLink.id },
            });
            expect(yield* Ref.get(goalLinkAttempts)).toBe(2);
            expect(yield* Ref.get(goalSuccessfulLinks)).toBe(1);
            expect((yield* Ref.get(goalAttempt)).nodeId).toBe(taskAfterInterruptedLink.id);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
                (task) => task.id === taskAfterInterruptedLink.id,
              ),
            ).toHaveLength(1);

            const scheduleTool = server.tools.find(({ tool }) => tool.name === "schedule_task");
            expect(scheduleTool?.tool.annotations?.destructiveHint).toBe(true);
            const scheduleCall = yield* invoke("schedule_task", {
              prompt: "wake up in this thread and say hello",
              schedule: { type: "interval", everyMs: 60_000 },
              clientRequestId: "schedule-hello-1",
            });
            expect(scheduleCall.isError).toBe(false);
            expect(scheduleCall.structuredContent).toMatchObject({
              // Defaults to binding the calling thread.
              boundThreadId: parentThreadId,
              projectId,
              enabled: true,
              schedule: { type: "interval", everyMs: 60_000 },
              // Title is derived from the prompt when omitted.
              title: "wake up in this thread and say hello",
            });
            const scheduledTaskId = (scheduleCall.structuredContent as { scheduledTaskId: string })
              .scheduledTaskId;
            const storedAfterCreate = yield* Ref.get(scheduledStore);
            expect(storedAfterCreate).toHaveLength(1);
            expect(storedAfterCreate[0]).toMatchObject({
              threadId: parentThreadId,
              projectId,
              createdBy: "agent",
              creationSource: "mcp",
              // Inherits the parent thread's model selection.
              modelSelection: codexSelection,
            });

            // list_scheduled_tasks returns the task scoped to this project.
            const scheduledListCall = yield* invoke("list_scheduled_tasks", {});
            expect(scheduledListCall.isError).toBe(false);
            expect(scheduledListCall.structuredContent).toMatchObject({
              tasks: [{ scheduledTaskId, boundThreadId: parentThreadId }],
            });

            // update_scheduled_task pauses without deleting.
            const scheduledUpdateCall = yield* invoke("update_scheduled_task", {
              scheduledTaskId,
              enabled: false,
            });
            expect(scheduledUpdateCall.isError).toBe(false);
            expect(scheduledUpdateCall.structuredContent).toMatchObject({
              scheduledTaskId,
              enabled: false,
            });

            // delete_scheduled_task removes it entirely.
            const scheduledDeleteCall = yield* invoke("delete_scheduled_task", { scheduledTaskId });
            expect(scheduledDeleteCall.isError).toBe(false);
            expect(scheduledDeleteCall.structuredContent).toMatchObject({
              scheduledTaskId,
              deleted: true,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            // OpenCode 1.15 has emitted this exact nested-object-as-JSON-string
            // shape. Decode it at the MCP boundary rather than failing a task
            // the model otherwise specified correctly.
            const serializedScheduleCall = yield* invoke("schedule_task", {
              prompt: "check for new pull requests",
              schedule: '{"type":"interval","everyMs":3600000}',
              clientRequestId: "schedule-opencode-compat-1",
            });
            expect(serializedScheduleCall.isError).toBe(false);
            expect(serializedScheduleCall.structuredContent).toMatchObject({
              schedule: { type: "interval", everyMs: 3_600_000 },
              boundThreadId: parentThreadId,
            });
            const serializedScheduledTaskId = (
              serializedScheduleCall.structuredContent as { scheduledTaskId: string }
            ).scheduledTaskId;
            yield* invoke("delete_scheduled_task", {
              scheduledTaskId: serializedScheduledTaskId,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            const takeoverRacePrompt = "This mutation must lose an in-flight runtime takeover.";
            yield* Ref.set(takeoverRaceEnabled, true);
            const takeoverMutation = yield* invoke("delegate_task", {
              task: takeoverRacePrompt,
              mode: "async",
              clientRequestId: "delegate-runtime-takeover-race",
            }).pipe(Effect.forkChild);
            yield* Deferred.await(takeoverRaceEntered);
            const takeoverRuntimeSessionId = ProviderSessionId.make(
              "runtime-provider-session-takeover-race",
            );
            yield* sql`
              UPDATE orchestration_v2_projection_provider_threads
              SET provider_session_id = ${takeoverRuntimeSessionId}
              WHERE provider_thread_id = ${parentRun!.providerThreadId}
            `;
            yield* Deferred.succeed(releaseTakeoverRace, undefined);
            const takeoverResult = yield* Fiber.join(takeoverMutation);
            expect(takeoverResult.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "orchestration_error",
            });
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.some(
                (task) => task.prompt === takeoverRacePrompt,
              ),
            ).toBe(false);
            yield* sql`
              UPDATE orchestration_v2_projection_provider_threads
              SET provider_session_id = ${runtimeProviderSessionId!}
              WHERE provider_thread_id = ${parentRun!.providerThreadId}
            `;
            yield* Ref.set(takeoverRaceEnabled, false);

            const delegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
              mode: "wait",
              timeoutMs: 10_000,
              clientRequestId: "delegate-claude-1",
            });
            expect(delegatedCall.isError).toBe(false);
            const delegated = yield* decodeDelegateTaskResult(delegatedCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(delegated.status).toBe("completed");
            expect(delegated.summary).toBe(delegatedResult);
            expect(delegated.providerInstanceId).toBe(claudeInstanceId);

            const completedParent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.subagents.some(
                  (task) =>
                    task.id === delegated.taskId &&
                    task.status === "completed" &&
                    task.result === delegatedResult,
                ) &&
                projection.contextTransfers.some(
                  (transfer) =>
                    transfer.type === "subagent_result" &&
                    transfer.sourceThreadId === delegated.childThreadId,
                ),
            );
            const completedTask = completedParent.subagents.find(
              (task) => task.id === delegated.taskId,
            );
            expect(completedTask).toMatchObject({
              origin: "app_owned",
              createdBy: "agent",
              childThreadId: delegated.childThreadId,
              status: "completed",
              result: delegatedResult,
            });
            const child = yield* orchestrator.getThreadProjection(delegated.childThreadId);
            expect(child.thread.lineage).toEqual({
              parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: parentThreadId,
            });
            expect(child.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(child.thread.modelSelection).toEqual(claudeSelection);
            expect(
              child.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([delegatedPrompt]);
            expect(
              child.contextTransfers.some(
                (transfer) =>
                  transfer.type === "subagent_spawn" && transfer.sourceThreadId === parentThreadId,
              ),
            ).toBe(true);
            const capturedAfterDelegate = yield* Ref.get(capturedTurns);
            expect(
              capturedAfterDelegate.filter((turn) => turn.threadId === delegated.childThreadId),
            ).toEqual([
              {
                instanceId: claudeInstanceId,
                threadId: delegated.childThreadId,
                text: delegatedPrompt,
              },
            ]);
            expect(
              capturedAfterDelegate.some(
                (turn) =>
                  turn.threadId === delegated.childThreadId && turn.text.includes(parentPrompt),
              ),
            ).toBe(false);

            const crossProjectDelegatedCall = yield* invokeAs(globalInvocation, "delegate_task", {
              projectId: foreignProjectId,
              task: "Inspect the foreign project root.",
              mode: "wait",
              timeoutMs: 10_000,
              clientRequestId: "delegate-foreign-project-1",
            });
            expect(crossProjectDelegatedCall.isError).toBe(false);
            const crossProjectDelegated = yield* decodeDelegateTaskResult(
              crossProjectDelegatedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(crossProjectDelegated.status).toBe("completed");
            const foreignChild = yield* orchestrator.getThreadProjection(
              crossProjectDelegated.childThreadId,
            );
            expect(foreignChild.thread).toMatchObject({
              projectId: foreignProjectId,
              branch: null,
              worktreePath: null,
              lineage: {
                parentThreadId,
                relationshipToParent: "subagent",
                rootThreadId: parentThreadId,
              },
            });
            expect(foreignChild.runs).toHaveLength(1);
            const parentWithForeignTask = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(
              parentWithForeignTask.subagents.find(
                (task) => task.id === crossProjectDelegated.taskId,
              ),
            ).toMatchObject({
              origin: "app_owned",
              childThreadId: crossProjectDelegated.childThreadId,
              status: "completed",
            });
            const foreignResultTransfer = parentWithForeignTask.contextTransfers.find(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === crossProjectDelegated.childThreadId,
            )!;
            const foreignResultEvents = yield* orchestrator
              .streamStoredEventsFrom({ threadId: parentThreadId, afterSequence: 0 })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "context-transfer.created" &&
                    stored.event.payload.id === foreignResultTransfer.id,
                ),
                Stream.take(1),
                Stream.runCollect,
                Effect.map((events) => Array.from(events)),
              );
            const wakeService = yield* SupervisorWakeService;
            yield* wakeService.handleStoredEvent(foreignResultEvents[0]!);
            yield* wakeService.handleStoredEvent(foreignResultEvents[0]!);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).messages.filter((message) =>
                message.id.startsWith("message:system:supervisor-wake:"),
              ),
            ).toHaveLength(1);

            const delegatedStatusCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatus = yield* decodeDelegateTaskResult(
              delegatedStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatus.status).toBe("completed");
            expect(delegatedStatus.resultContextTransferId).not.toBeNull();

            const repeatedDelegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
              mode: "async",
              clientRequestId: "delegate-claude-1",
            });
            const repeatedDelegated = yield* decodeDelegateTaskResult(
              repeatedDelegatedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedDelegated.taskId).toBe(delegated.taskId);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
                (task) => task.id === delegated.taskId,
              ),
            ).toHaveLength(1);

            // Options outside the model's advertised descriptors are rejected
            // before any child thread is created.
            const rejectedOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: { reasoning: "extreme" },
              },
              mode: "async",
              clientRequestId: "delegate-rejected-options-1",
            });
            expect(rejectedOptionsCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("rejected options"),
            });

            // Duplicate option ids fail fast: downstream consumers disagree on
            // whether the first or last value of a duplicated id wins.
            const duplicateOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: [
                  { id: "reasoning", value: "low" },
                  { id: "reasoning", value: "high" },
                ],
              },
              mode: "async",
              clientRequestId: "delegate-duplicate-options-1",
            });
            expect(duplicateOptionsCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("more than once"),
            });

            const cancellableCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                // Shorthand record form; decodes to the canonical array.
                options: { reasoning: "low" },
              },
              mode: "async",
              clientRequestId: "delegate-cancel-1",
            });
            const cancellable = yield* decodeDelegateTaskResult(
              cancellableCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancellable.status).toBe("running");
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            // The requested model options reach the child thread's selection.
            const optionedChild = yield* orchestrator.getThreadProjection(
              cancellable.childThreadId,
            );
            expect(optionedChild.thread.modelSelection).toEqual({
              instanceId: codexInstanceId,
              model: codexModel,
              options: [{ id: "reasoning", value: "low" }],
            });
            const cancelCall = yield* invoke("task_cancel", {
              taskId: cancellable.taskId,
              reason: "Parent no longer needs this work.",
              clientRequestId: "cancel-1",
            });
            const cancelResult = yield* decodeTaskCancelResult(cancelCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(cancelResult.status).toBe("cancel_requested");
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.runs.some((run) => run.status === "interrupted"),
            );
            const cancelledStatusCall = yield* invoke("task_status", {
              taskId: cancellable.taskId,
            });
            const cancelledStatus = yield* decodeDelegateTaskResult(
              cancelledStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancelledStatus.status).toBe("interrupted");

            const createInput = {
              clientRequestId: "create-thread-batch-1",
              threads: [
                {
                  title: "Inherited empty thread",
                },
                {
                  title: "Claude ordinary thread",
                  prompt: createdThreadPrompt,
                  target: {
                    driverKind: "claudeAgent",
                  },
                },
              ],
            };
            const createCall = yield* invoke("create_threads", createInput);
            expect(createCall.isError).toBe(false);
            const created = yield* decodeCreateThreadsResult(createCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(created.threads).toHaveLength(2);
            const emptyThread = created.threads[0]!;
            const promptedThread = created.threads[1]!;
            expect(emptyThread).toMatchObject({
              status: "idle",
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: codexInstanceId,
              model: codexModel,
            });
            expect(promptedThread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: claudeInstanceId,
              model: claudeModel,
            });
            const emptyProjection = yield* orchestrator.getThreadProjection(emptyThread.threadId);
            expect(emptyProjection.thread.lineage).toEqual({
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: emptyThread.threadId,
            });
            expect(emptyProjection.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(emptyProjection.thread.forkedFrom).toBeNull();
            expect(emptyProjection.runs).toEqual([]);
            const promptedProjection = yield* waitForProjection(
              orchestrator,
              promptedThread.threadId,
              (projection) => projection.runs.some((run) => run.status === "completed"),
            );
            expect(promptedProjection.thread.lineage.parentThreadId).toBeNull();
            expect(
              promptedProjection.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([createdThreadPrompt]);
            const createdThreadItems = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .filter((item) => item.type === "thread_created");
            expect(
              createdThreadItems.map((item) => ({
                targetThreadId: item.targetThreadId,
                targetRunId: item.targetRunId,
                title: item.title,
                providerInstanceId: item.targetProviderInstanceId,
                model: item.targetModel,
              })),
            ).toEqual([
              {
                targetThreadId: emptyThread.threadId,
                targetRunId: null,
                title: emptyThread.title,
                providerInstanceId: codexInstanceId,
                model: codexModel,
              },
              {
                targetThreadId: promptedThread.threadId,
                targetRunId: promptedThread.runId,
                title: promptedThread.title,
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
            ]);

            const rotatedCredentialInvocation: McpInvocationContext.McpInvocationScope = {
              ...invocation,
              providerSessionId: "mcp-provider-session-parent-rotated",
            };
            const repeatedCreateCall = yield* invokeAs(
              rotatedCredentialInvocation,
              "create_threads",
              createInput,
            );
            const repeatedCreated = yield* decodeCreateThreadsResult(
              repeatedCreateCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedCreated.threads.map((thread) => thread.threadId)).toEqual(
              created.threads.map((thread) => thread.threadId),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).visibleTurnItems.filter(
                (row) => {
                  if (row.item.type !== "thread_created") return false;
                  const targetThreadId = row.item.targetThreadId;
                  return created.threads.some((thread) => thread.threadId === targetThreadId);
                },
              ),
            ).toHaveLength(2);

            const promptedReadCall = yield* invoke("t3_thread_read", {
              threadId: promptedThread.threadId,
              limit: 1,
            });
            const promptedRead = yield* decodeThreadReadResult(
              promptedReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedRead.thread.status).toBe("completed");
            expect(promptedRead.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.items.map((item) => item.type)).toEqual(["user_message"]);
            expect(promptedRead.items[0]).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.hasMore).toBe(true);
            const promptedReadNextCall = yield* invoke("t3_thread_read", {
              threadId: promptedThread.threadId,
              afterPosition: promptedRead.nextPosition,
              limit: 1,
            });
            const promptedReadNext = yield* decodeThreadReadResult(
              promptedReadNextCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedReadNext.items.map((item) => item.type)).toEqual(["assistant_message"]);
            expect(promptedReadNext.items[0]?.text).toBe(
              `Claude completed: ${createdThreadPrompt}`,
            );

            const forkedThreadId = ThreadId.make("thread:mcp-orchestrator-inherited-read");
            yield* orchestrator.dispatch({
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-orchestrator-inherited-read"),
              sourceThreadId: promptedThread.threadId,
              targetThreadId: forkedThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Inherited read thread",
            });
            const forkedProjection = yield* orchestrator.getThreadProjection(forkedThreadId);
            expect(forkedProjection.messages).toEqual([]);
            expect(
              forkedProjection.visibleTurnItems.some(
                (row) =>
                  row.sourceThreadId === promptedThread.threadId &&
                  row.item.type === "user_message",
              ),
            ).toBe(true);

            const forkedReadCall = yield* invoke("t3_thread_read", {
              threadId: forkedThreadId,
            });
            const forkedRead = yield* decodeThreadReadResult(forkedReadCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(
              forkedRead.items.find((item) => item.text === createdThreadPrompt),
            ).toMatchObject({
              sourceThreadId: promptedThread.threadId,
              createdBy: "agent",
              creationSource: "mcp",
            });

            const ordinaryLoopPrompt = "Run an ordinary thread loop iteration.";
            const sendCall = yield* invoke("t3_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const sent = yield* decodeThreadSendResult(sendCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(sent.delivery).toBe("started");
            const waitCall = yield* invoke("t3_thread_wait", {
              threadId: emptyThread.threadId,
              runId: sent.runId,
              timeoutMs: 10_000,
            });
            const waited = yield* decodeThreadWaitResult(waitCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(waited).toMatchObject({
              runId: sent.runId,
              status: "completed",
              timedOut: false,
            });
            const restartedInvocation: McpInvocationContext.McpInvocationScope = {
              ...rotatedCredentialInvocation,
              runtimeProviderSessionId: ProviderSessionId.make(
                "runtime-provider-session-after-restart",
              ),
            };
            const repeatedSendCall = yield* invokeAs(restartedInvocation, "t3_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const repeatedSend = yield* decodeThreadSendResult(
              repeatedSendCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedSend.runId).toBe(sent.runId);
            expect(
              (yield* orchestrator.getThreadProjection(emptyThread.threadId)).runs,
            ).toHaveLength(1);

            const localApprovalSendCall = yield* invoke("t3_thread_send", {
              threadId: emptyThread.threadId,
              message: approvalRequestPrompt,
              clientRequestId: "local-approval-request-1",
            });
            expect(localApprovalSendCall.isError).toBe(false);
            const localApprovalProjection = yield* waitForProjection(
              orchestrator,
              emptyThread.threadId,
              (projection) =>
                projection.runtimeRequests.some((request) => request.status === "pending"),
            );
            const localApprovalRequest = localApprovalProjection.runtimeRequests.at(-1)!;
            const localApprovalReadCall = yield* invoke("t3_thread_read", {
              threadId: emptyThread.threadId,
            });
            const localApprovalRead = yield* decodeThreadReadResult(
              localApprovalReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(localApprovalRead.pendingRequests).toEqual([
              {
                requestId: localApprovalRequest.id,
                kind: "command",
                status: "pending",
                respondable: true,
                notResumableReason: null,
                runId: localApprovalProjection.nodes.find(
                  (node) => node.id === localApprovalRequest.nodeId,
                )?.runId,
                nodeId: localApprovalRequest.nodeId,
                approvalPrompt: "Allow the deployment command?",
                approvalRequestKind: "command",
                questions: null,
              },
            ]);
            for (const invalidPayload of [
              {},
              { answers: { environment: "staging" } },
              { decision: "accept", answers: { environment: "staging" } },
            ]) {
              const invalidResponse = yield* invoke("t3_thread_respond", {
                threadId: emptyThread.threadId,
                requestId: localApprovalRequest.id,
                ...invalidPayload,
              });
              expect(invalidResponse.structuredContent).toMatchObject({
                _tag: "OrchestratorMcpFailure",
                code: "invalid_request",
              });
            }
            const localApprovalInput = {
              threadId: emptyThread.threadId,
              requestId: localApprovalRequest.id,
              decision: "accept",
              clientRequestId: "local-approval-response-1",
            };
            yield* Ref.set(failRuntimeResponses, true);
            const localApprovalResponseCall = yield* invoke(
              "t3_thread_respond",
              localApprovalInput,
            );
            const localApprovalResponse = yield* decodeThreadRespondResult(
              localApprovalResponseCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(localApprovalResponse).toEqual({
              threadId: emptyThread.threadId,
              requestId: localApprovalRequest.id,
              status: "accepted_for_delivery",
            });
            let releasedRequest:
              | OrchestrationV2ThreadProjection["runtimeRequests"][number]
              | undefined;
            for (let attempt = 0; attempt < 1_000; attempt += 1) {
              releasedRequest = (yield* orchestrator.getThreadProjection(
                emptyThread.threadId,
              )).runtimeRequests.find((candidate) => candidate.id === localApprovalRequest.id);
              if (releasedRequest?.responseCommandId === undefined) break;
              yield* Effect.sleep("5 millis");
            }
            expect(releasedRequest).toMatchObject({ status: "pending", responseAttempt: 1 });
            expect(releasedRequest?.responseCommandId).toBeUndefined();
            yield* Ref.set(failRuntimeResponses, false);
            const redeliveredLocalApprovalCall = yield* invoke(
              "t3_thread_respond",
              localApprovalInput,
            );
            expect(redeliveredLocalApprovalCall.structuredContent).toEqual(
              localApprovalResponseCall.structuredContent,
            );
            yield* waitForProjection(
              orchestrator,
              emptyThread.threadId,
              (projection) =>
                projection.runtimeRequests.find(
                  (candidate) => candidate.id === localApprovalRequest.id,
                )?.status === "resolved",
            );
            const resolvedRequestResponseCall = yield* invoke("t3_thread_respond", {
              ...localApprovalInput,
              clientRequestId: "local-approval-response-after-resolution",
            });
            expect(resolvedRequestResponseCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
            });
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const responses = yield* Ref.get(capturedRuntimeResponses);
              if (
                responses.filter((response) => response.requestId === localApprovalRequest.id)
                  .length === 1
              ) {
                break;
              }
              yield* Effect.sleep("5 millis");
            }
            expect(
              (yield* Ref.get(capturedRuntimeResponses)).filter(
                (response) => response.requestId === localApprovalRequest.id,
              ),
            ).toEqual([{ requestId: localApprovalRequest.id, decision: "accept" }]);

            const activeThreadCall = yield* invoke("t3_thread_start", {
              prompt: cancellationPrompt,
              title: "Managed active thread",
              clientRequestId: "managed-active-thread-1",
            });
            const activeThread = yield* decodeCreatedThread(
              activeThreadCall.structuredContent,
            ).pipe(Effect.orDie);
            const activeThreadItem = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .find(
                (item) =>
                  item.type === "thread_created" && item.targetThreadId === activeThread.threadId,
              );
            expect(activeThreadItem).toMatchObject({
              type: "thread_created",
              title: "Managed active thread",
              targetThreadId: activeThread.threadId,
              targetRunId: activeThread.runId,
              targetProviderInstanceId: codexInstanceId,
              targetModel: codexModel,
            });
            const activeProjection = yield* waitForProjection(
              orchestrator,
              activeThread.threadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const activeRun = activeProjection.runs[0]!;
            const activeTimeoutCall = yield* invoke("t3_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 1,
            });
            const activeTimeout = yield* decodeThreadWaitResult(
              activeTimeoutCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(activeTimeout).toMatchObject({
              runId: activeRun.id,
              status: "running",
              timedOut: true,
            });
            const steerCall = yield* invoke("t3_thread_send", {
              threadId: activeThread.threadId,
              message: "Include the latest parent guidance before finishing.",
              mode: "steer",
              clientRequestId: "managed-active-steer-1",
            });
            const steered = yield* decodeThreadSendResult(steerCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(steered).toMatchObject({
              runId: activeRun.id,
              delivery: "steered",
            });
            const interruptCall = yield* invoke("t3_thread_interrupt", {
              threadId: activeThread.threadId,
              reason: "The orchestration loop has enough evidence.",
              clientRequestId: "managed-active-interrupt-1",
            });
            const interrupted = yield* decodeThreadInterruptResult(
              interruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interrupted).toMatchObject({
              runId: activeRun.id,
              status: "interrupt_requested",
            });
            const interruptedWaitCall = yield* invoke("t3_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 10_000,
            });
            const interruptedWait = yield* decodeThreadWaitResult(
              interruptedWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interruptedWait.status).toBe("interrupted");
            const repeatedInterruptCall = yield* invoke("t3_thread_interrupt", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
            });
            const repeatedInterrupt = yield* decodeThreadInterruptResult(
              repeatedInterruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedInterrupt.status).toBe("interrupted");

            const foreignThreadId = ThreadId.make("thread:mcp-foreign-project");
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-foreign-project:create"),
              threadId: foreignThreadId,
              projectId: foreignProjectId,
              title: "Foreign project thread",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            const foreignReadCall = yield* invoke("t3_thread_read", {
              projectId: foreignProjectId,
              threadId: foreignThreadId,
            });
            // Live persisted designation is authoritative; the capability bit
            // on the invocation is only provider feature-advertisement data.
            expect(foreignReadCall.structuredContent).toMatchObject({
              thread: { threadId: foreignThreadId, projectId: foreignProjectId },
            });

            const foreignApprovalThreadId = ThreadId.make("thread:mcp-foreign-approval");
            const foreignUserInputThreadId = ThreadId.make("thread:mcp-foreign-user-input");
            const foreignStaleThreadId = ThreadId.make("thread:mcp-foreign-stale-approval");
            for (const threadId of [
              foreignApprovalThreadId,
              foreignUserInputThreadId,
              foreignStaleThreadId,
            ]) {
              yield* orchestrator.dispatch({
                type: "thread.create",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`command:${threadId}:create`),
                threadId,
                projectId: foreignProjectId,
                title: `Runtime request ${threadId}`,
                modelSelection: codexSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: cwd,
              });
            }
            yield* invokeAs(globalInvocation, "t3_thread_send", {
              projectId: foreignProjectId,
              threadId: foreignApprovalThreadId,
              message: approvalRequestPrompt,
              clientRequestId: "foreign-approval-request-1",
            });
            yield* invokeAs(globalInvocation, "t3_thread_send", {
              projectId: foreignProjectId,
              threadId: foreignUserInputThreadId,
              message: userInputRequestPrompt,
              clientRequestId: "foreign-user-input-request-1",
            });
            yield* invokeAs(globalInvocation, "t3_thread_send", {
              projectId: foreignProjectId,
              threadId: foreignStaleThreadId,
              message: staleApprovalRequestPrompt,
              clientRequestId: "foreign-stale-request-1",
            });
            const foreignApprovalProjection = yield* waitForProjection(
              orchestrator,
              foreignApprovalThreadId,
              (projection) =>
                projection.runtimeRequests.some((request) => request.status === "pending"),
            );
            const foreignUserInputProjection = yield* waitForProjection(
              orchestrator,
              foreignUserInputThreadId,
              (projection) =>
                projection.runtimeRequests.some((request) => request.status === "pending"),
            );
            const foreignStaleProjection = yield* waitForProjection(
              orchestrator,
              foreignStaleThreadId,
              (projection) =>
                projection.runtimeRequests.some((request) => request.status === "pending"),
            );
            const foreignApprovalRequest = foreignApprovalProjection.runtimeRequests[0]!;
            const foreignUserInputRequest = foreignUserInputProjection.runtimeRequests[0]!;
            const foreignStaleRequest = foreignStaleProjection.runtimeRequests[0]!;

            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("command:mcp-parent:narrow-runtime"),
              threadId: parentThreadId,
              runtimeMode: "approval-required",
            });
            const broaderRuntimeResponse = yield* invokeAs(globalInvocation, "t3_thread_respond", {
              projectId: foreignProjectId,
              threadId: foreignApprovalThreadId,
              requestId: foreignApprovalRequest.id,
              decision: "accept",
            });
            expect(broaderRuntimeResponse.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "runtime_mode_escalation_denied",
            });
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("command:mcp-parent:restore-runtime"),
              threadId: parentThreadId,
              runtimeMode: "full-access",
            });
            yield* orchestrator.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make("command:mcp-parent:narrow-interaction"),
              threadId: parentThreadId,
              interactionMode: "plan",
            });
            const broaderInteractionResponse = yield* invokeAs(
              globalInvocation,
              "t3_thread_respond",
              {
                projectId: foreignProjectId,
                threadId: foreignApprovalThreadId,
                requestId: foreignApprovalRequest.id,
                decision: "accept",
              },
            );
            expect(broaderInteractionResponse.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "interaction_mode_escalation_denied",
            });
            yield* orchestrator.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make("command:mcp-parent:restore-interaction"),
              threadId: parentThreadId,
              interactionMode: "default",
            });
            const globalApprovalResponseCall = yield* invokeAs(
              globalInvocation,
              "t3_thread_respond",
              {
                projectId: foreignProjectId,
                threadId: foreignApprovalThreadId,
                requestId: foreignApprovalRequest.id,
                decision: "acceptForSession",
                clientRequestId: "foreign-approval-response-1",
              },
            );
            expect(
              yield* decodeThreadRespondResult(globalApprovalResponseCall.structuredContent).pipe(
                Effect.orDie,
              ),
            ).toMatchObject({
              threadId: foreignApprovalThreadId,
              requestId: foreignApprovalRequest.id,
              status: "accepted_for_delivery",
            });

            const globalUserInputReadCall = yield* invokeAs(globalInvocation, "t3_thread_read", {
              projectId: foreignProjectId,
              threadId: foreignUserInputThreadId,
            });
            const globalUserInputRead = yield* decodeThreadReadResult(
              globalUserInputReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(globalUserInputRead.pendingRequests[0]).toMatchObject({
              requestId: foreignUserInputRequest.id,
              kind: "user_input",
              respondable: true,
              approvalPrompt: null,
              approvalRequestKind: null,
              questions: [
                {
                  id: "environment",
                  question: "Which environment should receive the deployment?",
                },
              ],
            });
            for (const invalidPayload of [
              { decision: "accept" },
              { decision: "accept", answers: { environment: "staging" } },
            ]) {
              const invalidResponse = yield* invokeAs(globalInvocation, "t3_thread_respond", {
                projectId: foreignProjectId,
                threadId: foreignUserInputThreadId,
                requestId: foreignUserInputRequest.id,
                ...invalidPayload,
              });
              expect(invalidResponse.structuredContent).toMatchObject({
                _tag: "OrchestratorMcpFailure",
                code: "invalid_request",
              });
            }
            const globalUserInputResponseCall = yield* invokeAs(
              globalInvocation,
              "t3_thread_respond",
              {
                projectId: foreignProjectId,
                threadId: foreignUserInputThreadId,
                requestId: foreignUserInputRequest.id,
                answers: { environment: "staging" },
                clientRequestId: "foreign-user-input-response-1",
              },
            );
            expect(
              yield* decodeThreadRespondResult(globalUserInputResponseCall.structuredContent).pipe(
                Effect.orDie,
              ),
            ).toMatchObject({ status: "accepted_for_delivery" });

            const staleReadCall = yield* invokeAs(globalInvocation, "t3_thread_read", {
              projectId: foreignProjectId,
              threadId: foreignStaleThreadId,
            });
            const staleRead = yield* decodeThreadReadResult(staleReadCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(staleRead.pendingRequests[0]).toMatchObject({
              requestId: foreignStaleRequest.id,
              respondable: false,
              notResumableReason: "The provider session no longer owns this request.",
            });
            const staleResponseCall = yield* invokeAs(globalInvocation, "t3_thread_respond", {
              projectId: foreignProjectId,
              threadId: foreignStaleThreadId,
              requestId: foreignStaleRequest.id,
              decision: "accept",
              clientRequestId: "foreign-stale-response-1",
            });
            expect(staleResponseCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: "The provider session no longer owns this request.",
            });
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if ((yield* Ref.get(capturedRuntimeResponses)).length >= 3) break;
              yield* Effect.sleep("5 millis");
            }
            expect(yield* Ref.get(capturedRuntimeResponses)).toEqual(
              expect.arrayContaining([
                {
                  requestId: foreignApprovalRequest.id,
                  decision: "acceptForSession",
                },
                {
                  requestId: foreignUserInputRequest.id,
                  answers: { environment: "staging" },
                },
              ]),
            );
            const ordinaryProjectListCall = yield* invoke("t3_project_list", {});
            expect(ordinaryProjectListCall.structuredContent).toMatchObject({
              currentProjectId: projectId,
              projects: [
                { projectId, title: "MCP project" },
                { projectId: foreignProjectId, title: "Foreign project" },
              ],
            });
            const staleProjectListCall = yield* invokeAs(
              staleGlobalInvocation,
              "t3_project_list",
              {},
            );
            expect(staleProjectListCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "parent_not_active",
            });
            const projectListCall = yield* invokeAs(globalInvocation, "t3_project_list", {});
            const projectList = yield* decodeProjectListResult(
              projectListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(projectList).toEqual({
              currentProjectId: projectId,
              projects: [
                { projectId, title: "MCP project" },
                { projectId: foreignProjectId, title: "Foreign project" },
              ],
            });
            const idleSupervisorThreadId = ThreadId.make("thread:mcp-idle-supervisor");
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-idle-supervisor:create"),
              threadId: idleSupervisorThreadId,
              projectId,
              title: "Idle configured supervisor",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            const idleGlobalInvocation: McpInvocationContext.McpInvocationScope = {
              ...globalInvocation,
              threadId: idleSupervisorThreadId,
            };
            const idleProjectListCall = yield* invokeAs(
              idleGlobalInvocation,
              "t3_project_list",
              {},
            );
            expect(idleProjectListCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "parent_not_active",
            });
            const idleForeignReadCall = yield* invokeAs(idleGlobalInvocation, "t3_thread_read", {
              projectId: foreignProjectId,
              threadId: foreignThreadId,
            });
            expect(idleForeignReadCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "parent_not_active",
            });
            const globalForeignReadCall = yield* invokeAs(globalInvocation, "t3_thread_read", {
              projectId: foreignProjectId,
              threadId: foreignThreadId,
            });
            expect(globalForeignReadCall.isError).toBe(false);
            expect(globalForeignReadCall.structuredContent).toMatchObject({
              thread: { threadId: foreignThreadId, projectId: foreignProjectId },
            });
            const missingProjectCall = yield* invokeAs(globalInvocation, "t3_thread_list", {
              projectId: ProjectId.make("project:mcp-missing"),
            });
            expect(missingProjectCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "project_not_found",
            });
            const globalForeignListCall = yield* invokeAs(globalInvocation, "t3_thread_list", {
              projectId: foreignProjectId,
              includeSubagents: false,
            });
            const globalForeignList = yield* decodeThreadListResult(
              globalForeignListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(globalForeignList).toMatchObject({
              projectId: foreignProjectId,
              threads: expect.arrayContaining([
                expect.objectContaining({ threadId: foreignThreadId }),
              ]),
            });
            const localCollisionSendCall = yield* invokeAs(globalInvocation, "t3_thread_send", {
              projectId,
              threadId: emptyThread.threadId,
              message: "Local idempotency scope check.",
              clientRequestId: "cross-project-send-scope-1",
            });
            const localCollisionSend = yield* decodeThreadSendResult(
              localCollisionSendCall.structuredContent,
            ).pipe(Effect.orDie);
            const foreignSendCall = yield* invokeAs(globalInvocation, "t3_thread_send", {
              projectId: foreignProjectId,
              threadId: foreignThreadId,
              message: "Foreign project result.",
              clientRequestId: "cross-project-send-scope-1",
            });
            const foreignSend = yield* decodeThreadSendResult(
              foreignSendCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(foreignSend.messageId).not.toBe(localCollisionSend.messageId);
            const foreignWaitCall = yield* invokeAs(globalInvocation, "t3_thread_wait", {
              projectId: foreignProjectId,
              threadId: foreignThreadId,
              runId: foreignSend.runId,
              timeoutMs: 10_000,
            });
            const foreignWait = yield* decodeThreadWaitResult(
              foreignWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(foreignWait.status).toBe("completed");
            const localInterruptTargetCall = yield* invokeAs(globalInvocation, "t3_thread_start", {
              projectId,
              prompt: cancellationPrompt,
              clientRequestId: "cross-project-local-interrupt-target-1",
            });
            const localInterruptTarget = yield* decodeCreatedThread(
              localInterruptTargetCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).turnItems.find(
                (item) =>
                  item.type === "thread_created" &&
                  item.targetThreadId === localInterruptTarget.threadId,
              ),
            ).toMatchObject({
              type: "thread_created",
              targetThreadId: localInterruptTarget.threadId,
            });
            const foreignActiveSendCall = yield* invokeAs(globalInvocation, "t3_thread_send", {
              projectId: foreignProjectId,
              threadId: foreignThreadId,
              message: cancellationPrompt,
              mode: "queue",
              clientRequestId: "cross-project-active-1",
            });
            const foreignActiveSend = yield* decodeThreadSendResult(
              foreignActiveSendCall.structuredContent,
            ).pipe(Effect.orDie);
            const localInterruptCall = yield* invokeAs(globalInvocation, "t3_thread_interrupt", {
              projectId,
              threadId: localInterruptTarget.threadId,
              runId: localInterruptTarget.runId!,
              clientRequestId: "cross-project-interrupt-scope-1",
            });
            const localInterrupt = yield* decodeThreadInterruptResult(
              localInterruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(localInterrupt.status).toBe("interrupt_requested");
            const foreignInterruptCall = yield* invokeAs(globalInvocation, "t3_thread_interrupt", {
              projectId: foreignProjectId,
              threadId: foreignThreadId,
              runId: foreignActiveSend.runId,
              clientRequestId: "cross-project-interrupt-scope-1",
            });
            const foreignInterrupt = yield* decodeThreadInterruptResult(
              foreignInterruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(foreignInterrupt.status).toBe("interrupt_requested");
            const crossProjectStartCall = yield* invokeAs(globalInvocation, "t3_thread_start", {
              projectId: foreignProjectId,
              prompt: "Run in the foreign project root.",
              clientRequestId: "cross-project-start-1",
            });
            expect(crossProjectStartCall.isError).toBe(false);
            expect(crossProjectStartCall.structuredContent).toMatchObject({
              threadId: "thread:mcp-cross-project-start",
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(yield* Ref.get(capturedLaunches)).toMatchObject([
              {
                projectId: foreignProjectId,
                workspaceStrategy: { type: "root" },
                initialMessage: { text: "Run in the foreign project root." },
              },
            ]);
            const parentAfterCrossProjectStart =
              yield* orchestrator.getThreadProjection(parentThreadId);
            expect(
              parentAfterCrossProjectStart.visibleTurnItems.find(
                ({ item }) =>
                  item.type === "thread_created" &&
                  item.targetThreadId === ThreadId.make("thread:mcp-cross-project-start"),
              )?.item,
            ).toBeUndefined();
            const crossProjectThreadId = ThreadId.make("thread:mcp-cross-project-start");
            yield* waitForProjection(orchestrator, crossProjectThreadId, (projection) =>
              projection.runs.some((run) => run.status === "completed"),
            );
            const parentAfterWake = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(
              parentAfterWake.messages.filter((message) =>
                message.id.startsWith("message:system:supervisor-wake:"),
              ),
            ).toHaveLength(1);
            const queuedWakeRun = parentAfterWake.runs.find(
              (run) => run.id !== parentRun?.id && run.status === "queued",
            );
            expect(queuedWakeRun).toBeDefined();

            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-parent:release-supervisor-wake"),
              threadId: parentThreadId,
              runId: parentRun!.id,
            });
            const startedWake = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) => run.id === parentRun?.id && run.status === "interrupted",
                ) &&
                projection.runs.some(
                  (run) => run.id === queuedWakeRun?.id && run.status === "running",
                ),
            );
            expect(
              startedWake.runs.filter((run) =>
                ["starting", "running", "waiting"].includes(run.status),
              ),
            ).toHaveLength(1);
            const listCall = yield* invoke("t3_thread_list", {
              includeSubagents: false,
              limit: 100,
            });
            const listed = yield* decodeThreadListResult(listCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(listed.projectId).toBe(projectId);
            expect(listed.threads.map((thread) => thread.threadId)).toEqual(
              expect.arrayContaining([
                parentThreadId,
                emptyThread.threadId,
                promptedThread.threadId,
                activeThread.threadId,
              ]),
            );
            expect(
              listed.threads.find((thread) => thread.threadId === emptyThread.threadId),
            ).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(listed.threads.some((thread) => thread.threadId === foreignThreadId)).toBe(
              false,
            );
            expect(
              listed.threads.some((thread) => thread.relationshipToParent === "subagent"),
            ).toBe(false);
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );
});
