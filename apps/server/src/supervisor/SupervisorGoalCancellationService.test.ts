import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  SupervisorGoalId,
  SupervisorGoalTaskId,
  SupervisorTaskAttemptId,
  ThreadId,
  type SupervisorGoal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SupervisorControlPlaneService } from "./SupervisorControlPlaneService.ts";
import {
  layer as cancellationLayer,
  SupervisorGoalCancellationService,
} from "./SupervisorGoalCancellationService.ts";

const goalId = SupervisorGoalId.make("goal:cancellation-recovery");
const taskId = SupervisorGoalTaskId.make("goal-task:cancellation-recovery");
const attemptId = SupervisorTaskAttemptId.make("goal-attempt:cancellation-recovery");
const nodeId = NodeId.make("node:cancellation-recovery");
const childThreadId = ThreadId.make("thread:cancellation-recovery");
const runId = RunId.make("run:cancellation-recovery");
const now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");
const outboxLayer = Layer.mock(EffectOutboxV2)({
  listByIdPrefix: () => Effect.succeed([]),
});
const recoveryLayer = Layer.mock(ProviderRuntimeRecoveryService)({
  forceInterruptThread: () =>
    Effect.succeed({
      terminalizedRuns: 1,
      stoppedSessions: 1,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
    }),
});
const cancellationTestLayer = (
  controlLayer: Layer.Layer<SupervisorControlPlaneService>,
  threadLayer: Layer.Layer<ThreadManagementService>,
  testOutboxLayer: Layer.Layer<EffectOutboxV2> = outboxLayer,
  testRecoveryLayer: Layer.Layer<ProviderRuntimeRecoveryService> = recoveryLayer,
) =>
  cancellationLayer.pipe(
    Layer.provide(Layer.mergeAll(controlLayer, threadLayer, testOutboxLayer, testRecoveryLayer)),
  );

const cancelledGoal: SupervisorGoal = {
  id: goalId,
  title: "Cancellation recovery",
  prompt: "Stop all delegated work.",
  status: "cancelled",
  revision: 2,
  tasks: [
    {
      id: taskId,
      goalId,
      projectId: ProjectId.make("project:cancellation-recovery"),
      taskKey: "worker",
      title: "Worker",
      prompt: "Keep running.",
      role: "implementation",
      priority: 0,
      dependencies: [],
      status: "cancelled",
      attempts: [
        {
          id: attemptId,
          goalId,
          taskId,
          attemptNumber: 1,
          clientRequestId: "cancel-recovery",
          status: "cancelled",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          nodeId,
          threadId: childThreadId,
          runId,
          error: null,
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      ],
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    },
  ],
  createdAt: DateTime.formatIso(now),
  updatedAt: DateTime.formatIso(now),
  cancelledAt: DateTime.formatIso(now),
};

it.effect("automatically retries a transient interruption without a restart", () =>
  Effect.gen(function* () {
    const persisted = yield* Deferred.make<void>();
    const recovered = yield* Deferred.make<void>();
    const dispatchAttempts = yield* Ref.make(0);
    const controlLayer = Layer.mock(SupervisorControlPlaneService)({
      cancelGoal: () =>
        Deferred.succeed(persisted, undefined).pipe(Effect.as({ goal: cancelledGoal })),
      listCancelledGoalsWithLinkedAttempts: () => Effect.succeed([cancelledGoal]),
    });
    const threadLayer = Layer.mock(ThreadManagementService)({
      getThreadProjection: () =>
        Effect.succeed({
          runs: [{ id: runId, status: "running" }],
        } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          assert.equal(command.type, "run.interrupt");
          const attempt = yield* Ref.updateAndGet(dispatchAttempts, (count) => count + 1);
          if (attempt === 1) return yield* Effect.fail("transient dispatch failure" as never);
          yield* Deferred.succeed(recovered, undefined);
          return { sequence: 1, storedEvents: [] };
        }),
    });
    const layer = cancellationTestLayer(controlLayer, threadLayer);

    yield* Effect.gen(function* () {
      const service = yield* SupervisorGoalCancellationService;
      const request = yield* service.cancelGoal({ goalId }).pipe(Effect.forkChild);
      yield* Deferred.await(persisted);
      yield* Fiber.interrupt(request);
      yield* Deferred.await(recovered);
      assert.equal(yield* Ref.get(dispatchAttempts), 2);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  }),
);

it.effect("coordinates every active attempt of a cancelled goal", () =>
  Effect.gen(function* () {
    const secondThreadId = ThreadId.make("thread:cancellation-recovery-second");
    const secondRunId = RunId.make("run:cancellation-recovery-second");
    const secondAttemptId = SupervisorTaskAttemptId.make("goal-attempt:cancellation-recovery:2");
    const multipleAttempts: SupervisorGoal = {
      ...cancelledGoal,
      tasks: [
        cancelledGoal.tasks[0]!,
        {
          ...cancelledGoal.tasks[0]!,
          id: SupervisorGoalTaskId.make("goal-task:cancellation-recovery:2"),
          taskKey: "worker-two",
          attempts: [
            {
              ...cancelledGoal.tasks[0]!.attempts[0]!,
              id: secondAttemptId,
              taskId: SupervisorGoalTaskId.make("goal-task:cancellation-recovery:2"),
              threadId: secondThreadId,
              runId: secondRunId,
            },
          ],
        },
      ],
    };
    const interrupted = yield* Ref.make(new Set<string>());
    const firstDispatchAttempts = yield* Ref.make(0);
    const secondAttempted = yield* Deferred.make<void>();
    const allInterrupted = yield* Deferred.make<void>();
    const firstCommandId = `command:system:supervisor-goal-cancel:${attemptId}:1`;
    const secondCommandId = `command:system:supervisor-goal-cancel:${secondAttemptId}:1`;
    const controlLayer = Layer.mock(SupervisorControlPlaneService)({
      cancelGoal: () => Effect.succeed({ goal: multipleAttempts }),
      listCancelledGoalsWithLinkedAttempts: () => Effect.succeed([multipleAttempts]),
    });
    const threadLayer = Layer.mock(ThreadManagementService)({
      getThreadProjection: (requestedThreadId) =>
        Effect.succeed({
          runs: [
            {
              id: requestedThreadId === childThreadId ? runId : secondRunId,
              status: "running",
            },
          ],
        } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          assert.equal(command.type, "run.interrupt");
          if (command.commandId === firstCommandId) {
            const attempt = yield* Ref.updateAndGet(firstDispatchAttempts, (count) => count + 1);
            if (attempt === 1)
              return yield* Effect.fail("first attempt transient failure" as never);
          }
          const ids = yield* Ref.updateAndGet(interrupted, (current) =>
            new Set(current).add(command.commandId),
          );
          if (command.commandId === secondCommandId) {
            yield* Deferred.succeed(secondAttempted, undefined);
          }
          if (ids.size === 2) yield* Deferred.succeed(allInterrupted, undefined);
          return { sequence: ids.size, storedEvents: [] };
        }),
    });
    const layer = cancellationTestLayer(controlLayer, threadLayer);

    yield* Effect.gen(function* () {
      const service = yield* SupervisorGoalCancellationService;
      yield* service.cancelGoal({ goalId });
      yield* Deferred.await(secondAttempted);
      yield* Deferred.await(allInterrupted);
      assert.deepEqual(yield* Ref.get(interrupted), new Set([firstCommandId, secondCommandId]));
    }).pipe(Effect.provide(layer), TestClock.withLive);
  }),
);

it.effect("re-dispatches when an accepted interrupt effect leaves the run active", () =>
  Effect.gen(function* () {
    const effects = yield* Ref.make<ReadonlyArray<never>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const redispatched = yield* Deferred.make<void>();
    const controlLayer = Layer.mock(SupervisorControlPlaneService)({
      cancelGoal: () => Effect.succeed({ goal: cancelledGoal }),
      listCancelledGoalsWithLinkedAttempts: () => Effect.succeed([cancelledGoal]),
    });
    const threadLayer = Layer.mock(ThreadManagementService)({
      getThreadProjection: () =>
        Effect.succeed({ runs: [{ id: runId, status: "running" }] } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          const updated = yield* Ref.updateAndGet(commands, (current) => [
            ...current,
            command.commandId,
          ]);
          const currentTime = yield* DateTime.now;
          yield* Ref.update(effects, (current) => [
            ...current,
            {
              id: `effect:${command.commandId}:provider-turn.interrupt:turn`,
              commandId: command.commandId,
              threadId: childThreadId,
              request: { type: "provider-turn.interrupt" },
              status: "succeeded",
              updatedAt: DateTime.formatIso(
                DateTime.makeUnsafe(DateTime.toEpochMillis(currentTime) - 10_000),
              ),
            } as never,
          ]);
          if (updated.length === 2) yield* Deferred.succeed(redispatched, undefined);
          return { sequence: updated.length, storedEvents: [] };
        }),
    });
    const testOutbox = Layer.mock(EffectOutboxV2)({
      listByIdPrefix: () => Ref.get(effects),
    });
    const layer = cancellationTestLayer(controlLayer, threadLayer, testOutbox);

    yield* Effect.gen(function* () {
      const service = yield* SupervisorGoalCancellationService;
      yield* service.cancelGoal({ goalId });
      yield* Deferred.await(redispatched);
      assert.deepEqual(yield* Ref.get(commands), [
        `command:system:supervisor-goal-cancel:${attemptId}:1`,
        `command:system:supervisor-goal-cancel:${attemptId}:2`,
      ]);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  }),
);

it.effect("forces safe teardown after repeated interrupt effects leave the run active", () =>
  Effect.gen(function* () {
    const runStatus = yield* Ref.make<"running" | "interrupted">("running");
    const forced = yield* Deferred.make<void>();
    const controlLayer = Layer.mock(SupervisorControlPlaneService)({
      cancelGoal: () => Effect.succeed({ goal: cancelledGoal }),
      listCancelledGoalsWithLinkedAttempts: () => Effect.succeed([cancelledGoal]),
    });
    const threadLayer = Layer.mock(ThreadManagementService)({
      getThreadProjection: () =>
        Ref.get(runStatus).pipe(
          Effect.map((status) => ({ runs: [{ id: runId, status }] }) as never),
        ),
      dispatch: () => Effect.die("force teardown should happen before another dispatch"),
    });
    const testOutbox = Layer.mock(EffectOutboxV2)({
      listByIdPrefix: (prefix) =>
        Effect.succeed(
          Array.from({ length: 3 }, (_, index) => ({
            id: `${prefix}${index + 1}:provider-turn.interrupt:turn`,
            request: { type: "provider-turn.interrupt" },
            status: "failed",
            updatedAt: "2026-07-26T00:00:00.000Z",
          })) as never,
        ),
    });
    const testRecovery = Layer.mock(ProviderRuntimeRecoveryService)({
      forceInterruptThread: () =>
        Ref.set(runStatus, "interrupted").pipe(
          Effect.andThen(Deferred.succeed(forced, undefined)),
          Effect.as({
            terminalizedRuns: 1,
            stoppedSessions: 1,
            closedRequests: 0,
            retiredEffects: 3,
            requeuedEffects: 0,
          }),
        ),
    });
    const layer = cancellationTestLayer(controlLayer, threadLayer, testOutbox, testRecovery);

    yield* Effect.gen(function* () {
      const service = yield* SupervisorGoalCancellationService;
      yield* service.cancelGoal({ goalId });
      yield* Deferred.await(forced);
      assert.equal(yield* Ref.get(runStatus), "interrupted");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not force recovery while successful interrupts await projection reconciliation",
  () =>
    Effect.gen(function* () {
      const forced = yield* Ref.make(0);
      const controlLayer = Layer.mock(SupervisorControlPlaneService)({
        listCancelledGoalsWithLinkedAttempts: () => Effect.succeed([cancelledGoal]),
      });
      const threadLayer = Layer.mock(ThreadManagementService)({
        getThreadProjection: () =>
          Effect.succeed({ runs: [{ id: runId, status: "running" }] } as never),
        dispatch: () => Effect.die("a fresh successful interrupt must not be re-dispatched"),
      });
      const testOutbox = Layer.mock(EffectOutboxV2)({
        listByIdPrefix: (prefix) =>
          DateTime.now.pipe(
            Effect.map((currentTime) =>
              Array.from({ length: 3 }, (_, index) => ({
                id: `${prefix}${index + 1}:provider-turn.interrupt:turn`,
                request: { type: "provider-turn.interrupt" },
                status: "succeeded",
                updatedAt: DateTime.formatIso(currentTime),
              })),
            ),
          ) as never,
      });
      const testRecovery = Layer.mock(ProviderRuntimeRecoveryService)({
        forceInterruptThread: () =>
          Ref.update(forced, (count) => count + 1).pipe(Effect.as({} as never)),
      });
      const layer = cancellationTestLayer(controlLayer, threadLayer, testOutbox, testRecovery);

      const actions = yield* Effect.gen(function* () {
        return yield* (yield* SupervisorGoalCancellationService).reconcileCancelledGoals;
      }).pipe(Effect.provide(layer));

      assert.equal(actions, 0);
      assert.equal(yield* Ref.get(forced), 0);
    }),
);

it.effect(
  "eventually force-converges an OpenCode-like accepted interrupt without terminal status",
  () =>
    Effect.gen(function* () {
      const targetStatus = yield* Ref.make<"running" | "interrupted">("running");
      const unrelatedStatus = yield* Ref.make<"running" | "interrupted">("running");
      const effects = yield* Ref.make<ReadonlyArray<never>>([]);
      const dispatchCount = yield* Ref.make(0);
      const firstAccepted = yield* Deferred.make<void>();
      const forced = yield* Deferred.make<void>();
      const controlLayer = Layer.mock(SupervisorControlPlaneService)({
        cancelGoal: () => Effect.succeed({ goal: cancelledGoal }),
        listCancelledGoalsWithLinkedAttempts: () => Effect.succeed([cancelledGoal]),
      });
      const threadLayer = Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Ref.get(threadId === childThreadId ? targetStatus : unrelatedStatus).pipe(
            Effect.map((status) => ({ runs: [{ id: runId, status }] }) as never),
          ),
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type !== "run.interrupt") {
              return yield* Effect.die(`Unexpected command ${command.type}`);
            }
            assert.equal(command.threadId, childThreadId);
            const currentTime = yield* DateTime.now;
            const count = yield* Ref.updateAndGet(dispatchCount, (current) => current + 1);
            yield* Ref.update(effects, (current) => [
              ...current,
              {
                id: `effect:${command.commandId}:provider-turn.interrupt:turn`,
                commandId: command.commandId,
                threadId: childThreadId,
                request: { type: "provider-turn.interrupt" },
                status: "succeeded",
                updatedAt: DateTime.formatIso(currentTime),
              } as never,
            ]);
            if (count === 1) yield* Deferred.succeed(firstAccepted, undefined);
            return { sequence: count, storedEvents: [] };
          }),
      });
      const testOutbox = Layer.mock(EffectOutboxV2)({
        listByIdPrefix: () => Ref.get(effects),
      });
      const testRecovery = Layer.mock(ProviderRuntimeRecoveryService)({
        forceInterruptThread: (threadId) =>
          Effect.gen(function* () {
            assert.equal(threadId, childThreadId);
            yield* Ref.set(targetStatus, "interrupted");
            yield* Deferred.succeed(forced, undefined);
            return {
              terminalizedRuns: 1,
              stoppedSessions: 0,
              closedRequests: 0,
              retiredEffects: 3,
              requeuedEffects: 0,
            };
          }),
      });
      const layer = cancellationTestLayer(controlLayer, threadLayer, testOutbox, testRecovery);

      yield* Effect.gen(function* () {
        const service = yield* SupervisorGoalCancellationService;
        yield* service.cancelGoal({ goalId });
        yield* Deferred.await(firstAccepted);

        yield* TestClock.adjust("4999 millis");
        assert.equal(yield* Ref.get(targetStatus), "running");
        assert.equal(yield* Ref.get(unrelatedStatus), "running");

        yield* TestClock.adjust("20 seconds");
        yield* Deferred.await(forced);
        assert.equal(yield* Ref.get(dispatchCount), 3);
        assert.equal(yield* Ref.get(targetStatus), "interrupted");
        assert.equal(yield* Ref.get(unrelatedStatus), "running");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("ignores cancelled attempts whose child thread no longer exists", () =>
  Effect.gen(function* () {
    const controlLayer = Layer.mock(SupervisorControlPlaneService)({
      listCancelledGoalsWithLinkedAttempts: () => Effect.succeed([cancelledGoal]),
    });
    const threadLayer = Layer.mock(ThreadManagementService)({
      getThreadProjection: () =>
        Effect.fail(
          new OrchestratorProjectionError({
            threadId: childThreadId,
            cause: new ProjectionStoreThreadNotFoundError({ threadId: childThreadId }),
          }),
        ),
      dispatch: () => Effect.die("missing child must not be interrupted"),
    });
    const layer = cancellationTestLayer(controlLayer, threadLayer);

    const reconciled = yield* Effect.gen(function* () {
      const service = yield* SupervisorGoalCancellationService;
      return yield* service.reconcileCancelledGoals;
    }).pipe(Effect.provide(layer));

    assert.equal(reconciled, 0);
  }),
);
