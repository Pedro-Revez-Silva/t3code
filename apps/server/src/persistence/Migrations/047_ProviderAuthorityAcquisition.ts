import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_provider_authority_acquisitions (
      acquisition_order INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      run_ordinal INTEGER NOT NULL,
      attempt_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 0),
      acquired_at TEXT NOT NULL,
      UNIQUE(thread_id, provider_instance_id, attempt_id)
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_provider_authority_latest_idx
    ON orchestration_v2_provider_authority_acquisitions(
      thread_id,
      provider_instance_id,
      acquisition_order DESC
    )
  `;
  yield* sql`
    CREATE TABLE orchestration_v2_provider_resume_authorizations (
      acquisition_order INTEGER NOT NULL,
      child_provider_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL,
      PRIMARY KEY (acquisition_order, child_provider_thread_id),
      FOREIGN KEY (acquisition_order)
        REFERENCES orchestration_v2_provider_authority_acquisitions(acquisition_order)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_provider_resume_authorizations_child_idx
    ON orchestration_v2_provider_resume_authorizations(child_provider_thread_id)
  `;
  yield* sql`
    CREATE TABLE orchestration_v2_provider_rollback_reservations (
      reservation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 0),
      created_at TEXT NOT NULL,
      UNIQUE(thread_id, provider_instance_id)
    )
  `;
});
