import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { SupervisorControlPlaneService } from "../supervisor/SupervisorControlPlaneService.ts";
import { layer as supervisorWakeLayer, SupervisorWakeService } from "./SupervisorWakeService.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const now = DateTime.makeUnsafe("2026-07-25T12:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");

type MutableProjection = {
  -readonly [Key in keyof OrchestrationV2ThreadProjection]: OrchestrationV2ThreadProjection[Key];
};

function makeProjection(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly archived?: boolean;
  readonly parentThreadId?: ThreadId;
  readonly relationshipToParent?: "subagent";
}): MutableProjection {
  return {
    thread: {
      id: input.threadId,
      projectId: input.projectId,
      title: `Thread ${input.threadId}`,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: input.parentThreadId ?? null,
        relationshipToParent: input.relationshipToParent ?? null,
        rootThreadId: input.parentThreadId ?? input.threadId,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived === true ? now : null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

function addAppOwnedTask(input: {
  readonly parent: MutableProjection;
  readonly childThreadId: ThreadId;
  readonly status: "waiting" | "completed";
}) {
  const taskId = NodeId.make(`task:${input.childThreadId}`);
  input.parent.subagents = [
    {
      id: taskId,
      threadId: input.parent.thread.id,
      runId: RunId.make(`run:${input.parent.thread.id}`),
      parentNodeId: NodeId.make(`node:${input.parent.thread.id}`),
      origin: "app_owned",
      createdBy: "agent",
      driver: providerDriver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: input.childThreadId,
      nativeTaskRef: null,
      prompt: "Delegate work",
      title: null,
      model: "gpt-5.4",
      status: input.status,
      result: input.status === "completed" ? "untrusted result" : null,
      startedAt: now,
      completedAt: input.status === "completed" ? now : null,
      updatedAt: now,
    },
  ];
  return taskId;
}

function storedEvent(
  sequence: number,
  event: Omit<OrchestrationV2StoredEvent["event"], "id">,
): OrchestrationV2StoredEvent {
  return {
    sequence,
    commandId: null,
    event: { ...event, id: EventId.make(`event:supervisor-wake:${sequence}`) } as never,
  };
}

function makeHarness(
  projections: Map<ThreadId, OrchestrationV2ThreadProjection>,
  options: {
    readonly shouldFailDispatch?: (command: OrchestrationV2Command, attempt: number) => boolean;
    readonly stream?: (
      subscription: number,
      afterSequence: number,
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) => Stream.Stream<OrchestrationV2StoredEvent, string>;
    readonly shouldFailReconcile?: (attempt: number) => boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const accepted = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const dispatchAttempts = yield* Ref.make(0);
    const subscriptions = yield* Ref.make(0);
    const subscriptionCursors = yield* Ref.make<ReadonlyArray<number>>([]);
    const receipts = new Set<CommandId>();
    const events = yield* Ref.make<ReadonlyArray<OrchestrationV2StoredEvent>>([]);
    const reconciliations = yield* Ref.make<
      ReadonlyArray<{ readonly nodeId: NodeId; readonly status: string }>
    >([]);
    const reconciliationAttempts = yield* Ref.make(0);
    const threadLayer = Layer.mock(ThreadManagementService)({
      getThreadProjection: (threadId) => {
        const projection = projections.get(threadId);
        return projection === undefined
          ? Effect.die(`Missing projection ${threadId}`)
          : Effect.succeed(projection);
      },
      dispatch: (command) =>
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(dispatchAttempts, (value) => value + 1);
          if (options.shouldFailDispatch?.(command, attempt) === true) {
            return yield* Effect.die(`Transient wake dispatch failure ${attempt}`);
          }
          if (!receipts.has(command.commandId)) {
            receipts.add(command.commandId);
            yield* Ref.update(accepted, (commands) => [...commands, command]);
          }
          return { sequence: receipts.size, storedEvents: [] } as never;
        }),
      streamStoredEventsFrom: (input) => {
        const afterSequence = input?.afterSequence ?? 0;
        return Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* Ref.updateAndGet(subscriptions, (value) => value + 1);
            yield* Ref.update(subscriptionCursors, (cursors) => [...cursors, afterSequence]);
            const sourceEvents = (yield* Ref.get(events)).filter(
              (event) => event.sequence > afterSequence,
            );
            return (
              options.stream?.(subscription, afterSequence, sourceEvents) ??
              Stream.fromIterable(sourceEvents)
            );
          }),
        ) as never;
      },
    });
    const supervisorLayer = Layer.mock(SupervisorControlPlaneService)({
      readConfiguration: () =>
        Effect.succeed({
          configuration: { threadId: null, revision: 0, updatedAt: null },
        }),
      reconcileAttemptByNodeId: (input) =>
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(reconciliationAttempts, (value) => value + 1);
          if (options.shouldFailReconcile?.(attempt) === true) {
            return yield* Effect.die(`Transient control-plane failure ${attempt}`);
          }
          yield* Ref.update(reconciliations, (all) => [...all, input]);
        }),
    });
    const serviceLayer = supervisorWakeLayer.pipe(
      Layer.provide(Layer.merge(threadLayer, supervisorLayer)),
    );
    return {
      accepted,
      dispatchAttempts,
      subscriptions,
      subscriptionCursors,
      reconciliations,
      reconciliationAttempts,
      handle: (event: OrchestrationV2StoredEvent) =>
        Effect.gen(function* () {
          const service = yield* SupervisorWakeService;
          yield* service.handleStoredEvent(event);
        }).pipe(Effect.provide(serviceLayer)),
      replay: (sourceEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
        Ref.set(events, sourceEvents).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const service = yield* SupervisorWakeService;
              yield* service.run;
            }).pipe(Effect.provide(serviceLayer)),
          ),
        ),
    };
  });
}

function pendingRequestFixture(suffix = "", sequence = 1) {
  const parentThreadId = ThreadId.make(`thread:wake:request:parent${suffix}`);
  const childThreadId = ThreadId.make(`thread:wake:request:foreign-child${suffix}`);
  const requestId = RuntimeRequestId.make(`request:wake:app${suffix}`);
  const parent = makeProjection({
    projectId: ProjectId.make("project:wake:parent"),
    threadId: parentThreadId,
  });
  const taskId = addAppOwnedTask({ parent, childThreadId, status: "waiting" });
  const child = makeProjection({
    projectId: ProjectId.make("project:wake:foreign"),
    threadId: childThreadId,
    parentThreadId,
    relationshipToParent: "subagent",
  });
  const nodeId = NodeId.make(`node:wake:request:app${suffix}`);
  const runId = RunId.make(`run:wake:request:app-child${suffix}`);
  const request = {
    id: requestId,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input" as const,
    status: "pending" as const,
    responseCapability: { type: "not_resumable" as const, reason: "test" },
    createdAt: now,
    resolvedAt: null,
  };
  child.runtimeRequests = [request];
  child.nodes = [
    {
      id: nodeId,
      threadId: childThreadId,
      runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "user_input_request",
      status: "waiting",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    },
  ];
  const turnItem: OrchestrationV2ThreadProjection["turnItems"][number] = {
    id: TurnItemId.make(`turn-item:wake:request:app${suffix}`),
    threadId: childThreadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "waiting",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "user_input_request",
    requestId,
    questions: [],
  };
  child.turnItems = [turnItem];
  return {
    parentThreadId,
    childThreadId,
    requestId,
    taskId,
    child,
    request,
    turnItem,
    projections: new Map([
      [parentThreadId, parent],
      [childThreadId, child],
    ]),
    event: storedEvent(sequence, {
      type: "runtime-request.updated",
      threadId: childThreadId,
      runId,
      occurredAt: now,
      payload: request,
    }),
    turnItemEvent: storedEvent(sequence + 1, {
      type: "turn-item.updated",
      threadId: childThreadId,
      runId,
      occurredAt: now,
      payload: turnItem,
    }),
  };
}

describe("SupervisorWakeService", () => {
  it.effect("wakes an app-owned parent once for a foreign child request across replay", () =>
    Effect.gen(function* () {
      const fixture = pendingRequestFixture();
      const harness = yield* makeHarness(fixture.projections);

      yield* harness.replay([fixture.event]);
      yield* harness.replay([fixture.event]);

      const commands = yield* Ref.get(harness.accepted);
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.equal(command.threadId, fixture.parentThreadId);
      assert.include(command.text, fixture.taskId);
      assert.include(command.text, fixture.requestId);
      assert.include(command.text, "project:wake:foreign");
      assert.include(command.text, "t3_thread_respond");
    }),
  );

  it.effect("waits for the request turn item when the runtime request arrives first", () =>
    Effect.gen(function* () {
      const fixture = pendingRequestFixture(":request-first");
      fixture.child.turnItems = [];
      const harness = yield* makeHarness(fixture.projections);

      yield* harness.handle(fixture.event);
      assert.lengthOf(yield* Ref.get(harness.accepted), 0);

      fixture.child.turnItems = [
        fixture.turnItem,
        {
          ...fixture.turnItem,
          id: TurnItemId.make("turn-item:wake:request:duplicate"),
        },
      ];
      yield* harness.handle(fixture.turnItemEvent);
      assert.lengthOf(yield* Ref.get(harness.accepted), 0);

      fixture.child.turnItems = [fixture.turnItem];
      yield* harness.handle(fixture.turnItemEvent);

      assert.lengthOf(yield* Ref.get(harness.accepted), 1);
    }),
  );

  it.effect("wakes from the runtime request when its turn item arrived first", () =>
    Effect.gen(function* () {
      const fixture = pendingRequestFixture(":artifact-first");
      fixture.child.runtimeRequests = [];
      const harness = yield* makeHarness(fixture.projections);

      yield* harness.handle(fixture.turnItemEvent);
      assert.lengthOf(yield* Ref.get(harness.accepted), 0);

      fixture.child.runtimeRequests = [fixture.request];
      yield* harness.handle(fixture.event);

      assert.lengthOf(yield* Ref.get(harness.accepted), 1);
    }),
  );

  it.effect("wakes only after a durable app-owned result transfer and deduplicates replay", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:wake:result:parent");
      const childThreadId = ThreadId.make("thread:wake:result:foreign-child");
      const childRunId = RunId.make("run:wake:result:child");
      const parent = makeProjection({
        projectId: ProjectId.make("project:wake:result:parent"),
        threadId: parentThreadId,
      });
      const taskId = addAppOwnedTask({ parent, childThreadId, status: "completed" });
      const child = makeProjection({
        projectId: ProjectId.make("project:wake:result:foreign"),
        threadId: childThreadId,
        parentThreadId,
        relationshipToParent: "subagent",
      });
      const transfer = {
        id: ContextTransferId.make("transfer:wake:result"),
        type: "subagent_result" as const,
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        sourcePoint: { threadId: childThreadId, runId: childRunId },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "consumed" as const,
        resolution: null,
        createdBy: "system" as const,
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };
      parent.contextTransfers = [transfer];
      const event = storedEvent(1, {
        type: "context-transfer.created",
        threadId: parentThreadId,
        occurredAt: now,
        payload: transfer,
      });
      const harness = yield* makeHarness(
        new Map([
          [parentThreadId, parent],
          [childThreadId, child],
        ]),
        { shouldFailReconcile: (attempt) => attempt <= 3 },
      );

      yield* harness.replay([event]);
      yield* harness.replay([event]);

      const commands = yield* Ref.get(harness.accepted);
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.include(command.text, taskId);
      assert.include(command.text, transfer.id);
      assert.notInclude(command.text, "untrusted result");
      assert.include(command.text, "untrusted data");
      assert.equal(yield* Ref.get(harness.reconciliationAttempts), 5);
      assert.deepEqual(yield* Ref.get(harness.reconciliations), [
        { nodeId: taskId, status: "completed" },
        { nodeId: taskId, status: "completed" },
      ]);
    }),
  );

  it.effect("wakes again when a failed response delivery makes the request respondable", () =>
    Effect.gen(function* () {
      const fixture = pendingRequestFixture(":response-retry");
      const harness = yield* makeHarness(fixture.projections);

      yield* harness.handle(fixture.event);
      const child = fixture.projections.get(fixture.childThreadId) as MutableProjection;
      const reservedRequest = {
        ...child.runtimeRequests[0]!,
        responseCommandId: CommandId.make("command:wake:reserved-response"),
        responseAttempt: 1,
      };
      child.runtimeRequests = [reservedRequest];
      yield* harness.handle(
        storedEvent(2, {
          ...fixture.event.event,
          payload: reservedRequest,
        }),
      );
      assert.lengthOf(yield* Ref.get(harness.accepted), 1);

      const { responseCommandId: _responseCommandId, ...retriedRequest } = reservedRequest;
      child.runtimeRequests = [retriedRequest];
      yield* harness.handle(
        storedEvent(3, {
          ...fixture.event.event,
          payload: retriedRequest,
        }),
      );

      const commands = yield* Ref.get(harness.accepted);
      assert.lengthOf(commands, 2);
      const retry = commands[1];
      assert.equal(retry?.type, "message.dispatch");
      if (retry?.type !== "message.dispatch") return;
      assert.include(retry.text, "previous response delivery attempt failed");
      assert.include(retry.text, "new clientRequestId");
    }),
  );

  it.effect("retries a transient event handler failure before accepting the wake", () =>
    Effect.gen(function* () {
      const fixture = pendingRequestFixture();
      const harness = yield* makeHarness(fixture.projections, {
        shouldFailDispatch: (_command, attempt) => attempt < 3,
      });

      yield* harness.handle(fixture.event);

      assert.equal(yield* Ref.get(harness.dispatchAttempts), 3);
      assert.lengthOf(yield* Ref.get(harness.accepted), 1);
    }),
  );

  it.effect("replays a failed wake without advancing and then continues in order", () =>
    Effect.gen(function* () {
      const failing = pendingRequestFixture(":failing");
      const healthy = pendingRequestFixture(":healthy", 2);
      const projections = new Map([...failing.projections, ...healthy.projections]);
      const harness = yield* makeHarness(projections, {
        shouldFailDispatch: (command, attempt) =>
          command.type === "message.dispatch" &&
          command.threadId === failing.parentThreadId &&
          attempt <= 5,
      });

      const replayFiber = yield* Effect.forkChild(harness.replay([failing.event, healthy.event]));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(replayFiber);

      assert.equal(yield* Ref.get(harness.dispatchAttempts), 7);
      assert.deepEqual(yield* Ref.get(harness.subscriptionCursors), [0, 0]);
      const commands = yield* Ref.get(harness.accepted);
      assert.lengthOf(commands, 2);
      assert.deepEqual(
        commands.map((command) => (command.type === "message.dispatch" ? command.threadId : null)),
        [failing.parentThreadId, healthy.parentThreadId],
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resubscribes from the last processed global sequence", () =>
    Effect.gen(function* () {
      const fixture = pendingRequestFixture();
      const harness = yield* makeHarness(fixture.projections, {
        stream: (subscription, _afterSequence, events) =>
          subscription === 1
            ? Stream.fromIterable(events).pipe(
                Stream.concat(Stream.fail("transient stream failure")),
              )
            : Stream.fromIterable(events),
      });
      const replayFiber = yield* Effect.forkChild(harness.replay([fixture.event]));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(replayFiber);

      assert.equal(yield* Ref.get(harness.subscriptions), 2);
      assert.deepEqual(yield* Ref.get(harness.subscriptionCursors), [0, 1]);
      assert.lengthOf(yield* Ref.get(harness.accepted), 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
