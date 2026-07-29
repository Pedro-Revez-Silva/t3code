import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_036_OrchestrationV2", (it) => {
  it.effect("keeps released and private migration ids contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 48 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("installs the orchestration v2 and subagent schemas", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id IN (33, 34, 35, 36)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 33,
          name: "ProjectionThreadsSettled",
        },
        {
          migration_id: 34,
          name: "ProjectionThreadsSnoozed",
        },
        {
          migration_id: 35,
          name: "OrchestrationV2",
        },
        {
          migration_id: 36,
          name: "OrchestrationV2Subagents",
        },
      ]);

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_events)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;

      assert.ok(eventColumns.some((column) => column.name === "event_id"));
      assert.ok(subagentColumns.some((column) => column.name === "child_thread_id"));
    }),
  );

  it.effect("backfills provider-session thread bindings in migration 038", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_sessions (
          provider_session_id,
          thread_id,
          provider,
          driver,
          provider_instance_id,
          status,
          model,
          updated_at,
          payload_json
        ) VALUES (
          'provider-session:shared',
          'thread:existing',
          'codex',
          'codex',
          'codex',
          'ready',
          'gpt-5.4',
          '2026-01-01T00:00:00.000Z',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const bindings = yield* sql<{
        readonly provider_session_id: string;
        readonly thread_id: string;
      }>`
        SELECT provider_session_id, thread_id
        FROM orchestration_v2_projection_provider_session_bindings
      `;
      assert.deepStrictEqual(bindings, [
        {
          provider_session_id: "provider-session:shared",
          thread_id: "thread:existing",
        },
      ]);
    }),
  );
});

it.effect("upgrades a database already at released main migration 034", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* runMigrations({ toMigrationInclusive: 34 });
    const snoozeColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_threads)
    `;
    assert.ok(snoozeColumns.some((column) => column.name === "snoozed_until"));
    assert.ok(snoozeColumns.some((column) => column.name === "snoozed_at"));

    yield* runMigrations({ toMigrationInclusive: 43 });

    const migrations = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      WHERE migration_id BETWEEN 34 AND 43
      ORDER BY migration_id
    `;
    assert.deepStrictEqual(
      migrations.map(({ migration_id, name }) => [migration_id, name]),
      [
        [34, "ProjectionThreadsSnoozed"],
        [35, "OrchestrationV2"],
        [36, "OrchestrationV2Subagents"],
        [37, "OrchestrationV2Foundation"],
        [38, "OrchestrationV2ProviderSessionBindings"],
        [39, "OrchestrationV2ThreadLaunchWorkflows"],
        [40, "ApplicationEventSource"],
        [41, "OrchestrationV2EffectCancellation"],
        [42, "ScheduledTasks"],
        [43, "LegacyV1ImportState"],
      ],
    );

    const v2Tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
    `;
    assert.strictEqual(v2Tables.length, 1);

    const legacyImportTables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_legacy_imports'
    `;
    assert.strictEqual(legacyImportTables.length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("installs durable provider authority and rollback reservation tables", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 48 });
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'orchestration_v2_provider_authority_acquisitions',
          'orchestration_v2_provider_mutation_owner',
          'orchestration_v2_provider_resume_authorizations',
          'orchestration_v2_provider_resume_intents',
          'orchestration_v2_provider_rollback_reservations'
        )
      ORDER BY name
    `;
    assert.deepStrictEqual(
      tables.map(({ name }) => name),
      [
        "orchestration_v2_provider_authority_acquisitions",
        "orchestration_v2_provider_mutation_owner",
        "orchestration_v2_provider_resume_authorizations",
        "orchestration_v2_provider_resume_intents",
        "orchestration_v2_provider_rollback_reservations",
      ],
    );
    const resumeIntentColumns = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM pragma_table_info('orchestration_v2_provider_resume_intents')
      WHERE name IN ('native_turn_id_barrier', 'confirmed_native_turn_id')
      ORDER BY name
    `;
    assert.deepStrictEqual(
      resumeIntentColumns.map(({ name }) => name),
      ["confirmed_native_turn_id", "native_turn_id_barrier"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("upgrades legacy rollback reservations as conservatively abandoned", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 47 });
    yield* sql`
      INSERT INTO orchestration_v2_provider_rollback_reservations (
        reservation_id,
        thread_id,
        provider_instance_id,
        run_id,
        attempt_id,
        provider_thread_id,
        provider_session_id,
        generation,
        created_at
      ) VALUES (
        'reservation:legacy-recovery',
        'thread:legacy-recovery',
        'codex',
        'run:legacy-recovery',
        'attempt:legacy-recovery',
        'provider-thread:legacy-recovery',
        'provider-session:legacy-recovery',
        0,
        '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* runMigrations({ toMigrationInclusive: 48 });
    const rows = yield* sql<{
      readonly owner_instance_id: string;
      readonly phase: string;
      readonly target_run_ordinal: number | null;
      readonly target_resolution: string;
      readonly updated_at: string;
    }>`
      SELECT owner_instance_id, phase, target_run_ordinal, target_resolution, updated_at
      FROM orchestration_v2_provider_rollback_reservations
      WHERE reservation_id = 'reservation:legacy-recovery'
    `;
    assert.deepStrictEqual(rows, [
      {
        owner_instance_id: "legacy-abandoned",
        phase: "filesystem_started",
        target_run_ordinal: null,
        target_resolution: "ambiguous",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("recovers the exact target when a legacy rollback skips multiple runs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 47 });
    for (const ordinal of [3, 4, 5]) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id,
          thread_id,
          ordinal,
          provider,
          provider_instance_id,
          provider_thread_id,
          status,
          requested_at,
          completed_at,
          payload_json
        ) VALUES (
          ${`run:legacy-current-${ordinal}`},
          'thread:legacy-skip-many',
          ${ordinal},
          'codex',
          'codex',
          'provider-thread:legacy-skip-many',
          'completed',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '{}'
        )
      `;
    }
    yield* sql`
      INSERT INTO orchestration_v2_projection_checkpoints (
        checkpoint_id,
        thread_id,
        scope_id,
        run_id,
        node_id,
        parent_checkpoint_id,
        ordinal_within_scope,
        app_run_ordinal,
        status,
        captured_at,
        payload_json
      ) VALUES (
        'checkpoint:legacy-skip-many',
        'thread:legacy-skip-many',
        'scope:legacy-skip-many',
        'run:legacy-target-2',
        'node:legacy-target-2',
        NULL,
        2,
        2,
        'ready',
        '2026-01-01T00:00:00.000Z',
        '{}'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id,
        command_id,
        thread_id,
        effect_type,
        payload_json,
        status,
        attempt_count,
        available_at,
        created_at,
        updated_at
      ) VALUES (
        'effect:legacy-skip-many',
        'command:legacy-skip-many',
        'thread:legacy-skip-many',
        'provider-thread.rollback',
        '{"type":"provider-thread.rollback","providerThreadId":"provider-thread:legacy-skip-many","checkpointId":"checkpoint:legacy-skip-many","scopeId":"scope:legacy-skip-many"}',
        'running',
        1,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:01.000Z'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_provider_rollback_reservations (
        reservation_id,
        thread_id,
        provider_instance_id,
        run_id,
        attempt_id,
        provider_thread_id,
        provider_session_id,
        generation,
        created_at
      ) VALUES (
        'reservation:legacy-skip-many',
        'thread:legacy-skip-many',
        'codex',
        'run:legacy-current-5',
        'attempt:legacy-current-5',
        'provider-thread:legacy-skip-many',
        'provider-session:legacy-skip-many',
        0,
        '2026-01-01T00:00:02.000Z'
      )
    `;
    yield* runMigrations({ toMigrationInclusive: 48 });
    const rows = yield* sql<{
      readonly checkpoint_id: string;
      readonly scope_id: string;
      readonly target_run_ordinal: number | null;
      readonly target_resolution: string;
    }>`
      SELECT checkpoint_id, scope_id, target_run_ordinal, target_resolution
      FROM orchestration_v2_provider_rollback_reservations
      WHERE reservation_id = 'reservation:legacy-skip-many'
    `;
    assert.deepStrictEqual(rows, [
      {
        checkpoint_id: "checkpoint:legacy-skip-many",
        scope_id: "scope:legacy-skip-many",
        target_run_ordinal: 2,
        target_resolution: "exact",
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
