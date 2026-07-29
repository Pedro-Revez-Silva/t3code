import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  CheckpointRollbackServiceV2,
  layer as rollbackLayer,
} from "./CheckpointRollbackService.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import {
  ProviderOwnershipGuard,
  layer as providerOwnershipGuardLayer,
} from "./ProviderOwnershipGuard.ts";
import { ProviderSessionGenerationStore } from "./ProviderSessionGenerationStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { layer as runtimePolicyLayer } from "./RuntimePolicy.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:rollback-authority-race");
const providerSessionId = ProviderSessionId.make("provider-session:rollback-authority-race");
const providerThreadId = ProviderThreadId.make("provider-thread:rollback-authority-race");
const runId = RunId.make("run:rollback-authority-race");
const attemptId = RunAttemptId.make("attempt:rollback-authority-race");
const rootNodeId = NodeId.make("node:rollback-authority-race");
const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-authority-race");
const checkpointId = CheckpointId.make("checkpoint:rollback-authority-race");

it.effect("CheckpointRollbackServiceV2 revalidates ownership after waiting for quarantine", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const opened = yield* Deferred.make<void>();
    const restoreCount = yield* Ref.make(0);
    const reservationCount = yield* Ref.make(0);
    const writeCount = yield* Ref.make(0);
    const rollbackShouldFail = yield* Ref.make(false);
    const rollbackShouldBlock = yield* Ref.make(false);
    const rollbackEntered = yield* Deferred.make<void>();
    const generation = yield* Ref.make(0);
    const projection: OrchestrationV2ThreadProjection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:rollback-authority-race"),
        title: "Rollback authority race",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      runs: [
        {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          providerThreadId,
          userMessageId: MessageId.make("message:rollback-authority-race"),
          rootNodeId,
          activeAttemptId: attemptId,
          status: "completed",
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId,
          contextHandoffId: null,
        },
      ],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [
        {
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
      ],
      providerThreads: [
        {
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
      ],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [
        {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/workspace",
          createdAt: now,
        },
      ],
      checkpoints: [
        {
          id: checkpointId,
          threadId,
          scopeId,
          runId: null,
          nodeId: rootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("refs/t3/test/rollback-authority-race"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      ],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: now,
    };
    const runtime = {
      instanceId: providerInstanceId,
      driver,
      providerSessionId,
      providerSession: projection.providerSessions[0]!,
      events: Stream.empty,
      ensureThread: () => Effect.die("unused"),
      resumeThread: () => Effect.die("unused"),
      startTurn: () => Effect.die("unused"),
      steerTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRuntimeRequest: () => Effect.die("unused"),
      readThreadSnapshot: () => Effect.die("unused"),
      rollbackThread: () =>
        Effect.gen(function* () {
          if (yield* Ref.get(rollbackShouldBlock)) {
            yield* Deferred.succeed(rollbackEntered, undefined);
            return yield* Effect.never;
          }
          if (yield* Ref.get(rollbackShouldFail)) {
            return yield* Effect.die("simulated provider rollback failure");
          }
          return {
            providerThread: projection.providerThreads[0]!,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          };
        }),
      forkThread: () => Effect.die("unused"),
    } satisfies ProviderAdapterV2SessionRuntime;
    const ownershipLayer = providerOwnershipGuardLayer;
    const dependencies = Layer.mergeAll(
      Layer.mock(CheckpointServiceV2)({
        restore: () => Ref.update(restoreCount, (count) => count + 1),
      }),
      Layer.mock(EventSinkV2)({
        reserveProviderMutation: () =>
          Ref.update(reservationCount, (count) => count + 1).pipe(
            Effect.as({ committed: true as const }),
          ),
        markProviderMutationPhase: () => Effect.succeed({ committed: true as const }),
        releaseProviderMutation: () => Ref.update(reservationCount, (count) => count - 1),
        writeIfProviderMutationCurrent: () =>
          Ref.update(writeCount, (count) => count + 1).pipe(
            Effect.andThen(Ref.update(reservationCount, (count) => count - 1)),
            Effect.as({ committed: true as const, storedEvents: [] }),
          ),
      }),
      idAllocatorLayer,
      Layer.mock(ProjectionStoreV2)({ getThreadProjection: () => Effect.succeed(projection) }),
      ownershipLayer,
      Layer.mock(ProviderSessionGenerationStore)({
        state: () =>
          Ref.get(generation).pipe(
            Effect.map((value) => ({
              generation: value,
              quarantinedProviderSessionId: value === 0 ? null : providerSessionId,
            })),
          ),
      }),
      Layer.mock(ProviderSessionManagerV2)({
        open: () => Deferred.succeed(opened, undefined).pipe(Effect.as(runtime)),
      }),
      runtimePolicyLayer,
    );
    const serviceLayer = rollbackLayer.pipe(Layer.provide(dependencies));

    yield* Effect.gen(function* () {
      const guard = yield* ProviderOwnershipGuard;
      const rollback = yield* CheckpointRollbackServiceV2;
      const rollbackFiber = yield* guard.withLock(
        { threadId, providerInstanceId },
        Effect.gen(function* () {
          const fiber = yield* rollback
            .execute({ threadId, providerThreadId, checkpointId, scopeId })
            .pipe(Effect.forkChild);
          yield* Deferred.await(opened);
          yield* Ref.set(generation, 1);
          return fiber;
        }),
      );
      const exit = yield* Fiber.await(rollbackFiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(yield* Ref.get(restoreCount), 0);
      assert.equal(yield* Ref.get(reservationCount), 0);

      yield* Ref.set(generation, 0);
      yield* rollback.execute({ threadId, providerThreadId, checkpointId, scopeId });
      assert.equal(yield* Ref.get(restoreCount), 1);
      assert.equal(yield* Ref.get(writeCount), 1);
      assert.equal(yield* Ref.get(reservationCount), 0);

      yield* Ref.set(rollbackShouldFail, true);
      const failedRestore = yield* rollback
        .execute({ threadId, providerThreadId, checkpointId, scopeId })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failedRestore));
      assert.equal(yield* Ref.get(writeCount), 1);
      assert.equal(yield* Ref.get(reservationCount), 1);

      yield* Ref.set(reservationCount, 0);
      yield* Ref.set(rollbackShouldFail, false);
      yield* Ref.set(rollbackShouldBlock, true);
      const interruptedRestore = yield* rollback
        .execute({ threadId, providerThreadId, checkpointId, scopeId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(rollbackEntered);
      yield* Fiber.interrupt(interruptedRestore);
      assert.equal(yield* Ref.get(writeCount), 1);
      assert.equal(yield* Ref.get(reservationCount), 1);
    }).pipe(Effect.provide(Layer.merge(serviceLayer, ownershipLayer)));
  }),
);
