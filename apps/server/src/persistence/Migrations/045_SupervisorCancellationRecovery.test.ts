import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_SupervisorCancellationRecovery", (it) => {
  it.effect("indexes cancelled-goal attempt reconciliation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'supervisor_task_attempts'
      `;
      assert.isTrue(indexes.some((index) => index.name === "idx_supervisor_attempts_goal_node"));
    }),
  );
});
