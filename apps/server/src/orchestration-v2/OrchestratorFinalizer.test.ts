import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2StoredEvent,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runAppOwnedSubagentFinalizer } from "./Orchestrator.ts";

const now = DateTime.makeUnsafe("2026-07-26T12:00:00.000Z");
const childThreadId = ThreadId.make("thread:finalizer-child");

function terminalEvent(sequence: number): OrchestrationV2StoredEvent {
  return {
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`event:finalizer:${sequence}`),
      type: "run.updated",
      threadId: childThreadId,
      runId: RunId.make("run:finalizer-child"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt: now,
      payload: {
        id: RunId.make("run:finalizer-child"),
        threadId: childThreadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:finalizer-child"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "cancelled",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  };
}

describe("app-owned subagent finalizer", () => {
  it.effect("replays the same terminal event after five transient finalizer failures", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const accepted = yield* Ref.make(0);
      const cursors = yield* Ref.make<ReadonlyArray<number>>([]);
      const event = terminalEvent(1);
      const fiber = yield* runAppOwnedSubagentFinalizer({
        streamStoredEventsFrom: (afterSequence) =>
          Stream.unwrap(
            Ref.update(cursors, (all) => [...all, afterSequence]).pipe(
              Effect.as(Stream.fromIterable(afterSequence < 1 ? [event] : [])),
            ),
          ),
        finalize: () =>
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(attempts, (value) => value + 1);
            if (attempt <= 5) return yield* Effect.die(`failure ${attempt}`);
            yield* Ref.update(accepted, (value) => value + 1);
          }),
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(fiber);

      assert.equal(yield* Ref.get(attempts), 6);
      assert.equal(yield* Ref.get(accepted), 1);
      assert.deepEqual(yield* Ref.get(cursors), [0, 0]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resubscribes after a stream failure from the last finalized sequence", () =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.make(0);
      const cursors = yield* Ref.make<ReadonlyArray<number>>([]);
      const accepted = yield* Ref.make(0);
      const event = terminalEvent(1);
      const fiber = yield* runAppOwnedSubagentFinalizer({
        streamStoredEventsFrom: (afterSequence) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* Ref.updateAndGet(subscriptions, (value) => value + 1);
              yield* Ref.update(cursors, (all) => [...all, afterSequence]);
              return subscription === 1
                ? Stream.make(event).pipe(Stream.concat(Stream.fail("stream failure")))
                : Stream.empty;
            }),
          ),
        finalize: () => Ref.update(accepted, (value) => value + 1),
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(fiber);

      assert.equal(yield* Ref.get(accepted), 1);
      assert.deepEqual(yield* Ref.get(cursors), [0, 1]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
