import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ProviderSessionGenerationKey {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface ProviderSessionGenerationState {
  readonly generation: number;
  readonly quarantinedProviderSessionId: ProviderSessionId | null;
}

export class ProviderSessionGenerationStore extends Context.Service<
  ProviderSessionGenerationStore,
  {
    readonly current: (input: ProviderSessionGenerationKey) => Effect.Effect<number>;
    readonly state: (
      input: ProviderSessionGenerationKey,
    ) => Effect.Effect<ProviderSessionGenerationState>;
    readonly quarantine: (
      input: ProviderSessionGenerationKey & {
        readonly providerSessionId: ProviderSessionId;
        readonly reason: string;
      },
    ) => Effect.Effect<number>;
  }
>()("t3/orchestration-v2/ProviderSessionGenerationStore") {}

export const layer: Layer.Layer<ProviderSessionGenerationStore, never, SqlClient.SqlClient> =
  Layer.effect(
    ProviderSessionGenerationStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const state = (input: ProviderSessionGenerationKey) =>
        sql<{
          readonly generation: number;
          readonly quarantined_provider_session_id: string | null;
        }>`
          SELECT generation, quarantined_provider_session_id
          FROM orchestration_v2_provider_session_generations
          WHERE thread_id = ${input.threadId}
            AND provider_instance_id = ${input.providerInstanceId}
        `.pipe(
          Effect.map(
            (rows): ProviderSessionGenerationState => ({
              generation: rows[0]?.generation ?? 0,
              quarantinedProviderSessionId:
                rows[0]?.quarantined_provider_session_id == null
                  ? null
                  : ProviderSessionId.make(rows[0].quarantined_provider_session_id),
            }),
          ),
          Effect.orDie,
        );
      return ProviderSessionGenerationStore.of({
        current: (input) => state(input).pipe(Effect.map((current) => current.generation)),
        state,
        quarantine: (input) =>
          Effect.gen(function* () {
            const quarantinedAt = DateTime.formatIso(yield* DateTime.now);
            const rows = yield* sql<{ readonly generation: number }>`
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
            return rows[0]!.generation;
          }).pipe(Effect.orDie),
      });
    }),
  );
