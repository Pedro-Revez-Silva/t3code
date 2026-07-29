import { assert, expect, it, vi } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  ProviderTurnControlError,
  ProviderTurnControlServiceV2,
} from "./ProviderTurnControlService.ts";

const DelegatedTaskReconcilerLayer = Layer.mock(OrchestratorV2)({
  reconcileDelegatedTasks: Effect.succeed(0),
});
const ProviderSessionsLayer = Layer.merge(
  Layer.mock(ProviderSessionManagerV2)({ release: () => Effect.void }),
  Layer.mock(ProviderTurnControlServiceV2)({ interruptAndAwaitTerminal: () => Effect.void }),
);
const eventSinkRecoveryLayer = (overrides: Partial<EventSink.EventSinkV2["Service"]> = {}) =>
  Layer.mock(EventSink.EventSinkV2)({
    activateProviderMutationOwner: Effect.succeed({ activated: true, leaseEpoch: 1 }),
    heartbeatProviderMutationOwner: Effect.succeed(true),
    listAbandonedProviderMutations: Effect.succeed([]),
    ...overrides,
  });

it.effect("drains durable effects before reporting recovery complete", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          eventSinkRecoveryLayer(),
          IdAllocator.layer,
          DelegatedTaskReconcilerLayer,
          ProviderSessionsLayer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runOnce: Ref.getAndUpdate(runs, (count) => count + 1).pipe(
              Effect.map((count) => count < 2),
            ),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    const summary = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((recovery) => recovery.recover),
      Effect.provide(layer),
    );
    assert.deepEqual(summary, {
      terminalizedRuns: 0,
      stoppedSessions: 0,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
      executedEffects: 2,
    });
  }),
);

it.effect("expires orphaned runtime requests before command readiness", () => {
  const threadId = ThreadId.make("thread_recovery_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const committed = vi.fn(
    (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => {
      committedInput = input;
      return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
    },
  );
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_orphaned"),
        nodeId: NodeId.make("node_orphaned"),
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "old process" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        eventSinkRecoveryLayer({ commitCommand: committed }),
        IdAllocator.layer,
        DelegatedTaskReconcilerLayer,
        ProviderSessionsLayer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    assert.equal(command?.events[0]?.type, "runtime-request.updated");
    if (command?.events[0]?.type === "runtime-request.updated") {
      assert.equal(command.events[0].payload.status, "expired");
      assert.equal(command.events[0].payload.responseCapability.type, "not_resumable");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("uses the same reconciliation path to cancel runtime requests during shutdown", () => {
  const threadId = ThreadId.make("thread_shutdown_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_shutdown"),
        nodeId: NodeId.make("node_shutdown"),
        status: "pending",
        responseCapability: { type: "live" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        eventSinkRecoveryLayer({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
          },
        }),
        IdAllocator.layer,
        DelegatedTaskReconcilerLayer,
        ProviderSessionsLayer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("shutdown");
    assert.equal(summary.closedRequests, 1);
    assert.equal(summary.retiredEffects, 1);
    const requestEvent = committedInput?.events[0];
    assert.equal(requestEvent?.type, "runtime-request.updated");
    if (requestEvent?.type === "runtime-request.updated") {
      assert.equal(requestEvent.payload.status, "cancelled");
      assert.equal(requestEvent.payload.responseCapability.type, "not_resumable");
      if (requestEvent.payload.responseCapability.type === "not_resumable") {
        assert.match(requestEvent.payload.responseCapability.reason, /shut down/);
      }
    }
  }).pipe(Effect.provide(layer));
});

it.effect("preserves a waiting run while its replay-safe checkpoint capture is unsettled", () => {
  const threadId = ThreadId.make("thread_waiting_checkpoint");
  const runId = RunId.make("run_waiting_checkpoint");
  const committed = vi.fn(() => Effect.succeed({ committed: true } as never));
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    runs: [{ id: runId, status: "waiting" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        eventSinkRecoveryLayer({ commitCommand: committed }),
        IdAllocator.layer,
        DelegatedTaskReconcilerLayer,
        ProviderSessionsLayer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () =>
            Effect.succeed([
              {
                request: { type: "checkpoint.capture", runId },
                status: "running",
              },
            ] as never),
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 1, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 0);
    assert.equal(summary.requeuedEffects, 1);
    assert.equal(committed.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("cancels a stale waiting run when no checkpoint capture can finish it", () => {
  const threadId = ThreadId.make("thread_stale_waiting");
  const runId = RunId.make("run_stale_waiting");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "waiting",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        eventSinkRecoveryLayer({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        DelegatedTaskReconcilerLayer,
        ProviderSessionsLayer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 1);
    const runEvent = committedInput?.events.find((event) => event.type === "run.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "interrupted");
  }).pipe(Effect.provide(layer));
});

it.effect("cancels accepted queued work instead of replaying it after restart", () => {
  const threadId = ThreadId.make("thread_queued_restart");
  const runId = RunId.make("run_queued_restart");
  const attemptId = RunAttemptId.make("attempt_queued_restart");
  const rootNodeId = NodeId.make("node_queued_restart");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "queued",
        queuePosition: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        runId,
        status: "pending",
      },
    ],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        eventSinkRecoveryLayer({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        DelegatedTaskReconcilerLayer,
        ProviderSessionsLayer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 1);
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    const runEvent = command.events.find((event) => event.type === "run.updated");
    const attemptEvent = command.events.find((event) => event.type === "run-attempt.updated");
    const nodeEvent = command.events.find((event) => event.type === "node.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "interrupted");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queuePosition : 1, null);
    assert.equal(
      attemptEvent?.type === "run-attempt.updated" ? attemptEvent.payload.status : null,
      "interrupted",
    );
    assert.equal(
      nodeEvent?.type === "node.updated" ? nodeEvent.payload.status : null,
      "interrupted",
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "cancels the complete in-flight subtree and stops its persisted session without reopening it",
  () => {
    const threadId = ThreadId.make("thread_recovery_cancel");
    const runId = RunId.make("run_recovery_cancel");
    const attemptId = RunAttemptId.make("attempt_recovery_cancel");
    const rootNodeId = NodeId.make("node_recovery_cancel");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_cancel");
    const providerTurnId = ProviderTurnId.make("provider_turn_recovery_cancel");
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_cancel");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "active",
        },
      ],
      providerTurns: [
        {
          id: providerTurnId,
          runAttemptId: attemptId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
      runs: [
        {
          id: runId,
          status: "starting",
          providerThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
      attempts: [
        {
          id: attemptId,
          runId,
          rootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: rootNodeId, runId, status: "running" }],
      subagents: [],
      messages: [{ id: MessageId.make("message_recovery_cancel"), runId, streaming: true }],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_recovery_cancel"),
          runId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [{ id: threadId }],
                archivedThreads: [],
              } as never),
            getThreadProjection: () => Effect.succeed(projection),
          }),
          eventSinkRecoveryLayer({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 2 } as never);
            },
          }),
          IdAllocator.layer,
          DelegatedTaskReconcilerLayer,
          ProviderSessionsLayer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)
        .recover;
      assert.equal(summary.terminalizedRuns, 1);
      assert.equal(summary.stoppedSessions, 1);
      assert.equal(summary.retiredEffects, 2);
      assert.deepEqual(committedInput?.cancelUnsettledEffects?.effectTypes, [
        "provider-turn.start",
        "provider-turn.interrupt",
        "provider-turn.steer",
        "provider-turn.restart",
        "runtime-request.respond",
      ]);
      const events = committedInput?.events ?? [];
      assert.deepEqual(
        events.map((event) => [
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
        [
          ["run.updated", "interrupted"],
          ["run-attempt.updated", "interrupted"],
          ["node.updated", "interrupted"],
          ["provider-turn.updated", "interrupted"],
          ["message.updated", null],
          ["turn-item.updated", "interrupted"],
          ["provider-thread.updated", "idle"],
          ["provider-session.updated", "stopped"],
        ],
      );
      const messageEvent = events.find((event) => event.type === "message.updated");
      assert.isFalse(messageEvent?.type === "message.updated" && messageEvent.payload.streaming);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("hard-detaches ownership before terminalizing a provider turn that does not stop", () => {
  const threadId = ThreadId.make("thread_force_interrupt_nonterminal");
  const runId = RunId.make("run_force_interrupt_nonterminal");
  const attemptId = RunAttemptId.make("attempt_force_interrupt_nonterminal");
  const nodeId = NodeId.make("node_force_interrupt_nonterminal");
  const providerThreadId = ProviderThreadId.make("provider_thread_force_interrupt_nonterminal");
  const providerTurnId = ProviderTurnId.make("provider_turn_force_interrupt_nonterminal");
  const providerSessionId = ProviderSessionId.make("provider_session_force_interrupt_nonterminal");
  const commitCommand = vi.fn(() => Effect.succeed({ committed: true } as never));
  const hardStop = vi.fn(() => Effect.void);
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [{ id: providerSessionId, status: "ready" }],
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "active",
      },
    ],
    providerTurns: [
      {
        id: providerTurnId,
        providerThreadId,
        runAttemptId: attemptId,
        nodeId,
        status: "running",
      },
    ],
    runs: [
      {
        id: runId,
        providerThreadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
      },
    ],
    attempts: [{ id: attemptId, runId, rootNodeId: nodeId, status: "running" }],
    nodes: [{ id: nodeId, runId, status: "running" }],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        eventSinkRecoveryLayer({ commitCommand }),
        IdAllocator.layer,
        DelegatedTaskReconcilerLayer,
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControlServiceV2)({
          interruptAndAwaitTerminal: () =>
            Effect.fail(
              new ProviderTurnControlError({
                threadId,
                operation: "restart",
                providerTurnId,
                cause: "provider turn remained live",
              }),
            ),
          hardStop,
        }),
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
        Layer.mock(EffectOutbox.EffectOutboxV2)({}),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((recovery) => recovery.forceInterruptThread(threadId)),
      Effect.provide(layer),
    );
    assert.equal(summary.terminalizedRuns, 1);
    expect(hardStop).toHaveBeenCalledWith({
      threadId,
      providerSessionId,
      providerThreadId,
      providerTurnId,
    });
    assert.equal(commitCommand.mock.calls.length, 1);
  });
});

it.effect("force-interrupts one thread without releasing its shared Codex session", () =>
  Effect.gen(function* () {
    const cancelledThreadId = ThreadId.make("thread_shared_codex_cancelled");
    const unrelatedThreadId = ThreadId.make("thread_shared_codex_unrelated");
    const sharedSessionId = ProviderSessionId.make("provider_session_shared_codex");
    const cancelledRunId = RunId.make("run_shared_codex_cancelled");
    const unrelatedRunId = RunId.make("run_shared_codex_unrelated");
    const cancelledAttemptId = RunAttemptId.make("attempt_shared_codex_cancelled");
    const cancelledNodeId = NodeId.make("node_shared_codex_cancelled");
    const cancelledProviderThreadId = ProviderThreadId.make(
      "provider_thread_shared_codex_cancelled",
    );
    const unrelatedProviderThreadId = ProviderThreadId.make(
      "provider_thread_shared_codex_unrelated",
    );
    const cancelledProviderTurnId = ProviderTurnId.make("provider_turn_shared_codex_cancelled");
    const release = vi.fn(() => Effect.void);
    const interruptAndAwaitTerminal = vi.fn(() => Effect.void);
    const committedEvents = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const cancelledProjection = {
      thread: { id: cancelledThreadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: sharedSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: cancelledProviderThreadId,
          providerSessionId: sharedSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "active",
        },
      ],
      providerTurns: [
        {
          id: cancelledProviderTurnId,
          providerThreadId: cancelledProviderThreadId,
          runAttemptId: cancelledAttemptId,
          nodeId: cancelledNodeId,
          status: "running",
        },
      ],
      runs: [
        {
          id: cancelledRunId,
          status: "running",
          providerThreadId: cancelledProviderThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
      attempts: [
        {
          id: cancelledAttemptId,
          runId: cancelledRunId,
          rootNodeId: cancelledNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: cancelledNodeId, runId: cancelledRunId, status: "running" }],
      subagents: [],
      messages: [],
      turnItems: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const unrelatedProjection = yield* Ref.make({
      thread: { id: unrelatedThreadId },
      providerSessions: [{ id: sharedSessionId, status: "ready" }],
      providerThreads: [
        {
          id: unrelatedProviderThreadId,
          providerSessionId: sharedSessionId,
          status: "active",
        },
      ],
      runs: [{ id: unrelatedRunId, status: "running" }],
    });
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: (threadId) =>
              threadId === cancelledThreadId
                ? Effect.succeed(cancelledProjection)
                : Ref.get(unrelatedProjection).pipe(Effect.map((value) => value as never)),
          }),
          eventSinkRecoveryLayer({
            commitCommand: (input) =>
              Ref.set(committedEvents, input.events).pipe(
                Effect.as({ committed: true, cancelledEffectCount: 1 } as never),
              ),
          }),
          IdAllocator.layer,
          DelegatedTaskReconcilerLayer,
          Layer.mock(ProviderSessionManagerV2)({ release }),
          Layer.mock(ProviderTurnControlServiceV2)({
            interruptAndAwaitTerminal,
          }),
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );

    const summary = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((recovery) => recovery.forceInterruptThread(cancelledThreadId)),
      Effect.provide(layer),
    );

    assert.equal(summary.terminalizedRuns, 1);
    assert.equal(summary.stoppedSessions, 0);
    assert.equal(release.mock.calls.length, 0);
    expect(interruptAndAwaitTerminal).toHaveBeenCalledWith({
      threadId: cancelledThreadId,
      providerSessionId: sharedSessionId,
      providerThreadId: cancelledProviderThreadId,
      providerTurnId: cancelledProviderTurnId,
      interruptedAttemptId: cancelledAttemptId,
    });
    assert.isFalse(
      (yield* Ref.get(committedEvents)).some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "provider-session.updated",
      ),
    );
    const unrelated = yield* Ref.get(unrelatedProjection);
    assert.equal(unrelated.runs[0]?.status, "running");
    assert.equal(unrelated.providerSessions[0]?.status, "ready");
    assert.equal(unrelated.providerThreads[0]?.status, "active");
  }),
);
