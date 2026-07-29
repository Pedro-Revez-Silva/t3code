import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import { makeSingleLayer as makeProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import {
  layerWithOptions as providerSessionManagerLayerWithOptions,
  ProviderSessionManagerV2,
} from "./ProviderSessionManager.ts";
import { ProviderSessionGenerationStore } from "./ProviderSessionGenerationStore.ts";
import { layer as providerOwnershipGuardLayer } from "./ProviderOwnershipGuard.ts";
import {
  layer as providerTurnControlLayer,
  ProviderTurnControlServiceV2,
} from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
} as const;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        // The restart command has already projected this replacement binding
        // before the process-bound restart effect executes.
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const projectionLayer = Layer.succeed(
        ProjectionStoreV2,
        ProjectionStoreV2.of({
          apply: () => Effect.void,
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          getThreadProjection: () => Ref.get(projection),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
        }),
      );
      const sessionManagerLayer = Layer.succeed(
        ProviderSessionManagerV2,
        ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          close: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
          hardDetach: () => Effect.void,
        }),
      );
      const controlLayer = providerTurnControlLayer.pipe(
        Layer.provide(Layer.merge(projectionLayer, sessionManagerLayer)),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(controlLayer));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(controlLayer));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

it.effect(
  "hard-detaches one nonterminal thread through the shared session manager without affecting its peer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const targetThreadId = ThreadId.make("thread:hard-stop:target");
        const peerThreadId = ThreadId.make("thread:hard-stop:peer");
        const providerSessionId = ProviderSessionId.make("provider-session:hard-stop:shared");
        const targetProviderThreadId = ProviderThreadId.make("provider-thread:hard-stop:target");
        const peerProviderThreadId = ProviderThreadId.make("provider-thread:hard-stop:peer");
        const targetProviderTurnId = ProviderTurnId.make("provider-turn:hard-stop:target");
        const peerProviderTurnId = ProviderTurnId.make("provider-turn:hard-stop:peer");
        const targetAttemptId = RunAttemptId.make("run-attempt:hard-stop:target");
        const peerAttemptId = RunAttemptId.make("run-attempt:hard-stop:peer");
        const makeProviderThread = (
          threadId: ThreadId,
          providerThreadId: ProviderThreadId,
        ): OrchestrationV2ProviderThread => ({
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver,
            nativeId: `native:${providerThreadId}`,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        });
        const targetProviderThread = makeProviderThread(targetThreadId, targetProviderThreadId);
        const peerProviderThread = makeProviderThread(peerThreadId, peerProviderThreadId);
        const durableProviderSession = {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready" as const,
          cwd: runtimePolicy.cwd,
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runningProjection = (input: {
          readonly threadId: ThreadId;
          readonly providerThread: OrchestrationV2ProviderThread;
          readonly providerTurnId: ProviderTurnId;
          readonly attemptId: RunAttemptId;
        }) => {
          const projection = makeProjection({ now, ...input });
          return {
            ...projection,
            providerSessions: [durableProviderSession],
            attempts: projection.attempts.map((attempt) => ({
              ...attempt,
              status: "running" as const,
              completedAt: null,
            })),
          };
        };
        const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>([
          [
            targetThreadId,
            runningProjection({
              threadId: targetThreadId,
              providerThread: targetProviderThread,
              providerTurnId: targetProviderTurnId,
              attemptId: targetAttemptId,
            }),
          ],
          [
            peerThreadId,
            runningProjection({
              threadId: peerThreadId,
              providerThread: peerProviderThread,
              providerTurnId: peerProviderTurnId,
              attemptId: peerAttemptId,
            }),
          ],
        ]);
        const eventQueue = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const interrupts = yield* Ref.make<ReadonlyArray<ProviderTurnId>>([]);
        const resumedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
        const closeCount = yield* Ref.make(0);
        const persistedEvents = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const generation = yield* Ref.make(0);
        const adapter: ProviderAdapterV2Shape = {
          instanceId: providerInstanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Ref.update(closeCount, (count) => count + 1));
              const providerSession = { ...durableProviderSession, id: input.providerSessionId };
              return {
                instanceId: providerInstanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession,
                events: Stream.fromQueue(eventQueue),
                ensureThread: () => Effect.die("unused ensureThread"),
                resumeThread: (resumeInput) =>
                  Ref.update(resumedThreads, (threads) => [
                    ...threads,
                    resumeInput.threadId ?? resumeInput.providerThread.appThreadId!,
                  ]).pipe(Effect.as(resumeInput.providerThread)),
                startTurn: () => Effect.void,
                steerTurn: () => Effect.void,
                interruptTurn: (interruptInput) =>
                  Ref.update(interrupts, (turns) => [...turns, interruptInput.providerTurnId]),
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
                rollbackThread: () => Effect.die("unused rollbackThread"),
                forkThread: () => Effect.die("unused forkThread"),
              } satisfies ProviderAdapterV2SessionRuntime;
            }),
        };
        const projectionLayer = Layer.mock(ProjectionStoreV2)({
          getThreadProjection: (threadId) => Effect.succeed(projections.get(threadId)!),
        });
        const eventSinkLayer = Layer.mock(EventSinkV2)({
          write: (input) =>
            Ref.update(persistedEvents, (events) => [...events, ...input.events]).pipe(
              Effect.as([]),
            ),
          writeProviderEventsIfCurrent: (input) =>
            Ref.update(persistedEvents, (events) => [...events, ...input.events]).pipe(
              Effect.as({ committed: true as const, storedEvents: [] }),
            ),
          quarantineProviderSession: (input) =>
            Effect.gen(function* () {
              const nextGeneration = yield* Ref.updateAndGet(generation, (current) => current + 1);
              yield* Ref.update(persistedEvents, (events) => [
                ...events,
                input.providerThreadEvent,
                input.providerSessionDetachedEvent,
              ]);
              return {
                committed: true as const,
                finalOwner: false,
                generation: nextGeneration,
                storedEvents: [],
              };
            }),
        });
        const fakeHttpServer = HttpServer.HttpServer.of({
          address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        });
        const fakeEnvironment = ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:hard-stop")),
          getDescriptor: Effect.die("unused getDescriptor"),
        });
        const mcpRegistryLayer = Layer.effect(
          McpSessionRegistry.McpSessionRegistry,
          McpSessionRegistry.__testing.make(),
        ).pipe(
          Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
          Layer.provide(Layer.succeed(ServerEnvironment, fakeEnvironment)),
          Layer.provide(NodeServices.layer),
        );
        const dependencies = Layer.mergeAll(
          projectionLayer,
          eventSinkLayer,
          idAllocatorLayer,
          mcpRegistryLayer,
          makeProviderAdapterRegistryLayer(adapter),
          providerOwnershipGuardLayer,
          Layer.succeed(
            ProviderSessionGenerationStore,
            ProviderSessionGenerationStore.of({
              current: () => Ref.get(generation),
              state: () =>
                Ref.get(generation).pipe(
                  Effect.map((current) => ({
                    generation: current,
                    quarantinedProviderSessionId: current === 0 ? null : providerSessionId,
                  })),
                ),
              quarantine: () => Ref.updateAndGet(generation, (current) => current + 1),
            }),
          ),
        );
        const managerLayer = providerSessionManagerLayerWithOptions({
          idleTimeoutMs: 60_000,
        }).pipe(Layer.provide(dependencies));
        const controlLayer = providerTurnControlLayer.pipe(
          Layer.provide(Layer.merge(projectionLayer, managerLayer)),
        );
        const testLayer = Layer.mergeAll(
          managerLayer,
          controlLayer,
          mcpRegistryLayer,
          idAllocatorLayer,
        );

        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const control = yield* ProviderTurnControlServiceV2;
          const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
          const idAllocator = yield* IdAllocatorV2;
          const targetRuntime = yield* manager.open({
            threadId: targetThreadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const targetCredential = McpProviderSession.readMcpProviderSession(targetThreadId)!;
          const peerRuntime = yield* manager.open({
            threadId: peerThreadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const peerCredential = McpProviderSession.readMcpProviderSession(peerThreadId)!;
          const peerSubscription = yield* peerRuntime.subscribeEvents!;

          const interruptExit = yield* control
            .interruptAndAwaitTerminal({
              threadId: targetThreadId,
              providerSessionId,
              providerThreadId: targetProviderThreadId,
              providerTurnId: targetProviderTurnId,
              interruptedAttemptId: targetAttemptId,
            })
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(interruptExit));
          yield* control.hardStop({
            threadId: targetThreadId,
            providerSessionId,
            providerThreadId: targetProviderThreadId,
            providerTurnId: targetProviderTurnId,
          });

          const targetToken = targetCredential.authorizationHeader.replace(/^Bearer\s+/, "");
          const peerToken = peerCredential.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isUndefined(yield* mcpRegistry.resolve(targetToken));
          assert.isDefined(yield* mcpRegistry.resolve(peerToken));
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal(yield* Ref.get(closeCount), 0);
          assert.deepEqual(yield* Ref.get(interrupts), [targetProviderTurnId]);
          assert.isTrue(
            (yield* Ref.get(persistedEvents)).some(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                event.type === "provider-thread.updated" &&
                "payload" in event &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                "providerSessionId" in event.payload &&
                event.payload.providerSessionId === null,
            ),
          );
          assert.isTrue(
            (yield* Ref.get(persistedEvents)).some(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                event.type === "provider-session.detached",
            ),
          );
          assert.isFalse(
            (yield* Ref.get(persistedEvents)).some(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                event.type === "provider-session.updated" &&
                "payload" in event &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                "status" in event.payload &&
                event.payload.status === "error",
            ),
          );
          assert.equal(yield* Ref.get(generation), 1);

          assert.isTrue(
            Exit.isFailure(
              yield* targetRuntime
                .resumeThread({
                  providerThread: targetProviderThread,
                  threadId: targetThreadId,
                  modelSelection,
                  runtimePolicy,
                })
                .pipe(Effect.exit),
            ),
          );
          assert.isTrue(
            Exit.isFailure(
              yield* manager
                .open({
                  threadId: targetThreadId,
                  providerSessionId,
                  modelSelection,
                  runtimePolicy,
                })
                .pipe(Effect.exit),
            ),
          );
          yield* peerRuntime.resumeThread({
            providerThread: peerProviderThread,
            threadId: peerThreadId,
            modelSelection,
            runtimePolicy,
          });
          assert.deepEqual(yield* Ref.get(resumedThreads), [peerThreadId]);

          yield* Queue.offer(eventQueue, {
            type: "turn.terminal",
            driver,
            providerThreadId: targetProviderThreadId,
            providerTurnId: targetProviderTurnId,
            runOrdinal: 1,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Queue.offer(eventQueue, {
            type: "turn.terminal",
            driver,
            providerThreadId: peerProviderThreadId,
            providerTurnId: peerProviderTurnId,
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          const received = yield* peerSubscription.events.pipe(Stream.runHead);
          assert.isTrue(Option.isSome(received));
          if (Option.isSome(received) && received.value.type === "turn.terminal") {
            assert.equal(received.value.providerTurnId, peerProviderTurnId);
          }

          const reboundProviderSessionId = idAllocator.derive.providerSession({
            threadId: targetThreadId,
            providerInstanceId,
            generation: yield* Ref.get(generation),
          });
          assert.notEqual(reboundProviderSessionId, providerSessionId);
          yield* manager.open({
            threadId: targetThreadId,
            providerSessionId: reboundProviderSessionId,
            modelSelection,
            runtimePolicy,
          });
          const reboundCredential = McpProviderSession.readMcpProviderSession(targetThreadId)!;
          const reboundToken = reboundCredential.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(yield* mcpRegistry.resolve(reboundToken));
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.isTrue(Option.isSome(yield* manager.get(reboundProviderSessionId)));
        }).pipe(Effect.provide(testLayer));
      }),
    ),
);
