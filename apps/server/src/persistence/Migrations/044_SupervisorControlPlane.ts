import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE supervisor_designation (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      thread_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE supervisor_project_execution_profiles (
      project_id TEXT PRIMARY KEY,
      model_selection_json TEXT,
      runtime_mode TEXT CHECK (runtime_mode IS NULL OR runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      interaction_mode TEXT CHECK (interaction_mode IS NULL OR interaction_mode IN ('plan', 'default')),
      max_parallel_tasks INTEGER NOT NULL CHECK (max_parallel_tasks BETWEEN 1 AND 64),
      retry_max_attempts INTEGER NOT NULL CHECK (retry_max_attempts BETWEEN 1 AND 20),
      retry_backoff_ms INTEGER NOT NULL CHECK (retry_backoff_ms BETWEEN 0 AND 86400000),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE supervisor_goals (
      goal_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cancelled_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE supervisor_goal_tasks (
      task_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('implementation', 'research', 'review', 'design', 'test', 'general')),
      priority INTEGER NOT NULL CHECK (priority BETWEEN -1000 AND 1000),
      status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'running', 'completed', 'failed', 'cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (goal_id) REFERENCES supervisor_goals(goal_id) ON DELETE CASCADE,
      UNIQUE (goal_id, task_key),
      UNIQUE (goal_id, task_id)
    )
  `;
  yield* sql`
    CREATE TABLE supervisor_goal_task_dependencies (
      goal_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id),
      FOREIGN KEY (goal_id, task_id) REFERENCES supervisor_goal_tasks(goal_id, task_id) ON DELETE CASCADE,
      FOREIGN KEY (goal_id, depends_on_task_id) REFERENCES supervisor_goal_tasks(goal_id, task_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE supervisor_task_attempts (
      attempt_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      client_request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'delegated', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      interaction_mode TEXT NOT NULL CHECK (interaction_mode IN ('plan', 'default')),
      node_id TEXT UNIQUE,
      thread_id TEXT,
      run_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (goal_id, task_id) REFERENCES supervisor_goal_tasks(goal_id, task_id) ON DELETE CASCADE,
      UNIQUE (task_id, attempt_number)
    )
  `;

  yield* sql`CREATE INDEX idx_supervisor_goals_status_updated ON supervisor_goals(status, updated_at DESC)`;
  yield* sql`CREATE INDEX idx_supervisor_goal_tasks_ready ON supervisor_goal_tasks(goal_id, status, priority DESC)`;
  yield* sql`CREATE INDEX idx_supervisor_goal_tasks_project_status ON supervisor_goal_tasks(project_id, status)`;
  yield* sql`CREATE INDEX idx_supervisor_dependencies_goal ON supervisor_goal_task_dependencies(goal_id, task_id)`;
  yield* sql`CREATE INDEX idx_supervisor_attempts_task_status ON supervisor_task_attempts(task_id, status, attempt_number DESC)`;
  yield* sql`CREATE INDEX idx_supervisor_attempts_project_active ON supervisor_task_attempts(status, task_id)`;
});
