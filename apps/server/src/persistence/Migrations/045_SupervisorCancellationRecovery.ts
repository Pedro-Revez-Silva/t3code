import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX idx_supervisor_attempts_goal_node
    ON supervisor_task_attempts(goal_id, node_id)
  `;
});
