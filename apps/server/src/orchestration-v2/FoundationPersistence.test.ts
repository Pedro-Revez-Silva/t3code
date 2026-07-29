import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CommandReceiptStoreV2, layer as commandReceiptStoreLayer } from "./CommandReceiptStore.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "./EffectOutbox.ts";
import {
  layerWithOptions as effectWorkerLayerWithOptions,
  OrchestrationEffectExecutorV2,
  OrchestrationEffectWorkerV2,
  runDaemonWithOptions as runEffectWorkerDaemonWithOptions,
} from "./EffectWorker.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "./ProjectionMaintenance.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layer as providerSessionGenerationStoreLayer,
  ProviderSessionGenerationStore,
} from "./ProviderSessionGenerationStore.ts";

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
const effectOutboxProvided = effectOutboxLayer.pipe(Layer.provide(databaseLayer));
const commandReceiptStoreProvided = commandReceiptStoreLayer.pipe(Layer.provide(databaseLayer));
const providerSessionGenerationStoreProvided = providerSessionGenerationStoreLayer.pipe(
  Layer.provide(databaseLayer),
);
const projectionMaintenanceProvided = projectionMaintenanceLayer.pipe(
  Layer.provide(storesProvided),
);
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  effectOutboxProvided,
  commandReceiptStoreProvided,
  idAllocatorLayer,
  projectionMaintenanceProvided,
  providerSessionGenerationStoreProvided,
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

it.layer(TestLayer)("orchestration V2 foundation persistence", (it) => {
  it.effect("fences command commits by live supervisor runtime authority", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const generations = yield* ProviderSessionGenerationStore;
      const commandReceipts = yield* CommandReceiptStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const supervisorThreadId = ThreadId.make("thread:foundation-authority");
      const targetThreadId = ThreadId.make("thread:foundation-authority-target");
      const runtimeProviderSessionId = ProviderSessionId.make(
        "provider-session:foundation-authority",
      );
      yield* sql`
        INSERT INTO supervisor_designation(singleton_id, thread_id, revision, created_at, updated_at)
        VALUES (1, ${supervisorThreadId}, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads (
          provider_thread_id, thread_id, owner_node_id, provider, driver,
          provider_instance_id, provider_session_id, status, first_run_ordinal,
          last_run_ordinal, updated_at, payload_json
        ) VALUES (
          'provider-thread:foundation-authority', ${supervisorThreadId}, NULL,
          ${providerInstanceId}, ${providerDriver}, ${providerInstanceId},
          ${runtimeProviderSessionId}, 'active', 1, 1, '2026-01-01T00:00:00.000Z', '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_instance_id,
          provider_thread_id, status, requested_at, completed_at, payload_json
        ) VALUES (
          'run:foundation-authority', ${supervisorThreadId}, 1, ${providerInstanceId},
          ${providerInstanceId}, 'provider-thread:foundation-authority', 'running',
          '2026-01-01T00:00:00.000Z', NULL, '{}'
        )
      `;
      const commandId = CommandId.make("command:foundation-authority");
      const commit = eventSink.commitCommand({
        commandId,
        threadId: targetThreadId,
        commandType: "thread.create",
        acceptedAt: now,
        events: [
          threadCreatedEvent({
            id: "event:foundation-authority-target",
            thread: makeThread(targetThreadId, now),
            now,
          }),
        ],
        effects: [],
        supervisorAuthorityGuard: {
          threadId: supervisorThreadId,
          runtimeProviderSessionId,
          providerInstanceId,
        },
      });

      yield* sql`
        UPDATE supervisor_designation
        SET thread_id = 'thread:foundation-authority-replacement', revision = 2
        WHERE singleton_id = 1
      `;
      const failure = yield* Effect.flip(commit);
      assert.equal(failure._tag, "EventSinkWriteError");
      const rejectedCommandId = CommandId.make("command:foundation-authority-rejected");
      const rejectedFailure = yield* eventSink
        .commitRejectedCommand({
          commandId: rejectedCommandId,
          threadId: targetThreadId,
          commandType: "thread.create",
          rejectedAt: now,
          error: "planned rejection after takeover",
          runtimeAuthorityGuard: {
            threadId: supervisorThreadId,
            runtimeProviderSessionId,
            providerInstanceId,
          },
          supervisorAuthorityGuard: {
            threadId: supervisorThreadId,
            runtimeProviderSessionId,
            providerInstanceId,
          },
        })
        .pipe(Effect.flip);
      assert.equal(rejectedFailure._tag, "EventSinkWriteError");
      const receipts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_command_receipts
        WHERE command_id IN (${commandId}, ${rejectedCommandId})
      `;
      assert.equal(receipts[0]?.count, 0);

      yield* sql`
        UPDATE supervisor_designation
        SET thread_id = ${supervisorThreadId}, revision = 3
        WHERE singleton_id = 1
      `;
      const accepted = yield* commit;
      assert.isTrue(accepted.committed);

      yield* generations.quarantine({
        threadId: supervisorThreadId,
        providerInstanceId,
        providerSessionId: runtimeProviderSessionId,
        reason: "runtime ownership was quarantined",
      });
      const staleRuntimeCommandId = CommandId.make(
        "command:foundation-authority:stale-runtime-generation",
      );
      const staleRuntimeFailure = yield* eventSink
        .commitRejectedCommand({
          commandId: staleRuntimeCommandId,
          threadId: targetThreadId,
          commandType: "thread.create",
          rejectedAt: now,
          error: "stale runtime generation",
          runtimeAuthorityGuard: {
            threadId: supervisorThreadId,
            runtimeProviderSessionId,
            providerInstanceId,
            runtimeGeneration: 0,
          },
        })
        .pipe(Effect.flip);
      assert.equal(staleRuntimeFailure._tag, "EventSinkWriteError");

      const staleSupervisorCommandId = CommandId.make(
        "command:foundation-authority:stale-supervisor-generation",
      );
      const staleSupervisorFailure = yield* eventSink
        .commitRejectedCommand({
          commandId: staleSupervisorCommandId,
          threadId: targetThreadId,
          commandType: "thread.create",
          rejectedAt: now,
          error: "stale supervisor generation",
          supervisorAuthorityGuard: {
            threadId: supervisorThreadId,
            runtimeProviderSessionId,
            providerInstanceId,
            runtimeGeneration: 0,
          },
        })
        .pipe(Effect.flip);
      assert.equal(staleSupervisorFailure._tag, "EventSinkWriteError");

      const currentGenerationCommandId = CommandId.make(
        "command:foundation-authority:current-generation",
      );
      yield* eventSink.commitRejectedCommand({
        commandId: currentGenerationCommandId,
        threadId: targetThreadId,
        commandType: "thread.create",
        rejectedAt: now,
        error: "current authority generation",
        runtimeAuthorityGuard: {
          threadId: supervisorThreadId,
          runtimeProviderSessionId,
          providerInstanceId,
          runtimeGeneration: 1,
        },
        supervisorAuthorityGuard: {
          threadId: supervisorThreadId,
          runtimeProviderSessionId,
          providerInstanceId,
          runtimeGeneration: 1,
        },
      });
      assert.isTrue(Option.isNone(yield* commandReceipts.getByCommandId(staleRuntimeCommandId)));
      assert.isTrue(Option.isNone(yield* commandReceipts.getByCommandId(staleSupervisorCommandId)));
      assert.isTrue(
        Option.isSome(yield* commandReceipts.getByCommandId(currentGenerationCommandId)),
      );
    }),
  );

  it.effect("paginates catch-up beyond the event-store read limit", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-large-catch-up");
      const thread = makeThread(threadId, now);
      const eventCount = 1_005;
      const events: Array<OrchestrationV2DomainEvent> = [
        threadCreatedEvent({ id: "event:foundation-catch-up:0", thread, now }),
        ...Array.from({ length: eventCount - 1 }, (_, index) => ({
          id: EventId.make(`event:foundation-catch-up:${index + 1}`),
          type: "thread.metadata-updated" as const,
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...thread,
            title: `Catch-up update ${index + 1}`,
          },
        })),
      ];

      yield* eventSink.write({ events });
      const replayed = yield* eventSink.stream({ afterSequence: 0 }).pipe(
        Stream.take(eventCount),
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
      );

      assert.lengthOf(replayed, eventCount);
      assert.deepEqual(
        replayed.map((stored) => stored.sequence),
        Array.from({ length: eventCount }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("does not lose or duplicate events while transitioning from catch-up to live", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-stream-race");
      const thread = makeThread(threadId, now);
      const created = yield* eventSink.write({
        events: [threadCreatedEvent({ id: "event:foundation-stream-race:0", thread, now })],
      });

      let afterSequence = created[0]!.sequence;
      for (let index = 1; index <= 32; index += 1) {
        const nextEvent = {
          id: EventId.make(`event:foundation-stream-race:${index}`),
          type: "thread.metadata-updated" as const,
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: { ...thread, title: `Race update ${index}` },
        } satisfies OrchestrationV2DomainEvent;
        const reader = yield* eventSink
          .stream({ threadId, afterSequence })
          .pipe(Stream.runHead, Effect.forkChild);
        yield* Effect.yieldNow;
        const written = yield* eventSink.write({ events: [nextEvent] });
        const received = yield* Fiber.join(reader);
        if (Option.isNone(received)) {
          return yield* Effect.die("The event stream ended before delivering the live event.");
        }
        assert.equal(received.value.sequence, written[0]?.sequence);
        assert.equal(received.value.event.id, nextEvent.id);
        afterSequence = received.value.sequence;
      }
    }),
  );

  it.effect("replays shared provider-session payloads across every bound thread", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread:foundation-shared-session:first");
      const secondThreadId = ThreadId.make("thread:foundation-shared-session:second");
      const providerSessionId = ProviderSessionId.make("provider-session:foundation:shared");
      const firstProviderThreadId = ProviderThreadId.make(
        "provider-thread:foundation-shared-session:first",
      );
      const secondProviderThreadId = ProviderThreadId.make(
        "provider-thread:foundation-shared-session:second",
      );
      const firstSession = {
        id: providerSessionId,
        driver: providerDriver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace/first",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const secondSession = { ...firstSession, cwd: "/workspace/second" };
      const makeProviderThread = (
        threadId: ThreadId,
        id: ProviderThreadId,
      ): OrchestrationV2ProviderThread => ({
        id,
        driver: providerDriver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      });
      const firstProviderThread = makeProviderThread(firstThreadId, firstProviderThreadId);
      const secondProviderThread = makeProviderThread(secondThreadId, secondProviderThreadId);

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-shared-session:first-thread",
            thread: makeThread(firstThreadId, now),
            now,
          }),
          {
            id: EventId.make("event:foundation-shared-session:first-provider-thread"),
            type: "provider-thread.updated",
            threadId: firstThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: firstProviderThread,
          },
          {
            id: EventId.make("event:foundation-shared-session:first-attachment"),
            type: "provider-session.attached",
            threadId: firstThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: firstSession,
          },
          threadCreatedEvent({
            id: "event:foundation-shared-session:second-thread",
            thread: makeThread(secondThreadId, now),
            now,
          }),
          {
            id: EventId.make("event:foundation-shared-session:second-provider-thread"),
            type: "provider-thread.updated",
            threadId: secondThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: secondProviderThread,
          },
          {
            id: EventId.make("event:foundation-shared-session:second-attachment"),
            type: "provider-session.attached",
            threadId: secondThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: secondSession,
          },
        ],
      });

      assert.equal(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions[0]?.cwd,
        secondSession.cwd,
      );
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);

      const detail = "shared owner did not confirm provider termination";
      const quarantine = yield* eventSink.quarantineProviderSession({
        threadId: firstThreadId,
        providerInstanceId,
        providerSessionId,
        reason: detail,
        providerThreadEvent: {
          id: EventId.make("event:foundation-shared-session:first-provider-thread-detached"),
          type: "provider-thread.updated",
          threadId: firstThreadId,
          driver: providerDriver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...firstProviderThread,
            providerSessionId: null,
            status: "not_loaded",
          },
        },
        providerSessionErrorEvent: {
          id: EventId.make("event:foundation-shared-session:error"),
          type: "provider-session.updated",
          threadId: firstThreadId,
          driver: providerDriver,
          providerInstanceId,
          occurredAt: now,
          payload: { ...firstSession, status: "error", lastError: detail },
        },
        providerSessionDetachedEvent: {
          id: EventId.make("event:foundation-shared-session:first-detached"),
          type: "provider-session.detached",
          threadId: firstThreadId,
          driver: providerDriver,
          providerInstanceId,
          occurredAt: now,
          payload: { providerSessionId, detachedAt: now, reason: detail },
        },
      });
      assert.isTrue(quarantine.committed);
      assert.isFalse(quarantine.finalOwner);
      assert.deepEqual(
        quarantine.storedEvents.map((stored) => stored.event.type),
        ["provider-thread.updated", "provider-session.detached"],
      );
      const firstProjection = yield* projectionStore.getThreadProjection(firstThreadId);
      const secondProjection = yield* projectionStore.getThreadProjection(secondThreadId);
      assert.equal(firstProjection.providerThreads[0]?.providerSessionId, null);
      assert.deepEqual(firstProjection.providerSessions, []);
      assert.equal(secondProjection.providerThreads[0]?.providerSessionId, providerSessionId);
      assert.equal(secondProjection.providerSessions[0]?.status, "ready");
    }),
  );

  it.effect("verifies and rebuilds projections with cross-thread subagent relations", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const parentThreadId = ThreadId.make("thread:foundation-cross-thread:parent");
      const childThreadId = ThreadId.make("thread:foundation-cross-thread:child");
      const childProviderThreadId = ProviderThreadId.make(
        "provider-thread:foundation-cross-thread:child",
      );
      const subagentId = NodeId.make("subagent:foundation-cross-thread");
      const spawnTransferId = ContextTransferId.make("transfer:foundation-cross-thread:spawn");
      const resultTransferId = ContextTransferId.make("transfer:foundation-cross-thread:result");
      const parentThread = makeThread(parentThreadId, now);
      const childThread = {
        ...makeThread(childThreadId, now),
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        lineage: {
          parentThreadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: parentThreadId,
        },
      };

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-cross-thread:parent",
            thread: parentThread,
            now,
          }),
          threadCreatedEvent({
            id: "event:foundation-cross-thread:child",
            thread: childThread,
            now,
          }),
          {
            id: EventId.make("event:foundation-cross-thread:subagent"),
            type: "subagent.updated",
            threadId: parentThreadId,
            nodeId: subagentId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: subagentId,
              threadId: parentThreadId,
              runId: null,
              parentNodeId: NodeId.make("node:foundation-cross-thread:parent"),
              origin: "app_owned",
              createdBy: "agent",
              driver: providerDriver,
              providerInstanceId,
              providerThreadId: childProviderThreadId,
              childThreadId,
              nativeTaskRef: null,
              prompt: "Inspect the child flow",
              title: "Cross-thread child",
              model: modelSelection.model,
              status: "completed",
              result: "done",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:spawn-transfer"),
            type: "context-transfer.created",
            threadId: childThreadId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: spawnTransferId,
              type: "subagent_spawn",
              sourceThreadId: parentThreadId,
              targetThreadId: childThreadId,
              sourcePoint: { threadId: parentThreadId },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "agent",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:provider-thread"),
            type: "provider-thread.updated",
            threadId: parentThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: childProviderThreadId,
              driver: providerDriver,
              providerInstanceId,
              providerSessionId: null,
              appThreadId: childThreadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:result-transfer"),
            type: "context-transfer.created",
            threadId: parentThreadId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: resultTransferId,
              type: "subagent_result",
              sourceThreadId: childThreadId,
              targetThreadId: parentThreadId,
              sourcePoint: { threadId: childThreadId },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "system",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
        ],
      });

      const assertCrossThreadProjection = Effect.gen(function* () {
        const parent = yield* projectionStore.getThreadProjection(parentThreadId);
        const child = yield* projectionStore.getThreadProjection(childThreadId);
        const expectedTransferIds = [spawnTransferId, resultTransferId].toSorted();
        assert.deepEqual(
          parent.contextTransfers.map((transfer) => transfer.id).toSorted(),
          expectedTransferIds,
        );
        assert.deepEqual(
          child.contextTransfers.map((transfer) => transfer.id).toSorted(),
          expectedTransferIds,
        );
        assert.deepEqual(
          parent.providerThreads.map((providerThread) => providerThread.id),
          [childProviderThreadId],
        );
        assert.equal(child.thread.activeProviderThreadId, childProviderThreadId);
      });

      yield* assertCrossThreadProjection;
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* assertCrossThreadProjection;
    }),
  );

  it.effect(
    "rolls back events, projections, receipts, and effects after a projection failure",
    () =>
      Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const eventStore = yield* EventStoreV2;
        const receipts = yield* CommandReceiptStoreV2;
        const outbox = yield* EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const commandId = CommandId.make("command:foundation-atomic-failure");
        const threadId = ThreadId.make("thread:foundation-atomic-failure");
        const scopeId = CheckpointScopeId.make("scope:foundation-atomic-failure");
        const checkpoint = (index: number) => ({
          id: CheckpointId.make(`checkpoint:foundation-atomic-failure:${index}`),
          threadId,
          scopeId,
          runId: null,
          nodeId: NodeId.make("node:foundation-atomic-failure"),
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: null,
          ref: CheckpointRef.make(`checkpoint-ref:foundation-atomic-failure:${index}`),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        });
        const events = [1, 2].map(
          (index) =>
            ({
              id: EventId.make(`event:foundation-atomic-failure:${index}`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: checkpoint(index),
            }) satisfies OrchestrationV2DomainEvent,
        );

        const exit = yield* Effect.exit(
          eventSink.commitCommand({
            commandId,
            threadId,
            commandType: "checkpoint.atomicity-test",
            acceptedAt: now,
            events,
            effects: [
              {
                id: "effect:foundation-atomic-failure",
                commandId,
                threadId,
                request: {
                  type: "provider-turn.start",
                  runId: RunId.make("run:foundation-atomic-failure"),
                },
              },
            ],
          }),
        );
        assert.equal(exit._tag, "Failure");
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        assert.deepEqual(
          yield* eventStore.readByCommandId({ commandId }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
          [],
        );
        const checkpointRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_checkpoints
        WHERE thread_id = ${threadId}
      `;
        assert.equal(checkpointRows[0]?.count, 0);
      }),
  );

  it.effect(
    "atomically rejects delegated children for missing, deleted, or blank-root target projects",
    () =>
      Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const eventStore = yield* EventStoreV2;
        const receipts = yield* CommandReceiptStoreV2;
        const outbox = yield* EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const deletedProjectId = ProjectId.make("project:delegated-target-deleted");
        const blankRootProjectId = ProjectId.make("project:delegated-target-blank-root");

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
              'Deleted delegated target',
              '/deleted-target',
              NULL,
              '[]',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              '2026-01-02T00:00:00.000Z'
            ),
            (
              ${blankRootProjectId},
              'Blank-root delegated target',
              '   ',
              NULL,
              '[]',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL
            )
        `;

        const cases = [
          {
            name: "missing",
            projectId: ProjectId.make("project:delegated-target-missing"),
          },
          { name: "deleted", projectId: deletedProjectId },
          { name: "blank-root", projectId: blankRootProjectId },
        ];

        for (const target of cases) {
          const commandId = CommandId.make(`command:delegated-target-${target.name}`);
          const childThreadId = ThreadId.make(`thread:delegated-target-${target.name}`);
          const childThread = {
            ...makeThread(childThreadId, now),
            projectId: target.projectId,
          };
          const effectId = `effect:delegated-target-${target.name}`;

          const exit = yield* Effect.exit(
            eventSink.commitCommand({
              commandId,
              threadId: ThreadId.make("thread:delegated-parent"),
              commandType: "delegated_task.request",
              acceptedAt: now,
              events: [
                threadCreatedEvent({
                  id: `event:delegated-target-${target.name}`,
                  thread: childThread,
                  now,
                }),
              ],
              effects: [
                {
                  id: effectId,
                  commandId,
                  threadId: childThreadId,
                  request: {
                    type: "provider-turn.start",
                    runId: RunId.make(`run:delegated-target-${target.name}`),
                  },
                },
              ],
              activeProjectGuard: { projectId: target.projectId },
            }),
          );

          assert.equal(exit._tag, "Failure");
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
          assert.deepEqual(
            yield* eventStore.readByCommandId({ commandId }).pipe(
              Stream.runCollect,
              Effect.map((events) => Array.from(events)),
            ),
            [],
          );
          const childRows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM orchestration_v2_projection_threads
            WHERE thread_id = ${childThreadId}
          `;
          assert.equal(childRows[0]?.count, 0);
        }
      }),
  );

  it.effect("keeps one durable effect across command retries and executes it after recovery", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const now = yield* DateTime.now;
      const commandId = CommandId.make("command:foundation-effect-recovery");
      const threadId = ThreadId.make("thread:foundation-effect-recovery");
      const thread = makeThread(threadId, now);
      const event = threadCreatedEvent({
        id: "event:foundation-effect-recovery",
        thread,
        now,
      });
      const effect = {
        id: "effect:foundation-effect-recovery",
        commandId,
        threadId,
        request: {
          type: "provider-turn.start" as const,
          runId: RunId.make("run:foundation-effect-recovery"),
        },
      };

      const first = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.effect-recovery",
        acceptedAt: now,
        events: [event],
        effects: [effect],
      });
      const retry = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.effect-recovery",
        acceptedAt: now,
        events: [event],
        effects: [effect],
      });

      assert.isTrue(first.committed);
      assert.isFalse(retry.committed);
      assert.equal(retry.receipt.resultSequence, first.receipt.resultSequence);
      assert.lengthOf(retry.storedEvents, 1);
      assert.lengthOf(yield* outbox.listByCommandId(commandId), 1);

      const executionCount = yield* Ref.make(0);
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: () => Ref.update(executionCount, (count) => count + 1),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({ workerId: "recovery-worker" }).pipe(
        Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)),
      );
      yield* Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        assert.isTrue(yield* worker.runOnce);
        assert.isFalse(yield* worker.runOnce);
      }).pipe(Effect.provide(workerLayer));

      assert.equal(yield* Ref.get(executionCount), 1);
      const storedEffect = yield* outbox.get(effect.id);
      assert.isTrue(Option.isSome(storedEffect));
      if (Option.isSome(storedEffect)) {
        assert.equal(storedEffect.value.status, "succeeded");
      }
    }),
  );

  it.effect("does not publish a stale provider start after an interrupt wins", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-stale-provider-start");
      const runId = RunId.make("run:foundation-stale-provider-start");
      const attemptId = RunAttemptId.make("run-attempt:foundation-stale-provider-start");
      const thread = makeThread(threadId, now);
      const startingRun: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:foundation-stale-provider-start"),
        rootNodeId: null,
        activeAttemptId: attemptId,
        status: "starting",
        queuePosition: null,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-stale-provider-start:thread",
            thread,
            now,
          }),
          {
            id: EventId.make("event:foundation-stale-provider-start:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: startingRun,
          },
        ],
      });

      const reachedPrecommitGap = yield* Deferred.make<void>();
      const releaseStaleStart = yield* Deferred.make<void>();
      const providerStartCount = yield* Ref.make(0);
      const staleStartFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(reachedPrecommitGap, undefined);
        yield* Deferred.await(releaseStaleStart);
        const result = yield* eventSink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attemptId,
          expectedStatus: "starting",
          events: [
            {
              id: EventId.make("event:foundation-stale-provider-start:running"),
              type: "run.updated",
              threadId,
              runId,
              providerInstanceId,
              occurredAt: now,
              payload: { ...startingRun, status: "running", startedAt: now },
            },
          ],
        });
        if (result.committed) {
          yield* Ref.update(providerStartCount, (count) => count + 1);
        }
        return result;
      }).pipe(Effect.forkChild);

      yield* Deferred.await(reachedPrecommitGap);
      const interruptedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-stale-provider-start:cancelled"),
            type: "run.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: interruptedAt,
            payload: {
              ...startingRun,
              status: "cancelled",
              completedAt: interruptedAt,
            },
          },
        ],
      });
      yield* Deferred.succeed(releaseStaleStart, undefined);

      const staleResult = yield* Fiber.join(staleStartFiber);
      assert.isFalse(staleResult.committed);
      assert.deepEqual(staleResult.storedEvents, []);
      assert.equal(yield* Ref.get(providerStartCount), 0);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "cancelled");
    }),
  );

  it.effect("interrupts a running process-bound effect when it is cancelled", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-cancel-running-effect");
      const threadId = ThreadId.make("thread:foundation-cancel-running-effect");
      const effectId = "effect:foundation-cancel-running-effect";
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-cancel-running-effect"),
          },
        },
      ]);

      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined).pipe(Effect.ignore),
              ),
            ),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "cancellation-worker",
      }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

      yield* Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        const workerFiber = yield* worker.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const cancelledEffectIds = yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "The owning run was interrupted.",
        });
        assert.deepEqual(cancelledEffectIds, [effectId]);
        yield* outbox.signalCancellations(cancelledEffectIds);
        assert.isTrue(yield* Fiber.join(workerFiber));
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provide(workerLayer));

      const cancelled = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(cancelled));
      if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");
    }),
  );

  it.effect("treats cancellation between execution and settlement as a normal outcome", () =>
    Effect.gen(function* () {
      const effectId = "effect:foundation-cancel-before-settlement";
      const threadId = ThreadId.make("thread:foundation-cancel-before-settlement");
      const commandId = CommandId.make("command:foundation-cancel-before-settlement");
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimedEffect = {
        id: effectId,
        commandId,
        threadId,
        request: { type: "terminal.cleanup" as const },
        status: "running" as const,
        attemptCount: 1,
        availableAt: now,
        leaseOwner: "settlement-race-worker",
        leaseExpiresAt: now,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        lastError: null,
      };
      const outboxLayer = Layer.mock(EffectOutboxV2)({
        claimNext: () => Effect.succeed(Option.some(claimedEffect)),
        awaitCancellation: () => Effect.never,
        clearCancellation: () => Effect.void,
        succeed: () => Effect.succeed(false),
        get: () =>
          Effect.succeed(
            Option.some({
              ...claimedEffect,
              status: "cancelled" as const,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: now,
            }),
          ),
      });
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "settlement-race-worker",
      }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

      assert.isTrue(
        yield* OrchestrationEffectWorkerV2.pipe(
          Effect.flatMap((worker) => worker.runOnce),
          Effect.provide(workerLayer),
        ),
      );
    }),
  );

  it.effect("does not start an effect that was cancelled during claim registration", () =>
    Effect.gen(function* () {
      const effectId = "effect:foundation-cancelled-during-claim";
      const threadId = ThreadId.make("thread:foundation-cancelled-during-claim");
      const commandId = CommandId.make("command:foundation-cancelled-during-claim");
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimedEffect = {
        id: effectId,
        commandId,
        threadId,
        request: { type: "terminal.cleanup" as const },
        status: "running" as const,
        attemptCount: 1,
        availableAt: now,
        leaseOwner: "claim-cancellation-worker",
        leaseExpiresAt: now,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        lastError: null,
      };
      const executionCount = yield* Ref.make(0);
      const outboxLayer = Layer.mock(EffectOutboxV2)({
        claimNext: () => Effect.succeed(Option.some(claimedEffect)),
        get: () =>
          Effect.succeed(
            Option.some({
              ...claimedEffect,
              status: "cancelled" as const,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: now,
            }),
          ),
        clearCancellation: () => Effect.void,
        awaitCancellation: () => Effect.never,
      });
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: () => Ref.update(executionCount, (count) => count + 1),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "claim-cancellation-worker",
      }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

      assert.isTrue(
        yield* OrchestrationEffectWorkerV2.pipe(
          Effect.flatMap((worker) => worker.runOnce),
          Effect.provide(workerLayer),
        ),
      );
      assert.equal(yield* Ref.get(executionCount), 0);
    }),
  );

  it.effect("allows only one worker to claim an available effect", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-exclusive-claim");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-exclusive-claim",
          commandId,
          threadId: ThreadId.make("thread:foundation-exclusive-claim"),
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-exclusive-claim"),
          },
        },
      ]);

      const claims = yield* Effect.all(
        [
          outbox.claimNext({ workerId: "worker-a", leaseDurationMs: 30_000 }),
          outbox.claimNext({ workerId: "worker-b", leaseDurationMs: 30_000 }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(claims.filter(Option.isSome).length, 1);
      assert.equal(claims.filter(Option.isNone).length, 1);
      const claimedByA = claims[0];
      const claimedByB = claims[1];
      if (Option.isSome(claimedByA)) {
        yield* outbox.succeed({ effectId: claimedByA.value.id, workerId: "worker-a" });
      }
      if (Option.isSome(claimedByB)) {
        yield* outbox.succeed({ effectId: claimedByB.value.id, workerId: "worker-b" });
      }
    }),
  );

  it.effect("runs distinct threads concurrently while serializing effects within a thread", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-concurrent-effects");
      const threadA = ThreadId.make("thread:foundation-concurrent-effects:a");
      const threadB = ThreadId.make("thread:foundation-concurrent-effects:b");
      const effectA1 = "effect:foundation-concurrent-effects:a1";
      const effectA2 = "effect:foundation-concurrent-effects:a2";
      const effectB1 = "effect:foundation-concurrent-effects:b1";
      const startedA1 = yield* Deferred.make<void>();
      const startedA2 = yield* Deferred.make<void>();
      const startedB1 = yield* Deferred.make<void>();
      const releaseA1 = yield* Deferred.make<void>();
      const releaseA2 = yield* Deferred.make<void>();
      const releaseB1 = yield* Deferred.make<void>();
      const gates = new Map([
        [effectA1, { started: startedA1, release: releaseA1 }],
        [effectA2, { started: startedA2, release: releaseA2 }],
        [effectB1, { started: startedB1, release: releaseB1 }],
      ]);
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: (effect) => {
            const gate = gates.get(effect.id);
            if (gate === undefined) return Effect.die(`Missing gate for ${effect.id}`);
            return Deferred.succeed(gate.started, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            );
          },
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "concurrency-worker",
      }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

      yield* Effect.gen(function* () {
        yield* runEffectWorkerDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        // Let both slots reach the idle wait before work becomes available.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* outbox.enqueue([
          {
            id: effectA1,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a1"),
            },
          },
          {
            id: effectA2,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a2"),
            },
          },
          {
            id: effectB1,
            commandId,
            threadId: threadB,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:b1"),
            },
          },
        ]);

        yield* Effect.all([Deferred.await(startedA1), Deferred.await(startedB1)]);
        assert.isFalse(yield* Deferred.isDone(startedA2));

        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.succeed(releaseB1, undefined);
        yield* Deferred.await(startedA2);
        yield* Deferred.succeed(releaseA2, undefined);
        let settled = false;
        while (!settled) {
          settled = (yield* outbox.listByCommandId(commandId)).every(
            (effect) => effect.status === "succeeded",
          );
          if (!settled) yield* Effect.yieldNow;
        }
      }).pipe(Effect.provide(workerLayer), Effect.scoped);
    }),
  );

  it.effect("does not reclaim a running effect after its process-local lease expires", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.make("command:foundation-no-live-reclaim");
      const threadId = ThreadId.make("thread:foundation-no-live-reclaim");
      const firstEffectId = "effect:foundation-no-live-reclaim:first";
      const secondEffectId = "effect:foundation-no-live-reclaim:second";
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const executions = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* outbox.enqueue([
        {
          id: firstEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: secondEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Ref.update(executions, (current) => [...current, effect.id]).pipe(
              Effect.andThen(
                effect.id === firstEffectId
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                    )
                  : Effect.void,
              ),
            ),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "no-live-reclaim-worker",
        leaseDurationMs: 1,
      }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

      yield* Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        const firstFiber = yield* worker.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET lease_expires_at = '1970-01-01T00:00:00.000Z'
          WHERE effect_id = ${firstEffectId}
        `;

        assert.isFalse(yield* worker.runOnce);
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId]);

        yield* Deferred.succeed(releaseFirst, undefined);
        assert.isTrue(yield* Fiber.join(firstFiber));
        assert.isTrue(yield* worker.runOnce);
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId, secondEffectId]);
      }).pipe(Effect.provide(workerLayer));
    }),
  );

  it.effect(
    "retires live provider effects and requeues replay-safe effects after process loss",
    () =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutboxV2;
        const commandId = CommandId.make("command:foundation-reclaim-running");
        yield* outbox.enqueue([
          {
            id: "effect:a-foundation-cancel-provider-turn",
            commandId,
            threadId: ThreadId.make("thread:foundation-reclaim-running"),
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-reclaim-running"),
            },
          },
          {
            id: "effect:b-foundation-requeue-cleanup",
            commandId,
            threadId: ThreadId.make("thread:foundation-reclaim-cleanup"),
            request: { type: "terminal.cleanup" },
          },
        ]);
        assert.isTrue(
          Option.isSome(
            yield* outbox.claimNext({ workerId: "crashed-worker", leaseDurationMs: 30_000 }),
          ),
        );
        assert.isTrue(
          Option.isSome(
            yield* outbox.claimNext({ workerId: "crashed-worker", leaseDurationMs: 30_000 }),
          ),
        );
        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, {
          cancelled: 1,
          requeued: 1,
        });
        const cancelled = yield* outbox.get("effect:a-foundation-cancel-provider-turn");
        assert.isTrue(Option.isSome(cancelled));
        if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");

        const reclaimed = yield* outbox.claimNext({
          workerId: "recovery-worker",
          leaseDurationMs: 30_000,
        });
        assert.isTrue(Option.isSome(reclaimed));
        if (Option.isSome(reclaimed)) {
          assert.equal(reclaimed.value.request.type, "terminal.cleanup");
          assert.equal(reclaimed.value.attemptCount, 2);
        }
      }),
  );

  it.effect("atomically cancels stale runs and their process-bound effects", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-process-loss");
      const runId = RunId.make("run:foundation-process-loss");
      const commandId = CommandId.make("command:foundation-process-loss");
      const thread = makeThread(threadId, now);
      yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.process-loss",
        acceptedAt: now,
        events: [
          threadCreatedEvent({ id: "event:foundation-process-loss:thread", thread, now }),
          {
            id: EventId.make("event:foundation-process-loss:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:foundation-process-loss"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "starting",
              queuePosition: null,
              requestedAt: now,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
        effects: [
          {
            id: "effect:foundation-process-loss",
            commandId,
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ],
      });
      assert.isTrue(
        Option.isSome(
          yield* outbox.claimNext({ workerId: "crashed-worker", leaseDurationMs: 30_000 }),
        ),
      );

      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provideService(
          ProviderTurnControlServiceV2,
          ProviderTurnControlServiceV2.of({
            interrupt: () => Effect.void,
            interruptAndAwaitTerminal: () => Effect.void,
            hardStop: () => Effect.void,
            steer: () => Effect.void,
          }),
        ),
        Effect.provide(
          Layer.mock(ProviderSessionManagerV2)({
            release: () => Effect.void,
          }),
        ),
        Effect.provideService(
          OrchestratorV2,
          OrchestratorV2.of({
            reconcileDelegatedTasks: Effect.succeed(0),
          } as unknown as OrchestratorV2["Service"]),
        ),
        Effect.provideService(
          OrchestrationEffectWorkerV2,
          OrchestrationEffectWorkerV2.of({
            awaitWork: Effect.void,
            runOnce: Effect.succeed(false),
            drain: () => Effect.succeed(0),
          }),
        ),
      );
      const first = yield* recovery.recover;
      assert.equal(first.terminalizedRuns, 1);
      assert.equal(first.retiredEffects, 1);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "interrupted");
      const effect = yield* outbox.get("effect:foundation-process-loss");
      assert.isTrue(Option.isSome(effect));
      if (Option.isSome(effect)) assert.equal(effect.value.status, "cancelled");

      const second = yield* recovery.recover;
      assert.equal(second.terminalizedRuns, 0);
      assert.equal(second.retiredEffects, 0);
    }),
  );

  it.effect("atomically fails one leased response effect with its release events", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const projections = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-response-terminalization");
      const commandId = CommandId.make("command:foundation-response-terminalization");
      const effectId = "effect:foundation-response-terminalization";
      const workerId = "worker:foundation-response-terminalization";
      const thread = makeThread(threadId, now);
      const initialRunId = RunId.make("run:foundation-response-terminalization:initial");
      const created = threadCreatedEvent({
        id: "event:foundation-response-terminalization:create",
        thread,
        now,
      });
      yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "runtime-request.respond",
        acceptedAt: now,
        events: [
          created,
          {
            id: EventId.make("event:foundation-response-terminalization:initial-run"),
            type: "run.created",
            threadId,
            runId: initialRunId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: initialRunId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:foundation-response-terminalization:initial"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
        effects: [
          {
            id: effectId,
            commandId,
            threadId,
            request: {
              type: "runtime-request.respond",
              providerSessionId: ProviderSessionId.make(
                "provider-session:foundation-response-terminalization",
              ),
              requestId: RuntimeRequestId.make("request:foundation-response-terminalization"),
              decision: "accept",
            },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_effect_outbox
        SET status = 'running', attempt_count = attempt_count + 1,
          lease_owner = ${workerId}, lease_expires_at = '9999-01-01T00:00:00.000Z'
        WHERE effect_id = ${effectId}
      `;

      const failedTransaction = yield* Effect.exit(
        eventSink.failEffectWithEvents({
          effectId,
          workerId,
          error: "provider delivery failed",
          commandId: CommandId.make(`${commandId}:delivery-failed`),
          events: [
            {
              id: EventId.make("event:foundation-response-terminalization:conflicting-run"),
              type: "run.created",
              threadId,
              runId: RunId.make("run:foundation-response-terminalization:conflict"),
              providerInstanceId,
              occurredAt: now,
              payload: {
                id: RunId.make("run:foundation-response-terminalization:conflict"),
                threadId,
                ordinal: 1,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(
                  "message:foundation-response-terminalization:conflict",
                ),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        }),
      );
      assert.equal(failedTransaction._tag, "Failure");
      const stillRunning = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(stillRunning));
      if (Option.isSome(stillRunning)) assert.equal(stillRunning.value.status, "running");

      const updatedThread = { ...thread, title: "Reservation released", updatedAt: now };
      const terminalized = yield* eventSink.failEffectWithEvents({
        effectId,
        workerId,
        error: "provider delivery failed",
        commandId: CommandId.make(`${commandId}:delivery-failed`),
        events: [
          {
            id: EventId.make("event:foundation-response-terminalization:released"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: updatedThread,
          },
        ],
      });
      assert.isTrue(terminalized.failed);
      const terminalEffect = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(terminalEffect));
      if (Option.isSome(terminalEffect)) assert.equal(terminalEffect.value.status, "failed");
      assert.equal(
        (yield* projections.getThreadProjection(threadId)).thread.title,
        updatedThread.title,
      );

      yield* outbox.enqueue([
        {
          id: `${effectId}:replacement`,
          commandId: CommandId.make(`${commandId}:replacement`),
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);
      let claimedReplacement = false;
      for (let index = 0; index < 20; index += 1) {
        const claimed = yield* outbox.claimNext({
          workerId: `${workerId}:replacement:${index}`,
          leaseDurationMs: 30_000,
        });
        if (Option.isNone(claimed)) break;
        if (claimed.value.id === `${effectId}:replacement`) {
          claimedReplacement = true;
          break;
        }
      }
      assert.isTrue(claimedReplacement);
    }),
  );

  it.effect("atomically orders runtime response completion against terminalization", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-runtime-request-guard");
      const responseLosesId = RuntimeRequestId.make("request:foundation-response-loses");
      const responseWinsId = RuntimeRequestId.make("request:foundation-response-wins");
      const responseLosesCommandId = CommandId.make("command:foundation-response-loses");
      const responseWinsCommandId = CommandId.make("command:foundation-response-wins");
      const responseLosesNodeId = NodeId.make("node:foundation-response-loses");
      const responseWinsNodeId = NodeId.make("node:foundation-response-wins");
      const pendingRequest = (input: {
        readonly id: RuntimeRequestId;
        readonly nodeId: NodeId;
        readonly responseCommandId: CommandId;
      }) => ({
        id: input.id,
        nodeId: input.nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command" as const,
        status: "pending" as const,
        responseCommandId: input.responseCommandId,
        responseAttempt: 1,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("provider-session:foundation-request-guard"),
        },
        createdAt: now,
        resolvedAt: null,
      });
      const responseLoses = pendingRequest({
        id: responseLosesId,
        nodeId: responseLosesNodeId,
        responseCommandId: responseLosesCommandId,
      });
      const responseWins = pendingRequest({
        id: responseWinsId,
        nodeId: responseWinsNodeId,
        responseCommandId: responseWinsCommandId,
      });
      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-runtime-request-guard:thread",
            thread: makeThread(threadId, now),
            now,
          }),
          {
            id: EventId.make("event:foundation-runtime-request-guard:loses-pending"),
            type: "runtime-request.updated",
            threadId,
            nodeId: responseLosesNodeId,
            occurredAt: now,
            payload: responseLoses,
          },
          {
            id: EventId.make("event:foundation-runtime-request-guard:wins-pending"),
            type: "runtime-request.updated",
            threadId,
            nodeId: responseWinsNodeId,
            occurredAt: now,
            payload: responseWins,
          },
        ],
      });

      const terminalFirst = yield* eventSink.writeIfRuntimeRequestsCurrent({
        events: [
          {
            id: EventId.make("event:foundation-runtime-request-guard:terminal-first"),
            type: "runtime-request.updated",
            threadId,
            nodeId: responseLosesNodeId,
            occurredAt: now,
            payload: {
              ...responseLoses,
              status: "cancelled",
              responseCapability: { type: "not_resumable", reason: "Cancelled first." },
              resolvedAt: now,
            },
          },
        ],
        guards: [{ threadId, requestId: responseLosesId, expectedStatus: "pending" }],
      });
      const staleResponse = yield* eventSink.writeIfRuntimeRequestsCurrent({
        commandId: CommandId.make(`${responseLosesCommandId}:delivered`),
        events: [
          {
            id: EventId.make("event:foundation-runtime-request-guard:stale-response"),
            type: "runtime-request.updated",
            threadId,
            nodeId: responseLosesNodeId,
            occurredAt: now,
            payload: { ...responseLoses, status: "resolved", resolvedAt: now },
          },
        ],
        guards: [
          {
            threadId,
            requestId: responseLosesId,
            expectedStatus: "pending",
            expectedResponseCommandId: responseLosesCommandId,
          },
        ],
      });

      const responseFirst = yield* eventSink.writeIfRuntimeRequestsCurrent({
        commandId: CommandId.make(`${responseWinsCommandId}:delivered`),
        events: [
          {
            id: EventId.make("event:foundation-runtime-request-guard:response-first"),
            type: "runtime-request.updated",
            threadId,
            nodeId: responseWinsNodeId,
            occurredAt: now,
            payload: { ...responseWins, status: "resolved", resolvedAt: now },
          },
        ],
        guards: [
          {
            threadId,
            requestId: responseWinsId,
            expectedStatus: "pending",
            expectedResponseCommandId: responseWinsCommandId,
          },
        ],
      });
      const staleTerminalization = yield* eventSink.writeIfRuntimeRequestsCurrent({
        events: [
          {
            id: EventId.make("event:foundation-runtime-request-guard:stale-terminalization"),
            type: "runtime-request.updated",
            threadId,
            nodeId: responseWinsNodeId,
            occurredAt: now,
            payload: {
              ...responseWins,
              status: "expired",
              responseCapability: { type: "not_resumable", reason: "Expired too late." },
              resolvedAt: now,
            },
          },
        ],
        guards: [{ threadId, requestId: responseWinsId, expectedStatus: "pending" }],
      });

      assert.isTrue(terminalFirst.committed);
      assert.isFalse(staleResponse.committed);
      assert.isTrue(responseFirst.committed);
      assert.isFalse(staleTerminalization.committed);
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === responseLosesId)?.status,
        "cancelled",
      );
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === responseWinsId)?.status,
        "resolved",
      );
    }),
  );

  it.effect("allocates collision-free positions beyond 100 items and rebuilds equivalently", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-many-items");
      const runId = RunId.make("run:foundation-many-items");
      const providerThreadId = ProviderThreadId.make("provider-thread:foundation-many-items");
      const thread = makeThread(threadId, now);
      const providerThreadEvent = {
        id: EventId.make("event:foundation-many-items:provider-thread"),
        type: "provider-thread.updated" as const,
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: providerDriver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies OrchestrationV2DomainEvent;
      const runEvent = {
        id: EventId.make("event:foundation-many-items:run"),
        type: "run.created" as const,
        threadId,
        runId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:foundation-many-items"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed" as const,
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      } satisfies OrchestrationV2DomainEvent;
      const items = Array.from({ length: 151 }, (_, index) => ({
        id: TurnItemId.make(`turn-item:foundation-many-items:${index}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index % 3,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool" as const,
        toolName: `tool-${index}`,
        input: { index },
        output: { completed: true },
      }));
      const itemEvents = items.map(
        (item, index) =>
          ({
            id: EventId.make(`event:foundation-many-items:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: item,
          }) satisfies OrchestrationV2DomainEvent,
      );

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ id: "event:foundation-many-items:thread", thread, now }),
          providerThreadEvent,
          runEvent,
          ...itemEvents,
        ],
      });
      const beforeUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(beforeUpdate.thread.activeProviderThreadId, providerThreadId);
      const ordinals = beforeUpdate.turnItems.map((item) => item.ordinal);
      assert.lengthOf(ordinals, 151);
      assert.equal(new Set(ordinals).size, 151);
      assert.isTrue(ordinals.every((ordinal) => ordinal > 1_000_000));
      assert.isTrue(
        ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]!),
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-many-items:update"),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...items[0]!, ordinal: 99_999_999, title: "Updated" },
          },
        ],
      });
      const afterUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterUpdate.turnItems[0]?.ordinal, ordinals[0]);
      assert.equal((yield* maintenance.verify).valid, true);

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = '{}'
        WHERE turn_item_id = ${items[75]!.id}
      `;
      const broken = yield* maintenance.verify;
      assert.isFalse(broken.valid);
      assert.deepEqual(broken.unreadableThreadIds, [threadId]);

      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);
      assert.lengthOf((yield* projectionStore.getThreadProjection(threadId)).turnItems, 151);
    }),
  );
});

it.live("keeps claiming new work after repeated idle periods", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutboxV2;
    const completed = new Map<string, Deferred.Deferred<void>>();
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: (effect) => {
          const completion = completed.get(effect.id);
          return completion === undefined
            ? Effect.die(`Missing completion signal for ${effect.id}`)
            : Deferred.succeed(completion, undefined).pipe(Effect.asVoid);
        },
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({
      workerId: "idle-wave-worker",
    }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

    yield* Effect.gen(function* () {
      yield* runEffectWorkerDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
      for (let wave = 1; wave <= 6; wave += 1) {
        yield* Effect.sleep("125 millis");
        const effectId = `effect:foundation-idle-wave:${wave}`;
        const completion = yield* Deferred.make<void>();
        completed.set(effectId, completion);
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId: CommandId.make(`command:foundation-idle-wave:${wave}`),
            threadId: ThreadId.make(`thread:foundation-idle-wave:${wave}`),
            request: { type: "terminal.cleanup" },
          },
        ]);
        const observed = yield* Deferred.await(completion).pipe(Effect.timeoutOption("2 seconds"));
        assert.isTrue(Option.isSome(observed), `worker stopped before idle wave ${wave}`);
      }
    }).pipe(Effect.provide(workerLayer), Effect.scoped);
  }).pipe(Effect.provide(TestLayer)),
);
