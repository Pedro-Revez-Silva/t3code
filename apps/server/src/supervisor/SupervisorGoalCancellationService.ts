import {
  CommandId,
  type OrchestrationV2Run,
  SupervisorControlPlaneError,
  type SupervisorGoal,
  type SupervisorGoalCancelInput,
  type SupervisorGoalCancelResult,
  type SupervisorTaskAttemptStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { SupervisorMutationAuthority } from "./SupervisorAuthority.ts";
import {
  type ControlPlaneFailure,
  SupervisorControlPlaneService,
} from "./SupervisorControlPlaneService.ts";

const isProjectionError = Schema.is(OrchestratorProjectionError);
const isProjectionMissing = Schema.is(ProjectionStoreThreadNotFoundError);
const CANCELLATION_RETRY_INITIAL_DELAY_MS = 100;
const CANCELLATION_RETRY_MAX_DELAY_MS = 2_000;
const INTERRUPT_PROJECTION_GRACE_MS = 5_000;
const INTERRUPT_ACCEPTED_FORCE_AFTER_MS = 30_000;
const INTERRUPT_ATTEMPTS_BEFORE_FORCE_TEARDOWN = 3;

function attemptStatusForRun(
  status: OrchestrationV2Run["status"],
): SupervisorTaskAttemptStatus | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "rolled_back":
      return "cancelled";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return null;
  }
}

export class SupervisorGoalCancellationService extends Context.Service<
  SupervisorGoalCancellationService,
  {
    readonly cancelGoal: (
      input: SupervisorGoalCancelInput,
      authority?: SupervisorMutationAuthority,
    ) => Effect.Effect<SupervisorGoalCancelResult, ControlPlaneFailure>;
    readonly reconcileCancelledGoals: Effect.Effect<number, ControlPlaneFailure>;
  }
>()("t3/supervisor/SupervisorGoalCancellationService") {}

const make = Effect.gen(function* () {
  const controlPlane = yield* SupervisorControlPlaneService;
  const threads = yield* ThreadManagementService;
  const outbox = yield* EffectOutboxV2;
  const recovery = yield* ProviderRuntimeRecoveryService;
  const retrySignals = yield* Queue.sliding<void>(1);

  const coordinateGoal = Effect.fn("SupervisorGoalCancellationService.coordinateGoal")(function* (
    goal: SupervisorGoal,
  ) {
    const outcomes = yield* Effect.forEach(
      goal.tasks.flatMap((task) => task.attempts),
      (attempt) =>
        Effect.gen(function* () {
          if (attempt.nodeId === null || attempt.threadId === null) {
            return { actions: 0, pending: 0 };
          }
          const projectionOption = yield* threads.getThreadProjection(attempt.threadId).pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              isProjectionError(error) && isProjectionMissing(error.cause)
                ? Effect.succeed(Option.none())
                : Effect.fail(error),
            ),
          );
          if (Option.isNone(projectionOption)) return { actions: 0, pending: 0 };
          const projection = projectionOption.value;
          const run =
            attempt.runId === null
              ? projection.runs[0]
              : projection.runs.find((candidate) => candidate.id === attempt.runId);
          if (run === undefined || attemptStatusForRun(run.status) !== null) {
            return { actions: 0, pending: 0 };
          }
          const commandPrefix = `command:system:supervisor-goal-cancel:${attempt.id}:`;
          const interruptEffects = (yield* outbox.listByIdPrefix(`effect:${commandPrefix}`)).filter(
            (effect) => effect.request.type === "provider-turn.interrupt",
          );
          const latestEffect = interruptEffects.at(-1);
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (
            latestEffect?.status === "pending" ||
            latestEffect?.status === "running" ||
            latestEffect?.status === "succeeded"
          ) {
            const updatedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(latestEffect.updatedAt));
            if (now - updatedAt < INTERRUPT_PROJECTION_GRACE_MS) {
              return { actions: 0, pending: 1 };
            }
          }
          const ineffectiveInterrupts = interruptEffects.filter((effect) => {
            if (effect.status === "failed" || effect.status === "cancelled") return true;
            if (
              effect.status !== "pending" &&
              effect.status !== "running" &&
              effect.status !== "succeeded"
            ) {
              return false;
            }
            return (
              now - DateTime.toEpochMillis(DateTime.makeUnsafe(effect.updatedAt)) >=
              INTERRUPT_PROJECTION_GRACE_MS
            );
          });
          const firstAcceptedInterrupt = interruptEffects.find(
            (effect) => effect.status === "succeeded",
          );
          const acceptedInterruptExpired =
            firstAcceptedInterrupt !== undefined &&
            now - DateTime.toEpochMillis(DateTime.makeUnsafe(firstAcceptedInterrupt.updatedAt)) >=
              INTERRUPT_ACCEPTED_FORCE_AFTER_MS;
          if (
            ineffectiveInterrupts.length >= INTERRUPT_ATTEMPTS_BEFORE_FORCE_TEARDOWN ||
            acceptedInterruptExpired
          ) {
            yield* recovery.forceInterruptThread(attempt.threadId);
            const recovered = yield* threads.getThreadProjection(attempt.threadId);
            const recoveredRun = recovered.runs.find((candidate) => candidate.id === run.id);
            return {
              actions: 1,
              pending:
                recoveredRun !== undefined && attemptStatusForRun(recoveredRun.status) === null
                  ? 1
                  : 0,
            };
          }
          const generation = interruptEffects.length + 1;
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`${commandPrefix}${generation}`),
            threadId: attempt.threadId,
            runId: run.id,
            reason: `Supervisor goal ${goal.id} was cancelled.`,
          });
          return { actions: 1, pending: 1 };
        }).pipe(Effect.result),
      { concurrency: 1 },
    );
    const failure = outcomes.find(Result.isFailure);
    if (failure !== undefined) return yield* Effect.failCause(Cause.fail(failure.failure));
    let actions = 0;
    let pending = 0;
    for (const outcome of outcomes) {
      if (Result.isSuccess(outcome)) {
        actions += outcome.success.actions;
        pending += outcome.success.pending;
      }
    }
    return { actions, pending };
  });

  const coordinate = (goal: SupervisorGoal) =>
    coordinateGoal(goal).pipe(
      Effect.mapError(
        (cause) =>
          new SupervisorControlPlaneError({
            message: `Could not interrupt delegated work for supervisor goal ${goal.id}.`,
            cause,
          }),
      ),
    );

  const reconcileOnce = Effect.gen(function* () {
    const goals = yield* controlPlane.listCancelledGoalsWithLinkedAttempts();
    let actions = 0;
    let pending = 0;
    for (const goal of goals) {
      const result = yield* coordinate(goal);
      actions += result.actions;
      pending += result.pending;
    }
    return { actions, pending };
  });

  const monitorCancellation = Effect.fn("SupervisorGoalCancellationService.monitorCancellation")(
    function* (delayMs: number): Effect.fn.Return<void> {
      const result = yield* reconcileOnce.pipe(
        Effect.catch((error) =>
          Effect.logError("Supervisor goal cancellation reconciliation failed", { error }).pipe(
            Effect.as({ actions: 0, pending: 1 }),
          ),
        ),
      );
      if (result.pending === 0) return;
      yield* Effect.sleep(Duration.millis(delayMs));
      return yield* monitorCancellation(Math.min(CANCELLATION_RETRY_MAX_DELAY_MS, delayMs * 2));
    },
  );
  const retryWorker = Queue.take(retrySignals).pipe(
    Effect.andThen(monitorCancellation(CANCELLATION_RETRY_INITIAL_DELAY_MS)),
    Effect.forever,
  );
  yield* retryWorker.pipe(Effect.forkScoped);

  return SupervisorGoalCancellationService.of({
    cancelGoal: (input, authority) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* controlPlane.cancelGoal(input, authority);
          if (result.goal.status === "cancelled") yield* Queue.offer(retrySignals, undefined);
          return result;
        }),
      ),
    reconcileCancelledGoals: Effect.gen(function* () {
      const result = yield* reconcileOnce;
      if (result.pending > 0) yield* Queue.offer(retrySignals, undefined);
      return result.actions;
    }),
  });
});

export const layer: Layer.Layer<
  SupervisorGoalCancellationService,
  never,
  | EffectOutboxV2
  | ProviderRuntimeRecoveryService
  | SupervisorControlPlaneService
  | ThreadManagementService
> = Layer.effect(SupervisorGoalCancellationService, make);
