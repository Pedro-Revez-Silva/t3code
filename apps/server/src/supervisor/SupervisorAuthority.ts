import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface RuntimeMutationAuthority {
  readonly threadId: ThreadId;
  readonly runtimeProviderSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeGeneration?: number;
}

export type SupervisorMutationAuthority = RuntimeMutationAuthority;

export class SupervisorAuthorityError extends Schema.TaggedErrorClass<SupervisorAuthorityError>()(
  "SupervisorAuthorityError",
  {
    threadId: ThreadId,
    runtimeProviderSessionId: ProviderSessionId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return "Global supervisor authority changed before the mutation was committed.";
  }
}

export class RuntimeMutationAuthorityError extends Schema.TaggedErrorClass<RuntimeMutationAuthorityError>()(
  "RuntimeMutationAuthorityError",
  {
    threadId: ThreadId,
    runtimeProviderSessionId: ProviderSessionId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return "MCP runtime ownership changed before the mutation was committed.";
  }
}

export const requireRuntimeMutationAuthority = Effect.fn(
  "SupervisorAuthority.requireRuntimeMutationAuthority",
)(function* (sql: SqlClient.SqlClient, authority: RuntimeMutationAuthority) {
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT run.thread_id
    FROM orchestration_v2_projection_runs AS run
    JOIN orchestration_v2_projection_provider_threads AS provider_thread
      ON provider_thread.provider_thread_id = run.provider_thread_id
    WHERE run.thread_id = ${authority.threadId}
      AND run.run_id = (
        SELECT active_run.run_id
        FROM orchestration_v2_projection_runs AS active_run
        WHERE active_run.thread_id = ${authority.threadId}
          AND active_run.status IN ('preparing', 'starting', 'running', 'waiting')
        ORDER BY active_run.ordinal DESC
        LIMIT 1
      )
      AND run.provider_instance_id = ${authority.providerInstanceId}
      AND provider_thread.thread_id = ${authority.threadId}
      AND provider_thread.provider_session_id = ${authority.runtimeProviderSessionId}
      AND COALESCE((
        SELECT generation
        FROM orchestration_v2_provider_session_generations AS generation
        WHERE generation.thread_id = ${authority.threadId}
          AND generation.provider_instance_id = ${authority.providerInstanceId}
      ), 0) = ${authority.runtimeGeneration ?? 0}
    LIMIT 1
  `;
  if (rows[0] === undefined) {
    return yield* new RuntimeMutationAuthorityError(authority);
  }
});

export const requireSupervisorMutationAuthority = Effect.fn(
  "SupervisorAuthority.requireSupervisorMutationAuthority",
)(function* (sql: SqlClient.SqlClient, authority: SupervisorMutationAuthority) {
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT designation.thread_id
    FROM supervisor_designation AS designation
    JOIN orchestration_v2_projection_runs AS run
      ON run.thread_id = designation.thread_id
    JOIN orchestration_v2_projection_provider_threads AS provider_thread
      ON provider_thread.provider_thread_id = run.provider_thread_id
    WHERE designation.singleton_id = 1
      AND designation.thread_id = ${authority.threadId}
      AND run.run_id = (
        SELECT active_run.run_id
        FROM orchestration_v2_projection_runs AS active_run
        WHERE active_run.thread_id = designation.thread_id
          AND active_run.status IN ('preparing', 'starting', 'running', 'waiting')
        ORDER BY active_run.ordinal DESC
        LIMIT 1
      )
      AND run.provider_instance_id = ${authority.providerInstanceId}
      AND provider_thread.thread_id = designation.thread_id
      AND provider_thread.provider_session_id = ${authority.runtimeProviderSessionId}
      AND COALESCE((
        SELECT generation
        FROM orchestration_v2_provider_session_generations AS generation
        WHERE generation.thread_id = ${authority.threadId}
          AND generation.provider_instance_id = ${authority.providerInstanceId}
      ), 0) = ${authority.runtimeGeneration ?? 0}
    LIMIT 1
  `;
  if (rows[0] === undefined) {
    return yield* new SupervisorAuthorityError(authority);
  }
});

export class RuntimeMutationAuthorityGuard extends Context.Service<
  RuntimeMutationAuthorityGuard,
  {
    readonly require: (
      authority: RuntimeMutationAuthority,
    ) => Effect.Effect<void, RuntimeMutationAuthorityError | SqlError>;
  }
>()("t3/supervisor/SupervisorAuthority/RuntimeMutationAuthorityGuard") {}

export const runtimeMutationAuthorityGuardLayer: Layer.Layer<
  RuntimeMutationAuthorityGuard,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  RuntimeMutationAuthorityGuard,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return RuntimeMutationAuthorityGuard.of({
      require: (authority) => requireRuntimeMutationAuthority(sql, authority),
    });
  }),
);
