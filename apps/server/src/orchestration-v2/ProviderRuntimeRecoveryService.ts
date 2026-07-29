import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedErrorClass<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals([
      "read-projections",
      "reconcile",
      "drain-outbox",
      "recover-provider-mutation",
    ]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}
const isProviderRuntimeRecoveryError = Schema.is(ProviderRuntimeRecoveryError);

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
  readonly executedEffects: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly forceInterruptThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
    readonly maintainProviderMutationLease: Effect.Effect<never, ProviderRuntimeRecoveryError>;
  }
>()("t3/orchestration-v2/ProviderRuntimeRecoveryService") {}

function nonterminalRuns(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      run.status === "queued" ||
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const orchestrator = yield* OrchestratorV2;
  const providerTurnControl = yield* ProviderTurnControlServiceV2;
  const activateProviderMutationOwner = Effect.fn(
    "ProviderRuntimeRecoveryService.activateProviderMutationOwner",
  )(function* () {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const owner = yield* eventSink.activateProviderMutationOwner.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeRecoveryError({ operation: "recover-provider-mutation", cause }),
        ),
      );
      if (owner.activated) return;
      if (attempt < 5) yield* Effect.sleep("1 second");
    }
    return yield* new ProviderRuntimeRecoveryError({
      operation: "recover-provider-mutation",
      cause: "Another live server instance owns the provider mutation lease.",
    });
  });

  const recoverAbandonedProviderMutations = Effect.fn(
    "ProviderRuntimeRecoveryService.recoverAbandonedProviderMutations",
  )(function* () {
    yield* activateProviderMutationOwner();
    const reservations = yield* eventSink.listAbandonedProviderMutations.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderRuntimeRecoveryError({ operation: "recover-provider-mutation", cause }),
      ),
    );
    let recovered = 0;
    for (const reservation of reservations) {
      const renewed = yield* eventSink.heartbeatProviderMutationOwner.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeRecoveryError({
              operation: "recover-provider-mutation",
              threadId: reservation.threadId,
              cause,
            }),
        ),
      );
      if (!renewed) {
        return yield* new ProviderRuntimeRecoveryError({
          operation: "recover-provider-mutation",
          threadId: reservation.threadId,
          cause: "The provider mutation owner lease was lost during recovery.",
        });
      }
      if (reservation.phase === "reserved") {
        const cleared = yield* eventSink
          .clearAbandonedProviderMutation({
            reservationId: reservation.reservationId,
            ownerInstanceId: reservation.ownerInstanceId,
            leaseEpoch: reservation.leaseEpoch,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "recover-provider-mutation",
                  threadId: reservation.threadId,
                  cause,
                }),
            ),
          );
        if (cleared) recovered += 1;
        continue;
      }

      const projectionResult = yield* projections
        .getThreadProjection(reservation.threadId)
        .pipe(Effect.result);
      if (projectionResult._tag === "Failure") {
        const result = yield* eventSink
          .reconcileAbandonedProviderMutation({
            reservation,
            events: [],
            quarantineProvider: true,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "recover-provider-mutation",
                  threadId: reservation.threadId,
                  cause,
                }),
            ),
          );
        if (result.committed) recovered += 1;
        continue;
      }

      const projection = projectionResult.success;
      const now = yield* DateTime.now;
      const commandId = CommandId.make(
        `command:recover-provider-mutation:${reservation.reservationId}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: reservation.threadId, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "recover-provider-mutation",
                threadId: reservation.threadId,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      const hasExactTarget =
        reservation.targetResolution === "exact" && reservation.targetRunOrdinal !== null;
      const mutationOutcome =
        !hasExactTarget || reservation.phase === "filesystem_started"
          ? "interrupted"
          : "rolled_back";
      const affectedRuns = projection.runs.filter(
        (run) =>
          run.status !== "rolled_back" &&
          (hasExactTarget
            ? run.ordinal > reservation.targetRunOrdinal!
            : run.providerThreadId === reservation.providerThreadId),
      );
      for (const run of affectedRuns) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: reservation.threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...run,
            status: mutationOutcome,
            queuePosition: null,
            completedAt: now,
          },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: reservation.threadId,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "interrupted", completedAt: now },
          });
        }
        for (const node of projection.nodes.filter((candidate) => candidate.runId === run.id)) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: node.threadId,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: mutationOutcome, completedAt: now },
          });
        }
      }
      for (const checkpoint of projection.checkpoints.filter(
        (candidate) =>
          candidate.status === "ready" &&
          (!hasExactTarget ||
            (candidate.appRunOrdinal !== null &&
              candidate.appRunOrdinal > reservation.targetRunOrdinal!)),
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "checkpoint.captured",
          threadId: reservation.threadId,
          ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
          nodeId: checkpoint.nodeId,
          providerInstanceId: reservation.providerInstanceId,
          occurredAt: now,
          payload: { ...checkpoint, status: "stale" },
        });
      }
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === reservation.providerThreadId,
      );
      if (providerThread !== undefined) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: reservation.threadId,
          driver: providerThread.driver,
          providerInstanceId: reservation.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            providerSessionId: null,
            status: "not_loaded",
            lastRunOrdinal:
              !hasExactTarget || reservation.targetRunOrdinal === 0
                ? null
                : reservation.targetRunOrdinal,
            updatedAt: now,
          },
        });
      }
      events.push({
        id: yield* allocateEventId(),
        type: "provider-session.detached",
        threadId: reservation.threadId,
        providerInstanceId: reservation.providerInstanceId,
        occurredAt: now,
        payload: {
          providerSessionId: ProviderSessionId.make(reservation.providerSessionId),
          detachedAt: now,
          reason: `Recovered abandoned rollback reservation ${reservation.reservationId} at phase ${reservation.phase}.`,
        },
      });
      events.push({
        id: yield* allocateEventId(),
        type: "thread.metadata-updated",
        threadId: reservation.threadId,
        providerInstanceId: reservation.providerInstanceId,
        occurredAt: now,
        payload: { ...projection.thread, activeProviderThreadId: null, updatedAt: now },
      });
      const result = yield* eventSink
        .reconcileAbandonedProviderMutation({
          reservation,
          events,
          quarantineProvider: true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "recover-provider-mutation",
                threadId: reservation.threadId,
                cause,
              }),
          ),
        );
      if (result.committed) recovered += 1;
    }
    return recovered;
  });
  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      projection: OrchestrationV2ThreadProjection,
      trigger: "startup" | "shutdown",
      stopProviderSessions = true,
    ) {
      const now = yield* DateTime.now;
      const runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
      for (const run of nonterminalRuns(projection)) {
        if (run.status === "waiting") {
          const checkpointEffects = yield* outbox
            .listByCommandId(CommandId.make(`command:effect:checkpoint.capture:${run.id}`))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({
                    operation: "reconcile",
                    threadId: projection.thread.id,
                    cause,
                  }),
              ),
            );
          const hasReplayableCheckpoint = checkpointEffects.some(
            (effect) =>
              effect.request.type === "checkpoint.capture" &&
              effect.request.runId === run.id &&
              (effect.status === "pending" || effect.status === "running"),
          );
          if (hasReplayableCheckpoint) continue;
        }
        runs.push(run);
      }
      const requests = projection.runtimeRequests.filter((request) => request.status === "pending");
      const detail = `Interrupted because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "startup" ? "expired" : "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
          },
        });
      }
      for (const run of runs) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "interrupted", queuePosition: null, completedAt: now },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "interrupted", completedAt: now },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "interrupted", completedAt: now },
          });
        }
        for (const subagent of projection.subagents.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "subagent.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: subagent.id,
            driver: subagent.driver,
            providerInstanceId: subagent.providerInstanceId,
            occurredAt: now,
            payload: { ...subagent, status: "interrupted", completedAt: now, updatedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "interrupted", completedAt: now },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: now },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...item, status: "interrupted", completedAt: now, updatedAt: now },
          });
        }
      }
      for (const providerThread of projection.providerThreads.filter(
        (candidate) => candidate.status === "active",
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: { ...providerThread, status: "idle", updatedAt: now },
        });
      }
      if (stopProviderSessions) {
        for (const session of projection.providerSessions.filter(
          (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-session.updated",
            threadId: projection.thread.id,
            driver: session.driver,
            providerInstanceId: session.providerInstanceId,
            occurredAt: now,
            payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
          });
        }
      }
      const stoppedSessions = stopProviderSessions
        ? projection.providerSessions.filter(
            (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
          ).length
        : 0;
      let retiredEffects: number;
      if (events.length === 0) {
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects: [],
            runtimeRequestGuards: requests.map((request) => ({
              threadId: projection.thread.id,
              requestId: request.id,
              expectedStatus: "pending" as const,
            })),
            cancelUnsettledEffects: {
              effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length,
        retiredEffects,
      };
    },
  );

  const reconcile = (trigger: "startup" | "shutdown") =>
    Effect.gen(function* () {
      if (trigger === "startup") yield* recoverAbandonedProviderMutations();
      const shell = yield* projections
        .getShellSnapshot()
        .pipe(
          Effect.mapError(
            (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
          ),
        );
      let terminalizedRuns = 0;
      let stoppedSessions = 0;
      let closedRequests = 0;
      let retiredEffects = 0;
      for (const thread of [...shell.threads, ...shell.archivedThreads]) {
        if (trigger === "startup") {
          const renewed = yield* eventSink.heartbeatProviderMutationOwner.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "recover-provider-mutation",
                  threadId: thread.id,
                  cause,
                }),
            ),
          );
          if (!renewed) {
            return yield* new ProviderRuntimeRecoveryError({
              operation: "recover-provider-mutation",
              threadId: thread.id,
              cause: "The provider mutation owner lease was lost during startup reconciliation.",
            });
          }
        }
        const projection = yield* projections.getThreadProjection(thread.id).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId: thread.id,
                cause,
              }),
          ),
        );
        const result = yield* reconcileProjection(projection, trigger);
        terminalizedRuns += result.terminalizedRuns;
        stoppedSessions += result.stoppedSessions;
        closedRequests += result.closedRequests;
        retiredEffects += result.retiredEffects;
      }
      const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      );
      yield* orchestrator.reconcileDelegatedTasks.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", cause }),
        ),
      );
      return {
        terminalizedRuns,
        stoppedSessions,
        closedRequests,
        retiredEffects: retiredEffects + outboxReconciliation.cancelled,
        requeuedEffects: outboxReconciliation.requeued,
      } satisfies ProviderRuntimeReconciliationSummary;
    });

  const forceInterruptThread = Effect.fn("ProviderRuntimeRecoveryService.forceInterruptThread")(
    function* (threadId: ThreadId) {
      const initialProjection = yield* projections
        .getThreadProjection(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({ operation: "read-projections", threadId, cause }),
          ),
        );
      for (const run of nonterminalRuns(initialProjection)) {
        for (const attempt of initialProjection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          const providerTurn = initialProjection.providerTurns.find(
            (candidate) => candidate.runAttemptId === attempt.id && candidate.status === "running",
          );
          if (providerTurn === undefined) continue;
          const providerThread = initialProjection.providerThreads.find(
            (candidate) => candidate.id === providerTurn.providerThreadId,
          );
          if (providerThread?.providerSessionId == null) {
            return yield* new ProviderRuntimeRecoveryError({
              operation: "reconcile",
              threadId,
              cause: `Running provider turn ${providerTurn.id} has no recorded live session.`,
            });
          }
          const target = {
            threadId,
            providerSessionId: providerThread.providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
          } as const;
          yield* providerTurnControl
            .interruptAndAwaitTerminal({
              ...target,
              interruptedAttemptId: attempt.id,
            })
            .pipe(
              Effect.catch(() => providerTurnControl.hardStop(target)),
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({ operation: "reconcile", threadId, cause }),
              ),
            );
        }
      }
      const projection = yield* projections
        .getThreadProjection(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({ operation: "read-projections", threadId, cause }),
          ),
        );
      const result = yield* reconcileProjection(projection, "shutdown", false);
      return {
        ...result,
        requeuedEffects: 0,
      } satisfies ProviderRuntimeReconciliationSummary;
    },
  );

  const recover = Effect.gen(function* () {
    const reconciliation = yield* reconcile("startup");
    let executedEffects = 0;
    while (
      yield* worker.runOnce.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      )
    ) {
      executedEffects += 1;
    }
    return { ...reconciliation, executedEffects } satisfies ProviderRuntimeRecoverySummary;
  });

  const maintainProviderMutationLease = Effect.forever(
    Effect.sleep("1 second").pipe(
      Effect.andThen(eventSink.heartbeatProviderMutationOwner),
      Effect.flatMap((renewed) =>
        renewed
          ? Effect.void
          : new ProviderRuntimeRecoveryError({
              operation: "recover-provider-mutation",
              cause: "The provider mutation owner lease was lost.",
            }),
      ),
      Effect.mapError((cause) =>
        isProviderRuntimeRecoveryError(cause)
          ? cause
          : new ProviderRuntimeRecoveryError({
              operation: "recover-provider-mutation",
              cause,
            }),
      ),
    ),
  ).pipe(Effect.ensuring(eventSink.deactivateProviderMutationOwner.pipe(Effect.orDie)));

  return ProviderRuntimeRecoveryService.of({
    reconcile,
    forceInterruptThread,
    recover,
    maintainProviderMutationLease,
  });
});

export const layer: Layer.Layer<
  ProviderRuntimeRecoveryService,
  never,
  | EffectWorker.OrchestrationEffectWorkerV2
  | EffectOutbox.EffectOutboxV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | OrchestratorV2
  | ProjectionStore.ProjectionStoreV2
  | ProviderTurnControlServiceV2
> = Layer.effect(ProviderRuntimeRecoveryService, make);
