import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { EventSinkV2, EventSinkWriteError } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layer as runtimeRequestServiceLayer,
  RuntimeRequestServiceV2,
} from "./RuntimeRequestService.ts";

const threadId = ThreadId.make("thread:runtime-request-service");
const requestId = RuntimeRequestId.make("request:runtime-request-service");
const nodeId = NodeId.make("node:runtime-request-service");
const turnItemId = TurnItemId.make("turn-item:runtime-request-service");
const providerSessionId = ProviderSessionId.make("provider-session:runtime-request-service");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const commandId = CommandId.make("command:runtime-request-service");

function makeProjection(now: DateTime.Utc): OrchestrationV2ThreadProjection {
  return {
    runtimeRequests: [
      {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "approval",
        status: "pending",
        responseCommandId: commandId,
        responseAttempt: 1,
        responseCapability: { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: null,
      },
    ],
    providerSessions: [
      {
        id: providerSessionId,
        driver: providerDriver,
        providerInstanceId,
      },
    ],
    nodes: [
      {
        id: nodeId,
        runId: null,
        status: "waiting",
        completedAt: null,
      },
    ],
    turnItems: [
      {
        id: turnItemId,
        type: "approval_request",
        requestId,
        runId: null,
        nodeId,
        status: "waiting",
        completedAt: null,
        updatedAt: now,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

const applyEvents = (
  projection: OrchestrationV2ThreadProjection,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): OrchestrationV2ThreadProjection => {
  let runtimeRequests = projection.runtimeRequests;
  let nodes = projection.nodes;
  let turnItems = projection.turnItems;
  for (const event of events) {
    switch (event.type) {
      case "runtime-request.updated":
        runtimeRequests = [event.payload];
        break;
      case "node.updated":
        nodes = [event.payload];
        break;
      case "turn-item.updated":
        turnItems = [event.payload];
        break;
      default:
        break;
    }
  }
  return { ...projection, runtimeRequests, nodes, turnItems };
};

const makeHarness = Effect.fnUntraced(function* (input?: {
  readonly providerFailures?: number;
  readonly persistenceFailures?: number;
  readonly afterProviderDelivery?: Effect.Effect<void>;
  readonly beforeGuardedCommit?: Effect.Effect<void>;
}) {
  const now = yield* DateTime.now;
  const projection = yield* Ref.make(makeProjection(now));
  const providerFailures = yield* Ref.make(input?.providerFailures ?? 0);
  const persistenceFailures = yield* Ref.make(input?.persistenceFailures ?? 0);
  const providerSendCount = yield* Ref.make(0);
  const persistenceAttemptCount = yield* Ref.make(0);
  const persistedBatches = yield* Ref.make<
    ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>
  >([]);
  const runtime = {
    respondToRuntimeRequest: () =>
      Effect.gen(function* () {
        yield* Ref.update(providerSendCount, (count) => count + 1);
        const remainingFailures = yield* Ref.get(providerFailures);
        if (remainingFailures > 0) {
          yield* Ref.set(providerFailures, remainingFailures - 1);
          return yield* Effect.fail("simulated provider failure");
        }
        if (input?.afterProviderDelivery !== undefined) {
          yield* input.afterProviderDelivery;
        }
      }),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const guardsCurrent = (
    guards: Parameters<EventSinkV2["Service"]["writeIfRuntimeRequestsCurrent"]>[0]["guards"],
  ) =>
    Ref.get(projection).pipe(
      Effect.map((current) =>
        guards.every((guard) => {
          const request = current.runtimeRequests.find(
            (candidate) => candidate.id === guard.requestId,
          );
          return (
            request?.status === guard.expectedStatus &&
            (guard.expectedResponseCommandId === undefined ||
              request.responseCommandId === guard.expectedResponseCommandId)
          );
        }),
      ),
    );
  const guardedWrite = (
    writeInput: Parameters<EventSinkV2["Service"]["writeIfRuntimeRequestsCurrent"]>[0],
  ) =>
    Effect.gen(function* () {
      yield* Ref.update(persistenceAttemptCount, (count) => count + 1);
      if (input?.beforeGuardedCommit !== undefined) yield* input.beforeGuardedCommit;
      const remainingFailures = yield* Ref.get(persistenceFailures);
      if (remainingFailures > 0) {
        yield* Ref.set(persistenceFailures, remainingFailures - 1);
        return yield* new EventSinkWriteError({
          eventCount: writeInput.events.length,
          ...(writeInput.commandId === undefined ? {} : { commandId: writeInput.commandId }),
        });
      }
      if (!(yield* guardsCurrent(writeInput.guards))) {
        return { committed: false, storedEvents: [] };
      }
      yield* Ref.update(projection, (current) => applyEvents(current, writeInput.events));
      yield* Ref.update(persistedBatches, (batches) => [...batches, writeInput.events]);
      return { committed: true, storedEvents: [] };
    });
  const eventSinkLayer = Layer.mock(EventSinkV2)({
    writeIfRuntimeRequestsCurrent: guardedWrite,
    failEffectWithEvents: (writeInput) =>
      Effect.gen(function* () {
        yield* Ref.update(persistenceAttemptCount, (count) => count + 1);
        if (
          writeInput.runtimeRequestGuards === undefined ||
          (yield* guardsCurrent(writeInput.runtimeRequestGuards))
        ) {
          yield* Ref.update(projection, (current) => applyEvents(current, writeInput.events));
          yield* Ref.update(persistedBatches, (batches) => [...batches, writeInput.events]);
        }
        return { failed: true, storedEvents: [] };
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionStoreV2)({ getThreadProjection: () => Ref.get(projection) }),
    Layer.mock(ProviderSessionManagerV2)({
      get: () => Effect.succeed(Option.some(runtime)),
    }),
    eventSinkLayer,
    idAllocatorLayer,
  );

  return {
    layer: runtimeRequestServiceLayer.pipe(Layer.provide(dependencies)),
    projection,
    providerSendCount,
    persistenceAttemptCount,
    persistedBatches,
    guardedWrite,
  };
});

const responseInput = {
  threadId,
  providerSessionId,
  requestId,
  commandId,
  decision: "accept" as const,
};

it.effect("keeps the reserved request pending when provider delivery fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ providerFailures: 1 });
    const exit = yield* Effect.gen(function* () {
      const service = yield* RuntimeRequestServiceV2;
      return yield* Effect.exit(service.respond(responseInput));
    }).pipe(Effect.provide(harness.layer));

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(harness.providerSendCount), 1);
    assert.equal(yield* Ref.get(harness.persistenceAttemptCount), 0);
    const projection = yield* Ref.get(harness.projection);
    assert.equal(projection.runtimeRequests[0]?.status, "pending");
    assert.equal(projection.runtimeRequests[0]?.responseCommandId, commandId);
    assert.equal(projection.nodes[0]?.status, "waiting");
    assert.equal(projection.turnItems[0]?.status, "waiting");
  }),
);

it.effect("retries resolution persistence without delivering to the provider twice", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ persistenceFailures: 1 });

    yield* Effect.gen(function* () {
      const service = yield* RuntimeRequestServiceV2;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.respond(responseInput))));
      assert.isTrue(yield* service.isDeliveryAcknowledged(requestId));
      yield* service.releasePendingResponse({
        threadId,
        requestId,
        commandId,
        effectId: "effect:runtime-request-service",
        workerId: "worker:runtime-request-service",
        error: "delivery failed",
      });
      assert.equal(
        (yield* Ref.get(harness.projection)).runtimeRequests[0]?.responseCommandId,
        commandId,
      );
      yield* service.respond(responseInput);
      assert.isFalse(yield* service.isDeliveryAcknowledged(requestId));
    }).pipe(Effect.provide(harness.layer));

    assert.equal(yield* Ref.get(harness.providerSendCount), 1);
    assert.equal(yield* Ref.get(harness.persistenceAttemptCount), 2);
    const projection = yield* Ref.get(harness.projection);
    assert.equal(projection.runtimeRequests[0]?.status, "resolved");
    assert.equal(projection.nodes[0]?.status, "completed");
    assert.equal(projection.turnItems[0]?.status, "completed");
  }),
);

it.effect(
  "durably resolves the request, node, and item and treats a resolved retry as a no-op",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const service = yield* RuntimeRequestServiceV2;
        yield* service.respond(responseInput);
        yield* service.respond(responseInput);
      }).pipe(Effect.provide(harness.layer));

      assert.equal(yield* Ref.get(harness.providerSendCount), 1);
      assert.equal(yield* Ref.get(harness.persistenceAttemptCount), 1);
      const batches = yield* Ref.get(harness.persistedBatches);
      assert.deepEqual(
        batches[0]?.map((event) => event.type),
        ["runtime-request.updated", "node.updated", "turn-item.updated"],
      );
      const projection = yield* Ref.get(harness.projection);
      assert.equal(projection.runtimeRequests[0]?.status, "resolved");
      assert.isNotNull(projection.runtimeRequests[0]?.resolvedAt);
      assert.equal(projection.nodes[0]?.status, "completed");
      assert.isNotNull(projection.nodes[0]?.completedAt);
      assert.equal(projection.turnItems[0]?.status, "completed");
      assert.isNotNull(projection.turnItems[0]?.completedAt);
    }),
);

it.effect("advances the durable delivery generation when releasing a failed response", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Ref.update(harness.projection, (projection) => ({
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseAttempt: 3,
      })),
    }));

    yield* Effect.gen(function* () {
      const service = yield* RuntimeRequestServiceV2;
      yield* service.releasePendingResponse({
        threadId,
        requestId,
        commandId,
        effectId: "effect:runtime-request-service",
        workerId: "worker:runtime-request-service",
        error: "delivery failed",
      });
    }).pipe(Effect.provide(harness.layer));

    const request = (yield* Ref.get(harness.projection)).runtimeRequests[0];
    assert.equal(request?.status, "pending");
    assert.isFalse(request !== undefined && "responseCommandId" in request);
    assert.equal(request?.responseAttempt, 4);
    assert.isNull(request?.resolvedAt);
  }),
);

const completesWhenRequestTerminalizesAfterDelivery = (
  status: "cancelled" | "expired",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const commitEntered = yield* Deferred.make<void>();
    const releaseCommit = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      beforeGuardedCommit: Deferred.succeed(commitEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseCommit)),
      ),
    });

    yield* Effect.gen(function* () {
      const service = yield* RuntimeRequestServiceV2;
      const response = yield* service.respond(responseInput).pipe(Effect.forkChild);
      yield* Deferred.await(commitEntered);
      yield* Ref.update(harness.projection, (projection) => ({
        ...projection,
        runtimeRequests: projection.runtimeRequests.map((request) => ({
          ...request,
          status,
          responseCapability: {
            type: "not_resumable" as const,
            reason: `Request became ${status} during provider delivery.`,
          },
          resolvedAt: DateTime.makeUnsafe("2026-07-26T00:00:00.000Z"),
        })),
      }));
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(response);
      assert.isFalse(yield* service.isDeliveryAcknowledged(requestId));
    }).pipe(Effect.provide(harness.layer), Effect.orDie);

    assert.equal(yield* Ref.get(harness.providerSendCount), 1);
    assert.equal(yield* Ref.get(harness.persistenceAttemptCount), 1);
    assert.isEmpty(yield* Ref.get(harness.persistedBatches));
    assert.equal((yield* Ref.get(harness.projection)).runtimeRequests[0]?.status, status);
  });

it.effect("completes an acknowledged response when cancellation wins delivery", () =>
  completesWhenRequestTerminalizesAfterDelivery("cancelled"),
);

it.effect("completes an acknowledged response when session release wins delivery", () =>
  completesWhenRequestTerminalizesAfterDelivery("expired"),
);

it.effect("does not let stale terminalization overwrite a committed response", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const terminalSnapshot = (yield* Ref.get(harness.projection)).runtimeRequests[0]!;
    const terminalAt = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");

    yield* Effect.gen(function* () {
      const service = yield* RuntimeRequestServiceV2;
      yield* service.respond(responseInput);
    }).pipe(Effect.provide(harness.layer));

    const terminalCommit = yield* harness.guardedWrite({
      events: [
        {
          id: "event:stale-runtime-request-terminalization" as never,
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: terminalAt,
          payload: {
            ...terminalSnapshot,
            status: "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: "The request was cancelled.",
            },
            resolvedAt: terminalAt,
          },
        },
      ],
      guards: [{ threadId, requestId, expectedStatus: "pending" }],
    });

    assert.isFalse(terminalCommit.committed);
    assert.equal((yield* Ref.get(harness.projection)).runtimeRequests[0]?.status, "resolved");
  }),
);
