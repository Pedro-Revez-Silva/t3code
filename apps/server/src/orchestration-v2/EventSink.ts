import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  SupervisorTaskAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CommandReceiptStoreV2,
  type CommandReceiptV2,
  layer as commandReceiptStoreLayer,
} from "./CommandReceiptStore.ts";
import { isCodexNativeTurnAfterBarrier, isCodexNativeTurnId } from "./CodexResumeCorrelation.ts";
import {
  EffectOutboxV2,
  type OrchestrationEffectRequestV2,
  type PendingOrchestrationEffectV2,
  layer as effectOutboxLayer,
} from "./EffectOutbox.ts";
import { EventStoreV2 } from "./EventStore.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "./ProjectionStore.ts";
import {
  TurnItemPositionStoreV2,
  layer as turnItemPositionStoreLayer,
} from "./TurnItemPositionStore.ts";
import {
  requireRuntimeMutationAuthority,
  requireSupervisorMutationAuthority,
  type RuntimeMutationAuthority,
  type SupervisorMutationAuthority,
} from "../supervisor/SupervisorAuthority.ts";
import { randomUuidV4 } from "./RandomUuid.ts";

/**
 * ERRORS
 */
export class EventSinkWriteError extends Schema.TaggedErrorClass<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedErrorClass<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

class EventSinkActiveProjectGuardError extends Schema.TaggedErrorClass<EventSinkActiveProjectGuardError>()(
  "EventSinkActiveProjectGuardError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is missing, deleted, or has no workspace root.`;
  }
}

class EventSinkSupervisorAttemptGuardError extends Schema.TaggedErrorClass<EventSinkSupervisorAttemptGuardError>()(
  "EventSinkSupervisorAttemptGuardError",
  { attemptId: SupervisorTaskAttemptId, detail: Schema.String },
) {
  override get message(): string {
    return `Supervisor attempt ${this.attemptId} cannot commit delegated work: ${this.detail}`;
  }
}

class EventSinkRuntimeRequestGuardError extends Schema.TaggedErrorClass<EventSinkRuntimeRequestGuardError>()(
  "EventSinkRuntimeRequestGuardError",
  { requestId: RuntimeRequestId },
) {
  override get message(): string {
    return `Runtime request ${this.requestId} changed before the mutation was committed.`;
  }
}

class EventSinkProviderAuthorityGuardError extends Schema.TaggedErrorClass<EventSinkProviderAuthorityGuardError>()(
  "EventSinkProviderAuthorityGuardError",
  { threadId: ThreadId, providerSessionId: ProviderSessionId },
) {
  override get message(): string {
    return `Provider session ${this.providerSessionId} no longer owns thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

export interface RuntimeRequestCommitGuard {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly expectedStatus: OrchestrationV2RuntimeRequest["status"];
  readonly expectedResponseCommandId?: CommandId | null;
}

export interface ProviderEventCommitAuthority {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly generation: number;
  readonly providerThreadId?: ProviderThreadId;
  readonly runId?: RunId;
  readonly activeAttemptId?: RunAttemptId;
  readonly terminalProviderTurnId?: ProviderTurnId;
}

export interface ProviderMutationCommitAuthority extends ProviderEventCommitAuthority {
  readonly providerThreadId: ProviderThreadId;
  readonly runId: RunId;
  readonly activeAttemptId: RunAttemptId;
  readonly expectedRunStatus: OrchestrationV2Run["status"];
}

export type ProviderMutationPhase =
  | "reserved"
  | "filesystem_started"
  | "filesystem_restored"
  | "provider_started"
  | "provider_restored"
  | "cleanup_started"
  | "external_complete";

export interface AbandonedProviderMutation {
  readonly reservationId: string;
  readonly ownerInstanceId: string;
  readonly leaseEpoch: number;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly generation: number;
  readonly checkpointId: CheckpointId;
  readonly scopeId: CheckpointScopeId;
  readonly targetRunOrdinal: number | null;
  readonly targetResolution: "exact" | "ambiguous";
  readonly phase: ProviderMutationPhase;
}

/**
 * SERVICE DEFINITION
 */
export interface EventSinkV2Shape {
  readonly write: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
    readonly providerAuthority?: ProviderEventCommitAuthority;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly failEffectWithEvents: (input: {
    readonly effectId: string;
    readonly workerId: string;
    readonly error: string;
    readonly commandId: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly runtimeRequestGuards?: ReadonlyArray<RuntimeRequestCommitGuard>;
  }) => Effect.Effect<
    {
      readonly failed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly writeIfRunCurrent: (input: {
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly providerAuthority?: ProviderEventCommitAuthority;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly writeProviderEventsIfCurrent: (input: {
    readonly commandId?: CommandId;
    readonly authority: ProviderEventCommitAuthority;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly confirmProviderThreadResume: (input: {
    readonly authority: ProviderEventCommitAuthority;
    readonly parentProviderTurnId: ProviderTurnId;
    readonly childProviderThreadId: ProviderThreadId;
    readonly childThreadId: ThreadId;
    readonly nativeItemId: string;
    readonly nativeTurnIdBarrier: string;
    readonly nativeChildTurnId: string;
  }) => Effect.Effect<{ readonly committed: boolean }, EventSinkV2Error>;
  readonly recordProviderThreadResumeIntent: (input: {
    readonly authority: ProviderEventCommitAuthority;
    readonly parentProviderTurnId: ProviderTurnId;
    readonly childProviderThreadId: ProviderThreadId;
    readonly childThreadId: ThreadId;
    readonly nativeItemId: string;
    readonly nativeTurnIdBarrier: string;
  }) => Effect.Effect<{ readonly committed: boolean }, EventSinkV2Error>;
  readonly writeIfProviderMutationCurrent: (input: {
    readonly commandId?: CommandId;
    readonly reservationId: string;
    readonly authority: ProviderMutationCommitAuthority;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly reserveProviderMutation: (input: {
    readonly reservationId: string;
    readonly authority: ProviderMutationCommitAuthority;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly targetRunOrdinal: number;
  }) => Effect.Effect<{ readonly committed: boolean }, EventSinkV2Error>;
  readonly markProviderMutationPhase: (input: {
    readonly reservationId: string;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly phase: ProviderMutationPhase;
  }) => Effect.Effect<{ readonly committed: boolean }, EventSinkV2Error>;
  readonly releaseProviderMutation: (input: {
    readonly reservationId: string;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<void, EventSinkV2Error>;
  readonly activateProviderMutationOwner: Effect.Effect<
    { readonly activated: boolean; readonly leaseEpoch: number | null },
    EventSinkV2Error
  >;
  readonly heartbeatProviderMutationOwner: Effect.Effect<boolean, EventSinkV2Error>;
  readonly deactivateProviderMutationOwner: Effect.Effect<void, EventSinkV2Error>;
  readonly listAbandonedProviderMutations: Effect.Effect<
    ReadonlyArray<AbandonedProviderMutation>,
    EventSinkV2Error
  >;
  readonly clearAbandonedProviderMutation: (input: {
    readonly reservationId: string;
    readonly ownerInstanceId: string;
    readonly leaseEpoch: number;
  }) => Effect.Effect<boolean, EventSinkV2Error>;
  readonly reconcileAbandonedProviderMutation: (input: {
    readonly reservation: AbandonedProviderMutation;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly quarantineProvider: boolean;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly quarantineProviderSession: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly reason: string;
    readonly providerThreadEvent: OrchestrationV2DomainEvent;
    readonly providerSessionErrorEvent: OrchestrationV2DomainEvent;
    readonly providerSessionDetachedEvent: OrchestrationV2DomainEvent;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly finalOwner: boolean;
      readonly generation: number;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly writeIfRuntimeRequestsCurrent: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly guards: ReadonlyArray<RuntimeRequestCommitGuard>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
    readonly activeProjectGuard?: {
      readonly projectId: ProjectId;
    };
    readonly runtimeAuthorityGuard?: RuntimeMutationAuthority;
    readonly supervisorAuthorityGuard?: SupervisorMutationAuthority;
    readonly supervisorAttemptGuard?: {
      readonly attemptId: SupervisorTaskAttemptId;
    };
    readonly runtimeRequestGuards?: ReadonlyArray<RuntimeRequestCommitGuard>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
    readonly runtimeAuthorityGuard?: RuntimeMutationAuthority;
    readonly supervisorAuthorityGuard?: SupervisorMutationAuthority;
  }) => Effect.Effect<CommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

/**
 * IMPLEMENTATIONS
 */
const baseLayer: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStoreV2
  | EffectOutboxV2
  | EventStoreV2
  | ProjectionStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutboxV2;
    const eventStore = yield* EventStoreV2;
    const projectionStore = yield* ProjectionStoreV2;
    const turnItemPositions = yield* TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const providerMutationInstanceId = yield* randomUuidV4;
    const providerMutationLeaseEpoch = yield* Ref.make<number | null>(null);

    const activateProviderMutationOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.activateProviderMutationOwner",
    )(function* () {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly instance_id: string;
            readonly lease_epoch: number;
            readonly lease_active: number;
          }>`
            SELECT
              instance_id,
              lease_epoch,
              lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS lease_active
            FROM orchestration_v2_provider_mutation_owner
            WHERE singleton_id = 1
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current !== undefined &&
            current.instance_id !== providerMutationInstanceId &&
            current.lease_active === 1
          ) {
            return { activated: false as const, leaseEpoch: null };
          }
          const leaseEpoch =
            current?.instance_id === providerMutationInstanceId
              ? current.lease_epoch
              : (current?.lease_epoch ?? 0) + 1;
          yield* sql`
            INSERT INTO orchestration_v2_provider_mutation_owner (
              singleton_id,
              instance_id,
              lease_epoch,
              lease_expires_at,
              updated_at
            ) VALUES (
              1,
              ${providerMutationInstanceId},
              ${leaseEpoch},
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+3 seconds'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ON CONFLICT(singleton_id) DO UPDATE SET
              instance_id = excluded.instance_id,
              lease_epoch = excluded.lease_epoch,
              lease_expires_at = excluded.lease_expires_at,
              updated_at = excluded.updated_at
          `;
          return { activated: true as const, leaseEpoch };
        }),
      );
      if (result.activated) yield* Ref.set(providerMutationLeaseEpoch, result.leaseEpoch);
      return result;
    });

    const heartbeatProviderMutationOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.heartbeatProviderMutationOwner",
    )(function* () {
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) return false;
      const updated = yield* sql<{ readonly singleton_id: number }>`
        UPDATE orchestration_v2_provider_mutation_owner
        SET
          lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+3 seconds'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE singleton_id = 1
          AND instance_id = ${providerMutationInstanceId}
          AND lease_epoch = ${leaseEpoch}
          AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        RETURNING singleton_id
      `;
      if (updated[0] === undefined) yield* Ref.set(providerMutationLeaseEpoch, null);
      return updated[0] !== undefined;
    });

    const deactivateProviderMutationOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.deactivateProviderMutationOwner",
    )(function* () {
      const leaseEpoch = yield* Ref.getAndSet(providerMutationLeaseEpoch, null);
      if (leaseEpoch === null) return;
      yield* sql`
        DELETE FROM orchestration_v2_provider_mutation_owner
        WHERE singleton_id = 1
          AND instance_id = ${providerMutationInstanceId}
          AND lease_epoch = ${leaseEpoch}
      `;
    });

    const providerSessionBindingEventsCurrent = Effect.fn(
      "orchestrationV2.EventSink.providerSessionBindingEventsCurrent",
    )(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
      for (const event of events) {
        if (event.type !== "provider-thread.updated") continue;
        const providerSessionId = event.payload.providerSessionId;
        if (providerSessionId === null) continue;
        const providerInstanceId = event.providerInstanceId ?? event.payload.providerInstanceId;
        const rows = yield* sql<{ readonly current: number }>`
          SELECT 1 AS current
          WHERE NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_session_generations AS generation
            WHERE generation.thread_id = ${event.threadId}
              AND generation.provider_instance_id = ${providerInstanceId}
              AND generation.quarantined_provider_session_id = ${providerSessionId}
          )
          LIMIT 1
        `;
        if (rows[0] === undefined) {
          return yield* new EventSinkProviderAuthorityGuardError({
            threadId: event.threadId,
            providerSessionId,
          });
        }
      }
    });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.gen(function* () {
        yield* providerSessionBindingEventsCurrent(events);
        return yield* Effect.forEach(
          events,
          (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
            event.type === "turn-item.updated"
              ? turnItemPositions
                  .normalize(
                    event.payload,
                    event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                  )
                  .pipe(Effect.map((payload) => ({ ...event, payload })))
              : Effect.succeed(event),
          { concurrency: 1 },
        );
      });
    };

    const applyStoredEvents = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
      });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const storedEvents = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            input.providerAuthority !== undefined &&
            !(yield* providerEventsCurrent(input.providerAuthority, input.events))
          ) {
            return [] as ReadonlyArray<OrchestrationV2StoredEvent>;
          }
          const normalized = yield* normalizeEvents(input.events);
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return committed;
        }),
      );
      if (storedEvents.length > 0 && input.effects.length > 0) {
        yield* effectOutbox.notifyAvailable;
      }
      if (storedEvents.length > 0) {
        yield* eventStore.publishCommitted(storedEvents);
        yield* PubSub.publishAll(liveEvents, storedEvents);
      }
      return storedEvents;
    });

    const runtimeRequestGuardsCurrent = Effect.fn(
      "orchestrationV2.EventSink.runtimeRequestGuardsCurrent",
    )(function* (guards: ReadonlyArray<RuntimeRequestCommitGuard>) {
      for (const guard of guards) {
        const rows = yield* sql<{
          readonly status: string;
          readonly response_command_id: string | null;
        }>`
          SELECT
            status,
            json_extract(payload_json, '$.responseCommandId') AS response_command_id
          FROM orchestration_v2_projection_runtime_requests
          WHERE runtime_request_id = ${guard.requestId}
            AND thread_id = ${guard.threadId}
          LIMIT 1
        `;
        const current = rows[0];
        if (
          current === undefined ||
          current.status !== guard.expectedStatus ||
          (guard.expectedResponseCommandId !== undefined &&
            current.response_command_id !== guard.expectedResponseCommandId)
        ) {
          return false;
        }
      }
      return true;
    });

    const providerEventAuthorityCurrent = Effect.fn(
      "orchestrationV2.EventSink.providerEventAuthorityCurrent",
    )(function* (authority: ProviderEventCommitAuthority) {
      const providerThreadId = authority.providerThreadId ?? null;
      const runId = authority.runId ?? null;
      const activeAttemptId = authority.activeAttemptId ?? null;
      const rows = yield* sql<{ readonly current: number }>`
        SELECT 1 AS current
        WHERE COALESCE((
          SELECT generation
          FROM orchestration_v2_provider_session_generations AS generation
          WHERE generation.thread_id = ${authority.threadId}
            AND generation.provider_instance_id = ${authority.providerInstanceId}
        ), 0) = ${authority.generation}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_session_generations AS generation
            WHERE generation.thread_id = ${authority.threadId}
              AND generation.provider_instance_id = ${authority.providerInstanceId}
              AND generation.quarantined_provider_session_id = ${authority.providerSessionId}
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_provider_threads AS provider_thread
            WHERE provider_thread.thread_id = ${authority.threadId}
              AND provider_thread.provider_instance_id = ${authority.providerInstanceId}
              AND provider_thread.provider_session_id = ${authority.providerSessionId}
              AND (${providerThreadId} IS NULL OR provider_thread.provider_thread_id = ${providerThreadId})
          )
          AND (
            ${runId} IS NULL
            OR EXISTS (
              SELECT 1
              FROM orchestration_v2_provider_authority_acquisitions AS acquisition
              INNER JOIN orchestration_v2_projection_runs AS run
                ON run.run_id = acquisition.run_id
              WHERE run.thread_id = ${authority.threadId}
                AND run.run_id = ${runId}
                AND acquisition.thread_id = ${authority.threadId}
                AND acquisition.provider_instance_id = ${authority.providerInstanceId}
                AND acquisition.attempt_id = ${activeAttemptId}
                AND acquisition.provider_thread_id = ${providerThreadId}
                AND acquisition.provider_session_id = ${authority.providerSessionId}
                AND acquisition.generation = ${authority.generation}
                AND run.provider_instance_id = ${authority.providerInstanceId}
                AND run.provider_thread_id = ${providerThreadId}
                AND json_extract(run.payload_json, '$.activeAttemptId') = ${activeAttemptId}
                AND run.status IN ('starting', 'running', 'waiting', 'completed')
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_provider_authority_acquisitions AS newer_acquisition
                  WHERE newer_acquisition.thread_id = acquisition.thread_id
                    AND newer_acquisition.provider_instance_id = acquisition.provider_instance_id
                    AND newer_acquisition.acquisition_order > acquisition.acquisition_order
                )
            )
          )
        LIMIT 1
      `;
      return rows[0] !== undefined;
    });

    const acquireProviderAuthority = Effect.fn(
      "orchestrationV2.EventSink.acquireProviderAuthority",
    )(function* (
      authority: ProviderEventCommitAuthority,
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) {
      if (
        authority.runId === undefined ||
        authority.activeAttemptId === undefined ||
        authority.providerThreadId === undefined
      ) {
        return false;
      }
      const attemptEvent = events.find(
        (event) =>
          event.type === "run-attempt.updated" &&
          event.payload.id === authority.activeAttemptId &&
          event.payload.runId === authority.runId &&
          event.payload.providerThreadId === authority.providerThreadId &&
          event.payload.status === "running",
      );
      const runEvent = events.find(
        (event) =>
          (event.type === "run.created" || event.type === "run.updated") &&
          event.payload.id === authority.runId &&
          event.payload.activeAttemptId === authority.activeAttemptId &&
          event.payload.providerThreadId === authority.providerThreadId &&
          event.payload.status === "running",
      );
      const providerThreadEvent = events.find(
        (event) =>
          event.type === "provider-thread.updated" &&
          event.payload.id === authority.providerThreadId &&
          event.payload.appThreadId === authority.threadId &&
          event.payload.providerInstanceId === authority.providerInstanceId &&
          event.payload.providerSessionId === authority.providerSessionId,
      );
      if (
        attemptEvent === undefined ||
        runEvent === undefined ||
        (runEvent.type !== "run.created" && runEvent.type !== "run.updated") ||
        providerThreadEvent === undefined
      ) {
        return false;
      }
      const acquiredAt = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* sql<{ readonly acquisition_order: number }>`
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
        )
        SELECT
          ${authority.threadId},
          ${authority.providerInstanceId},
          ${authority.runId},
          ${runEvent.payload.ordinal},
          ${authority.activeAttemptId},
          ${authority.providerThreadId},
          ${authority.providerSessionId},
          ${authority.generation},
          ${acquiredAt}
        WHERE COALESCE((
          SELECT generation
          FROM orchestration_v2_provider_session_generations
          WHERE thread_id = ${authority.threadId}
            AND provider_instance_id = ${authority.providerInstanceId}
        ), 0) = ${authority.generation}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_session_generations
            WHERE thread_id = ${authority.threadId}
              AND provider_instance_id = ${authority.providerInstanceId}
              AND quarantined_provider_session_id = ${authority.providerSessionId}
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_provider_session_bindings
            WHERE thread_id = ${authority.threadId}
              AND provider_session_id = ${authority.providerSessionId}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_rollback_reservations
            WHERE thread_id = ${authority.threadId}
              AND provider_instance_id = ${authority.providerInstanceId}
          )
        ON CONFLICT(thread_id, provider_instance_id, attempt_id) DO NOTHING
        RETURNING acquisition_order
      `;
      const existing = yield* sql<{ readonly acquisition_order: number }>`
        SELECT acquisition_order
        FROM orchestration_v2_provider_authority_acquisitions
        WHERE thread_id = ${authority.threadId}
          AND provider_instance_id = ${authority.providerInstanceId}
          AND run_id = ${authority.runId}
          AND attempt_id = ${authority.activeAttemptId}
          AND provider_thread_id = ${authority.providerThreadId}
          AND provider_session_id = ${authority.providerSessionId}
          AND generation = ${authority.generation}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_rollback_reservations
            WHERE thread_id = ${authority.threadId}
              AND provider_instance_id = ${authority.providerInstanceId}
          )
        LIMIT 1
      `;
      const acquisitionOrder = inserted[0]?.acquisition_order ?? existing[0]?.acquisition_order;
      if (acquisitionOrder === undefined) return false;
      return true;
    });

    const confirmProviderThreadResumeEffect = Effect.fn(
      "orchestrationV2.EventSink.confirmProviderThreadResume",
    )(function* (input: Parameters<EventSinkV2Shape["confirmProviderThreadResume"]>[0]) {
      if (
        input.authority.runId === undefined ||
        input.authority.activeAttemptId === undefined ||
        input.authority.providerThreadId === undefined ||
        !isCodexNativeTurnAfterBarrier(input.nativeChildTurnId, input.nativeTurnIdBarrier)
      ) {
        return { committed: false as const };
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* providerEventAuthorityCurrent(input.authority))) {
            return { committed: false as const };
          }
          const inserted = yield* sql<{ readonly acquisition_order: number }>`
            INSERT INTO orchestration_v2_provider_resume_authorizations (
              acquisition_order,
              child_provider_thread_id,
              child_thread_id
            )
            SELECT
              acquisition.acquisition_order,
              child_provider_thread.provider_thread_id,
              child_provider_thread.thread_id
            FROM orchestration_v2_provider_authority_acquisitions AS acquisition
            INNER JOIN orchestration_v2_projection_provider_turns AS parent_provider_turn
              ON parent_provider_turn.provider_thread_id = acquisition.provider_thread_id
            INNER JOIN orchestration_v2_provider_resume_intents AS intent
              ON intent.acquisition_order = acquisition.acquisition_order
              AND intent.parent_provider_turn_id = parent_provider_turn.provider_turn_id
              AND intent.child_provider_thread_id = ${input.childProviderThreadId}
              AND intent.child_thread_id = ${input.childThreadId}
              AND intent.native_item_id = ${input.nativeItemId}
              AND intent.native_turn_id_barrier = ${input.nativeTurnIdBarrier}
              AND lower(${input.nativeChildTurnId}) > lower(intent.native_turn_id_barrier)
              AND intent.consumed_at IS NULL
            INNER JOIN orchestration_v2_projection_provider_threads AS child_provider_thread
              ON child_provider_thread.provider_thread_id = ${input.childProviderThreadId}
            INNER JOIN orchestration_v2_projection_subagents AS subagent
              ON subagent.provider_thread_id = child_provider_thread.provider_thread_id
            WHERE acquisition.thread_id = ${input.authority.threadId}
              AND acquisition.provider_instance_id = ${input.authority.providerInstanceId}
              AND acquisition.run_id = ${input.authority.runId}
              AND acquisition.attempt_id = ${input.authority.activeAttemptId}
              AND acquisition.provider_thread_id = ${input.authority.providerThreadId}
              AND acquisition.provider_session_id = ${input.authority.providerSessionId}
              AND acquisition.generation = ${input.authority.generation}
              AND parent_provider_turn.provider_turn_id = ${input.parentProviderTurnId}
              AND parent_provider_turn.run_attempt_id = ${input.authority.activeAttemptId}
              AND child_provider_thread.thread_id = ${input.childThreadId}
              AND child_provider_thread.provider_instance_id = ${input.authority.providerInstanceId}
              AND child_provider_thread.provider_session_id = ${input.authority.providerSessionId}
              AND json_extract(
                child_provider_thread.payload_json,
                '$.forkedFrom.providerThreadId'
              ) = ${input.authority.providerThreadId}
              AND subagent.thread_id = ${input.authority.threadId}
              AND subagent.child_thread_id = ${input.childThreadId}
              AND subagent.origin = 'provider_native'
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_authority_acquisitions AS newer_acquisition
                WHERE newer_acquisition.thread_id = acquisition.thread_id
                  AND newer_acquisition.provider_instance_id = acquisition.provider_instance_id
                  AND newer_acquisition.acquisition_order > acquisition.acquisition_order
              )
            LIMIT 1
            ON CONFLICT(acquisition_order, child_provider_thread_id) DO NOTHING
            RETURNING acquisition_order
          `;
          if (inserted[0] !== undefined) {
            yield* sql`
              UPDATE orchestration_v2_provider_resume_intents
              SET consumed_at = ${DateTime.formatIso(yield* DateTime.now)},
                confirmed_native_turn_id = ${input.nativeChildTurnId}
              WHERE acquisition_order = ${inserted[0].acquisition_order}
                AND parent_provider_turn_id = ${input.parentProviderTurnId}
                AND child_provider_thread_id = ${input.childProviderThreadId}
                AND child_thread_id = ${input.childThreadId}
                AND native_item_id = ${input.nativeItemId}
                AND native_turn_id_barrier = ${input.nativeTurnIdBarrier}
                AND consumed_at IS NULL
            `;
            return { committed: true as const };
          }
          const existing = yield* sql<{ readonly current: number }>`
            SELECT 1 AS current
            FROM orchestration_v2_provider_resume_authorizations AS resume
            INNER JOIN orchestration_v2_provider_authority_acquisitions AS acquisition
              ON acquisition.acquisition_order = resume.acquisition_order
            INNER JOIN orchestration_v2_provider_resume_intents AS intent
              ON intent.acquisition_order = acquisition.acquisition_order
              AND intent.child_provider_thread_id = resume.child_provider_thread_id
            WHERE acquisition.thread_id = ${input.authority.threadId}
              AND acquisition.provider_instance_id = ${input.authority.providerInstanceId}
              AND acquisition.run_id = ${input.authority.runId}
              AND acquisition.attempt_id = ${input.authority.activeAttemptId}
              AND resume.child_provider_thread_id = ${input.childProviderThreadId}
              AND resume.child_thread_id = ${input.childThreadId}
              AND intent.parent_provider_turn_id = ${input.parentProviderTurnId}
              AND intent.child_thread_id = ${input.childThreadId}
              AND intent.native_item_id = ${input.nativeItemId}
              AND intent.native_turn_id_barrier = ${input.nativeTurnIdBarrier}
              AND intent.confirmed_native_turn_id = ${input.nativeChildTurnId}
              AND intent.consumed_at IS NOT NULL
            LIMIT 1
          `;
          return { committed: existing[0] !== undefined };
        }),
      );
    });

    const recordProviderThreadResumeIntentEffect = Effect.fn(
      "orchestrationV2.EventSink.recordProviderThreadResumeIntent",
    )(function* (input: Parameters<EventSinkV2Shape["recordProviderThreadResumeIntent"]>[0]) {
      if (
        input.authority.runId === undefined ||
        input.authority.activeAttemptId === undefined ||
        input.authority.providerThreadId === undefined ||
        !isCodexNativeTurnId(input.nativeTurnIdBarrier)
      ) {
        return { committed: false as const };
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* providerEventAuthorityCurrent(input.authority))) {
            return { committed: false as const };
          }
          const requestedAt = DateTime.formatIso(yield* DateTime.now);
          const inserted = yield* sql<{ readonly acquisition_order: number }>`
            INSERT INTO orchestration_v2_provider_resume_intents (
              acquisition_order,
              parent_provider_turn_id,
              child_provider_thread_id,
              child_thread_id,
              native_item_id,
              native_turn_id_barrier,
              requested_at,
              consumed_at,
              confirmed_native_turn_id
            )
            SELECT
              acquisition.acquisition_order,
              parent_provider_turn.provider_turn_id,
              child_provider_thread.provider_thread_id,
              child_provider_thread.thread_id,
              ${input.nativeItemId},
              ${input.nativeTurnIdBarrier},
              ${requestedAt},
              NULL,
              NULL
            FROM orchestration_v2_provider_authority_acquisitions AS acquisition
            INNER JOIN orchestration_v2_projection_provider_turns AS parent_provider_turn
              ON parent_provider_turn.provider_thread_id = acquisition.provider_thread_id
            INNER JOIN orchestration_v2_projection_provider_threads AS child_provider_thread
              ON child_provider_thread.provider_thread_id = ${input.childProviderThreadId}
            INNER JOIN orchestration_v2_projection_subagents AS subagent
              ON subagent.provider_thread_id = child_provider_thread.provider_thread_id
            WHERE acquisition.thread_id = ${input.authority.threadId}
              AND acquisition.provider_instance_id = ${input.authority.providerInstanceId}
              AND acquisition.run_id = ${input.authority.runId}
              AND acquisition.attempt_id = ${input.authority.activeAttemptId}
              AND acquisition.provider_thread_id = ${input.authority.providerThreadId}
              AND acquisition.provider_session_id = ${input.authority.providerSessionId}
              AND acquisition.generation = ${input.authority.generation}
              AND parent_provider_turn.provider_turn_id = ${input.parentProviderTurnId}
              AND parent_provider_turn.run_attempt_id = ${input.authority.activeAttemptId}
              AND child_provider_thread.thread_id = ${input.childThreadId}
              AND child_provider_thread.provider_instance_id = ${input.authority.providerInstanceId}
              AND child_provider_thread.provider_session_id = ${input.authority.providerSessionId}
              AND json_extract(
                child_provider_thread.payload_json,
                '$.forkedFrom.providerThreadId'
              ) = ${input.authority.providerThreadId}
              AND subagent.thread_id = ${input.authority.threadId}
              AND subagent.child_thread_id = ${input.childThreadId}
              AND subagent.origin = 'provider_native'
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_authority_acquisitions AS newer_acquisition
                WHERE newer_acquisition.thread_id = acquisition.thread_id
                  AND newer_acquisition.provider_instance_id = acquisition.provider_instance_id
                  AND newer_acquisition.acquisition_order > acquisition.acquisition_order
              )
            LIMIT 1
            ON CONFLICT(acquisition_order, child_provider_thread_id, native_item_id) DO NOTHING
            RETURNING acquisition_order
          `;
          if (inserted[0] !== undefined) return { committed: true as const };
          const existing = yield* sql<{ readonly current: number }>`
            SELECT 1 AS current
            FROM orchestration_v2_provider_resume_intents AS intent
            INNER JOIN orchestration_v2_provider_authority_acquisitions AS acquisition
              ON acquisition.acquisition_order = intent.acquisition_order
            WHERE acquisition.thread_id = ${input.authority.threadId}
              AND acquisition.run_id = ${input.authority.runId}
              AND acquisition.attempt_id = ${input.authority.activeAttemptId}
              AND intent.parent_provider_turn_id = ${input.parentProviderTurnId}
              AND intent.child_provider_thread_id = ${input.childProviderThreadId}
              AND intent.child_thread_id = ${input.childThreadId}
              AND intent.native_item_id = ${input.nativeItemId}
              AND intent.native_turn_id_barrier = ${input.nativeTurnIdBarrier}
            LIMIT 1
          `;
          return { committed: existing[0] !== undefined };
        }),
      );
    });

    const providerEventLineageCurrent = Effect.fn(
      "orchestrationV2.EventSink.providerEventLineageCurrent",
    )(function* (
      authority: ProviderEventCommitAuthority,
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) {
      if (
        authority.runId === undefined ||
        authority.activeAttemptId === undefined ||
        authority.providerThreadId === undefined
      ) {
        return events.every(
          (event) =>
            (event.type === "provider-session.attached" ||
              event.type === "provider-session.updated") &&
            event.threadId === authority.threadId &&
            event.payload.id === authority.providerSessionId &&
            event.payload.providerInstanceId === authority.providerInstanceId,
        );
      }
      const childThreadCache = new Map<ThreadId, boolean>();
      const providerThreadCache = new Map<ProviderThreadId, boolean>();
      const providerTurnCache = new Map<ProviderTurnId, boolean>();
      const nodeCache = new Map<string, boolean>();
      const providerSubagentNodeCache = new Map<string, boolean>();
      const providerSubagentClaimCache = new Map<string, boolean>();
      const childThreadCurrent = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const cached = childThreadCache.get(threadId);
          if (cached !== undefined) return cached;
          const rows = yield* sql<{ readonly current: number }>`
            WITH RECURSIVE owned_threads(thread_id) AS (
              SELECT subagent.child_thread_id
              FROM orchestration_v2_projection_subagents AS subagent
              INNER JOIN orchestration_v2_projection_nodes AS node
                ON node.node_id = subagent.subagent_id
              INNER JOIN orchestration_v2_projection_provider_turns AS provider_turn
                ON provider_turn.provider_turn_id = node.provider_turn_id
              WHERE subagent.thread_id = ${authority.threadId}
                AND subagent.run_id = ${authority.runId}
                AND subagent.origin = 'provider_native'
                AND subagent.child_thread_id IS NOT NULL
                AND provider_turn.run_attempt_id = ${authority.activeAttemptId}
                AND (
                  subagent.provider_thread_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM orchestration_v2_projection_provider_threads AS child_provider_thread
                    WHERE child_provider_thread.provider_thread_id = subagent.provider_thread_id
                      AND child_provider_thread.thread_id = subagent.child_thread_id
                      AND child_provider_thread.provider_instance_id = ${authority.providerInstanceId}
                      AND child_provider_thread.provider_session_id = ${authority.providerSessionId}
                  )
                )
              UNION
              SELECT resume.child_thread_id
              FROM orchestration_v2_provider_resume_authorizations AS resume
              INNER JOIN orchestration_v2_provider_authority_acquisitions AS acquisition
                ON acquisition.acquisition_order = resume.acquisition_order
              WHERE acquisition.thread_id = ${authority.threadId}
                AND acquisition.provider_instance_id = ${authority.providerInstanceId}
                AND acquisition.run_id = ${authority.runId}
                AND acquisition.attempt_id = ${authority.activeAttemptId}
                AND acquisition.provider_thread_id = ${authority.providerThreadId}
                AND acquisition.provider_session_id = ${authority.providerSessionId}
                AND acquisition.generation = ${authority.generation}
              UNION
              SELECT created.stream_id
              FROM orchestration_events AS created
              WHERE created.event_type = 'thread.created'
                AND created.application_event_version = 2
                AND json_extract(created.metadata_json, '$.runId') = ${authority.runId}
                AND json_extract(created.payload_json, '$.creationSource') = 'provider'
                AND json_extract(created.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                AND json_extract(created.payload_json, '$.lineage.rootThreadId') = ${authority.threadId}
                AND created.sequence > (
                  SELECT MIN(attempt_event.sequence)
                  FROM orchestration_events AS attempt_event
                  WHERE attempt_event.event_type = 'run-attempt.updated'
                    AND json_extract(attempt_event.payload_json, '$.id') = ${authority.activeAttemptId}
                )
              UNION
              SELECT subagent.child_thread_id
              FROM orchestration_v2_projection_subagents AS subagent
              INNER JOIN owned_threads AS parent
                ON subagent.thread_id = parent.thread_id
              INNER JOIN orchestration_v2_projection_nodes AS node
                ON node.node_id = subagent.subagent_id
                AND node.thread_id = subagent.thread_id
              INNER JOIN orchestration_v2_projection_provider_turns AS provider_turn
                ON provider_turn.provider_turn_id = node.provider_turn_id
              INNER JOIN orchestration_v2_projection_provider_threads AS parent_provider_thread
                ON parent_provider_thread.provider_thread_id = provider_turn.provider_thread_id
              WHERE subagent.origin = 'provider_native'
                AND subagent.child_thread_id IS NOT NULL
                AND node.kind = 'subagent'
                AND parent_provider_thread.thread_id = subagent.thread_id
                AND parent_provider_thread.provider_instance_id = ${authority.providerInstanceId}
                AND parent_provider_thread.provider_session_id = ${authority.providerSessionId}
                AND (
                  subagent.provider_thread_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM orchestration_v2_projection_provider_threads AS child_provider_thread
                    WHERE child_provider_thread.provider_thread_id = subagent.provider_thread_id
                      AND child_provider_thread.thread_id = subagent.child_thread_id
                      AND child_provider_thread.provider_instance_id = ${authority.providerInstanceId}
                      AND child_provider_thread.provider_session_id = ${authority.providerSessionId}
                      AND json_extract(child_provider_thread.payload_json, '$.forkedFrom.providerThreadId') = parent_provider_thread.provider_thread_id
                  )
                )
            )
            SELECT 1 AS current
            FROM owned_threads
            WHERE thread_id = ${threadId}
            LIMIT 1
          `;
          const current = rows[0] !== undefined;
          childThreadCache.set(threadId, current);
          return current;
        });
      const providerThreadCurrent = (providerThreadId: ProviderThreadId) =>
        Effect.gen(function* () {
          const cached = providerThreadCache.get(providerThreadId);
          if (cached !== undefined) return cached;
          if (providerThreadId === authority.providerThreadId) {
            providerThreadCache.set(providerThreadId, true);
            return true;
          }
          const rows = yield* sql<{ readonly thread_id: string | null }>`
            WITH RECURSIVE provider_ancestry(provider_thread_id) AS (
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE provider_thread_id = ${providerThreadId}
                AND provider_instance_id = ${authority.providerInstanceId}
                AND provider_session_id = ${authority.providerSessionId}
              UNION
              SELECT json_extract(provider_thread.payload_json, '$.forkedFrom.providerThreadId')
              FROM orchestration_v2_projection_provider_threads AS provider_thread
              INNER JOIN provider_ancestry AS child
                ON provider_thread.provider_thread_id = child.provider_thread_id
              WHERE provider_thread.provider_instance_id = ${authority.providerInstanceId}
                AND provider_thread.provider_session_id = ${authority.providerSessionId}
                AND json_extract(provider_thread.payload_json, '$.forkedFrom.providerThreadId') IS NOT NULL
            )
            SELECT provider_thread.thread_id
            FROM orchestration_v2_projection_provider_threads AS provider_thread
            WHERE provider_thread.provider_thread_id = ${providerThreadId}
              AND EXISTS (
                SELECT 1
                FROM provider_ancestry
                WHERE provider_thread_id = ${authority.providerThreadId}
              )
            LIMIT 1
          `;
          const threadId = rows[0]?.thread_id;
          const current =
            threadId !== undefined &&
            threadId !== null &&
            (yield* childThreadCurrent(ThreadId.make(threadId)));
          providerThreadCache.set(providerThreadId, current);
          return current;
        });
      const providerTurnCurrent = (providerTurnId: ProviderTurnId) =>
        Effect.gen(function* () {
          const cached = providerTurnCache.get(providerTurnId);
          if (cached !== undefined) return cached;
          const rows = yield* sql<{
            readonly provider_thread_id: string;
            readonly run_attempt_id: string | null;
          }>`
            SELECT provider_thread_id, run_attempt_id
            FROM orchestration_v2_projection_provider_turns
            WHERE provider_turn_id = ${providerTurnId}
            LIMIT 1
          `;
          const row = rows[0];
          const current =
            row !== undefined &&
            ((row.provider_thread_id === authority.providerThreadId &&
              row.run_attempt_id === authority.activeAttemptId) ||
              (yield* providerThreadCurrent(ProviderThreadId.make(row.provider_thread_id))));
          providerTurnCache.set(providerTurnId, current);
          return current;
        });
      const nodeCurrent = (nodeId: string) =>
        Effect.gen(function* () {
          const cached = nodeCache.get(nodeId);
          if (cached !== undefined) return cached;
          const rows = yield* sql<{ readonly thread_id: string; readonly run_id: string | null }>`
            SELECT thread_id, run_id
            FROM orchestration_v2_projection_nodes
            WHERE node_id = ${nodeId}
            LIMIT 1
          `;
          const row = rows[0];
          const current =
            row !== undefined &&
            (row.run_id === authority.runId ||
              (yield* childThreadCurrent(ThreadId.make(row.thread_id))));
          nodeCache.set(nodeId, current);
          return current;
        });
      const providerSubagentNodeCurrent = (nodeId: string) =>
        Effect.gen(function* () {
          const cached = providerSubagentNodeCache.get(nodeId);
          if (cached !== undefined) return cached;
          const rows = yield* sql<{
            readonly thread_id: string;
            readonly run_id: string | null;
            readonly provider_thread_id: string | null;
            readonly provider_turn_id: string | null;
            readonly turn_provider_thread_id: string | null;
            readonly origin: string | null;
          }>`
            SELECT
              node.thread_id,
              node.run_id,
              node.provider_thread_id,
              node.provider_turn_id,
              provider_turn.provider_thread_id AS turn_provider_thread_id,
              subagent.origin
            FROM orchestration_v2_projection_nodes AS node
            LEFT JOIN orchestration_v2_projection_provider_turns AS provider_turn
              ON provider_turn.provider_turn_id = node.provider_turn_id
            LEFT JOIN orchestration_v2_projection_subagents AS subagent
              ON subagent.subagent_id = node.node_id
            WHERE node.node_id = ${nodeId}
              AND node.kind = 'subagent'
              AND (subagent.subagent_id IS NULL OR subagent.origin = 'provider_native')
            LIMIT 1
          `;
          const row = rows[0];
          const providerThreadId = row?.provider_thread_id;
          const providerTurnId = row?.provider_turn_id;
          const current =
            row !== undefined &&
            row.origin !== "app_owned" &&
            providerThreadId !== undefined &&
            providerThreadId !== null &&
            providerTurnId !== undefined &&
            providerTurnId !== null &&
            row.turn_provider_thread_id !== null &&
            (yield* providerThreadCurrent(ProviderThreadId.make(providerThreadId))) &&
            (yield* providerTurnCurrent(ProviderTurnId.make(providerTurnId))) &&
            ((row.thread_id === authority.threadId && row.run_id === authority.runId) ||
              (row.run_id === null && (yield* childThreadCurrent(ThreadId.make(row.thread_id)))));
          providerSubagentNodeCache.set(nodeId, current);
          return current;
        });
      const providerSubagentClaimable = (nodeId: string) =>
        Effect.gen(function* () {
          const cached = providerSubagentClaimCache.get(nodeId);
          if (cached !== undefined) return cached;
          const rows = yield* sql<{ readonly origin: string }>`
            SELECT origin
            FROM orchestration_v2_projection_subagents
            WHERE subagent_id = ${nodeId}
            LIMIT 1
          `;
          const claimable = rows[0] === undefined || rows[0].origin === "provider_native";
          providerSubagentClaimCache.set(nodeId, claimable);
          return claimable;
        });

      for (const event of events) {
        if (event.runId !== undefined && event.runId !== authority.runId) return false;
        switch (event.type) {
          case "provider-session.attached":
          case "provider-session.updated":
            if (
              event.threadId !== authority.threadId ||
              event.payload.id !== authority.providerSessionId ||
              event.payload.providerInstanceId !== authority.providerInstanceId
            ) {
              return false;
            }
            break;
          case "provider-thread.updated": {
            if (
              event.payload.appThreadId !== event.threadId ||
              event.payload.providerInstanceId !== authority.providerInstanceId ||
              event.payload.providerSessionId !== authority.providerSessionId
            ) {
              return false;
            }
            if (
              event.payload.id !== authority.providerThreadId &&
              !(yield* childThreadCurrent(event.threadId))
            ) {
              return false;
            }
            break;
          }
          case "provider-turn.updated":
            if (
              !(
                (event.payload.providerThreadId === authority.providerThreadId &&
                  event.payload.runAttemptId === authority.activeAttemptId) ||
                (yield* providerThreadCurrent(event.payload.providerThreadId))
              )
            ) {
              return false;
            }
            break;
          case "runtime-request.updated":
            if (
              event.payload.providerTurnId === null
                ? !(yield* nodeCurrent(event.payload.nodeId))
                : !(yield* providerTurnCurrent(event.payload.providerTurnId))
            ) {
              return false;
            }
            break;
          case "node.updated":
            if (
              event.payload.kind === "subagent" &&
              (event.payload.providerTurnId === null ||
                !(yield* providerTurnCurrent(event.payload.providerTurnId)) ||
                !(yield* providerSubagentClaimable(event.payload.id)))
            ) {
              return false;
            }
          // Fall through to the common run/child artifact checks.
          case "subagent.updated":
          case "message.updated":
          case "turn-item.updated":
          case "plan.updated": {
            if (
              event.type === "subagent.updated" &&
              (event.payload.origin !== "provider_native" ||
                !(yield* providerSubagentNodeCurrent(event.payload.id)))
            ) {
              return false;
            }
            if (event.payload.threadId !== event.threadId) return false;
            const payloadRunCurrent = event.payload.runId === authority.runId;
            const payloadChildCurrent =
              event.payload.runId === null && (yield* childThreadCurrent(event.payload.threadId));
            if (!payloadRunCurrent && !payloadChildCurrent) return false;
            if (
              "providerThreadId" in event.payload &&
              event.payload.providerThreadId !== null &&
              event.payload.providerThreadId !== undefined &&
              !(event.type === "node.updated" && event.payload.kind === "subagent") &&
              !(yield* providerThreadCurrent(event.payload.providerThreadId))
            ) {
              return false;
            }
            if (
              "providerTurnId" in event.payload &&
              event.payload.providerTurnId !== null &&
              event.payload.providerTurnId !== undefined &&
              !(yield* providerTurnCurrent(event.payload.providerTurnId))
            ) {
              return false;
            }
            break;
          }
          case "thread.created": {
            if (event.payload.id !== event.threadId) return false;
            if (event.threadId === authority.threadId) break;
            if (yield* childThreadCurrent(event.threadId)) break;
            const existingRows = yield* sql<{ readonly current: number }>`
              SELECT 1 AS current
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${event.threadId}
              LIMIT 1
            `;
            const parentThreadId = event.payload.lineage.parentThreadId;
            if (
              existingRows[0] !== undefined ||
              event.payload.lineage.relationshipToParent !== "subagent" ||
              event.payload.lineage.rootThreadId !== authority.threadId ||
              parentThreadId === null ||
              (parentThreadId !== authority.threadId &&
                !(yield* childThreadCurrent(parentThreadId)))
            ) {
              return false;
            }
            break;
          }
          default:
            if (
              event.threadId !== authority.threadId &&
              !(yield* childThreadCurrent(event.threadId))
            ) {
              return false;
            }
        }
      }
      return true;
    });

    const supersededProviderTurnTerminalCurrent = Effect.fn(
      "orchestrationV2.EventSink.supersededProviderTurnTerminalCurrent",
    )(function* (
      authority: ProviderEventCommitAuthority,
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) {
      if (
        authority.providerThreadId === undefined ||
        authority.activeAttemptId === undefined ||
        authority.runId === undefined ||
        events.length === 0 ||
        events.some(
          (event) =>
            event.type !== "provider-turn.updated" ||
            event.payload.providerThreadId !== authority.providerThreadId ||
            event.payload.runAttemptId !== authority.activeAttemptId ||
            !["completed", "interrupted", "failed", "cancelled"].includes(event.payload.status),
        )
      ) {
        return false;
      }
      const rows = yield* sql<{ readonly current: number }>`
        SELECT 1 AS current
        WHERE COALESCE((
          SELECT generation
          FROM orchestration_v2_provider_session_generations AS generation
          WHERE generation.thread_id = ${authority.threadId}
            AND generation.provider_instance_id = ${authority.providerInstanceId}
        ), 0) = ${authority.generation}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_session_generations AS generation
            WHERE generation.thread_id = ${authority.threadId}
              AND generation.provider_instance_id = ${authority.providerInstanceId}
              AND generation.quarantined_provider_session_id = ${authority.providerSessionId}
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_provider_turns AS provider_turn
            INNER JOIN orchestration_v2_projection_run_attempts AS attempt
              ON attempt.attempt_id = provider_turn.run_attempt_id
            WHERE provider_turn.provider_thread_id = ${authority.providerThreadId}
              AND provider_turn.run_attempt_id = ${authority.activeAttemptId}
              AND attempt.run_id = ${authority.runId}
              AND provider_turn.status = 'running'
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_authority_acquisitions AS acquisition
            WHERE acquisition.thread_id = ${authority.threadId}
              AND acquisition.provider_instance_id = ${authority.providerInstanceId}
              AND acquisition.run_id = ${authority.runId}
              AND acquisition.attempt_id = ${authority.activeAttemptId}
              AND acquisition.provider_thread_id = ${authority.providerThreadId}
              AND acquisition.provider_session_id = ${authority.providerSessionId}
              AND acquisition.generation = ${authority.generation}
          )
        LIMIT 1
      `;
      return rows[0] !== undefined;
    });

    const providerTerminalFinalizationCurrent = Effect.fn(
      "orchestrationV2.EventSink.providerTerminalFinalizationCurrent",
    )(function* (authority: ProviderEventCommitAuthority) {
      if (
        authority.providerThreadId === undefined ||
        authority.activeAttemptId === undefined ||
        authority.runId === undefined ||
        authority.terminalProviderTurnId === undefined
      ) {
        return false;
      }
      const rows = yield* sql<{ readonly current: number }>`
        SELECT 1 AS current
        WHERE COALESCE((
          SELECT generation
          FROM orchestration_v2_provider_session_generations AS generation
          WHERE generation.thread_id = ${authority.threadId}
            AND generation.provider_instance_id = ${authority.providerInstanceId}
        ), 0) = ${authority.generation}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_session_generations AS generation
            WHERE generation.thread_id = ${authority.threadId}
              AND generation.provider_instance_id = ${authority.providerInstanceId}
              AND generation.quarantined_provider_session_id = ${authority.providerSessionId}
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_provider_turns AS provider_turn
            INNER JOIN orchestration_v2_projection_run_attempts AS attempt
              ON attempt.attempt_id = provider_turn.run_attempt_id
            WHERE provider_turn.provider_turn_id = ${authority.terminalProviderTurnId}
              AND provider_turn.provider_thread_id = ${authority.providerThreadId}
              AND provider_turn.run_attempt_id = ${authority.activeAttemptId}
              AND attempt.run_id = ${authority.runId}
              AND provider_turn.status IN ('completed', 'interrupted', 'failed', 'cancelled')
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_authority_acquisitions AS acquisition
            WHERE acquisition.thread_id = ${authority.threadId}
              AND acquisition.provider_instance_id = ${authority.providerInstanceId}
              AND acquisition.run_id = ${authority.runId}
              AND acquisition.attempt_id = ${authority.activeAttemptId}
              AND acquisition.provider_thread_id = ${authority.providerThreadId}
              AND acquisition.provider_session_id = ${authority.providerSessionId}
              AND acquisition.generation = ${authority.generation}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_authority_acquisitions AS newer_acquisition
                WHERE newer_acquisition.thread_id = acquisition.thread_id
                  AND newer_acquisition.provider_instance_id = acquisition.provider_instance_id
                  AND newer_acquisition.acquisition_order > acquisition.acquisition_order
              )
          )
        LIMIT 1
      `;
      return rows[0] !== undefined;
    });

    const providerEventsCurrent = Effect.fn("orchestrationV2.EventSink.providerEventsCurrent")(
      function* (
        authority: ProviderEventCommitAuthority,
        events: ReadonlyArray<OrchestrationV2DomainEvent>,
      ) {
        const authorityCurrent =
          (yield* providerEventAuthorityCurrent(authority)) ||
          (yield* supersededProviderTurnTerminalCurrent(authority, events)) ||
          (yield* providerTerminalFinalizationCurrent(authority));
        return authorityCurrent && (yield* providerEventLineageCurrent(authority, events));
      },
    );

    const appendEvents = Effect.fn("orchestrationV2.EventSink.appendEvents")(function* (input: {
      readonly commandId?: CommandId;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    }) {
      const normalized = yield* normalizeEvents(input.events);
      const storedEvents = yield* eventStore.append({
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        events: normalized,
      });
      yield* applyStoredEvents(storedEvents);
      return storedEvents;
    });

    const publishStoredEvents = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      storedEvents.length === 0
        ? Effect.void
        : eventStore
            .publishCommitted(storedEvents)
            .pipe(Effect.andThen(PubSub.publishAll(liveEvents, storedEvents)));

    const writeProviderEventsIfCurrentEffect = Effect.fn(
      "orchestrationV2.EventSink.writeProviderEventsIfCurrent",
    )(function* (input: Parameters<EventSinkV2Shape["writeProviderEventsIfCurrent"]>[0]) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* providerEventsCurrent(input.authority, input.events))) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }
          const storedEvents = yield* appendEvents(input);
          return { committed: true as const, storedEvents };
        }),
      );
      if (result.committed) yield* publishStoredEvents(result.storedEvents);
      return result;
    });

    const writeIfProviderMutationCurrentEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderMutationCurrent",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderMutationCurrent"]>[0]) {
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) {
        return {
          committed: false as const,
          storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
        };
      }
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly status: string }>`
            SELECT run.status
            FROM orchestration_v2_provider_rollback_reservations AS reservation
            INNER JOIN orchestration_v2_projection_runs AS run
              ON run.run_id = reservation.run_id
            WHERE reservation.reservation_id = ${input.reservationId}
              AND reservation.owner_instance_id = ${providerMutationInstanceId}
              AND reservation.lease_epoch = ${leaseEpoch}
              AND reservation.phase = 'external_complete'
              AND reservation.thread_id = ${input.authority.threadId}
              AND reservation.provider_instance_id = ${input.authority.providerInstanceId}
              AND reservation.run_id = ${input.authority.runId}
              AND reservation.attempt_id = ${input.authority.activeAttemptId}
              AND reservation.provider_thread_id = ${input.authority.providerThreadId}
              AND reservation.provider_session_id = ${input.authority.providerSessionId}
              AND reservation.generation = ${input.authority.generation}
              AND run.thread_id = ${input.authority.threadId}
              AND run.status = ${input.authority.expectedRunStatus}
              AND COALESCE((
                SELECT generation
                FROM orchestration_v2_provider_session_generations AS generation
                WHERE generation.thread_id = reservation.thread_id
                  AND generation.provider_instance_id = reservation.provider_instance_id
              ), 0) = reservation.generation
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_session_generations AS generation
                WHERE generation.thread_id = reservation.thread_id
                  AND generation.provider_instance_id = reservation.provider_instance_id
                  AND generation.quarantined_provider_session_id = reservation.provider_session_id
              )
              AND EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_mutation_owner AS owner
                WHERE owner.singleton_id = 1
                  AND owner.instance_id = ${providerMutationInstanceId}
                  AND owner.lease_epoch = ${leaseEpoch}
                  AND owner.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              )
            LIMIT 1
          `;
          if (rows[0] === undefined) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }
          const storedEvents = yield* appendEvents(input);
          yield* sql`
            DELETE FROM orchestration_v2_provider_rollback_reservations
            WHERE reservation_id = ${input.reservationId}
              AND owner_instance_id = ${providerMutationInstanceId}
              AND lease_epoch = ${leaseEpoch}
              AND thread_id = ${input.authority.threadId}
              AND provider_instance_id = ${input.authority.providerInstanceId}
          `;
          return { committed: true as const, storedEvents };
        }),
      );
      if (result.committed) yield* publishStoredEvents(result.storedEvents);
      return result;
    });

    const reserveProviderMutationEffect = Effect.fn(
      "orchestrationV2.EventSink.reserveProviderMutation",
    )(function* (input: Parameters<EventSinkV2Shape["reserveProviderMutation"]>[0]) {
      if ((yield* Ref.get(providerMutationLeaseEpoch)) === null) {
        const owner = yield* activateProviderMutationOwnerEffect();
        if (!owner.activated) return { committed: false as const };
      }
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) return { committed: false as const };
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* providerEventAuthorityCurrent(input.authority))) {
            return { committed: false as const };
          }
          const runRows = yield* sql<{ readonly status: string }>`
            SELECT status
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.authority.runId}
              AND thread_id = ${input.authority.threadId}
              AND status = ${input.authority.expectedRunStatus}
            LIMIT 1
          `;
          if (runRows[0] === undefined) return { committed: false as const };

          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const inserted = yield* sql<{ readonly reservation_id: string }>`
            INSERT INTO orchestration_v2_provider_rollback_reservations (
              reservation_id,
              owner_instance_id,
              lease_epoch,
              thread_id,
              provider_instance_id,
              run_id,
              attempt_id,
              provider_thread_id,
              provider_session_id,
              generation,
              checkpoint_id,
              scope_id,
              target_run_ordinal,
              target_resolution,
              phase,
              created_at,
              updated_at
            ) SELECT
              ${input.reservationId},
              ${providerMutationInstanceId},
              ${leaseEpoch},
              ${input.authority.threadId},
              ${input.authority.providerInstanceId},
              ${input.authority.runId},
              ${input.authority.activeAttemptId},
              ${input.authority.providerThreadId},
              ${input.authority.providerSessionId},
              ${input.authority.generation},
              ${input.checkpointId},
              ${input.scopeId},
              ${input.targetRunOrdinal},
              'exact',
              'reserved',
              ${createdAt},
              ${createdAt}
            WHERE EXISTS (
              SELECT 1
              FROM orchestration_v2_provider_mutation_owner
              WHERE singleton_id = 1
                AND instance_id = ${providerMutationInstanceId}
                AND lease_epoch = ${leaseEpoch}
                AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ON CONFLICT DO NOTHING
            RETURNING reservation_id
          `;
          return { committed: inserted[0] !== undefined };
        }),
      );
    });

    const markProviderMutationPhaseEffect = Effect.fn(
      "orchestrationV2.EventSink.markProviderMutationPhase",
    )(function* (input: Parameters<EventSinkV2Shape["markProviderMutationPhase"]>[0]) {
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) return { committed: false as const };
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql<{ readonly reservation_id: string }>`
        UPDATE orchestration_v2_provider_rollback_reservations
        SET phase = ${input.phase}, updated_at = ${updatedAt}
        WHERE reservation_id = ${input.reservationId}
          AND owner_instance_id = ${providerMutationInstanceId}
          AND lease_epoch = ${leaseEpoch}
          AND thread_id = ${input.threadId}
          AND provider_instance_id = ${input.providerInstanceId}
          AND (
            (phase = 'reserved' AND ${input.phase} = 'filesystem_started')
            OR (phase = 'filesystem_started' AND ${input.phase} = 'filesystem_restored')
            OR (phase = 'filesystem_restored' AND ${input.phase} IN (
              'provider_started',
              'cleanup_started',
              'external_complete'
            ))
            OR (phase = 'provider_started' AND ${input.phase} = 'provider_restored')
            OR (phase = 'provider_restored' AND ${input.phase} IN (
              'cleanup_started',
              'external_complete'
            ))
            OR (phase = 'cleanup_started' AND ${input.phase} = 'external_complete')
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_mutation_owner
            WHERE singleton_id = 1
              AND instance_id = ${providerMutationInstanceId}
              AND lease_epoch = ${leaseEpoch}
              AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
        RETURNING reservation_id
      `;
      return { committed: rows[0] !== undefined };
    });

    const releaseProviderMutationEffect = Effect.fn(
      "orchestrationV2.EventSink.releaseProviderMutation",
    )(function* (input: Parameters<EventSinkV2Shape["releaseProviderMutation"]>[0]) {
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) return;
      yield* sql`
        DELETE FROM orchestration_v2_provider_rollback_reservations
        WHERE reservation_id = ${input.reservationId}
          AND owner_instance_id = ${providerMutationInstanceId}
          AND lease_epoch = ${leaseEpoch}
          AND thread_id = ${input.threadId}
          AND provider_instance_id = ${input.providerInstanceId}
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_mutation_owner AS owner
            WHERE owner.singleton_id = 1
              AND owner.instance_id = ${providerMutationInstanceId}
              AND owner.lease_epoch = ${leaseEpoch}
              AND owner.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
      `;
    });

    const listAbandonedProviderMutationsEffect = Effect.fn(
      "orchestrationV2.EventSink.listAbandonedProviderMutations",
    )(function* () {
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) return [];
      const rows = yield* sql<{
        readonly reservation_id: string;
        readonly owner_instance_id: string;
        readonly lease_epoch: number;
        readonly thread_id: string;
        readonly provider_instance_id: string;
        readonly run_id: string;
        readonly attempt_id: string;
        readonly provider_thread_id: string;
        readonly provider_session_id: string;
        readonly generation: number;
        readonly checkpoint_id: string;
        readonly scope_id: string;
        readonly target_run_ordinal: number | null;
        readonly target_resolution: "exact" | "ambiguous";
        readonly phase: ProviderMutationPhase;
      }>`
        SELECT
          reservation.reservation_id,
          reservation.owner_instance_id,
          reservation.lease_epoch,
          reservation.thread_id,
          reservation.provider_instance_id,
          reservation.run_id,
          reservation.attempt_id,
          reservation.provider_thread_id,
          reservation.provider_session_id,
          reservation.generation,
          reservation.checkpoint_id,
          reservation.scope_id,
          reservation.target_run_ordinal,
          reservation.target_resolution,
          reservation.phase
        FROM orchestration_v2_provider_rollback_reservations AS reservation
        WHERE (reservation.owner_instance_id <> ${providerMutationInstanceId}
            OR reservation.lease_epoch <> ${leaseEpoch})
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_mutation_owner AS owner
            WHERE owner.singleton_id = 1
              AND owner.instance_id = ${providerMutationInstanceId}
              AND owner.lease_epoch = ${leaseEpoch}
              AND owner.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
        ORDER BY reservation.created_at, reservation.reservation_id
      `;
      return rows.map(
        (row): AbandonedProviderMutation => ({
          reservationId: row.reservation_id,
          ownerInstanceId: row.owner_instance_id,
          leaseEpoch: row.lease_epoch,
          threadId: ThreadId.make(row.thread_id),
          providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
          runId: RunId.make(row.run_id),
          attemptId: RunAttemptId.make(row.attempt_id),
          providerThreadId: ProviderThreadId.make(row.provider_thread_id),
          providerSessionId: ProviderSessionId.make(row.provider_session_id),
          generation: row.generation,
          checkpointId: CheckpointId.make(row.checkpoint_id),
          scopeId: CheckpointScopeId.make(row.scope_id),
          targetRunOrdinal: row.target_run_ordinal,
          targetResolution: row.target_resolution,
          phase: row.phase,
        }),
      );
    });

    const clearAbandonedProviderMutationEffect = Effect.fn(
      "orchestrationV2.EventSink.clearAbandonedProviderMutation",
    )(function* (input: Parameters<EventSinkV2Shape["clearAbandonedProviderMutation"]>[0]) {
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) return false;
      const rows = yield* sql<{ readonly reservation_id: string }>`
        DELETE FROM orchestration_v2_provider_rollback_reservations
        WHERE reservation_id = ${input.reservationId}
          AND owner_instance_id = ${input.ownerInstanceId}
          AND lease_epoch = ${input.leaseEpoch}
          AND phase = 'reserved'
          AND EXISTS (
            SELECT 1
            FROM orchestration_v2_provider_mutation_owner
            WHERE singleton_id = 1
              AND instance_id = ${providerMutationInstanceId}
              AND lease_epoch = ${leaseEpoch}
              AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
        RETURNING reservation_id
      `;
      return rows[0] !== undefined;
    });

    const reconcileAbandonedProviderMutationEffect = Effect.fn(
      "orchestrationV2.EventSink.reconcileAbandonedProviderMutation",
    )(function* (input: Parameters<EventSinkV2Shape["reconcileAbandonedProviderMutation"]>[0]) {
      const leaseEpoch = yield* Ref.get(providerMutationLeaseEpoch);
      if (leaseEpoch === null) {
        return {
          committed: false as const,
          storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
        };
      }
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* sql<{ readonly reservation_id: string }>`
            SELECT reservation.reservation_id
            FROM orchestration_v2_provider_rollback_reservations AS reservation
            WHERE reservation.reservation_id = ${input.reservation.reservationId}
              AND reservation.owner_instance_id = ${input.reservation.ownerInstanceId}
              AND reservation.lease_epoch = ${input.reservation.leaseEpoch}
              AND reservation.phase = ${input.reservation.phase}
              AND EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_mutation_owner
                WHERE singleton_id = 1
                  AND instance_id = ${providerMutationInstanceId}
                  AND lease_epoch = ${leaseEpoch}
                  AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              )
            LIMIT 1
          `;
          if (current[0] === undefined) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }
          if (input.quarantineProvider) {
            yield* sql`
              INSERT INTO orchestration_v2_provider_session_generations (
                thread_id,
                provider_instance_id,
                generation,
                quarantined_provider_session_id,
                quarantined_at,
                reason
              ) VALUES (
                ${input.reservation.threadId},
                ${input.reservation.providerInstanceId},
                ${input.reservation.generation + 1},
                ${input.reservation.providerSessionId},
                ${DateTime.formatIso(yield* DateTime.now)},
                'Recovered an abandoned provider rollback reservation.'
              )
              ON CONFLICT(thread_id, provider_instance_id) DO UPDATE SET
                generation = MAX(
                  orchestration_v2_provider_session_generations.generation,
                  excluded.generation
                ),
                quarantined_provider_session_id = excluded.quarantined_provider_session_id,
                quarantined_at = excluded.quarantined_at,
                reason = excluded.reason
            `;
            yield* sql`
              DELETE FROM orchestration_v2_projection_provider_session_bindings
              WHERE provider_session_id = ${input.reservation.providerSessionId}
                AND thread_id = ${input.reservation.threadId}
            `;
          }
          const storedEvents = yield* appendEvents({ events: input.events });
          yield* sql`
            DELETE FROM orchestration_v2_provider_rollback_reservations
            WHERE reservation_id = ${input.reservation.reservationId}
              AND owner_instance_id = ${input.reservation.ownerInstanceId}
              AND lease_epoch = ${input.reservation.leaseEpoch}
              AND EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_mutation_owner AS owner
                WHERE owner.singleton_id = 1
                  AND owner.instance_id = ${providerMutationInstanceId}
                  AND owner.lease_epoch = ${leaseEpoch}
                  AND owner.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              )
          `;
          return { committed: true as const, storedEvents };
        }),
      );
      if (result.committed) yield* publishStoredEvents(result.storedEvents);
      return result;
    });

    const quarantineProviderSessionEffect = Effect.fn(
      "orchestrationV2.EventSink.quarantineProviderSession",
    )(function* (input: Parameters<EventSinkV2Shape["quarantineProviderSession"]>[0]) {
      if (
        input.providerThreadEvent.type !== "provider-thread.updated" ||
        input.providerSessionErrorEvent.type !== "provider-session.updated" ||
        input.providerSessionDetachedEvent.type !== "provider-session.detached" ||
        input.providerThreadEvent.threadId !== input.threadId ||
        input.providerThreadEvent.payload.providerSessionId !== null ||
        input.providerThreadEvent.payload.providerInstanceId !== input.providerInstanceId ||
        input.providerSessionErrorEvent.threadId !== input.threadId ||
        input.providerSessionErrorEvent.payload.id !== input.providerSessionId ||
        input.providerSessionErrorEvent.payload.status !== "error" ||
        input.providerSessionDetachedEvent.threadId !== input.threadId ||
        input.providerSessionDetachedEvent.payload.providerSessionId !== input.providerSessionId
      ) {
        return yield* Effect.die("Invalid provider quarantine event batch.");
      }
      const providerThreadId =
        input.providerThreadEvent.type === "provider-thread.updated"
          ? input.providerThreadEvent.payload.id
          : null;
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const currentGenerationRows = yield* sql<{ readonly generation: number }>`
            SELECT COALESCE((
              SELECT generation
              FROM orchestration_v2_provider_session_generations AS generation
              WHERE generation.thread_id = ${input.threadId}
                AND generation.provider_instance_id = ${input.providerInstanceId}
            ), 0) AS generation
          `;
          const currentGeneration = currentGenerationRows[0]?.generation ?? 0;
          const ownershipRows = yield* sql<{
            readonly binding_count: number;
          }>`
            SELECT (
              SELECT COUNT(*)
              FROM orchestration_v2_projection_provider_session_bindings AS binding
              WHERE binding.provider_session_id = ${input.providerSessionId}
            ) AS binding_count
            FROM orchestration_v2_projection_provider_threads AS provider_thread
            WHERE provider_thread.provider_thread_id = ${providerThreadId}
              AND provider_thread.thread_id = ${input.threadId}
              AND provider_thread.provider_instance_id = ${input.providerInstanceId}
              AND provider_thread.provider_session_id = ${input.providerSessionId}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_provider_rollback_reservations AS reservation
                WHERE reservation.thread_id = ${input.threadId}
                  AND reservation.provider_instance_id = ${input.providerInstanceId}
              )
            LIMIT 1
          `;
          const ownership = ownershipRows[0];
          if (ownership === undefined) {
            return {
              committed: false as const,
              finalOwner: false,
              generation: currentGeneration,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }
          const finalOwner = ownership.binding_count <= 1;
          const events = [
            input.providerThreadEvent,
            ...(finalOwner ? [input.providerSessionErrorEvent] : []),
            input.providerSessionDetachedEvent,
          ];
          const normalized = yield* normalizeEvents(events);
          const quarantinedAt = DateTime.formatIso(yield* DateTime.now);
          const generationRows = yield* sql<{ readonly generation: number }>`
            INSERT INTO orchestration_v2_provider_session_generations(
              thread_id,
              provider_instance_id,
              generation,
              quarantined_provider_session_id,
              quarantined_at,
              reason
            ) VALUES (
              ${input.threadId},
              ${input.providerInstanceId},
              1,
              ${input.providerSessionId},
              ${quarantinedAt},
              ${input.reason}
            )
            ON CONFLICT(thread_id, provider_instance_id) DO UPDATE SET
              generation = generation + 1,
              quarantined_provider_session_id = excluded.quarantined_provider_session_id,
              quarantined_at = excluded.quarantined_at,
              reason = excluded.reason
            RETURNING generation
          `;
          const storedEvents = yield* eventStore.append({ events: normalized });
          yield* applyStoredEvents(storedEvents);
          return {
            committed: true as const,
            finalOwner,
            generation: generationRows[0]!.generation,
            storedEvents,
          };
        }),
      );
      if (result.committed) yield* publishStoredEvents(result.storedEvents);
      return result;
    });

    const writeIfRuntimeRequestsCurrentEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfRuntimeRequestsCurrent",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfRuntimeRequestsCurrent"]>[0]) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* runtimeRequestGuardsCurrent(input.guards))) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }
          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents };
        }),
      );
      if (result.committed) {
        yield* eventStore.publishCommitted(result.storedEvents);
        yield* PubSub.publishAll(liveEvents, result.storedEvents);
      }
      return result;
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }
            if (input.providerAuthority !== undefined) {
              const isAcquisition = input.events.some(
                (event) =>
                  event.type === "run-attempt.updated" &&
                  event.payload.id === input.activeAttemptId &&
                  event.payload.status === "running",
              );
              const authorityCurrent = isAcquisition
                ? yield* acquireProviderAuthority(input.providerAuthority, input.events)
                : yield* providerEventsCurrent(input.providerAuthority, input.events);
              if (!authorityCurrent) {
                return {
                  committed: false as const,
                  storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
                };
              }
            }

            const normalized = yield* normalizeEvents(input.events);
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            yield* applyStoredEvents(storedEvents);
            return { committed: true as const, storedEvents };
          }),
        );
        if (result.committed) {
          yield* eventStore.publishCommitted(result.storedEvents);
          yield* PubSub.publishAll(liveEvents, result.storedEvents);
        }
        return result;
      },
    );

    const failEffectWithEvents = Effect.fn("orchestrationV2.EventSink.failEffectWithEvents")(
      function* (input: Parameters<EventSinkV2Shape["failEffectWithEvents"]>[0]) {
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const failed = yield* effectOutbox.fail({
              effectId: input.effectId,
              workerId: input.workerId,
              error: input.error,
            });
            if (!failed) {
              return {
                failed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }
            if (
              input.runtimeRequestGuards !== undefined &&
              !(yield* runtimeRequestGuardsCurrent(input.runtimeRequestGuards))
            ) {
              return {
                failed: true as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }
            if (input.events.length === 0) {
              return {
                failed: true as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }
            const normalized = yield* normalizeEvents(input.events);
            const storedEvents = yield* eventStore.append({
              commandId: input.commandId,
              events: normalized,
            });
            yield* applyStoredEvents(storedEvents);
            return { failed: true as const, storedEvents };
          }),
        );
        if (result.storedEvents.length > 0) {
          yield* eventStore.publishCommitted(result.storedEvents);
          yield* PubSub.publishAll(liveEvents, result.storedEvents);
        }
        return result;
      },
    );

    const existingCommandResult = (commandId: CommandId) =>
      Effect.gen(function* () {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          if (
            input.runtimeRequestGuards !== undefined &&
            !(yield* runtimeRequestGuardsCurrent(input.runtimeRequestGuards))
          ) {
            return yield* new EventSinkRuntimeRequestGuardError({
              requestId: input.runtimeRequestGuards[0]!.requestId,
            });
          }

          if (input.supervisorAuthorityGuard !== undefined) {
            yield* requireSupervisorMutationAuthority(sql, input.supervisorAuthorityGuard);
          }

          if (input.runtimeAuthorityGuard !== undefined) {
            yield* requireRuntimeMutationAuthority(sql, input.runtimeAuthorityGuard);
          }

          if (input.activeProjectGuard !== undefined) {
            const activeProjects = yield* sql<{ readonly project_id: string }>`
              SELECT project_id
              FROM projection_projects
              WHERE project_id = ${input.activeProjectGuard.projectId}
                AND deleted_at IS NULL
                AND TRIM(workspace_root) <> ''
              LIMIT 1
            `;
            if (activeProjects[0] === undefined) {
              return yield* new EventSinkActiveProjectGuardError({
                projectId: input.activeProjectGuard.projectId,
              });
            }
          }

          if (input.supervisorAttemptGuard !== undefined) {
            const taskEvent = input.events.find(
              (event) => event.type === "subagent.updated" && event.payload.origin === "app_owned",
            );
            const childThreadId =
              taskEvent?.type === "subagent.updated" ? taskEvent.payload.childThreadId : null;
            const childRunEvent = input.events.find(
              (event) => event.type === "run.created" && event.threadId === childThreadId,
            );
            if (
              taskEvent?.type !== "subagent.updated" ||
              childThreadId === null ||
              childRunEvent?.type !== "run.created"
            ) {
              return yield* new EventSinkSupervisorAttemptGuardError({
                attemptId: input.supervisorAttemptGuard.attemptId,
                detail: "the delegated task plan is incomplete",
              });
            }
            const now = DateTime.formatIso(yield* DateTime.now);
            const linked = yield* sql<{ readonly task_id: string }>`
              UPDATE supervisor_task_attempts
              SET
                status = 'delegated',
                node_id = ${taskEvent.payload.id},
                thread_id = ${childThreadId},
                run_id = ${childRunEvent.payload.id},
                updated_at = ${now}
              WHERE attempt_id = ${input.supervisorAttemptGuard.attemptId}
                AND status = 'reserved'
                AND node_id IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM supervisor_goals goal
                  WHERE goal.goal_id = supervisor_task_attempts.goal_id
                    AND goal.status NOT IN ('cancelled', 'completed')
                )
              RETURNING task_id
            `;
            if (linked[0] === undefined) {
              return yield* new EventSinkSupervisorAttemptGuardError({
                attemptId: input.supervisorAttemptGuard.attemptId,
                detail: "the reservation is no longer current or its goal was cancelled",
              });
            }
            yield* sql`
              UPDATE supervisor_goal_tasks
              SET status = 'running', updated_at = ${now}
              WHERE task_id = ${linked[0].task_id} AND status = 'reserved'
            `;
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          const sequence = storedEvents.at(-1)?.sequence;
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, committed: true as const, cancelledEffectIds };
        }),
      );
      yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
      if (input.effects.length > 0) {
        yield* effectOutbox.notifyAvailable;
      }
      if (result.committed) {
        yield* eventStore.publishCommitted(result.storedEvents);
        yield* PubSub.publishAll(liveEvents, result.storedEvents);
      }
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (input.supervisorAuthorityGuard !== undefined) {
            yield* requireSupervisorMutationAuthority(sql, input.supervisorAuthorityGuard);
          }
          if (input.runtimeAuthorityGuard !== undefined) {
            yield* requireRuntimeMutationAuthority(sql, input.runtimeAuthorityGuard);
          }
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: { readonly threadId?: ThreadId; readonly afterSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe first, then capture the database high-water mark. Events
          // committed between those operations are buffered by the subscription.
          const subscription = yield* PubSub.subscribe(liveEvents);
          const highWater = yield* eventStore.latestSequence();
          const afterSequence = input?.afterSequence ?? 0;
          const replay = catchUp({
            afterSequence,
            throughSequence: highWater,
            ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          });
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(
              (stored) => input?.threadId === undefined || stored.event.threadId === input.threadId,
            ),
          );
          return Stream.concat(replay, live);
        }),
      );

    return EventSinkV2.of({
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      failEffectWithEvents: (input) =>
        failEffectWithEvents(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeProviderEventsIfCurrent: (input) =>
        writeProviderEventsIfCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      confirmProviderThreadResume: (input) =>
        confirmProviderThreadResumeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: 0,
                cause,
              }),
          ),
        ),
      recordProviderThreadResumeIntent: (input) =>
        recordProviderThreadResumeIntentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: 0,
                cause,
              }),
          ),
        ),
      writeIfProviderMutationCurrent: (input) =>
        writeIfProviderMutationCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      reserveProviderMutation: (input) =>
        reserveProviderMutationEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: 0,
                cause,
              }),
          ),
        ),
      markProviderMutationPhase: (input) =>
        markProviderMutationPhaseEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: 0,
                cause,
              }),
          ),
        ),
      releaseProviderMutation: (input) =>
        releaseProviderMutationEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: 0,
                cause,
              }),
          ),
        ),
      activateProviderMutationOwner: activateProviderMutationOwnerEffect().pipe(
        Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })),
      ),
      heartbeatProviderMutationOwner: heartbeatProviderMutationOwnerEffect().pipe(
        Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })),
      ),
      deactivateProviderMutationOwner: deactivateProviderMutationOwnerEffect().pipe(
        Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })),
      ),
      listAbandonedProviderMutations: listAbandonedProviderMutationsEffect().pipe(
        Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })),
      ),
      clearAbandonedProviderMutation: (input) =>
        clearAbandonedProviderMutationEffect(input).pipe(
          Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })),
        ),
      reconcileAbandonedProviderMutation: (input) =>
        reconcileAbandonedProviderMutationEffect(input).pipe(
          Effect.mapError(
            (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
      quarantineProviderSession: (input) =>
        quarantineProviderSessionEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: 3,
                cause,
              }),
          ),
        ),
      writeIfRuntimeRequestsCurrent: (input) =>
        writeIfRuntimeRequestsCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Event sink layer for application compositions that already own the
 * persistence services. Keeping the outbox instance shared with the worker is
 * important because enqueue notifications are in-memory wakeups backed by the
 * durable SQL queue.
 */
export const layerFromStores = baseLayer;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStoreV2 | ProjectionStoreV2 | SqlClient.SqlClient
> = baseLayer.pipe(
  Layer.provide(
    Layer.mergeAll(commandReceiptStoreLayer, effectOutboxLayer, turnItemPositionStoreLayer),
  ),
);
