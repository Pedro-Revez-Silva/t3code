import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2, type ProviderMutationPhase } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackTarget } from "./ProviderAdapter.ts";
import { ProviderOwnershipGuard } from "./ProviderOwnershipGuard.ts";
import { ProviderSessionGenerationStore } from "./ProviderSessionGenerationStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { randomUuidV4 } from "./RandomUuid.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class CheckpointRollbackExecutionError extends Schema.TaggedErrorClass<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | EventSinkV2
  | IdAllocatorV2
  | ProjectionStoreV2
  | ProviderOwnershipGuard
  | ProviderSessionGenerationStore
  | ProviderSessionManagerV2
  | RuntimePolicyV2
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const providerOwnershipGuard = yield* ProviderOwnershipGuard;
    const providerSessionGenerations = yield* ProviderSessionGenerationStore;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
    }) {
      const projection = yield* projections.getThreadProjection(input.threadId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id
      ) {
        return yield* new CheckpointRollbackExecutionError({
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          cause: "The persisted rollback target is incomplete or no longer valid.",
        });
      }

      const modelSelection = projection.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerThread.providerSessionId,
      );
      const latestRun = projection.runs.reduce(
        (latest, candidate) =>
          latest === undefined || candidate.ordinal > latest.ordinal ? candidate : latest,
        projection.runs[0],
      );
      const generationState = yield* providerSessionGenerations.state({
        threadId: input.threadId,
        providerInstanceId: providerThread.providerInstanceId,
      });
      if (
        latestRun === undefined ||
        latestRun.activeAttemptId === null ||
        generationState.quarantinedProviderSessionId === providerThread.providerSessionId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          cause: "The provider rollback authority is unavailable.",
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      const latestActiveAttemptId = latestRun.activeAttemptId;
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
      });

      yield* providerOwnershipGuard.withLock(
        {
          threadId: input.threadId,
          providerInstanceId: providerThread.providerInstanceId,
        },
        Effect.gen(function* () {
          const currentProjection = yield* projections.getThreadProjection(input.threadId);
          const currentProviderThread = currentProjection.providerThreads.find(
            (candidate) => candidate.id === input.providerThreadId,
          );
          const currentCheckpoint = currentProjection.checkpoints.find(
            (candidate) => candidate.id === input.checkpointId,
          );
          const currentScope = currentProjection.checkpointScopes.find(
            (candidate) => candidate.id === input.scopeId,
          );
          const currentLatestRun = currentProjection.runs.reduce(
            (latest, candidate) =>
              latest === undefined || candidate.ordinal > latest.ordinal ? candidate : latest,
            currentProjection.runs[0],
          );
          const currentGenerationState = yield* providerSessionGenerations.state({
            threadId: input.threadId,
            providerInstanceId: providerThread.providerInstanceId,
          });
          if (
            currentProviderThread === undefined ||
            currentProviderThread.providerSessionId !== providerSessionId ||
            currentProviderThread.providerInstanceId !== providerThread.providerInstanceId ||
            currentCheckpoint === undefined ||
            currentCheckpoint.scopeId !== input.scopeId ||
            currentCheckpoint.ref !== checkpoint.ref ||
            currentCheckpoint.appRunOrdinal !== checkpoint.appRunOrdinal ||
            currentScope === undefined ||
            currentLatestRun?.id !== latestRun.id ||
            currentLatestRun.activeAttemptId !== latestActiveAttemptId ||
            currentLatestRun.status !== latestRun.status ||
            currentGenerationState.generation !== generationState.generation ||
            currentGenerationState.quarantinedProviderSessionId === providerSessionId
          ) {
            return yield* new CheckpointRollbackExecutionError({
              threadId: input.threadId,
              providerThreadId: input.providerThreadId,
              checkpointId: input.checkpointId,
              cause: "The provider rollback authority changed before restore.",
            });
          }

          const targetOrdinal = currentCheckpoint.appRunOrdinal ?? 0;
          const runsToRollback = currentProjection.runs.filter(
            (run) => run.ordinal > targetOrdinal && run.status === "completed",
          );
          const providerThreadTurns = currentProjection.providerTurns.filter(
            (turn) => turn.providerThreadId === currentProviderThread.id,
          );
          const rollbackTarget: ProviderAdapterV2RollbackTarget =
            targetOrdinal === 0
              ? {
                  type: "thread_start",
                  checkpointId: currentCheckpoint.id,
                  appRunOrdinal: 0,
                }
              : yield* Effect.gen(function* () {
                  const targetRun = currentProjection.runs.find(
                    (run) => run.ordinal === targetOrdinal,
                  );
                  const targetAttempt = currentProjection.attempts.find(
                    (attempt) => attempt.id === targetRun?.activeAttemptId,
                  );
                  const targetTurn = currentProjection.providerTurns.find(
                    (turn) =>
                      turn.id === targetAttempt?.providerTurnId ||
                      turn.runAttemptId === targetAttempt?.id,
                  );
                  if (
                    targetTurn === undefined ||
                    targetTurn.providerThreadId !== currentProviderThread.id
                  ) {
                    return yield* new CheckpointRollbackExecutionError({
                      threadId: input.threadId,
                      providerThreadId: input.providerThreadId,
                      checkpointId: input.checkpointId,
                      cause: "The provider rollback turn is unavailable.",
                    });
                  }
                  return {
                    type: "provider_turn" as const,
                    checkpointId: currentCheckpoint.id,
                    appRunOrdinal: targetOrdinal,
                    providerTurn: targetTurn,
                  };
                });

          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const reservationId = yield* randomUuidV4;
              const authority = {
                threadId: input.threadId,
                providerSessionId,
                providerInstanceId: providerThread.providerInstanceId,
                generation: generationState.generation,
                providerThreadId: currentProviderThread.id,
                runId: latestRun.id,
                activeAttemptId: latestActiveAttemptId,
                expectedRunStatus: latestRun.status,
              } as const;
              const reservation = yield* eventSink.reserveProviderMutation({
                reservationId,
                authority,
                checkpointId: currentCheckpoint.id,
                scopeId: currentScope.id,
                targetRunOrdinal: targetOrdinal,
              });
              if (!reservation.committed) {
                return yield* new CheckpointRollbackExecutionError({
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                  cause: "The provider rollback authority changed before reservation.",
                });
              }

              const externalMutationStarted = yield* Ref.make(false);
              const markPhase = (phase: ProviderMutationPhase) =>
                eventSink
                  .markProviderMutationPhase({
                    reservationId,
                    threadId: input.threadId,
                    providerInstanceId: providerThread.providerInstanceId,
                    phase,
                  })
                  .pipe(
                    Effect.filterOrFail(
                      (result) => result.committed,
                      () =>
                        new CheckpointRollbackExecutionError({
                          threadId: input.threadId,
                          providerThreadId: input.providerThreadId,
                          checkpointId: input.checkpointId,
                          cause: `The provider rollback reservation was lost before ${phase}.`,
                        }),
                    ),
                  );

              yield* restore(
                Effect.gen(function* () {
                  yield* markPhase("filesystem_started");
                  yield* Ref.set(externalMutationStarted, true);
                  yield* checkpoints.restore({
                    scope: currentScope,
                    checkpoint: currentCheckpoint,
                  });
                  yield* markPhase("filesystem_restored");
                  const snapshot =
                    runsToRollback.length === 0
                      ? { providerThread: currentProviderThread }
                      : yield* Effect.gen(function* () {
                          yield* markPhase("provider_started");
                          const restored = yield* session.rollbackThread({
                            providerThread: currentProviderThread,
                            target: rollbackTarget,
                            providerThreadTurns,
                          });
                          yield* markPhase("provider_restored");
                          return restored;
                        });
                  const staleCheckpoints = currentProjection.checkpoints.filter(
                    (candidate) =>
                      candidate.scopeId === currentScope.id &&
                      candidate.appRunOrdinal !== null &&
                      candidate.appRunOrdinal > targetOrdinal &&
                      candidate.status === "ready",
                  );
                  if (staleCheckpoints.length > 0) {
                    yield* markPhase("cleanup_started");
                    yield* checkpoints.deleteStaleRefs({
                      scope: currentScope,
                      checkpoints: staleCheckpoints,
                    });
                  }
                  yield* markPhase("external_complete");

                  const now = yield* DateTime.now;
                  const makeEvent = <Event extends OrchestrationV2DomainEvent>(
                    event: Omit<Event, "id">,
                  ) =>
                    Effect.map(
                      ids.allocate.event({ threadId: event.threadId }),
                      (id) => ({ ...event, id }) as Event,
                    );
                  const events: Array<OrchestrationV2DomainEvent> = [];
                  events.push(
                    yield* makeEvent({
                      type: "provider-thread.updated",
                      threadId: input.threadId,
                      driver: currentProviderThread.driver,
                      providerInstanceId: currentProviderThread.providerInstanceId,
                      occurredAt: now,
                      payload: {
                        ...snapshot.providerThread,
                        lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
                        updatedAt: now,
                      },
                    }),
                  );
                  for (const staleCheckpoint of staleCheckpoints) {
                    events.push(
                      yield* makeEvent({
                        type: "checkpoint.captured",
                        threadId: input.threadId,
                        ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
                        nodeId: staleCheckpoint.nodeId,
                        providerInstanceId: currentProviderThread.providerInstanceId,
                        occurredAt: now,
                        payload: { ...staleCheckpoint, status: "stale" },
                      }),
                    );
                  }
                  for (const run of runsToRollback) {
                    const rootNode = currentProjection.nodes.find(
                      (candidate) => candidate.id === run.rootNodeId,
                    );
                    events.push(
                      yield* makeEvent({
                        type: "run.updated",
                        threadId: input.threadId,
                        runId: run.id,
                        ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
                        providerInstanceId: run.providerInstanceId,
                        occurredAt: now,
                        payload: { ...run, status: "rolled_back", completedAt: now },
                      }),
                    );
                    if (rootNode !== undefined) {
                      events.push(
                        yield* makeEvent({
                          type: "node.updated",
                          threadId: input.threadId,
                          runId: run.id,
                          nodeId: rootNode.id,
                          providerInstanceId: run.providerInstanceId,
                          occurredAt: now,
                          payload: { ...rootNode, status: "rolled_back", completedAt: now },
                        }),
                      );
                    }
                  }
                  const write = yield* eventSink.writeIfProviderMutationCurrent({
                    reservationId,
                    authority,
                    events,
                  });
                  if (!write.committed) {
                    return yield* new CheckpointRollbackExecutionError({
                      threadId: input.threadId,
                      providerThreadId: input.providerThreadId,
                      checkpointId: input.checkpointId,
                      cause: "The provider rollback authority changed before persistence.",
                    });
                  }
                }),
              ).pipe(
                Effect.ensuring(
                  Ref.get(externalMutationStarted).pipe(
                    Effect.flatMap((started) =>
                      started
                        ? Effect.void
                        : eventSink.releaseProviderMutation({
                            reservationId,
                            threadId: input.threadId,
                            providerInstanceId: providerThread.providerInstanceId,
                          }),
                    ),
                    Effect.orDie,
                  ),
                ),
              );
            }),
          );
        }),
      );
    });

    return CheckpointRollbackServiceV2.of({
      execute: (input) =>
        execute(input).pipe(
          Effect.mapError((cause) =>
            isCheckpointRollbackExecutionError(cause)
              ? cause
              : new CheckpointRollbackExecutionError({
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
