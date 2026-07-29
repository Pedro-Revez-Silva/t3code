import {
  CommandId,
  type OrchestrationV2DomainEvent,
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";

export class RuntimeRequestResponseExecutionError extends Schema.TaggedErrorClass<RuntimeRequestResponseExecutionError>()(
  "RuntimeRequestResponseExecutionError",
  {
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isRuntimeRequestResponseExecutionError = Schema.is(RuntimeRequestResponseExecutionError);

export interface RuntimeRequestServiceV2Shape {
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly requestId: RuntimeRequestId;
    readonly commandId: CommandId;
    readonly decision?: ProviderApprovalDecision;
    readonly answers?: ProviderUserInputAnswers;
  }) => Effect.Effect<void, RuntimeRequestResponseExecutionError>;
  readonly releasePendingResponse: (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly commandId: CommandId;
    readonly effectId: string;
    readonly workerId: string;
    readonly error: string;
  }) => Effect.Effect<boolean, RuntimeRequestResponseExecutionError>;
  readonly isDeliveryAcknowledged: (requestId: RuntimeRequestId) => Effect.Effect<boolean>;
}

export class RuntimeRequestServiceV2 extends Context.Service<
  RuntimeRequestServiceV2,
  RuntimeRequestServiceV2Shape
>()("t3/orchestration-v2/RuntimeRequestService/RuntimeRequestServiceV2") {}

export const layer: Layer.Layer<
  RuntimeRequestServiceV2,
  never,
  EventSinkV2 | IdAllocatorV2 | ProjectionStoreV2 | ProviderSessionManagerV2
> = Layer.effect(
  RuntimeRequestServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const deliveredRequests = yield* Ref.make<ReadonlySet<RuntimeRequestId>>(new Set());

    const updateDelivered = (requestId: RuntimeRequestId, delivered: boolean) =>
      Ref.update(deliveredRequests, (current) => {
        const next = new Set(current);
        if (delivered) next.add(requestId);
        else next.delete(requestId);
        return next;
      });

    const mapError = (input: {
      readonly threadId: ThreadId;
      readonly requestId: RuntimeRequestId;
    }) =>
      Effect.mapError((cause: unknown) =>
        isRuntimeRequestResponseExecutionError(cause)
          ? cause
          : new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }),
      );

    return RuntimeRequestServiceV2.of({
      respond: (input) =>
        Effect.gen(function* () {
          const projection = yield* projections.getThreadProjection(input.threadId);
          const request = projection.runtimeRequests.find(
            (candidate) => candidate.id === input.requestId,
          );
          if (request === undefined) {
            return yield* new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause: "The runtime request no longer exists.",
            });
          }
          if (request.status !== "pending") {
            yield* updateDelivered(input.requestId, false);
            return;
          }
          if (
            request.status !== "pending" ||
            request.responseCommandId !== input.commandId ||
            request.responseCapability.type !== "live" ||
            request.responseCapability.providerSessionId !== input.providerSessionId
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause: "The runtime request is not resumable on the recorded provider session.",
            });
          }
          if (!(yield* Ref.get(deliveredRequests)).has(input.requestId)) {
            const session = yield* sessions.get(input.providerSessionId);
            if (Option.isNone(session)) {
              return yield* new RuntimeRequestResponseExecutionError({
                threadId: input.threadId,
                requestId: input.requestId,
                cause: `Provider session ${input.providerSessionId} is not active.`,
              });
            }
            yield* session.value.respondToRuntimeRequest({
              requestId: input.requestId,
              ...(input.decision === undefined ? {} : { decision: input.decision }),
              ...(input.answers === undefined ? {} : { answers: input.answers }),
            });
            yield* updateDelivered(input.requestId, true);
          }

          const currentProjection = yield* projections.getThreadProjection(input.threadId);
          const currentRequest = currentProjection.runtimeRequests.find(
            (candidate) => candidate.id === input.requestId,
          );
          if (currentRequest === undefined || currentRequest.status !== "pending") {
            yield* updateDelivered(input.requestId, false);
            return;
          }
          if (
            currentRequest?.status !== "pending" ||
            currentRequest.responseCommandId !== input.commandId
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause: "The runtime request response reservation is no longer current.",
            });
          }
          const providerSession = currentProjection.providerSessions.find(
            (candidate) => candidate.id === input.providerSessionId,
          );
          if (providerSession === undefined) {
            return yield* new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause: `Provider session ${input.providerSessionId} was not found.`,
            });
          }

          const now = yield* DateTime.now;
          const completionCommandId = CommandId.make(`${input.commandId}:delivered`);
          const requestNode = currentProjection.nodes.find(
            (node) => node.id === currentRequest.nodeId,
          );
          const requestItem = currentProjection.turnItems.find(
            (item) =>
              (item.type === "approval_request" || item.type === "user_input_request") &&
              item.requestId === currentRequest.id,
          );
          const resolvedNodeStatus =
            input.decision === "decline" || input.decision === "cancel"
              ? ("cancelled" as const)
              : ("completed" as const);
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: yield* ids.allocate.event({
                threadId: input.threadId,
                providerSessionId: input.providerSessionId,
                commandId: completionCommandId,
              }),
              type: "runtime-request.updated",
              threadId: input.threadId,
              ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
              nodeId: currentRequest.nodeId,
              driver: providerSession.driver,
              providerInstanceId: providerSession.providerInstanceId,
              occurredAt: now,
              payload: {
                ...currentRequest,
                status: "resolved",
                resolvedAt: now,
              },
            },
          ];
          if (requestNode !== undefined) {
            events.push({
              id: yield* ids.allocate.event({
                threadId: input.threadId,
                providerSessionId: input.providerSessionId,
                commandId: completionCommandId,
              }),
              type: "node.updated",
              threadId: input.threadId,
              ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
              nodeId: requestNode.id,
              driver: providerSession.driver,
              providerInstanceId: providerSession.providerInstanceId,
              occurredAt: now,
              payload: {
                ...requestNode,
                status: resolvedNodeStatus,
                completedAt: now,
              },
            });
          }
          if (requestItem !== undefined) {
            events.push({
              id: yield* ids.allocate.event({
                threadId: input.threadId,
                providerSessionId: input.providerSessionId,
                commandId: completionCommandId,
              }),
              type: "turn-item.updated",
              threadId: input.threadId,
              ...(requestItem.runId === null ? {} : { runId: requestItem.runId }),
              ...(requestItem.nodeId === null ? {} : { nodeId: requestItem.nodeId }),
              driver: providerSession.driver,
              providerInstanceId: providerSession.providerInstanceId,
              occurredAt: now,
              payload: {
                ...requestItem,
                status: resolvedNodeStatus,
                completedAt: now,
                updatedAt: now,
              },
            });
          }
          yield* eventSink.writeIfRuntimeRequestsCurrent({
            commandId: completionCommandId,
            events,
            guards: [
              {
                threadId: input.threadId,
                requestId: input.requestId,
                expectedStatus: "pending",
                expectedResponseCommandId: input.commandId,
              },
            ],
          });
          yield* updateDelivered(input.requestId, false);
        }).pipe(mapError(input)),
      releasePendingResponse: (input) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(deliveredRequests)).has(input.requestId)) {
            return false;
          }
          yield* updateDelivered(input.requestId, false);
          const projection = yield* projections.getThreadProjection(input.threadId);
          const request = projection.runtimeRequests.find(
            (candidate) => candidate.id === input.requestId,
          );
          const now = yield* DateTime.now;
          const releaseCommandId = CommandId.make(`${input.commandId}:delivery-failed`);
          const events: Array<OrchestrationV2DomainEvent> = [];
          if (request?.status === "pending" && request.responseCommandId === input.commandId) {
            const { responseCommandId: _responseCommandId, ...releasedRequest } = request;
            events.push({
              id: yield* ids.allocate.event({
                threadId: input.threadId,
                commandId: releaseCommandId,
              }),
              type: "runtime-request.updated",
              threadId: input.threadId,
              nodeId: request.nodeId,
              occurredAt: now,
              payload: {
                ...releasedRequest,
                responseAttempt: (request.responseAttempt ?? 0) + 1,
              },
            });
          }
          const result = yield* eventSink.failEffectWithEvents({
            effectId: input.effectId,
            workerId: input.workerId,
            error: input.error,
            commandId: releaseCommandId,
            events,
            runtimeRequestGuards: [
              {
                threadId: input.threadId,
                requestId: input.requestId,
                expectedStatus: "pending",
                expectedResponseCommandId: input.commandId,
              },
            ],
          });
          return result.failed;
        }).pipe(mapError(input)),
      isDeliveryAcknowledged: (requestId) =>
        Ref.get(deliveredRequests).pipe(Effect.map((requests) => requests.has(requestId))),
    });
  }),
);
