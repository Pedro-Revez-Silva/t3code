import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { SupervisorControlPlaneService } from "../supervisor/SupervisorControlPlaneService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { makeSingleLayer as makeProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderRuntimeRecoveryService } from "./ProviderRuntimeRecoveryService.ts";
import { layer as supervisorWakeLayer, SupervisorWakeService } from "./SupervisorWakeService.ts";
import { layer as threadManagementLayer } from "./ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const providerInstanceId = ProviderInstanceId.make("delegated-project-integrity");
const driver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "delegated-project-integrity-model",
} satisfies ModelSelection;
const adapter: ProviderAdapterV2Shape = {
  instanceId: providerInstanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Provider session startup is disabled in this test."),
};

const databaseLayer = SqlitePersistenceMemory;
const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  {
    name: "delegated-task-project-integrity",
    runtimePolicyOverride: { cwd: process.cwd() },
  },
  makeProviderAdapterRegistryLayer(adapter),
  { databaseLayer, runEffectWorker: false },
);
const TestLayer = Layer.merge(orchestratorLayer, databaseLayer);
const threadManagementProvided = threadManagementLayer.pipe(Layer.provide(orchestratorLayer));
const supervisorLayer = Layer.mock(SupervisorControlPlaneService)({
  reconcileAttemptByNodeId: () => Effect.void,
});
const wakeLayer = supervisorWakeLayer.pipe(
  Layer.provide(Layer.merge(threadManagementProvided, supervisorLayer)),
);
const RecoveryTestLayer = Layer.mergeAll(
  TestLayer,
  threadManagementProvided,
  supervisorLayer,
  wakeLayer,
);

it.effect("does not commit delegated children or effects for invalid target projects", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const parentProjectId = ProjectId.make("project:delegated-integrity-parent");
    const parentThreadId = ThreadId.make("thread:delegated-integrity-parent");

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:delegated-integrity-parent-create"),
      threadId: parentThreadId,
      projectId: parentProjectId,
      title: "Delegated integrity parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:delegated-integrity-parent-message"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:delegated-integrity-parent"),
      text: "Keep this run active.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    });

    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0];
    const parentNodeId = parentRun?.rootNodeId;
    if (parentRun === undefined || parentNodeId === null || parentNodeId === undefined) {
      return yield* Effect.die("Expected an active parent run with a root node.");
    }

    const deletedProjectId = ProjectId.make("project:delegated-integrity-deleted");
    const blankRootProjectId = ProjectId.make("project:delegated-integrity-blank-root");
    yield* sql`
      INSERT INTO projection_projects (
        project_id,
        title,
        workspace_root,
        default_model_selection_json,
        scripts_json,
        created_at,
        updated_at,
        deleted_at
      ) VALUES
        (
          ${deletedProjectId},
          'Deleted target',
          '/deleted-target',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z'
        ),
        (
          ${blankRootProjectId},
          'Blank-root target',
          '   ',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
    `;

    const targets = [
      {
        name: "missing",
        projectId: ProjectId.make("project:delegated-integrity-missing"),
      },
      { name: "deleted", projectId: deletedProjectId },
      { name: "blank-root", projectId: blankRootProjectId },
    ];

    for (const target of targets) {
      const commandId = CommandId.make(`command:delegated-integrity-${target.name}`);
      const exit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "provider",
          commandId,
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId,
          task: `Delegate to the ${target.name} target.`,
          targetProjectId: target.projectId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      );
      assert.equal(exit._tag, "Failure");

      const rows = yield* sql<{
        readonly child_count: number;
        readonly effect_count: number;
        readonly receipt_count: number;
      }>`
        SELECT
          (
            SELECT COUNT(*)
            FROM orchestration_v2_projection_threads
            WHERE project_id = ${target.projectId}
          ) AS child_count,
          (
            SELECT COUNT(*)
            FROM orchestration_v2_effect_outbox
            WHERE command_id = ${commandId}
          ) AS effect_count,
          (
            SELECT COUNT(*)
            FROM orchestration_v2_command_receipts
            WHERE command_id = ${commandId}
          ) AS receipt_count
      `;
      assert.deepEqual(rows[0], {
        child_count: 0,
        effect_count: 0,
        receipt_count: 0,
      });
      assert.lengthOf((yield* orchestrator.getThreadProjection(parentThreadId)).subagents, 0);
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("converges one delegated result and wake after process-loss recovery and replay", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const recovery = yield* ProviderRuntimeRecoveryService;
    const wake = yield* SupervisorWakeService;
    const projectId = ProjectId.make("project:delegated-recovery");
    const parentThreadId = ThreadId.make("thread:delegated-recovery-parent");

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:delegated-recovery-parent-create"),
      threadId: parentThreadId,
      projectId,
      title: "Delegated recovery parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:delegated-recovery-parent-message"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:delegated-recovery-parent"),
      text: "Delegate before process loss.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    const parentNodeId = parentRun.rootNodeId!;
    const delegated = yield* orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make("command:delegated-recovery-task"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId,
      task: "Remain active until recovery cancels this child.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const taskEvent = delegated.storedEvents.find(
      (stored) => stored.event.type === "subagent.updated",
    );
    if (taskEvent?.event.type !== "subagent.updated") {
      return yield* Effect.die("Expected delegated task event.");
    }
    const taskId = taskEvent.event.payload.id;
    const childThreadId = taskEvent.event.payload.childThreadId!;

    yield* recovery.recover;
    const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
    const resultTransfers = recovered.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
    );
    assert.lengthOf(
      recovered.subagents.filter((task) => task.id === taskId),
      1,
    );
    assert.lengthOf(
      recovered.nodes.filter((node) => node.id === taskId),
      1,
    );
    assert.lengthOf(
      recovered.turnItems.filter((item) => item.type === "subagent" && item.subagentId === taskId),
      1,
    );
    assert.lengthOf(resultTransfers, 1);
    assert.equal(recovered.subagents.find((task) => task.id === taskId)?.status, "interrupted");
    assert.equal(recovered.nodes.find((node) => node.id === taskId)?.status, "interrupted");

    const transferEvent = yield* orchestrator
      .streamStoredEventsFrom({ threadId: parentThreadId, afterSequence: 0 })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "context-transfer.created" &&
            stored.event.payload.id === resultTransfers[0]!.id,
        ),
        Stream.take(1),
        Stream.runHead,
      );
    if (transferEvent._tag === "None") return yield* Effect.die("Missing result transfer event.");
    yield* wake.handleStoredEvent(transferEvent.value);
    yield* recovery.recover;
    yield* wake.handleStoredEvent(transferEvent.value);

    const replayed = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.lengthOf(
      replayed.contextTransfers.filter(
        (transfer) =>
          transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
      ),
      1,
    );
    assert.lengthOf(
      replayed.messages.filter((message) =>
        message.id.startsWith("message:system:supervisor-wake:"),
      ),
      1,
    );
  }).pipe(Effect.provide(RecoveryTestLayer)),
);
