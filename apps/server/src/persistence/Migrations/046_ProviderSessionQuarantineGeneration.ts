import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_provider_session_generations (
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      quarantined_provider_session_id TEXT,
      quarantined_at TEXT,
      reason TEXT,
      PRIMARY KEY(thread_id, provider_instance_id)
    )
  `;
});
