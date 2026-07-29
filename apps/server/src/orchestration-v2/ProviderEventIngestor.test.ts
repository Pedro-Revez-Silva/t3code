import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import {
  IdAllocatorV2,
  type IdAllocatorV2Error,
  layer as idAllocatorLayer,
} from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  ProviderEventIngestorV2,
  layer as providerEventIngestorLayer,
} from "./ProviderEventIngestor.ts";
import { layer as providerSessionGenerationStoreLayer } from "./ProviderSessionGenerationStore.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";

const TestDatabaseLayer = SqlitePersistenceMemory;
const TestStoresLayer = Layer.merge(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provide(TestDatabaseLayer),
);

const TestEventSinkLayer = eventSinkLayer.pipe(
  Layer.provide(Layer.mergeAll(TestStoresLayer, TestDatabaseLayer)),
);
const TestProviderSessionGenerationStoreLayer = providerSessionGenerationStoreLayer.pipe(
  Layer.provide(TestDatabaseLayer),
);

const TestLayer = Layer.mergeAll(
  TestDatabaseLayer,
  TestStoresLayer,
  TestEventSinkLayer,
  idAllocatorLayer,
  TestProviderSessionGenerationStoreLayer,
  providerEventIngestorLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        TestStoresLayer,
        TestEventSinkLayer,
        idAllocatorLayer,
        TestProviderSessionGenerationStoreLayer,
      ),
    ),
  ),
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<OrchestrationV2DomainEvent, IdAllocatorV2Error, IdAllocatorV2> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const layer = it.layer(TestLayer);

layer("ProviderEventIngestorV2", (it) => {
  it.effect("normalizes provider events through the real event log and projection store", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const eventStore = yield* EventStoreV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-thread",
        }),
        driver: CODEX_DRIVER,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: threadEvent.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER,
          nativeId: "native-thread",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({ events: [threadEvent] });
      const storedEvents = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const storedDomainEvents = yield* eventStore.read({}).pipe(Stream.runCollect);
      const afterFirstEvent = yield* eventStore
        .read({ afterSequence: 1, threadId: threadEvent.threadId })
        .pipe(Stream.runCollect);
      const latestThreadSequence = yield* eventStore.latestSequence({
        threadId: threadEvent.threadId,
      });

      assert.equal(storedEvents.length, 1);
      assert.equal(storedEvents[0]?.event.type, "provider-thread.updated");
      assert.deepEqual(
        projection.providerThreads.map((thread) => thread.id),
        [providerThread.id],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.event.type),
        ["thread.created", "provider-thread.updated"],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.sequence),
        [1, 2],
      );
      assert.deepEqual(
        Array.from(afterFirstEvent).map((stored) => stored.event.type),
        ["provider-thread.updated"],
      );
      assert.equal(latestThreadSequence, 2);
    }),
  );

  it.effect(
    "treats successful provider terminal markers as non-persisted orchestration control signals",
    () =>
      Effect.gen(function* () {
        const ingestor = yield* ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocatorV2;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-event-terminal",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-event-terminal",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const normalized = yield* ingestor.normalize({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event: {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId: idAllocator.derive.providerThread({
              driver: CODEX_DRIVER,
              nativeThreadId: "native-thread",
            }),
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: "native-turn",
            }),
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          },
        });

        assert.deepEqual(normalized, []);
      }),
  );

  it.effect("persists a failed provider terminal as one expected error item", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-failed",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-failed",
      });

      yield* eventSink.write({ events: [threadEvent] });
      const stored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId,
          providerTurnId,
          runOrdinal: 1,
          failureItemOrdinal: 102,
          status: "failed",
          failure: makeProviderFailure({
            message: "Invalid reasoning effort.",
            code: "invalid_request",
            class: "validation_error",
          }),
          threadDisposition: "reusable",
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const errorItems = projection.visibleTurnItems.filter(
        (candidate) => candidate.item.type === "error",
      );

      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.event.type, "turn-item.updated");
      assert.equal(errorItems.length, 1);
      const errorItem = errorItems[0]?.item;
      assert.equal(errorItem?.type, "error");
      if (errorItem?.type !== "error") return;
      assert.equal(errorItem.failure.message, "Invalid reasoning effort.");
      assert.equal(errorItem.failure.code, "invalid_request");
      assert.equal(errorItem.providerThreadId, providerThreadId);
      assert.equal(errorItem.providerTurnId, providerTurnId);
    }),
  );

  it.effect("routes provider-owned child artifacts to their child app thread", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-subagent-thread",
      });
      const childRootNodeId = NodeId.make("node:subagent-root");
      const childThread: OrchestrationV2AppThread = {
        ...rootEvent.payload,
        id: childThreadId,
        title: "inspect package",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent",
          rootThreadId: rootEvent.threadId,
        },
        forkedFrom: {
          type: "node",
          nodeId: NodeId.make("node:parent-subagent"),
        },
      };
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });

      const threadEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "app_thread.created",
          driver: CODEX_DRIVER,
          appThread: childThread,
        },
      });
      const messageEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "message.updated",
          driver: CODEX_DRIVER,
          message: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make("message:subagent-response"),
            threadId: childThreadId,
            runId: null,
            nodeId: childRootNodeId,
            role: "assistant",
            text: "Subagent result",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      assert.equal(threadEvents[0]?.type, "thread.created");
      assert.equal(threadEvents[0]?.threadId, childThreadId);
      assert.equal(messageEvents[0]?.type, "message.updated");
      assert.equal(messageEvents[0]?.threadId, childThreadId);
    }),
  );

  it.effect(
    "transactionally fences buffered shared-runtime child artifacts after hard detach",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSinkV2;
        const ingestor = yield* ProviderEventIngestorV2;
        const projectionStore = yield* ProjectionStoreV2;
        const idAllocator = yield* IdAllocatorV2;
        const sql = yield* SqlClient.SqlClient;
        const rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") return assert.fail("expected root thread");
        const rootThreadId = rootEvent.threadId;
        const childThreadId = ThreadId.make("thread:provider-event-authority:child");
        const providerSessionId = idAllocator.derive.providerSession({
          threadId: rootThreadId,
          providerInstanceId: modelSelection.instanceId,
          generation: 0,
        });
        const providerThreadId = ProviderThreadId.make("provider-thread:provider-event-authority");
        const runId = RunId.make("run:provider-event-authority");
        const attemptId = RunAttemptId.make("run-attempt:provider-event-authority");
        const rootNodeId = NodeId.make("node:provider-event-authority");
        const providerTurnId = ProviderTurnId.make("provider-turn:provider-event-authority");
        const providerThread: OrchestrationV2ProviderThread = {
          id: providerThreadId,
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId,
          appThreadId: rootThreadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const providerSession = {
          id: providerSessionId,
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          status: "running" as const,
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const run = {
          id: runId,
          threadId: rootThreadId,
          ordinal: 1,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:provider-event-authority:user"),
          rootNodeId,
          activeAttemptId: attemptId,
          status: "running" as const,
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        } satisfies OrchestrationV2Run;
        yield* eventSink.write({
          events: [
            rootEvent,
            {
              id: EventId.make("event:provider-event-authority:provider-thread"),
              type: "provider-thread.updated",
              threadId: rootThreadId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: EventId.make("event:provider-event-authority:session"),
              type: "provider-session.attached",
              threadId: rootThreadId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: providerSession,
            },
            {
              id: EventId.make("event:provider-event-authority:run"),
              type: "run.created",
              threadId: rootThreadId,
              runId,
              nodeId: rootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: run,
            },
            {
              id: EventId.make("event:provider-event-authority:attempt"),
              type: "run-attempt.updated",
              threadId: rootThreadId,
              runId,
              nodeId: rootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: modelSelection.instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make("event:provider-event-authority:root-node"),
              type: "node.updated",
              threadId: rootThreadId,
              runId,
              nodeId: rootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: rootNodeId,
                threadId: rootThreadId,
                runId,
                parentNodeId: null,
                rootNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: true,
                providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make("event:provider-event-authority:provider-turn"),
              type: "provider-turn.updated",
              threadId: rootThreadId,
              runId,
              nodeId: rootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        yield* sql`
          INSERT INTO orchestration_v2_provider_authority_acquisitions (
            thread_id,
            provider_instance_id,
            run_id,
            run_ordinal,
            attempt_id,
            provider_thread_id,
            provider_session_id,
            generation,
            acquired_at
          ) VALUES (
            ${rootThreadId},
            ${modelSelection.instanceId},
            ${runId},
            1,
            ${attemptId},
            ${providerThreadId},
            ${providerSessionId},
            0,
            ${DateTime.formatIso(now)}
          )
        `;

        const childThread: OrchestrationV2AppThread = {
          ...rootEvent.payload,
          id: childThreadId,
          createdBy: "agent",
          creationSource: "provider",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: rootThreadId,
            relationshipToParent: "subagent",
            rootThreadId,
          },
        };
        const providerAuthority = { providerThreadId, runId, activeAttemptId: attemptId };
        const childThreadEvents = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: { type: "app_thread.created", driver: CODEX_DRIVER, appThread: childThread },
        });
        assert.equal(childThreadEvents.length, 1);

        const turnItem = {
          id: TurnItemId.make("turn-item:provider-event-authority:child"),
          threadId: childThreadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running" as const,
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "assistant_message" as const,
          messageId: MessageId.make("message:provider-event-authority:child"),
          text: "buffered child output",
          streaming: true,
        } satisfies OrchestrationV2TurnItem;
        const initialItemEvents = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
        });
        assert.equal(initialItemEvents.length, 1);

        const providerSubagentNodeId = NodeId.make("node:provider-event-authority:provider-child");
        const childProviderThreadId = ProviderThreadId.make(
          "provider-thread:provider-event-authority:provider-child",
        );
        const childProviderThread = {
          ...providerThread,
          id: childProviderThreadId,
          appThreadId: childThreadId,
          ownerNodeId: null,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          forkedFrom: { providerThreadId, providerTurnId },
        };
        const providerSubagent = {
          id: providerSubagentNodeId,
          threadId: rootThreadId,
          runId,
          parentNodeId: rootNodeId,
          origin: "provider_native" as const,
          createdBy: "agent" as const,
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: childProviderThreadId,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Provider-owned child",
          title: "Provider child",
          model: modelSelection.model,
          status: "running" as const,
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const providerSubagentNodeEvents = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "node.updated",
            driver: CODEX_DRIVER,
            node: {
              id: providerSubagentNodeId,
              threadId: rootThreadId,
              runId,
              parentNodeId: rootNodeId,
              rootNodeId,
              kind: "subagent",
              status: "running",
              countsForRun: false,
              providerThreadId: childProviderThreadId,
              providerTurnId,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
        });
        assert.equal(providerSubagentNodeEvents.length, 1);
        const childProviderThreadEvents = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "provider_thread.updated",
            driver: CODEX_DRIVER,
            providerThread: childProviderThread,
          },
        });
        assert.equal(childProviderThreadEvents.length, 1);
        const providerSubagentEvents = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: { type: "subagent.updated", driver: CODEX_DRIVER, subagent: providerSubagent },
        });
        assert.equal(providerSubagentEvents.length, 1);

        const appOwnedChildThreadId = ThreadId.make(
          "thread:provider-event-authority:app-owned-child",
        );
        const appOwnedSubagentNodeId = NodeId.make("node:provider-event-authority:app-owned-child");
        const appOwnedChildThread = {
          ...childThread,
          id: appOwnedChildThreadId,
          creationSource: "mcp" as const,
        };
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:provider-event-authority:app-owned-thread"),
              type: "thread.created",
              threadId: appOwnedChildThreadId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: appOwnedChildThread,
            },
            {
              id: EventId.make("event:provider-event-authority:app-owned-node"),
              type: "node.updated",
              threadId: rootThreadId,
              runId,
              nodeId: appOwnedSubagentNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: appOwnedSubagentNodeId,
                threadId: rootThreadId,
                runId,
                parentNodeId: rootNodeId,
                rootNodeId,
                kind: "subagent",
                status: "running",
                countsForRun: false,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make("event:provider-event-authority:app-owned-subagent"),
              type: "subagent.updated",
              threadId: rootThreadId,
              runId,
              nodeId: appOwnedSubagentNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                ...providerSubagent,
                id: appOwnedSubagentNodeId,
                origin: "app_owned",
                providerThreadId: null,
                childThreadId: appOwnedChildThreadId,
                nativeTaskRef: null,
                prompt: "Delegated child",
                title: "Delegated child",
              },
            },
          ],
        });
        const rejectedAppOwnedSubagent = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "subagent.updated",
            driver: CODEX_DRIVER,
            subagent: {
              ...providerSubagent,
              id: appOwnedSubagentNodeId,
              origin: "app_owned",
              providerThreadId: null,
              childThreadId: appOwnedChildThreadId,
              nativeTaskRef: null,
            },
          },
        });
        assert.deepEqual(rejectedAppOwnedSubagent, []);
        const rejectedAppOwnedItem = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "turn_item.updated",
            driver: CODEX_DRIVER,
            turnItem: {
              ...turnItem,
              id: TurnItemId.make("turn-item:provider-event-authority:app-owned-child"),
              threadId: appOwnedChildThreadId,
            },
          },
        });
        assert.deepEqual(rejectedAppOwnedItem, []);
        const acceptedProviderOwnedItem = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "turn_item.updated",
            driver: CODEX_DRIVER,
            turnItem: {
              ...turnItem,
              id: TurnItemId.make("turn-item:provider-event-authority:provider-child:durable"),
            },
          },
        });
        assert.equal(acceptedProviderOwnedItem.length, 1);

        const childProviderTurnId = ProviderTurnId.make(
          "provider-turn:provider-event-authority:provider-child",
        );
        const childRootNodeId = NodeId.make("node:provider-event-authority:provider-child-root");
        const childProviderTurnEvents = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "provider_turn.updated",
            driver: CODEX_DRIVER,
            threadId: childThreadId,
            providerTurn: {
              id: childProviderTurnId,
              providerThreadId: childProviderThreadId,
              nodeId: childRootNodeId,
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        });
        assert.equal(childProviderTurnEvents.length, 1);
        const staleNestedThreadId = ThreadId.make(
          "thread:provider-event-authority:stale-nested-child",
        );
        const staleNestedNodeId = NodeId.make("node:provider-event-authority:stale-nested-child");
        const staleNestedProviderThreadId = ProviderThreadId.make(
          "provider-thread:provider-event-authority:stale-nested-child",
        );
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:provider-event-authority:stale-nested-thread"),
              type: "thread.created",
              threadId: staleNestedThreadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                ...childThread,
                id: staleNestedThreadId,
                lineage: {
                  parentThreadId: childThreadId,
                  relationshipToParent: "subagent",
                  rootThreadId,
                },
              },
            },
            {
              id: EventId.make("event:provider-event-authority:stale-nested-provider-thread"),
              type: "provider-thread.updated",
              threadId: staleNestedThreadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                ...childProviderThread,
                id: staleNestedProviderThreadId,
                providerSessionId: null,
                appThreadId: staleNestedThreadId,
                forkedFrom: {
                  providerThreadId: childProviderThreadId,
                  providerTurnId: childProviderTurnId,
                },
              },
            },
            {
              id: EventId.make("event:provider-event-authority:stale-nested-node"),
              type: "node.updated",
              threadId: childThreadId,
              runId,
              nodeId: staleNestedNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: staleNestedNodeId,
                threadId: childThreadId,
                runId: null,
                parentNodeId: childRootNodeId,
                rootNodeId: childRootNodeId,
                kind: "subagent",
                status: "running",
                countsForRun: false,
                providerThreadId: staleNestedProviderThreadId,
                providerTurnId: childProviderTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        const rejectedStaleNestedSubagent = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "subagent.updated",
            driver: CODEX_DRIVER,
            subagent: {
              ...providerSubagent,
              id: staleNestedNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: childRootNodeId,
              providerThreadId: staleNestedProviderThreadId,
              childThreadId: staleNestedThreadId,
            },
          },
        });
        assert.deepEqual(rejectedStaleNestedSubagent, []);

        const historicalRunId = RunId.make("run:provider-event-authority:historical");
        const historicalChildThreadId = ThreadId.make(
          "thread:provider-event-authority:historical-child",
        );
        const historicalProviderThreadId = ProviderThreadId.make(
          "provider-thread:provider-event-authority:historical-child",
        );
        const historicalProviderTurnId = ProviderTurnId.make(
          "provider-turn:provider-event-authority:historical-child",
        );
        const historicalRequestId = RuntimeRequestId.make(
          "runtime-request:provider-event-authority:historical-child",
        );
        const historicalNodeId = NodeId.make("node:provider-event-authority:historical-child");
        const historicalChildThread = {
          ...childThread,
          id: historicalChildThreadId,
          lineage: {
            parentThreadId: rootThreadId,
            relationshipToParent: "subagent" as const,
            rootThreadId,
          },
        };
        const historicalProviderThread = {
          ...providerThread,
          id: historicalProviderThreadId,
          appThreadId: historicalChildThreadId,
          ownerNodeId: historicalNodeId,
        };
        const historicalProviderTurn = {
          id: historicalProviderTurnId,
          providerThreadId: historicalProviderThreadId,
          nodeId: historicalNodeId,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running" as const,
          startedAt: now,
          completedAt: null,
        };
        const historicalRequest = {
          id: historicalRequestId,
          nodeId: historicalNodeId,
          providerTurnId: historicalProviderTurnId,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: { type: "live" as const, providerSessionId },
          createdAt: now,
          resolvedAt: null,
        };
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:provider-event-authority:historical-thread"),
              type: "thread.created",
              threadId: historicalChildThreadId,
              runId: historicalRunId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: historicalChildThread,
            },
            {
              id: EventId.make("event:provider-event-authority:historical-provider-thread"),
              type: "provider-thread.updated",
              threadId: historicalChildThreadId,
              runId: historicalRunId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: historicalProviderThread,
            },
            {
              id: EventId.make("event:provider-event-authority:historical-provider-turn"),
              type: "provider-turn.updated",
              threadId: historicalChildThreadId,
              runId: historicalRunId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: historicalProviderTurn,
            },
            {
              id: EventId.make("event:provider-event-authority:historical-request"),
              type: "runtime-request.updated",
              threadId: historicalChildThreadId,
              runId: historicalRunId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: historicalRequest,
            },
          ],
        });
        const authority = {
          threadId: rootThreadId,
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          generation: 0,
          providerThreadId,
          runId,
          activeAttemptId: attemptId,
        };
        const staleArtifacts = [
          {
            id: EventId.make("event:provider-event-authority:late-historical-provider-thread"),
            type: "provider-thread.updated" as const,
            threadId: historicalChildThreadId,
            runId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: historicalProviderThread,
          },
          {
            id: EventId.make("event:provider-event-authority:late-historical-provider-turn"),
            type: "provider-turn.updated" as const,
            threadId: historicalChildThreadId,
            runId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...historicalProviderTurn, status: "completed" as const, completedAt: now },
          },
          {
            id: EventId.make("event:provider-event-authority:late-historical-request"),
            type: "runtime-request.updated" as const,
            threadId: historicalChildThreadId,
            runId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...historicalRequest, status: "resolved" as const, resolvedAt: now },
          },
          {
            id: EventId.make("event:provider-event-authority:late-historical-null-owner-item"),
            type: "turn-item.updated" as const,
            threadId: historicalChildThreadId,
            runId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...turnItem,
              id: TurnItemId.make("turn-item:provider-event-authority:historical-child"),
              threadId: historicalChildThreadId,
              runId: null,
              providerThreadId: null,
              providerTurnId: null,
            },
          },
        ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
        for (const event of staleArtifacts) {
          const result = yield* eventSink.writeProviderEventsIfCurrent({
            authority,
            events: [event],
          });
          assert.isFalse(result.committed);
        }

        const nextRunId = RunId.make("run:provider-event-authority:next");
        const nextAttemptId = RunAttemptId.make("attempt:provider-event-authority:next");
        const nextRootNodeId = NodeId.make("node:provider-event-authority:next");
        const nextRun = {
          ...run,
          id: nextRunId,
          ordinal: 2,
          rootNodeId: nextRootNodeId,
          activeAttemptId: nextAttemptId,
          status: "starting" as const,
          completedAt: null,
        };
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:provider-event-authority:next-run"),
              type: "run.created",
              threadId: rootThreadId,
              runId: nextRunId,
              nodeId: nextRootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: nextRun,
            },
            {
              id: EventId.make("event:provider-event-authority:next-attempt"),
              type: "run-attempt.updated",
              threadId: rootThreadId,
              runId: nextRunId,
              nodeId: nextRootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: nextAttemptId,
                runId: nextRunId,
                attemptOrdinal: 1,
                rootNodeId: nextRootNodeId,
                providerInstanceId: modelSelection.instanceId,
                providerThreadId,
                providerTurnId: null,
                reason: "initial",
                status: "pending",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        const pendingAttemptDoesNotSupersede = yield* eventSink.writeProviderEventsIfCurrent({
          authority,
          events: [
            {
              id: EventId.make("event:provider-event-authority:before-next-acquisition"),
              type: "provider-thread.updated",
              threadId: rootThreadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        assert.isTrue(pendingAttemptDoesNotSupersede.committed);
        const reservationAuthority = {
          ...authority,
          expectedRunStatus: "running" as const,
        };
        const reservation = yield* eventSink.reserveProviderMutation({
          reservationId: "reservation:provider-event-authority",
          authority: reservationAuthority,
          checkpointId: CheckpointId.make("checkpoint:provider-event-authority"),
          scopeId: CheckpointScopeId.make("checkpoint-scope:provider-event-authority"),
          targetRunOrdinal: 0,
        });
        assert.isTrue(reservation.committed);
        const competingReservation = yield* eventSink.reserveProviderMutation({
          reservationId: "reservation:provider-event-authority:competing",
          authority: reservationAuthority,
          checkpointId: CheckpointId.make("checkpoint:provider-event-authority"),
          scopeId: CheckpointScopeId.make("checkpoint-scope:provider-event-authority"),
          targetRunOrdinal: 0,
        });
        assert.isFalse(competingReservation.committed);
        const acquisitionEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
          {
            id: EventId.make("event:provider-event-authority:next-run-running"),
            type: "run.updated",
            threadId: rootThreadId,
            runId: nextRunId,
            nodeId: nextRootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...nextRun, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:provider-event-authority:next-attempt-running"),
            type: "run-attempt.updated",
            threadId: rootThreadId,
            runId: nextRunId,
            nodeId: nextRootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: nextAttemptId,
              runId: nextRunId,
              attemptOrdinal: 1,
              rootNodeId: nextRootNodeId,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId,
              providerTurnId: null,
              reason: "initial",
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("event:provider-event-authority:next-provider-thread-running"),
            type: "provider-thread.updated",
            threadId: rootThreadId,
            runId: nextRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: providerThread,
          },
        ];
        const blockedAcquisition = yield* eventSink.writeIfRunCurrent({
          threadId: rootThreadId,
          runId: nextRunId,
          activeAttemptId: nextAttemptId,
          expectedStatus: "starting",
          providerAuthority: {
            ...authority,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          events: acquisitionEvents,
        });
        assert.isFalse(blockedAcquisition.committed);
        yield* eventSink.releaseProviderMutation({
          reservationId: "reservation:provider-event-authority",
          threadId: rootThreadId,
          providerInstanceId: modelSelection.instanceId,
        });
        const acquired = yield* eventSink.writeIfRunCurrent({
          threadId: rootThreadId,
          runId: nextRunId,
          activeAttemptId: nextAttemptId,
          expectedStatus: "starting",
          providerAuthority: {
            ...authority,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          events: acquisitionEvents,
        });
        assert.isTrue(acquired.committed);
        const nextProviderTurnId = ProviderTurnId.make(
          "provider-turn:provider-event-authority:next",
        );
        const nextProviderTurn = yield* eventSink.writeProviderEventsIfCurrent({
          authority: {
            ...authority,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          events: [
            {
              id: EventId.make("event:provider-event-authority:next-provider-turn"),
              type: "provider-turn.updated",
              threadId: rootThreadId,
              runId: nextRunId,
              nodeId: nextRootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: nextProviderTurnId,
                providerThreadId,
                nodeId: nextRootNodeId,
                runAttemptId: nextAttemptId,
                nativeTurnRef: null,
                ordinal: 2,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        assert.isTrue(nextProviderTurn.committed);
        const delayedChildArtifact = yield* eventSink.writeProviderEventsIfCurrent({
          authority: {
            ...authority,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          events: [
            {
              id: EventId.make("event:provider-event-authority:delayed-child-artifact"),
              type: "turn-item.updated",
              threadId: childThreadId,
              runId: nextRunId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                ...turnItem,
                id: TurnItemId.make("turn-item:provider-event-authority:delayed-child"),
              },
            },
          ],
        });
        assert.isFalse(delayedChildArtifact.committed);
        const nativeTurnIdBarrier = "019a0000-0002-7000-8000-000000000001";
        const delayedNativeChildTurnId = "019a0000-0001-7000-8000-000000000001";
        const currentNativeChildTurnId = "019a0000-0003-7000-8000-000000000001";
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId: nextRunId,
          nodeId: nextRootNodeId,
          providerAuthority: {
            providerThreadId,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          event: {
            type: "provider_thread.resume_confirmed",
            driver: CODEX_DRIVER,
            parentProviderThreadId: providerThreadId,
            parentProviderTurnId: nextProviderTurnId,
            childProviderThreadId,
            childThreadId,
            nativeItemId: "resume-item:delayed-old-start",
            nativeTurnIdBarrier,
            nativeChildTurnId: delayedNativeChildTurnId,
          },
        });
        const uncorrelatedChildArtifact = yield* eventSink.writeProviderEventsIfCurrent({
          authority: {
            ...authority,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          events: [
            {
              id: EventId.make("event:provider-event-authority:uncorrelated-child-artifact"),
              type: "turn-item.updated",
              threadId: childThreadId,
              runId: nextRunId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                ...turnItem,
                id: TurnItemId.make("turn-item:provider-event-authority:uncorrelated-child"),
              },
            },
          ],
        });
        assert.isFalse(uncorrelatedChildArtifact.committed);
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId: nextRunId,
          nodeId: nextRootNodeId,
          providerAuthority: {
            providerThreadId,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          event: {
            type: "provider_thread.resume_requested",
            driver: CODEX_DRIVER,
            parentProviderThreadId: providerThreadId,
            parentProviderTurnId: nextProviderTurnId,
            childProviderThreadId,
            childThreadId,
            nativeItemId: "resume-item:current-attempt",
            nativeTurnIdBarrier,
          },
        });
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId: nextRunId,
          nodeId: nextRootNodeId,
          providerAuthority: {
            providerThreadId,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          event: {
            type: "provider_thread.resume_confirmed",
            driver: CODEX_DRIVER,
            parentProviderThreadId: providerThreadId,
            parentProviderTurnId: nextProviderTurnId,
            childProviderThreadId,
            childThreadId,
            nativeItemId: "resume-item:current-attempt",
            nativeTurnIdBarrier,
            nativeChildTurnId: delayedNativeChildTurnId,
          },
        });
        const intentAfterDelayedStart = yield* sql<{
          readonly consumed_at: string | null;
          readonly confirmed_native_turn_id: string | null;
        }>`
          SELECT consumed_at, confirmed_native_turn_id
          FROM orchestration_v2_provider_resume_intents
          WHERE native_item_id = 'resume-item:current-attempt'
        `;
        assert.deepStrictEqual(intentAfterDelayedStart, [
          { consumed_at: null, confirmed_native_turn_id: null },
        ]);
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId: nextRunId,
          nodeId: nextRootNodeId,
          providerAuthority: {
            providerThreadId,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          event: {
            type: "provider_thread.resume_confirmed",
            driver: CODEX_DRIVER,
            parentProviderThreadId: providerThreadId,
            parentProviderTurnId: nextProviderTurnId,
            childProviderThreadId,
            childThreadId,
            nativeItemId: "resume-item:current-attempt",
            nativeTurnIdBarrier,
            nativeChildTurnId: currentNativeChildTurnId,
          },
        });
        const intentAfterCurrentStart = yield* sql<{
          readonly consumed_at: string | null;
          readonly confirmed_native_turn_id: string | null;
        }>`
          SELECT consumed_at, confirmed_native_turn_id
          FROM orchestration_v2_provider_resume_intents
          WHERE native_item_id = 'resume-item:current-attempt'
        `;
        assert.isNotNull(intentAfterCurrentStart[0]?.consumed_at);
        assert.equal(
          intentAfterCurrentStart[0]?.confirmed_native_turn_id,
          currentNativeChildTurnId,
        );
        const resumedChildArtifact = yield* eventSink.writeProviderEventsIfCurrent({
          authority: {
            ...authority,
            runId: nextRunId,
            activeAttemptId: nextAttemptId,
          },
          events: [
            {
              id: EventId.make("event:provider-event-authority:resumed-child-artifact"),
              type: "turn-item.updated",
              threadId: childThreadId,
              runId: nextRunId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                ...turnItem,
                id: TurnItemId.make("turn-item:provider-event-authority:resumed-child"),
              },
            },
          ],
        });
        assert.isTrue(resumedChildArtifact.committed);
        for (const status of [
          "completed",
          "failed",
          "interrupted",
          "cancelled",
          "rolled_back",
        ] as const) {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`event:provider-event-authority:next-run:${status}`),
                type: "run.updated",
                threadId: rootThreadId,
                runId: nextRunId,
                nodeId: nextRootNodeId,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: { ...nextRun, activeAttemptId: null, status },
              },
            ],
          });
          const staleProviderThread = yield* eventSink.writeProviderEventsIfCurrent({
            authority,
            events: [
              {
                id: EventId.make(
                  `event:provider-event-authority:stale-root-provider-thread:${status}`,
                ),
                type: "provider-thread.updated",
                threadId: rootThreadId,
                runId,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: { ...providerThread, status: "idle", updatedAt: now },
              },
            ],
          });
          assert.isFalse(staleProviderThread.committed, status);
          const staleArtifact = yield* eventSink.writeProviderEventsIfCurrent({
            authority,
            events: [
              {
                id: EventId.make(`event:provider-event-authority:stale-child-item:${status}`),
                type: "turn-item.updated",
                threadId: childThreadId,
                runId,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: {
                  ...turnItem,
                  status: "completed",
                  completedAt: now,
                  streaming: false,
                },
              },
            ],
          });
          assert.isFalse(staleArtifact.committed, status);
        }
        const mixedSupersededTerminal = yield* eventSink.writeProviderEventsIfCurrent({
          authority,
          events: [
            {
              id: EventId.make("event:provider-event-authority:mixed-superseded-terminal"),
              type: "provider-turn.updated",
              threadId: rootThreadId,
              runId,
              nodeId: rootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "interrupted",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("event:provider-event-authority:mixed-stale-provider-thread"),
              type: "provider-thread.updated",
              threadId: rootThreadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: { ...providerThread, status: "idle", updatedAt: now },
            },
          ],
        });
        assert.isFalse(mixedSupersededTerminal.committed);
        const exactSupersededTerminal = yield* eventSink.writeProviderEventsIfCurrent({
          authority,
          events: [
            {
              id: EventId.make("event:provider-event-authority:exact-superseded-terminal"),
              type: "provider-turn.updated",
              threadId: rootThreadId,
              runId,
              nodeId: rootNodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "interrupted",
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
        assert.isTrue(exactSupersededTerminal.committed);
        const stalePostTerminalFinalization = yield* eventSink.writeProviderEventsIfCurrent({
          authority: { ...authority, terminalProviderTurnId: providerTurnId },
          events: [
            {
              id: EventId.make("event:provider-event-authority:stale-post-terminal-thread"),
              type: "provider-thread.updated",
              threadId: rootThreadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: { ...providerThread, status: "idle", updatedAt: now },
            },
          ],
        });
        assert.isFalse(stalePostTerminalFinalization.committed);

        const detail = "provider termination was not confirmed";
        const detachedProviderThread = {
          ...providerThread,
          providerSessionId: null,
          status: "not_loaded" as const,
          updatedAt: now,
        };
        const quarantineInput = {
          threadId: rootThreadId,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId,
          reason: detail,
          providerThreadEvent: {
            id: EventId.make("event:provider-event-authority:detach-thread"),
            type: "provider-thread.updated",
            threadId: rootThreadId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: detachedProviderThread,
          },
          providerSessionErrorEvent: {
            id: EventId.make("event:provider-event-authority:error-session"),
            type: "provider-session.updated",
            threadId: rootThreadId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...providerSession, status: "error", lastError: detail },
          },
          providerSessionDetachedEvent: {
            id: EventId.make("event:provider-event-authority:detach-session"),
            type: "provider-session.detached",
            threadId: rootThreadId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { providerSessionId, detachedAt: now, reason: detail },
          },
        } satisfies Parameters<EventSinkV2["Service"]["quarantineProviderSession"]>[0];
        yield* sql`
          CREATE TRIGGER fail_provider_quarantine_append
          BEFORE INSERT ON orchestration_events
          WHEN NEW.event_id = 'event:provider-event-authority:detach-thread'
          BEGIN
            SELECT RAISE(ABORT, 'simulated hard-detach crash');
          END
        `;
        const failedQuarantine = yield* eventSink
          .quarantineProviderSession(quarantineInput)
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failedQuarantine));
        const afterCrash = yield* sql<{
          readonly generation_count: number;
          readonly provider_session_id: string | null;
          readonly binding_count: number;
        }>`
          SELECT
            (SELECT COUNT(*) FROM orchestration_v2_provider_session_generations
             WHERE thread_id = ${rootThreadId}) AS generation_count,
            provider_thread.provider_session_id,
            (SELECT COUNT(*) FROM orchestration_v2_projection_provider_session_bindings
             WHERE provider_session_id = ${providerSessionId}) AS binding_count
          FROM orchestration_v2_projection_provider_threads AS provider_thread
          WHERE provider_thread.provider_thread_id = ${providerThreadId}
        `;
        assert.deepEqual(afterCrash, [
          { generation_count: 0, provider_session_id: providerSessionId, binding_count: 1 },
        ]);
        yield* sql`DROP TRIGGER fail_provider_quarantine_append`;
        const quarantine = yield* eventSink.quarantineProviderSession(quarantineInput);
        assert.isTrue(quarantine.committed);
        assert.isTrue(quarantine.finalOwner);

        const lateItemEvents = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootThreadId,
          runId,
          nodeId: rootNodeId,
          providerAuthority,
          event: {
            type: "turn_item.updated",
            driver: CODEX_DRIVER,
            turnItem: { ...turnItem, status: "completed", completedAt: now, streaming: false },
          },
        });
        assert.deepEqual(lateItemEvents, []);
        const lateSession = yield* eventSink.writeProviderEventsIfCurrent({
          authority: {
            threadId: rootThreadId,
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            generation: 0,
            providerThreadId,
            runId,
            activeAttemptId: attemptId,
          },
          events: [
            {
              id: EventId.make("event:provider-event-authority:late-session"),
              type: "provider-session.updated",
              threadId: rootThreadId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: { ...providerSession, status: "ready", lastError: null },
            },
          ],
        });
        assert.isFalse(lateSession.committed);
        const lateAttachment = yield* eventSink.writeProviderEventsIfCurrent({
          authority: {
            threadId: rootThreadId,
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            generation: 0,
            providerThreadId,
            runId,
            activeAttemptId: attemptId,
          },
          events: [
            {
              id: EventId.make("event:provider-event-authority:late-attachment"),
              type: "provider-session.attached",
              threadId: rootThreadId,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: { ...providerSession, status: "ready", lastError: null },
            },
          ],
        });
        assert.isFalse(lateAttachment.committed);

        const childProjection = yield* projectionStore.getThreadProjection(childThreadId);
        assert.equal(childProjection.turnItems[0]?.status, "running");
        const durable = yield* sql<{
          readonly generation: number;
          readonly provider_session_id: string | null;
          readonly session_status: string;
          readonly binding_count: number;
        }>`
          SELECT
            generation.generation,
            provider_thread.provider_session_id,
            provider_session.status AS session_status,
            (SELECT COUNT(*) FROM orchestration_v2_projection_provider_session_bindings
             WHERE provider_session_id = ${providerSessionId}) AS binding_count
          FROM orchestration_v2_provider_session_generations AS generation
          JOIN orchestration_v2_projection_provider_threads AS provider_thread
            ON provider_thread.provider_thread_id = ${providerThreadId}
          JOIN orchestration_v2_projection_provider_sessions AS provider_session
            ON provider_session.provider_session_id = ${providerSessionId}
          WHERE generation.thread_id = ${rootThreadId}
        `;
        assert.deepEqual(durable, [
          { generation: 1, provider_session_id: null, session_status: "error", binding_count: 0 },
        ]);
      }),
  );
});
