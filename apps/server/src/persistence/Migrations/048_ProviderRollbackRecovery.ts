import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_provider_mutation_owner (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      instance_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL CHECK(lease_epoch > 0),
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN owner_instance_id TEXT NOT NULL DEFAULT 'legacy-abandoned'
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1 CHECK(lease_epoch > 0)
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN checkpoint_id TEXT NOT NULL DEFAULT ''
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN scope_id TEXT NOT NULL DEFAULT ''
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN target_run_ordinal INTEGER CHECK(target_run_ordinal IS NULL OR target_run_ordinal >= 0)
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN target_resolution TEXT NOT NULL DEFAULT 'ambiguous' CHECK(target_resolution IN (
      'exact',
      'ambiguous'
    ))
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN phase TEXT NOT NULL DEFAULT 'filesystem_started' CHECK(phase IN (
      'reserved',
      'filesystem_started',
      'filesystem_restored',
      'provider_started',
      'provider_restored',
      'cleanup_started',
      'external_complete'
    ))
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_provider_rollback_reservations
    ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''
  `;
  yield* sql`
    UPDATE orchestration_v2_provider_rollback_reservations
    SET
      checkpoint_id = COALESCE((
        SELECT json_extract(effect.payload_json, '$.checkpointId')
        FROM orchestration_v2_effect_outbox AS effect
        WHERE effect.thread_id = orchestration_v2_provider_rollback_reservations.thread_id
          AND effect.effect_type = 'provider-thread.rollback'
          AND effect.status = 'running'
          AND json_extract(effect.payload_json, '$.providerThreadId') =
            orchestration_v2_provider_rollback_reservations.provider_thread_id
          AND effect.created_at <= orchestration_v2_provider_rollback_reservations.created_at
        ORDER BY effect.updated_at DESC, effect.effect_id DESC
        LIMIT 1
      ), ''),
      scope_id = COALESCE((
        SELECT json_extract(effect.payload_json, '$.scopeId')
        FROM orchestration_v2_effect_outbox AS effect
        WHERE effect.thread_id = orchestration_v2_provider_rollback_reservations.thread_id
          AND effect.effect_type = 'provider-thread.rollback'
          AND effect.status = 'running'
          AND json_extract(effect.payload_json, '$.providerThreadId') =
            orchestration_v2_provider_rollback_reservations.provider_thread_id
          AND effect.created_at <= orchestration_v2_provider_rollback_reservations.created_at
        ORDER BY effect.updated_at DESC, effect.effect_id DESC
        LIMIT 1
      ), ''),
      target_run_ordinal = (
        SELECT COALESCE(checkpoint.app_run_ordinal, 0)
        FROM orchestration_v2_projection_checkpoints AS checkpoint
        WHERE checkpoint.checkpoint_id = (
          SELECT json_extract(effect.payload_json, '$.checkpointId')
          FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = orchestration_v2_provider_rollback_reservations.thread_id
            AND effect.effect_type = 'provider-thread.rollback'
            AND effect.status = 'running'
            AND json_extract(effect.payload_json, '$.providerThreadId') =
              orchestration_v2_provider_rollback_reservations.provider_thread_id
            AND effect.created_at <= orchestration_v2_provider_rollback_reservations.created_at
          ORDER BY effect.updated_at DESC, effect.effect_id DESC
          LIMIT 1
        )
      ),
      updated_at = created_at
    WHERE owner_instance_id = 'legacy-abandoned'
  `;
  yield* sql`
    UPDATE orchestration_v2_provider_rollback_reservations
    SET target_resolution = CASE
      WHEN target_run_ordinal IS NULL THEN 'ambiguous'
      ELSE 'exact'
    END
    WHERE owner_instance_id = 'legacy-abandoned'
  `;
  yield* sql`
    CREATE TABLE orchestration_v2_provider_resume_intents (
      acquisition_order INTEGER NOT NULL,
      parent_provider_turn_id TEXT NOT NULL,
      child_provider_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL,
      native_item_id TEXT NOT NULL,
      native_turn_id_barrier TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      consumed_at TEXT,
      confirmed_native_turn_id TEXT,
      PRIMARY KEY (acquisition_order, child_provider_thread_id, native_item_id),
      FOREIGN KEY (acquisition_order)
        REFERENCES orchestration_v2_provider_authority_acquisitions(acquisition_order)
        ON DELETE CASCADE
    )
  `;
});
