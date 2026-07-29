import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_SupervisorControlPlane", (it) => {
  it.effect("creates isolated graph tables with cascading foreign keys", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'supervisor_%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "supervisor_designation",
          "supervisor_goal_task_dependencies",
          "supervisor_goal_tasks",
          "supervisor_goals",
          "supervisor_project_execution_profiles",
          "supervisor_task_attempts",
        ],
      );

      const foreignKeys = yield* sql<{ readonly on_delete: string }>`
        PRAGMA foreign_key_list(supervisor_goal_task_dependencies)
      `;
      assert.equal(foreignKeys.length, 4);
      assert.ok(foreignKeys.every((key) => key.on_delete === "CASCADE"));

      const designationColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(supervisor_designation)`;
      assert.equal(designationColumns.find((column) => column.name === "thread_id")?.notnull, 0);
    }),
  );
});
