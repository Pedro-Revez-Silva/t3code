import {
  ModelSelection,
  NodeId,
  type ProjectId,
  type ProjectExecutionProfile,
  type ProjectExecutionProfileListResult,
  type ProjectExecutionProfileUpdateInput,
  type ProviderInteractionMode,
  type RuntimeMode,
  RunId,
  SupervisorControlPlaneError,
  type SupervisorConfigurationReadResult,
  type SupervisorConfigurationUpdateInput,
  SupervisorGoalId,
  SupervisorGoalNotFoundError,
  type SupervisorGoal,
  type SupervisorGoalCancelInput,
  type SupervisorGoalListInput,
  type SupervisorGoalListResult,
  type SupervisorGoalReadResult,
  SupervisorGoalTaskId,
  SupervisorGoalTaskNotReadyError,
  type SupervisorGoalTaskStatus,
  SupervisorGoalValidationError,
  SupervisorRevisionConflictError,
  type SupervisorTaskAttempt,
  SupervisorTaskAttemptId,
  type SupervisorTaskAttemptStatus,
  type SupervisorGoalUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import {
  requireSupervisorMutationAuthority,
  type SupervisorMutationAuthority,
} from "./SupervisorAuthority.ts";

export type ControlPlaneFailure =
  | SupervisorControlPlaneError
  | SupervisorRevisionConflictError
  | SupervisorGoalValidationError
  | SupervisorGoalNotFoundError
  | SupervisorGoalTaskNotReadyError;

export interface PreparedSupervisorAttempt {
  readonly goal: SupervisorGoal;
  readonly task: SupervisorGoal["tasks"][number];
  readonly attempt: SupervisorTaskAttempt;
}

export class SupervisorControlPlaneService extends Context.Service<
  SupervisorControlPlaneService,
  {
    readonly readConfiguration: () => Effect.Effect<
      SupervisorConfigurationReadResult,
      ControlPlaneFailure
    >;
    readonly updateConfiguration: (
      input: SupervisorConfigurationUpdateInput,
    ) => Effect.Effect<SupervisorConfigurationReadResult, ControlPlaneFailure>;
    readonly subscribeConfiguration: () => Stream.Stream<
      SupervisorConfigurationReadResult,
      ControlPlaneFailure
    >;
    readonly isDesignatedSupervisor: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, ControlPlaneFailure>;
    readonly listProfiles: () => Effect.Effect<
      ProjectExecutionProfileListResult,
      ControlPlaneFailure
    >;
    readonly getProfile: (
      projectId: string,
    ) => Effect.Effect<ProjectExecutionProfile | null, ControlPlaneFailure>;
    readonly updateProfile: (
      input: ProjectExecutionProfileUpdateInput,
    ) => Effect.Effect<{ readonly profile: ProjectExecutionProfile }, ControlPlaneFailure>;
    readonly subscribeProfiles: () => Stream.Stream<
      ProjectExecutionProfileListResult,
      ControlPlaneFailure
    >;
    readonly listGoals: (
      input?: SupervisorGoalListInput,
    ) => Effect.Effect<SupervisorGoalListResult, ControlPlaneFailure>;
    readonly readGoal: (
      goalId: SupervisorGoalId,
    ) => Effect.Effect<SupervisorGoalReadResult, ControlPlaneFailure>;
    readonly updateGoal: (
      input: SupervisorGoalUpdateInput,
      authority?: SupervisorMutationAuthority,
    ) => Effect.Effect<SupervisorGoalReadResult, ControlPlaneFailure>;
    readonly subscribeGoals: (
      input?: SupervisorGoalListInput,
    ) => Stream.Stream<SupervisorGoalListResult, ControlPlaneFailure>;
    readonly listCancelledGoalsWithLinkedAttempts: () => Effect.Effect<
      ReadonlyArray<SupervisorGoal>,
      ControlPlaneFailure
    >;
    readonly cancelGoal: (
      input: SupervisorGoalCancelInput,
      authority?: SupervisorMutationAuthority,
    ) => Effect.Effect<SupervisorGoalReadResult, ControlPlaneFailure>;
    readonly prepareAttempt: (
      input: {
        readonly goalId: SupervisorGoalId;
        readonly taskKey: string;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
      authority?: SupervisorMutationAuthority,
    ) => Effect.Effect<PreparedSupervisorAttempt, ControlPlaneFailure>;
    readonly linkAttempt: (
      input: {
        readonly attemptId: SupervisorTaskAttemptId;
        readonly nodeId: NodeId;
        readonly threadId: ThreadId;
        readonly runId: RunId | null;
      },
      authority?: SupervisorMutationAuthority,
    ) => Effect.Effect<SupervisorTaskAttempt, ControlPlaneFailure>;
    readonly updateAttemptStatus: (
      input: {
        readonly attemptId: SupervisorTaskAttemptId;
        readonly status: SupervisorTaskAttemptStatus;
        readonly error?: string | null;
      },
      authority?: SupervisorMutationAuthority,
    ) => Effect.Effect<void, ControlPlaneFailure>;
    readonly reconcileAttemptByNodeId: (
      input: {
        readonly nodeId: NodeId;
        readonly status: Extract<
          SupervisorTaskAttemptStatus,
          "completed" | "failed" | "cancelled" | "interrupted"
        >;
        readonly error?: string | null;
      },
      authority?: SupervisorMutationAuthority,
    ) => Effect.Effect<void, ControlPlaneFailure>;
  }
>()("t3/supervisor/SupervisorControlPlaneService") {}

interface DesignationRow {
  readonly thread_id: string | null;
  readonly revision: number;
  readonly updated_at: string;
}
interface ProfileRow {
  readonly project_id: string;
  readonly model_selection_json: string | null;
  readonly runtime_mode: RuntimeMode | null;
  readonly interaction_mode: ProviderInteractionMode | null;
  readonly max_parallel_tasks: number;
  readonly retry_max_attempts: number;
  readonly retry_backoff_ms: number;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}
interface GoalRow {
  readonly goal_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: SupervisorGoal["status"];
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly cancelled_at: string | null;
}
interface TaskRow {
  readonly task_id: string;
  readonly goal_id: string;
  readonly project_id: string;
  readonly task_key: string;
  readonly title: string;
  readonly prompt: string;
  readonly role: SupervisorGoal["tasks"][number]["role"];
  readonly priority: number;
  readonly status: SupervisorGoalTaskStatus;
  readonly created_at: string;
  readonly updated_at: string;
}
interface DependencyRow {
  readonly task_id: string;
  readonly depends_on_task_id: string;
}
interface AttemptRow {
  readonly attempt_id: string;
  readonly goal_id: string;
  readonly task_id: string;
  readonly attempt_number: number;
  readonly client_request_id: string;
  readonly status: SupervisorTaskAttemptStatus;
  readonly model_selection_json: string;
  readonly runtime_mode: RuntimeMode;
  readonly interaction_mode: ProviderInteractionMode;
  readonly node_id: string | null;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const controlError = (message: string, cause?: unknown) =>
  new SupervisorControlPlaneError({ message, ...(cause === undefined ? {} : { cause }) });
const decodeModelJson = Schema.decodeUnknownSync(Schema.fromJsonString(ModelSelection));
const encodeModelJson = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const isControlError = Schema.is(SupervisorControlPlaneError);
const isRevisionConflict = Schema.is(SupervisorRevisionConflictError);
const isGoalValidation = Schema.is(SupervisorGoalValidationError);
const isGoalNotFound = Schema.is(SupervisorGoalNotFoundError);
const isTaskNotReady = Schema.is(SupervisorGoalTaskNotReadyError);
const parseModel = (json: string): ModelSelection => decodeModelJson(json);
const decodeProfile = (row: ProfileRow): ProjectExecutionProfile => ({
  projectId: row.project_id as ProjectExecutionProfile["projectId"],
  modelSelection: row.model_selection_json === null ? null : parseModel(row.model_selection_json),
  runtimeMode: row.runtime_mode,
  interactionMode: row.interaction_mode,
  maxParallelTasks: row.max_parallel_tasks,
  retry: { maxAttempts: row.retry_max_attempts, backoffMs: row.retry_backoff_ms },
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const decodeAttempt = (row: AttemptRow): SupervisorTaskAttempt => ({
  id: SupervisorTaskAttemptId.make(row.attempt_id),
  goalId: SupervisorGoalId.make(row.goal_id),
  taskId: SupervisorGoalTaskId.make(row.task_id),
  attemptNumber: row.attempt_number,
  clientRequestId: row.client_request_id,
  status: row.status,
  modelSelection: parseModel(row.model_selection_json),
  runtimeMode: row.runtime_mode,
  interactionMode: row.interaction_mode,
  nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
  threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
  runId: row.run_id === null ? null : RunId.make(row.run_id),
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function validateGoalDag(tasks: SupervisorGoalUpdateInput["tasks"]): void {
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.taskKey)) {
      throw new SupervisorGoalValidationError({
        message: `Duplicate goal task key: ${task.taskKey}.`,
        taskKey: task.taskKey,
      });
    }
    keys.add(task.taskKey);
  }
  for (const task of tasks) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (!keys.has(dependency)) {
        throw new SupervisorGoalValidationError({
          message: `Goal task ${task.taskKey} depends on missing task ${dependency}.`,
          taskKey: task.taskKey,
        });
      }
      if (dependency === task.taskKey || dependencies.has(dependency)) {
        throw new SupervisorGoalValidationError({
          message: `Goal task ${task.taskKey} has an invalid duplicate or self dependency.`,
          taskKey: task.taskKey,
        });
      }
      dependencies.add(dependency);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(tasks.map((task) => [task.taskKey, task]));
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      throw new SupervisorGoalValidationError({
        message: `Goal task graph contains a cycle through ${key}.`,
        taskKey: key,
      });
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of tasks) visit(task.taskKey);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const configurationChanges = yield* PubSub.sliding<void>(1);
  const profileChanges = yield* PubSub.sliding<void>(1);
  const goalChanges = yield* PubSub.sliding<void>(1);

  if (config.experimentalGlobalSupervisorThreadId !== undefined) {
    const now = yield* nowIso;
    yield* sql`
        INSERT INTO supervisor_designation(singleton_id, thread_id, revision, created_at, updated_at)
        VALUES (1, ${config.experimentalGlobalSupervisorThreadId}, 1, ${now}, ${now})
        ON CONFLICT(singleton_id) DO NOTHING
      `;
  }

  const mapFailure = <A, E>(effect: Effect.Effect<A, E>, message: string) =>
    effect.pipe(Effect.mapError((cause) => controlError(message, cause)));

  const readConfiguration = (): Effect.Effect<
    SupervisorConfigurationReadResult,
    ControlPlaneFailure
  > =>
    mapFailure(
      sql<DesignationRow>`SELECT thread_id, revision, updated_at FROM supervisor_designation WHERE singleton_id = 1`,
      "Could not read supervisor configuration.",
    ).pipe(
      Effect.map((rows) => ({
        configuration:
          rows[0] === undefined
            ? { threadId: null, revision: 0, updatedAt: null }
            : {
                threadId: rows[0].thread_id === null ? null : ThreadId.make(rows[0].thread_id),
                revision: rows[0].revision,
                updatedAt: rows[0].updated_at,
              },
      })),
    );

  const listProfiles = (): Effect.Effect<ProjectExecutionProfileListResult, ControlPlaneFailure> =>
    mapFailure(
      sql<ProfileRow>`SELECT * FROM supervisor_project_execution_profiles ORDER BY project_id`,
      "Could not list supervisor execution profiles.",
    ).pipe(Effect.map((rows) => ({ profiles: rows.map(decodeProfile) })));

  const getProfile = (projectId: string) =>
    mapFailure(
      sql<ProfileRow>`SELECT * FROM supervisor_project_execution_profiles WHERE project_id = ${projectId}`,
      "Could not read supervisor execution profile.",
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? null : decodeProfile(rows[0]))));

  const validateDesignationEligibility = Effect.fn(
    "SupervisorControlPlaneService.validateDesignationEligibility",
  )(function* (threadId: ThreadId | null) {
    if (threadId === null) return;
    const rows = yield* sql<{
      readonly archived_at: string | null;
      readonly deleted_at: string | null;
      readonly parent_thread_id: string | null;
      readonly active_project_id: string | null;
    }>`
      SELECT
        thread.archived_at,
        thread.deleted_at,
        json_extract(thread.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        project.project_id AS active_project_id
      FROM orchestration_v2_projection_threads thread
      LEFT JOIN projection_projects project
        ON project.project_id = thread.project_id
        AND project.deleted_at IS NULL
        AND TRIM(project.workspace_root) <> ''
      WHERE thread.thread_id = ${threadId}
      LIMIT 1
    `;
    const existing = rows[0];
    // A missing row is a client-side draft whose durable thread is created on first send.
    if (existing === undefined) return;
    if (
      existing.archived_at !== null ||
      existing.deleted_at !== null ||
      existing.parent_thread_id !== null ||
      existing.active_project_id === null
    ) {
      return yield* controlError(
        `Thread ${threadId} is not an active top-level thread and cannot be designated as supervisor.`,
      );
    }
  });

  const validateTaskProjects = Effect.fn("SupervisorControlPlaneService.validateTaskProjects")(
    function* (tasks: SupervisorGoalUpdateInput["tasks"]) {
      const checked = new Set<string>();
      for (const task of tasks) {
        if (checked.has(task.projectId)) continue;
        checked.add(task.projectId);
        const rows = yield* sql<{ readonly project_id: string }>`
        SELECT project_id
        FROM projection_projects
        WHERE project_id = ${task.projectId}
          AND deleted_at IS NULL
          AND TRIM(workspace_root) <> ''
        LIMIT 1
      `;
        if (rows[0] === undefined) {
          return yield* new SupervisorGoalValidationError({
            message: `Goal task ${task.taskKey} references a missing, deleted, or inactive project ${task.projectId}.`,
            taskKey: task.taskKey,
          });
        }
      }
    },
  );

  const validateProfileProject = Effect.fn("SupervisorControlPlaneService.validateProfileProject")(
    function* (projectId: ProjectId) {
      const rows = yield* sql<{ readonly project_id: string }>`
      SELECT project_id
      FROM projection_projects
      WHERE project_id = ${projectId}
        AND deleted_at IS NULL
        AND TRIM(workspace_root) <> ''
      LIMIT 1
    `;
      if (rows[0] === undefined) {
        return yield* controlError(
          `Execution profile project ${projectId} is missing, deleted, or inactive.`,
        );
      }
    },
  );

  const loadGoal = Effect.fn("SupervisorControlPlaneService.loadGoal")(function* (
    goalId: SupervisorGoalId,
  ) {
    const goals = yield* sql<GoalRow>`SELECT * FROM supervisor_goals WHERE goal_id = ${goalId}`;
    const goal = goals[0];
    if (goal === undefined) {
      return yield* new SupervisorGoalNotFoundError({
        goalId,
        message: `Supervisor goal ${goalId} was not found.`,
      });
    }
    const tasks = yield* sql<TaskRow>`
        SELECT * FROM supervisor_goal_tasks WHERE goal_id = ${goalId}
        ORDER BY priority DESC, task_key
      `;
    const dependencies = yield* sql<DependencyRow>`
        SELECT d.task_id, d.depends_on_task_id
        FROM supervisor_goal_task_dependencies d WHERE d.goal_id = ${goalId}
      `;
    const attempts = yield* sql<AttemptRow>`
        SELECT * FROM supervisor_task_attempts WHERE goal_id = ${goalId}
        ORDER BY task_id, attempt_number
      `;
    const keyById = new Map(tasks.map((task) => [task.task_id, task.task_key]));
    return {
      id: SupervisorGoalId.make(goal.goal_id),
      title: goal.title,
      prompt: goal.prompt,
      status: goal.status,
      revision: goal.revision,
      tasks: tasks.map((task) => ({
        id: SupervisorGoalTaskId.make(task.task_id),
        goalId: SupervisorGoalId.make(task.goal_id),
        projectId: task.project_id as SupervisorGoal["tasks"][number]["projectId"],
        taskKey: task.task_key,
        title: task.title,
        prompt: task.prompt,
        role: task.role,
        priority: task.priority,
        dependencies: dependencies
          .filter((dependency) => dependency.task_id === task.task_id)
          .map((dependency) => keyById.get(dependency.depends_on_task_id)!)
          .filter((key) => key !== undefined),
        status: task.status,
        attempts: attempts.filter((attempt) => attempt.task_id === task.task_id).map(decodeAttempt),
        createdAt: task.created_at,
        updatedAt: task.updated_at,
      })),
      createdAt: goal.created_at,
      updatedAt: goal.updated_at,
      cancelledAt: goal.cancelled_at,
    } satisfies SupervisorGoal;
  });

  const readGoal = (goalId: SupervisorGoalId) =>
    loadGoal(goalId).pipe(
      Effect.map((goal) => ({ goal })),
      Effect.mapError((error) =>
        isGoalNotFound(error) ? error : controlError("Could not read supervisor goal.", error),
      ),
    );

  const listGoals = (input: SupervisorGoalListInput = {}) =>
    mapFailure(
      input.status === undefined
        ? sql<GoalRow>`SELECT * FROM supervisor_goals ORDER BY updated_at DESC LIMIT ${input.limit ?? 100}`
        : sql<GoalRow>`SELECT * FROM supervisor_goals WHERE status = ${input.status} ORDER BY updated_at DESC LIMIT ${input.limit ?? 100}`,
      "Could not list supervisor goals.",
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => loadGoal(SupervisorGoalId.make(row.goal_id)), {
          concurrency: 1,
        }),
      ),
      Effect.map((goals) => ({ goals })),
      Effect.mapError((error) =>
        isGoalNotFound(error) || isControlError(error)
          ? error
          : controlError("Could not list supervisor goals.", error),
      ),
    );

  const subscription = <A, E>(pubsub: PubSub.PubSub<void>, snapshot: () => Effect.Effect<A, E>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* PubSub.subscribe(pubsub);
        return Stream.concat(
          Stream.fromEffect(snapshot()),
          Stream.fromSubscription(changes).pipe(Stream.mapEffect(snapshot)),
        );
      }),
    );

  const isTerminalAttemptStatus = (status: SupervisorTaskAttemptStatus): boolean =>
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted";

  const transitionAttempt = Effect.fn("SupervisorControlPlaneService.transitionAttempt")(
    function* (input: {
      readonly attemptId?: SupervisorTaskAttemptId;
      readonly nodeId?: NodeId;
      readonly status: SupervisorTaskAttemptStatus;
      readonly error?: string | null;
      readonly missingIsNoop: boolean;
      readonly authority?: SupervisorMutationAuthority;
    }) {
      const changed = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (input.authority !== undefined) {
            yield* requireSupervisorMutationAuthority(sql, input.authority);
          }
          const rows =
            input.attemptId === undefined
              ? yield* sql<AttemptRow>`SELECT * FROM supervisor_task_attempts WHERE node_id = ${input.nodeId!}`
              : yield* sql<AttemptRow>`SELECT * FROM supervisor_task_attempts WHERE attempt_id = ${input.attemptId}`;
          const attempt = rows[0];
          if (attempt === undefined) {
            if (input.missingIsNoop) return false;
            return yield* controlError(`Supervisor task attempt was not found.`);
          }
          const nextError = input.error ?? null;
          if (
            isTerminalAttemptStatus(attempt.status) ||
            (attempt.status === input.status && attempt.error === nextError)
          ) {
            return false;
          }

          const now = yield* nowIso;
          const updated = yield* sql<{ readonly attempt_id: string }>`
              UPDATE supervisor_task_attempts
              SET status = ${input.status}, error = ${nextError}, updated_at = ${now}
              WHERE attempt_id = ${attempt.attempt_id} AND status = ${attempt.status}
              RETURNING attempt_id
            `;
          if (updated.length === 0) return false;

          const taskStatus: SupervisorGoalTaskStatus =
            input.status === "completed"
              ? "completed"
              : input.status === "failed" || input.status === "interrupted"
                ? "failed"
                : input.status === "cancelled"
                  ? "cancelled"
                  : "running";
          yield* sql`
              UPDATE supervisor_goal_tasks SET status = ${taskStatus}, updated_at = ${now}
              WHERE task_id = ${attempt.task_id} AND status <> ${taskStatus}
            `;

          const tasks = yield* sql<{ readonly status: SupervisorGoalTaskStatus }>`
              SELECT status FROM supervisor_goal_tasks WHERE goal_id = ${attempt.goal_id}
            `;
          const goals = yield* sql<{ readonly status: SupervisorGoal["status"] }>`
              SELECT status FROM supervisor_goals WHERE goal_id = ${attempt.goal_id}
            `;
          const currentGoalStatus = goals[0]?.status;
          if (currentGoalStatus === undefined || currentGoalStatus === "cancelled") return true;
          const goalStatus: SupervisorGoal["status"] = tasks.every(
            (task) => task.status === "completed",
          )
            ? "completed"
            : tasks.some((task) => task.status === "failed")
              ? "failed"
              : tasks.some((task) => task.status === "cancelled")
                ? "cancelled"
                : "running";
          if (goalStatus !== currentGoalStatus) {
            yield* sql`
                UPDATE supervisor_goals
                SET status = ${goalStatus}, revision = revision + 1, updated_at = ${now}
                WHERE goal_id = ${attempt.goal_id} AND status = ${currentGoalStatus}
              `;
          }
          return true;
        }),
      );
      if (changed) yield* PubSub.publish(goalChanges, undefined);
    },
  );

  const service = SupervisorControlPlaneService.of({
    readConfiguration,
    isDesignatedSupervisor: (threadId) =>
      readConfiguration().pipe(
        Effect.map(({ configuration }) => configuration.threadId === threadId),
      ),
    updateConfiguration: (input) =>
      Effect.gen(function* () {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* validateDesignationEligibility(input.threadId);
            const current = yield* readConfiguration();
            if (current.configuration.revision !== input.expectedRevision) {
              return yield* new SupervisorRevisionConflictError({
                expectedRevision: input.expectedRevision,
                actualRevision: current.configuration.revision,
                message: "Supervisor configuration changed since it was read.",
              });
            }
            const now = yield* nowIso;
            const nextRevision = input.expectedRevision + 1;
            const rows =
              input.expectedRevision === 0
                ? yield* sql<{ readonly revision: number }>`
                    INSERT INTO supervisor_designation(singleton_id, thread_id, revision, created_at, updated_at)
                    VALUES (1, ${input.threadId}, ${nextRevision}, ${now}, ${now})
                    ON CONFLICT(singleton_id) DO NOTHING RETURNING revision
                  `
                : yield* sql<{ readonly revision: number }>`
                    UPDATE supervisor_designation SET thread_id = ${input.threadId}, revision = ${nextRevision}, updated_at = ${now}
                    WHERE singleton_id = 1 AND revision = ${input.expectedRevision} RETURNING revision
                  `;
            if (rows.length === 0) {
              const latest = yield* readConfiguration();
              return yield* new SupervisorRevisionConflictError({
                expectedRevision: input.expectedRevision,
                actualRevision: latest.configuration.revision,
                message: "Supervisor configuration changed concurrently.",
              });
            }
          }),
        );
        yield* PubSub.publish(configurationChanges, undefined);
        return yield* readConfiguration();
      }).pipe(
        Effect.mapError((error) =>
          isRevisionConflict(error) || isControlError(error)
            ? error
            : controlError("Could not update supervisor configuration.", error),
        ),
      ),
    subscribeConfiguration: () => subscription(configurationChanges, readConfiguration),
    listProfiles,
    getProfile,
    updateProfile: (input) =>
      Effect.gen(function* () {
        const profile = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* validateProfileProject(input.projectId);
            const existing = yield* getProfile(input.projectId);
            const actualRevision = existing?.revision ?? 0;
            if (actualRevision !== input.expectedRevision) {
              return yield* new SupervisorRevisionConflictError({
                expectedRevision: input.expectedRevision,
                actualRevision,
                message: `Execution profile ${input.projectId} changed since it was read.`,
              });
            }
            const now = yield* nowIso;
            const rows = yield* sql<ProfileRow>`
              INSERT INTO supervisor_project_execution_profiles(
                project_id, model_selection_json, runtime_mode, interaction_mode,
                max_parallel_tasks, retry_max_attempts, retry_backoff_ms, revision, created_at, updated_at
              ) VALUES (
                ${input.projectId}, ${input.modelSelection == null ? null : encodeModelJson(input.modelSelection)},
                ${input.runtimeMode ?? null}, ${input.interactionMode ?? null}, ${input.maxParallelTasks},
                ${input.retry.maxAttempts}, ${input.retry.backoffMs}, ${actualRevision + 1}, ${existing?.createdAt ?? now}, ${now}
              ) ON CONFLICT(project_id) DO UPDATE SET
                model_selection_json = excluded.model_selection_json,
                runtime_mode = excluded.runtime_mode,
                interaction_mode = excluded.interaction_mode,
                max_parallel_tasks = excluded.max_parallel_tasks,
                retry_max_attempts = excluded.retry_max_attempts,
                retry_backoff_ms = excluded.retry_backoff_ms,
                revision = excluded.revision,
                updated_at = excluded.updated_at
              WHERE supervisor_project_execution_profiles.revision = ${actualRevision}
              RETURNING *
            `;
            if (rows[0] === undefined) {
              return yield* new SupervisorRevisionConflictError({
                expectedRevision: input.expectedRevision,
                actualRevision: (yield* getProfile(input.projectId))?.revision ?? 0,
                message: `Execution profile ${input.projectId} changed concurrently.`,
              });
            }
            return rows[0];
          }),
        );
        yield* PubSub.publish(profileChanges, undefined);
        return { profile: decodeProfile(profile) };
      }).pipe(
        Effect.mapError((error) =>
          isRevisionConflict(error) || isControlError(error)
            ? error
            : controlError("Could not update supervisor execution profile.", error),
        ),
      ),
    subscribeProfiles: () => subscription(profileChanges, listProfiles),
    listGoals,
    readGoal,
    updateGoal: (input, authority) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => validateGoalDag(input.tasks),
          catch: (error) =>
            isGoalValidation(error)
              ? error
              : new SupervisorGoalValidationError({ message: String(error) }),
        });
        const uuid =
          input.goalId === undefined && input.clientRequestId === undefined
            ? yield* crypto.randomUUIDv4
            : null;
        const goalId =
          input.goalId ??
          SupervisorGoalId.make(
            input.clientRequestId === undefined
              ? `goal:${uuid}`
              : `goal:mcp:${encodeURIComponent(input.clientRequestId)}`,
          );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (authority !== undefined) {
              yield* requireSupervisorMutationAuthority(sql, authority);
            }
            yield* validateTaskProjects(input.tasks);
            const existing =
              yield* sql<GoalRow>`SELECT * FROM supervisor_goals WHERE goal_id = ${goalId}`;
            const current = existing[0];
            if (
              current !== undefined &&
              input.expectedRevision === undefined &&
              input.clientRequestId !== undefined
            )
              return;
            const actualRevision = current?.revision ?? 0;
            const expectedRevision = input.expectedRevision ?? 0;
            if (actualRevision !== expectedRevision) {
              return yield* new SupervisorRevisionConflictError({
                expectedRevision,
                actualRevision,
                message: `Supervisor goal ${goalId} changed since it was read.`,
              });
            }
            if (current !== undefined) {
              const attempts = yield* sql<{ readonly count: number }>`
                  SELECT COUNT(*) AS count FROM supervisor_task_attempts WHERE goal_id = ${goalId}
                `;
              if ((attempts[0]?.count ?? 0) > 0) {
                return yield* new SupervisorGoalValidationError({
                  message: "A goal DAG cannot be replaced after execution attempts exist.",
                });
              }
            }
            const now = yield* nowIso;
            const saved = yield* sql<{ readonly goal_id: string }>`
                INSERT INTO supervisor_goals(goal_id, title, prompt, status, revision, created_at, updated_at, cancelled_at)
                VALUES (${goalId}, ${input.title}, ${input.prompt}, 'pending', ${actualRevision + 1}, ${current?.created_at ?? now}, ${now}, NULL)
                ON CONFLICT(goal_id) DO UPDATE SET title = excluded.title, prompt = excluded.prompt,
                  status = 'pending', revision = excluded.revision, updated_at = excluded.updated_at, cancelled_at = NULL
                WHERE supervisor_goals.revision = ${actualRevision}
                RETURNING goal_id
              `;
            if (saved.length === 0) {
              const latest = yield* sql<{ readonly revision: number }>`
                  SELECT revision FROM supervisor_goals WHERE goal_id = ${goalId}
                `;
              return yield* new SupervisorRevisionConflictError({
                expectedRevision,
                actualRevision: latest[0]?.revision ?? 0,
                message: `Supervisor goal ${goalId} changed concurrently.`,
              });
            }
            yield* sql`DELETE FROM supervisor_goal_tasks WHERE goal_id = ${goalId}`;
            const taskIdByKey = new Map<string, SupervisorGoalTaskId>();
            for (const task of input.tasks) {
              const taskId = SupervisorGoalTaskId.make(
                `goal-task:${encodeURIComponent(goalId)}:${encodeURIComponent(task.taskKey)}`,
              );
              taskIdByKey.set(task.taskKey, taskId);
              yield* sql`
                  INSERT INTO supervisor_goal_tasks(
                    task_id, goal_id, project_id, task_key, title, prompt, role, priority, status, created_at, updated_at
                  ) VALUES (
                    ${taskId}, ${goalId}, ${task.projectId}, ${task.taskKey}, ${task.title}, ${task.prompt},
                    ${task.role}, ${task.priority}, 'pending', ${now}, ${now}
                  )
                `;
            }
            for (const task of input.tasks) {
              for (const dependency of task.dependencies) {
                yield* sql`
                    INSERT INTO supervisor_goal_task_dependencies(goal_id, task_id, depends_on_task_id)
                    VALUES (${goalId}, ${taskIdByKey.get(task.taskKey)!}, ${taskIdByKey.get(dependency)!})
                  `;
              }
            }
          }),
        );
        yield* PubSub.publish(goalChanges, undefined);
        return yield* readGoal(goalId);
      }).pipe(
        Effect.mapError((error) =>
          isRevisionConflict(error) || isGoalValidation(error) || isGoalNotFound(error)
            ? error
            : controlError("Could not update supervisor goal.", error),
        ),
      ),
    subscribeGoals: (input = {}) => subscription(goalChanges, () => listGoals(input)),
    listCancelledGoalsWithLinkedAttempts: () =>
      mapFailure(
        sql<{ readonly goal_id: string }>`
          SELECT DISTINCT goal.goal_id
          FROM supervisor_goals goal
          JOIN supervisor_task_attempts attempt ON attempt.goal_id = goal.goal_id
          WHERE goal.status = 'cancelled' AND attempt.node_id IS NOT NULL
          ORDER BY goal.updated_at
        `,
        "Could not list cancelled supervisor goals.",
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => loadGoal(SupervisorGoalId.make(row.goal_id)), {
            concurrency: 1,
          }),
        ),
        Effect.mapError((error) =>
          isControlError(error) || isGoalNotFound(error)
            ? error
            : controlError("Could not list cancelled supervisor goals.", error),
        ),
      ),
    cancelGoal: (input, authority) =>
      Effect.gen(function* () {
        const current = (yield* readGoal(input.goalId)).goal;
        if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
          return yield* new SupervisorRevisionConflictError({
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
            message: `Supervisor goal ${input.goalId} changed since it was read.`,
          });
        }
        if (current.status === "cancelled" || current.status === "completed") {
          return { goal: current };
        }
        const now = yield* nowIso;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (authority !== undefined) {
              yield* requireSupervisorMutationAuthority(sql, authority);
            }
            const cancelled = yield* sql<{ readonly goal_id: string }>`
                UPDATE supervisor_goals SET status = 'cancelled', revision = revision + 1,
                  cancelled_at = ${now}, updated_at = ${now}
                WHERE goal_id = ${input.goalId} AND revision = ${current.revision}
                RETURNING goal_id
              `;
            if (cancelled.length === 0) {
              const latest = yield* sql<{ readonly revision: number }>`
                  SELECT revision FROM supervisor_goals WHERE goal_id = ${input.goalId}
                `;
              return yield* new SupervisorRevisionConflictError({
                expectedRevision: input.expectedRevision ?? current.revision,
                actualRevision: latest[0]?.revision ?? 0,
                message: `Supervisor goal ${input.goalId} changed concurrently.`,
              });
            }
            yield* sql`
                UPDATE supervisor_goal_tasks SET status = 'cancelled', updated_at = ${now}
                WHERE goal_id = ${input.goalId} AND status IN ('pending', 'reserved', 'running')
              `;
            yield* sql`
                UPDATE supervisor_task_attempts SET status = 'cancelled', updated_at = ${now}
                WHERE goal_id = ${input.goalId} AND status IN ('reserved', 'delegated', 'running')
              `;
          }),
        );
        yield* PubSub.publish(goalChanges, undefined);
        return yield* readGoal(input.goalId);
      }).pipe(
        Effect.mapError((error) =>
          isRevisionConflict(error) || isGoalNotFound(error)
            ? error
            : controlError("Could not cancel supervisor goal.", error),
        ),
      ),
    prepareAttempt: (input, authority) =>
      Effect.gen(function* () {
        let attemptId: SupervisorTaskAttemptId | undefined;
        let changed = false;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (authority !== undefined) {
              yield* requireSupervisorMutationAuthority(sql, authority);
            }
            const goals =
              yield* sql<GoalRow>`SELECT * FROM supervisor_goals WHERE goal_id = ${input.goalId}`;
            const goal = goals[0];
            if (goal === undefined) {
              return yield* new SupervisorGoalNotFoundError({
                goalId: input.goalId,
                message: `Supervisor goal ${input.goalId} was not found.`,
              });
            }
            const tasks = yield* sql<TaskRow>`
                SELECT * FROM supervisor_goal_tasks WHERE goal_id = ${input.goalId} AND task_key = ${input.taskKey}
              `;
            const task = tasks[0];
            if (task === undefined || goal.status === "cancelled") {
              return yield* new SupervisorGoalTaskNotReadyError({
                goalId: input.goalId,
                taskKey: input.taskKey,
                message: "Goal task is missing or its goal is cancelled.",
              });
            }
            const existing = yield* sql<AttemptRow>`
                SELECT * FROM supervisor_task_attempts
                WHERE task_id = ${task.task_id} AND status IN ('reserved', 'delegated', 'running')
                ORDER BY attempt_number DESC LIMIT 1
              `;
            if (existing[0] !== undefined) {
              attemptId = SupervisorTaskAttemptId.make(existing[0].attempt_id);
              return;
            }
            if (task.status === "completed" || task.status === "cancelled") {
              return yield* new SupervisorGoalTaskNotReadyError({
                goalId: input.goalId,
                taskKey: input.taskKey,
                message: `Goal task is already ${task.status}.`,
              });
            }
            const unsatisfied = yield* sql<{ readonly task_key: string }>`
                SELECT dependency.task_key
                FROM supervisor_goal_task_dependencies edge
                JOIN supervisor_goal_tasks dependency ON dependency.task_id = edge.depends_on_task_id
                WHERE edge.task_id = ${task.task_id} AND dependency.status <> 'completed'
              `;
            if (unsatisfied.length > 0) {
              return yield* new SupervisorGoalTaskNotReadyError({
                goalId: input.goalId,
                taskKey: input.taskKey,
                message: `Dependencies are not complete: ${unsatisfied.map((row) => row.task_key).join(", ")}.`,
              });
            }
            const profile = yield* getProfile(task.project_id);
            const now = yield* nowIso;
            const attempts = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count FROM supervisor_task_attempts WHERE task_id = ${task.task_id}
              `;
            const attemptNumber = (attempts[0]?.count ?? 0) + 1;
            if (attemptNumber > (profile?.retry.maxAttempts ?? 1)) {
              return yield* new SupervisorGoalTaskNotReadyError({
                goalId: input.goalId,
                taskKey: input.taskKey,
                message: "Goal task exhausted its configured attempts.",
              });
            }
            if (attemptNumber > 1 && (profile?.retry.backoffMs ?? 0) > 0) {
              const previous = yield* sql<{ readonly updated_at: string }>`
                  SELECT updated_at FROM supervisor_task_attempts
                  WHERE task_id = ${task.task_id} ORDER BY attempt_number DESC LIMIT 1
                `;
              const elapsed =
                DateTime.toEpochMillis(DateTime.makeUnsafe(now)) -
                DateTime.toEpochMillis(DateTime.makeUnsafe(previous[0]!.updated_at));
              if (elapsed < profile!.retry.backoffMs) {
                return yield* new SupervisorGoalTaskNotReadyError({
                  goalId: input.goalId,
                  taskKey: input.taskKey,
                  message: "Goal task retry backoff has not elapsed.",
                });
              }
            }
            const active = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM supervisor_task_attempts attempt
                JOIN supervisor_goal_tasks active_task ON active_task.task_id = attempt.task_id
                WHERE active_task.project_id = ${task.project_id}
                  AND attempt.status IN ('reserved', 'delegated', 'running')
              `;
            if ((active[0]?.count ?? 0) >= (profile?.maxParallelTasks ?? 4)) {
              return yield* new SupervisorGoalTaskNotReadyError({
                goalId: input.goalId,
                taskKey: input.taskKey,
                message: "Project execution profile parallel-task limit is reached.",
              });
            }
            attemptId = SupervisorTaskAttemptId.make(
              `goal-attempt:${encodeURIComponent(input.goalId)}:${encodeURIComponent(input.taskKey)}:${attemptNumber}`,
            );
            const clientRequestId = `goal-task:${input.goalId}:${input.taskKey}:attempt:${attemptNumber}`;
            yield* sql`
                INSERT INTO supervisor_task_attempts(
                  attempt_id, goal_id, task_id, attempt_number, client_request_id, status,
                  model_selection_json, runtime_mode, interaction_mode, node_id, thread_id, run_id,
                  error, created_at, updated_at
                ) VALUES (
                  ${attemptId}, ${input.goalId}, ${task.task_id}, ${attemptNumber}, ${clientRequestId}, 'reserved',
                  ${encodeModelJson(input.modelSelection)}, ${input.runtimeMode}, ${input.interactionMode},
                  NULL, NULL, NULL, NULL, ${now}, ${now}
                )
              `;
            yield* sql`UPDATE supervisor_goal_tasks SET status = 'reserved', updated_at = ${now} WHERE task_id = ${task.task_id}`;
            yield* sql`UPDATE supervisor_goals SET status = 'running', updated_at = ${now} WHERE goal_id = ${input.goalId}`;
            changed = true;
          }),
        );
        if (changed) yield* PubSub.publish(goalChanges, undefined);
        const goal = (yield* readGoal(input.goalId)).goal;
        const task = goal.tasks.find((candidate) => candidate.taskKey === input.taskKey)!;
        const attempt = task.attempts.find((candidate) => candidate.id === attemptId)!;
        return { goal, task, attempt };
      }).pipe(
        Effect.mapError((error) =>
          isGoalNotFound(error) || isTaskNotReady(error)
            ? error
            : controlError("Could not prepare supervisor task attempt.", error),
        ),
      ),
    linkAttempt: (input, authority) =>
      Effect.gen(function* () {
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (authority !== undefined) {
              yield* requireSupervisorMutationAuthority(sql, authority);
            }
            const rows = yield* sql<AttemptRow>`
                SELECT * FROM supervisor_task_attempts WHERE attempt_id = ${input.attemptId}
              `;
            const attempt = rows[0];
            if (attempt === undefined) {
              return yield* controlError(`Attempt ${input.attemptId} was not found.`);
            }
            if (attempt.node_id !== null) {
              if (
                attempt.node_id === input.nodeId &&
                attempt.thread_id === input.threadId &&
                attempt.run_id === input.runId
              ) {
                // The orchestration event sink may have linked this attempt in
                // the same transaction as delegated-task creation. Publish the
                // refreshed aggregate when the caller confirms that link.
                return { attempt, changed: true } as const;
              }
              return yield* controlError(
                `Attempt ${input.attemptId} is already linked to delegated task ${attempt.node_id}.`,
              );
            }
            if (isTerminalAttemptStatus(attempt.status)) {
              return yield* controlError(
                `Terminal attempt ${input.attemptId} cannot be linked to delegated work.`,
              );
            }
            const now = yield* nowIso;
            const linkedStatus = attempt.status === "reserved" ? "delegated" : attempt.status;
            const updated = yield* sql<AttemptRow>`
                UPDATE supervisor_task_attempts
                SET status = ${linkedStatus}, node_id = ${input.nodeId}, thread_id = ${input.threadId},
                  run_id = ${input.runId}, updated_at = ${now}
                WHERE attempt_id = ${input.attemptId} AND node_id IS NULL
                RETURNING *
              `;
            const linked = updated[0];
            if (linked === undefined) {
              return yield* controlError(`Attempt ${input.attemptId} changed concurrently.`);
            }
            yield* sql`
                UPDATE supervisor_goal_tasks SET status = 'running', updated_at = ${now}
                WHERE task_id = ${linked.task_id} AND status <> 'running'
              `;
            return { attempt: linked, changed: true } as const;
          }),
        );
        if (result.changed) yield* PubSub.publish(goalChanges, undefined);
        return decodeAttempt(result.attempt);
      }).pipe(
        Effect.mapError((error) =>
          isControlError(error)
            ? error
            : controlError("Could not link supervisor task attempt.", error),
        ),
      ),
    updateAttemptStatus: (input, authority) =>
      transitionAttempt({
        ...input,
        missingIsNoop: false,
        ...(authority === undefined ? {} : { authority }),
      }).pipe(
        Effect.mapError((error) =>
          isControlError(error)
            ? error
            : controlError("Could not update supervisor task attempt.", error),
        ),
      ),
    reconcileAttemptByNodeId: (input, authority) =>
      transitionAttempt({
        ...input,
        missingIsNoop: true,
        ...(authority === undefined ? {} : { authority }),
      }).pipe(
        Effect.mapError((error) =>
          isControlError(error)
            ? error
            : controlError("Could not reconcile supervisor task attempt.", error),
        ),
      ),
  });
  return service;
});

let activeSupervisorControlPlane: SupervisorControlPlaneService["Service"] | undefined;

const makeActive = Effect.acquireRelease(
  make.pipe(
    Effect.tap((service) =>
      Effect.sync(() => {
        activeSupervisorControlPlane = service;
      }),
    ),
  ),
  (service) =>
    Effect.sync(() => {
      if (activeSupervisorControlPlane === service) activeSupervisorControlPlane = undefined;
    }),
);

export const layer = Layer.effect(SupervisorControlPlaneService, makeActive);

export const isActiveDesignatedSupervisor = (threadId: ThreadId): Effect.Effect<boolean> =>
  activeSupervisorControlPlane === undefined
    ? Effect.succeed(false)
    : activeSupervisorControlPlane.isDesignatedSupervisor(threadId).pipe(Effect.orDie);
