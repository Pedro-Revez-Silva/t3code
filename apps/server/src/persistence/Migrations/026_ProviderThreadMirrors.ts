import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_thread_mirrors (
      thread_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      external_thread_id TEXT,
      last_seen_at TEXT NOT NULL,
      last_imported_at TEXT,
      last_exported_at TEXT,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT,
      metadata_json TEXT,
      PRIMARY KEY (thread_id, provider_name)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_thread_mirrors_thread
    ON provider_thread_mirrors(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_thread_mirrors_provider
    ON provider_thread_mirrors(provider_name)
  `;
});
