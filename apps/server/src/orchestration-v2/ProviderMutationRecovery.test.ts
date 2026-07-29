import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  ProviderRuntimeRecoveryService,
  layer as providerRuntimeRecoveryLayer,
} from "./ProviderRuntimeRecoveryService.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";

const phases = [
  "reserved",
  "filesystem_started",
  "filesystem_restored",
  "provider_started",
  "provider_restored",
  "cleanup_started",
  "external_complete",
] as const;

const StoresLayer = Layer.merge(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const EventSinkLayer = eventSinkLayer.pipe(
  Layer.provide(Layer.mergeAll(StoresLayer, SqlitePersistenceMemory)),
);
const RecoveryLayer = providerRuntimeRecoveryLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      StoresLayer,
      EventSinkLayer,
      IdAllocator.layer,
      Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
      Layer.mock(EffectOutbox.EffectOutboxV2)({
        reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        cancelUnsettled: () => Effect.succeed([]),
        signalCancellations: () => Effect.void,
      }),
      Layer.mock(OrchestratorV2)({ reconcileDelegatedTasks: Effect.succeed(0) }),
      Layer.mock(ProviderTurnControlServiceV2)({}),
    ),
  ),
);
const TestLayer = Layer.mergeAll(
  SqlitePersistenceMemory,
  StoresLayer,
  EventSinkLayer,
  RecoveryLayer,
);

it.effect("recovers abandoned rollback reservations at every durable crash phase", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const driver = ProviderDriverKind.make("codex");
    const providerInstanceId = ProviderInstanceId.make("codex");

    for (const [index, phase] of phases.entries()) {
      const threadId = ThreadId.make(`thread:mutation-recovery:${phase}`);
      const providerSessionId = ProviderSessionId.make(`session:mutation-recovery:${phase}`);
      const providerThreadId = ProviderThreadId.make(`provider-thread:mutation-recovery:${phase}`);
      const runId = RunId.make(`run:mutation-recovery:${phase}`);
      const attemptId = RunAttemptId.make(`attempt:mutation-recovery:${phase}`);
      const rootNodeId = NodeId.make(`node:mutation-recovery:${phase}`);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:mutation-recovery:${phase}:thread`),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: threadId,
              projectId: ProjectId.make("project:mutation-recovery"),
              title: `Mutation recovery ${phase}`,
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: "/workspace",
              activeProviderThreadId: providerThreadId,
              createdBy: "user",
              creationSource: "web",
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              deletedAt: null,
            },
          },
          {
            id: EventId.make(`event:mutation-recovery:${phase}:session`),
            type: "provider-session.attached",
            threadId,
            driver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver,
              providerInstanceId,
              status: "ready",
              cwd: "/workspace",
              model: "gpt-5.4",
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make(`event:mutation-recovery:${phase}:provider-thread`),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId,
              providerSessionId,
              appThreadId: threadId,
              ownerNodeId: rootNodeId,
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
            id: EventId.make(`event:mutation-recovery:${phase}:run`),
            type: "run.created",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
              providerThreadId,
              userMessageId: MessageId.make(`message:mutation-recovery:${phase}`),
              rootNodeId,
              activeAttemptId: attemptId,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make(`event:mutation-recovery:${phase}:node`),
            type: "node.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: rootNodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "completed",
              countsForRun: true,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: now,
            },
          },
        ],
      });
      yield* sql`
        INSERT INTO orchestration_v2_provider_rollback_reservations (
          reservation_id,
          owner_instance_id,
          lease_epoch,
          thread_id,
          provider_instance_id,
          run_id,
          attempt_id,
          provider_thread_id,
          provider_session_id,
          generation,
          checkpoint_id,
          scope_id,
          target_run_ordinal,
          target_resolution,
          phase,
          created_at,
          updated_at
        ) VALUES (
          ${`reservation:mutation-recovery:${phase}`},
          'crashed-instance',
          1,
          ${threadId},
          ${providerInstanceId},
          ${runId},
          ${attemptId},
          ${providerThreadId},
          ${providerSessionId},
          0,
          ${`checkpoint:mutation-recovery:${phase}`},
          ${`scope:mutation-recovery:${phase}`},
          0,
          'exact',
          ${phase},
          ${DateTime.formatIso(DateTime.add(now, { milliseconds: index }))},
          ${DateTime.formatIso(now)}
        )
      `;
    }
    const ambiguousThreadId = ThreadId.make("thread:mutation-recovery:filesystem_restored");
    const ambiguousProviderThreadId = ProviderThreadId.make(
      "provider-thread:mutation-recovery:filesystem_restored",
    );
    for (const ordinal of [2, 3]) {
      const runId = RunId.make(`run:mutation-recovery:ambiguous:${ordinal}`);
      const rootNodeId = NodeId.make(`node:mutation-recovery:ambiguous:${ordinal}`);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:mutation-recovery:ambiguous:run:${ordinal}`),
            type: "run.created",
            threadId: ambiguousThreadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: ambiguousThreadId,
              ordinal,
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
              providerThreadId: ambiguousProviderThreadId,
              userMessageId: MessageId.make(`message:mutation-recovery:ambiguous:${ordinal}`),
              rootNodeId,
              activeAttemptId: RunAttemptId.make(`attempt:mutation-recovery:ambiguous:${ordinal}`),
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
      });
    }
    yield* sql`
      UPDATE orchestration_v2_provider_rollback_reservations
      SET target_run_ordinal = NULL, target_resolution = 'ambiguous'
      WHERE reservation_id = 'reservation:mutation-recovery:filesystem_restored'
    `;
    yield* sql`
      INSERT INTO orchestration_v2_provider_mutation_owner (
        singleton_id,
        instance_id,
        lease_epoch,
        lease_expires_at,
        updated_at
      ) VALUES (1, 'crashed-instance', 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
    `;

    yield* recovery.recover;

    const remaining = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_provider_rollback_reservations
    `;
    assert.deepStrictEqual(remaining, [{ count: 0 }]);
    for (const phase of phases) {
      const projection = yield* projections.getThreadProjection(
        ThreadId.make(`thread:mutation-recovery:${phase}`),
      );
      if (phase === "reserved") {
        assert.equal(projection.runs[0]?.status, "completed");
        assert.isNotNull(projection.providerThreads[0]?.providerSessionId);
        continue;
      }
      assert.equal(
        projection.runs[0]?.status,
        phase === "filesystem_started" || phase === "filesystem_restored"
          ? "interrupted"
          : "rolled_back",
        phase,
      );
      if (phase === "filesystem_restored") {
        assert.deepStrictEqual(
          projection.runs.map((run) => run.status),
          ["interrupted", "interrupted", "interrupted"],
        );
      }
      assert.isNull(projection.providerThreads[0]?.providerSessionId, phase);
      const generation = yield* sql<{ readonly generation: number }>`
        SELECT generation
        FROM orchestration_v2_provider_session_generations
        WHERE thread_id = ${projection.thread.id}
          AND provider_instance_id = ${providerInstanceId}
      `;
      assert.deepStrictEqual(generation, [{ generation: 1 }], phase);
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("does not take over an unexpired mutation owner lease", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    yield* sql`
      INSERT INTO orchestration_v2_provider_mutation_owner (
        singleton_id,
        instance_id,
        lease_epoch,
        lease_expires_at,
        updated_at
      ) VALUES (
        1,
        'live-other-instance',
        7,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minute'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_provider_rollback_reservations (
        reservation_id,
        owner_instance_id,
        lease_epoch,
        thread_id,
        provider_instance_id,
        run_id,
        attempt_id,
        provider_thread_id,
        provider_session_id,
        generation,
        checkpoint_id,
        scope_id,
        target_run_ordinal,
        target_resolution,
        phase,
        created_at,
        updated_at
      ) VALUES (
        'reservation:live-other-instance',
        'live-other-instance',
        7,
        'thread:live-other-instance',
        'codex',
        'run:live-other-instance',
        'attempt:live-other-instance',
        'provider-thread:live-other-instance',
        'provider-session:live-other-instance',
        0,
        'checkpoint:live-other-instance',
        'scope:live-other-instance',
        0,
        'exact',
        'filesystem_started',
        ${DateTime.formatIso(now)},
        ${DateTime.formatIso(now)}
      )
    `;
    const activation = yield* eventSink.activateProviderMutationOwner;
    assert.isFalse(activation.activated);
    assert.deepStrictEqual(yield* eventSink.listAbandonedProviderMutations, []);
    const owner = yield* sql<{ readonly instance_id: string; readonly lease_epoch: number }>`
      SELECT instance_id, lease_epoch
      FROM orchestration_v2_provider_mutation_owner
      WHERE singleton_id = 1
    `;
    assert.deepStrictEqual(owner, [{ instance_id: "live-other-instance", lease_epoch: 7 }]);
    const reservations = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_provider_rollback_reservations
    `;
    assert.deepStrictEqual(reservations, [{ count: 1 }]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("fences heartbeat and terminal commit after database lease expiry", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:expired-mutation-owner");
    const runId = RunId.make("run:expired-mutation-owner");
    const attemptId = RunAttemptId.make("attempt:expired-mutation-owner");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerThreadId = ProviderThreadId.make("provider-thread:expired-mutation-owner");
    const providerSessionId = ProviderSessionId.make("provider-session:expired-mutation-owner");
    const rootNodeId = NodeId.make("node:expired-mutation-owner");
    const activation = yield* eventSink.activateProviderMutationOwner;
    assert.isTrue(activation.activated);
    const owner = yield* sql<{ readonly instance_id: string; readonly lease_epoch: number }>`
      SELECT instance_id, lease_epoch
      FROM orchestration_v2_provider_mutation_owner
      WHERE singleton_id = 1
    `;
    const currentOwner = owner[0]!;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:expired-mutation-owner:run"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
            providerThreadId,
            userMessageId: MessageId.make("message:expired-mutation-owner"),
            rootNodeId,
            activeAttemptId: attemptId,
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
    });
    yield* sql`
      INSERT INTO orchestration_v2_provider_rollback_reservations (
        reservation_id,
        owner_instance_id,
        lease_epoch,
        thread_id,
        provider_instance_id,
        run_id,
        attempt_id,
        provider_thread_id,
        provider_session_id,
        generation,
        checkpoint_id,
        scope_id,
        target_run_ordinal,
        target_resolution,
        phase,
        created_at,
        updated_at
      ) VALUES (
        'reservation:expired-mutation-owner',
        ${currentOwner.instance_id},
        ${currentOwner.lease_epoch},
        ${threadId},
        ${providerInstanceId},
        ${runId},
        ${attemptId},
        ${providerThreadId},
        ${providerSessionId},
        0,
        'checkpoint:expired-mutation-owner',
        'scope:expired-mutation-owner',
        0,
        'exact',
        'external_complete',
        ${DateTime.formatIso(now)},
        ${DateTime.formatIso(now)}
      )
    `;
    yield* sql`
      UPDATE orchestration_v2_provider_mutation_owner
      SET lease_expires_at = '1970-01-01T00:00:00.000Z'
      WHERE singleton_id = 1
    `;
    const terminal = yield* eventSink.writeIfProviderMutationCurrent({
      reservationId: "reservation:expired-mutation-owner",
      authority: {
        threadId,
        providerInstanceId,
        providerSessionId,
        providerThreadId,
        runId,
        activeAttemptId: attemptId,
        generation: 0,
        expectedRunStatus: "completed",
      },
      events: [],
    });
    assert.isFalse(terminal.committed);
    yield* eventSink.releaseProviderMutation({
      reservationId: "reservation:expired-mutation-owner",
      threadId,
      providerInstanceId,
    });
    assert.isFalse(yield* eventSink.heartbeatProviderMutationOwner);
    const rows = yield* sql<{ readonly reservation_id: string; readonly lease_expires_at: string }>`
      SELECT reservation.reservation_id, owner.lease_expires_at
      FROM orchestration_v2_provider_rollback_reservations AS reservation
      INNER JOIN orchestration_v2_provider_mutation_owner AS owner ON owner.singleton_id = 1
      WHERE reservation.reservation_id = 'reservation:expired-mutation-owner'
    `;
    assert.deepStrictEqual(rows, [
      {
        reservation_id: "reservation:expired-mutation-owner",
        lease_expires_at: "1970-01-01T00:00:00.000Z",
      },
    ]);
  }).pipe(Effect.provide(TestLayer)),
);
