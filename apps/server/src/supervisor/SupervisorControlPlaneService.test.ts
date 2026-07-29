import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  SupervisorGoalId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  isActiveDesignatedSupervisor,
  layer,
  SupervisorControlPlaneService,
  validateGoalDag,
} from "./SupervisorControlPlaneService.ts";

const projectId = ProjectId.make("project:supervisor-test");
const goalInput = {
  clientRequestId: "goal-idempotent",
  title: "Durable goal",
  prompt: "Run a dependency graph.",
  tasks: [
    {
      projectId,
      taskKey: "build",
      title: "Build",
      prompt: "Build it.",
      role: "implementation" as const,
      priority: 10,
      dependencies: [],
    },
    {
      projectId,
      taskKey: "review",
      title: "Review",
      prompt: "Review it.",
      role: "review" as const,
      priority: 0,
      dependencies: ["build"],
    },
  ],
};

const runWithService = <A, E, R>(effect: Effect.Effect<A, E, R>, bootstrapThreadId?: ThreadId) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 44 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO projection_projects(
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, 'Supervisor test', '/tmp/supervisor-test', NULL, '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      )
    `;
    return yield* effect.pipe(Effect.provide(layer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeSqliteClient.layerMemory(),
        NodeServices.layer,
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (config) =>
            ServerConfig.make({
              ...config,
              ...(bootstrapThreadId === undefined
                ? {}
                : { experimentalGlobalSupervisorThreadId: bootstrapThreadId }),
            }),
          ),
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-supervisor-test-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

describe("SupervisorControlPlaneService", () => {
  it("rejects duplicate, missing, and cyclic dependencies", () => {
    assert.throws(() => validateGoalDag([goalInput.tasks[0]!, goalInput.tasks[0]!]));
    assert.throws(() => validateGoalDag([{ ...goalInput.tasks[0]!, dependencies: ["missing"] }]));
    assert.throws(() =>
      validateGoalDag([
        { ...goalInput.tasks[0]!, dependencies: ["review"] },
        { ...goalInput.tasks[1]!, dependencies: ["build"] },
      ]),
    );
  });

  it.effect("rotates persisted authority immediately with optimistic revisions", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const oldThread = ThreadId.make("thread:old-supervisor");
        const newThread = ThreadId.make("thread:new-supervisor");
        yield* service.updateConfiguration({ threadId: oldThread, expectedRevision: 0 });
        assert.isTrue(yield* service.isDesignatedSupervisor(oldThread));
        yield* service.updateConfiguration({ threadId: newThread, expectedRevision: 1 });
        assert.isFalse(yield* service.isDesignatedSupervisor(oldThread));
        assert.isTrue(yield* service.isDesignatedSupervisor(newThread));
        const conflict = yield* Effect.flip(
          service.updateConfiguration({ threadId: oldThread, expectedRevision: 1 }),
        );
        assert.equal(conflict._tag, "SupervisorRevisionConflictError");
      }),
    ),
  );

  it.effect("accepts pending drafts but rejects existing ineligible supervisor threads", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const sql = yield* SqlClient.SqlClient;
        const draftThreadId = ThreadId.make("thread:pending-supervisor-draft");
        yield* service.updateConfiguration({ threadId: draftThreadId, expectedRevision: 0 });

        const archivedThreadId = ThreadId.make("thread:archived-supervisor");
        const childThreadId = ThreadId.make("thread:child-supervisor");
        const activeThreadId = ThreadId.make("thread:active-supervisor");
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads(
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at,
            payload_json, provider_instance_id
          ) VALUES (
            ${archivedThreadId}, ${projectId}, 'Archived', 'codex', 'approval-required', 'default',
            NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z', NULL,
            '{"lineage":{"parentThreadId":null}}', 'codex'
          ), (
            ${childThreadId}, ${projectId}, 'Child', 'codex', 'approval-required', 'default',
            NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL,
            '{"lineage":{"parentThreadId":"thread:parent"}}', 'codex'
          ), (
            ${activeThreadId}, ${projectId}, 'Active', 'codex', 'approval-required', 'default',
            NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL,
            '{"lineage":{"parentThreadId":null}}', 'codex'
          )
        `;

        const archived = yield* Effect.flip(
          service.updateConfiguration({ threadId: archivedThreadId, expectedRevision: 1 }),
        );
        assert.equal(archived._tag, "SupervisorControlPlaneError");
        const child = yield* Effect.flip(
          service.updateConfiguration({ threadId: childThreadId, expectedRevision: 1 }),
        );
        assert.equal(child._tag, "SupervisorControlPlaneError");
        assert.equal((yield* service.readConfiguration()).configuration.threadId, draftThreadId);
        const active = yield* service.updateConfiguration({
          threadId: activeThreadId,
          expectedRevision: 1,
        });
        assert.equal(active.configuration.threadId, activeThreadId);
      }),
    ),
  );

  it.effect("rejects goals that reference inactive projects", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const invalid = yield* Effect.flip(
          service.updateGoal({
            ...goalInput,
            clientRequestId: "goal-invalid-project",
            tasks: [
              {
                ...goalInput.tasks[0]!,
                projectId: ProjectId.make("project:missing-supervisor-test"),
              },
            ],
          }),
        );
        assert.equal(invalid._tag, "SupervisorGoalValidationError");
        assert.lengthOf((yield* service.listGoals()).goals, 0);
      }),
    ),
  );

  it.effect("fences goal commits by live designation and exact runtime ownership", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:authority-supervisor");
        const replacementThreadId = ThreadId.make("thread:authority-replacement");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const runtimeProviderSessionId = ProviderSessionId.make("provider-session:authority");
        yield* service.updateConfiguration({ threadId, expectedRevision: 0 });
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_threads (
            provider_thread_id, thread_id, owner_node_id, provider, driver,
            provider_instance_id, provider_session_id, status, first_run_ordinal,
            last_run_ordinal, updated_at, payload_json
          ) VALUES (
            'provider-thread:authority', ${threadId}, NULL, ${providerInstanceId}, 'codex',
            ${providerInstanceId}, ${runtimeProviderSessionId}, 'active', 1, 1,
            '2026-01-01T00:00:00.000Z', '{}'
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_instance_id,
            provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES (
            'run:authority', ${threadId}, 1, ${providerInstanceId}, ${providerInstanceId},
            'provider-thread:authority', 'running', '2026-01-01T00:00:00.000Z', NULL, '{}'
          )
        `;
        const authority = { threadId, runtimeProviderSessionId, providerInstanceId };

        const wrongRuntime = yield* Effect.flip(
          service.updateGoal(
            { ...goalInput, clientRequestId: "goal-wrong-runtime" },
            {
              ...authority,
              runtimeProviderSessionId: ProviderSessionId.make("provider-session:stale"),
            },
          ),
        );
        assert.equal(wrongRuntime._tag, "SupervisorControlPlaneError");
        assert.lengthOf((yield* service.listGoals()).goals, 0);

        const staleCommit = service.updateGoal(
          { ...goalInput, clientRequestId: "goal-stale-designation" },
          authority,
        );
        yield* service.updateConfiguration({ threadId: replacementThreadId, expectedRevision: 1 });
        const staleFailure = yield* Effect.flip(staleCommit);
        assert.equal(staleFailure._tag, "SupervisorControlPlaneError");
        assert.lengthOf((yield* service.listGoals()).goals, 0);
      }),
    ),
  );

  it.effect("persists an explicit disabled state that environment bootstrap cannot overwrite", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const bootstrapped = yield* service.readConfiguration();
        assert.equal(bootstrapped.configuration.threadId, "thread:bootstrap-supervisor");
        assert.equal(bootstrapped.configuration.revision, 1);
        assert.isTrue(
          yield* isActiveDesignatedSupervisor(ThreadId.make("thread:bootstrap-supervisor")),
        );

        const disabled = yield* service.updateConfiguration({
          threadId: null,
          expectedRevision: 1,
        });
        assert.isNull(disabled.configuration.threadId);
        assert.equal(disabled.configuration.revision, 2);
        assert.isFalse(
          yield* service.isDesignatedSupervisor(ThreadId.make("thread:bootstrap-supervisor")),
        );
        assert.isFalse(
          yield* isActiveDesignatedSupervisor(ThreadId.make("thread:bootstrap-supervisor")),
        );

        const afterRestart = yield* service.readConfiguration().pipe(Effect.provide(layer));
        assert.isNull(afterRestart.configuration.threadId);
        assert.equal(afterRestart.configuration.revision, 2);
      }),
      ThreadId.make("thread:bootstrap-supervisor"),
    ),
  );

  it.effect("persists a DAG and reuses deterministic attempts until linked work resolves", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        yield* service.updateProfile({
          projectId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          maxParallelTasks: 2,
          retry: { maxAttempts: 2, backoffMs: 100 },
          expectedRevision: 0,
        });
        const created = yield* service.updateGoal(goalInput);
        assert.equal(created.goal.id, SupervisorGoalId.make("goal:mcp:goal-idempotent"));
        const settings = {
          goalId: created.goal.id,
          taskKey: "build",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          interactionMode: "plan" as const,
        };
        const first = yield* service.prepareAttempt(settings);
        const retry = yield* service.prepareAttempt(settings);
        assert.equal(retry.attempt.id, first.attempt.id);
        assert.equal(retry.attempt.clientRequestId, first.attempt.clientRequestId);

        const blocked = yield* Effect.flip(
          service.prepareAttempt({ ...settings, taskKey: "review" }),
        );
        assert.equal(blocked._tag, "SupervisorGoalTaskNotReadyError");

        yield* service.updateAttemptStatus({ attemptId: first.attempt.id, status: "completed" });
        const review = yield* service.prepareAttempt({ ...settings, taskKey: "review" });
        assert.equal(review.attempt.attemptNumber, 1);
        assert.equal(review.attempt.modelSelection.instanceId, "codex");
      }),
    ),
  );

  it.effect("rejects execution profiles for missing or inactive projects", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const sql = yield* SqlClient.SqlClient;
        const deletedProjectId = ProjectId.make("project:supervisor-deleted-profile");
        yield* sql`
          INSERT INTO projection_projects(
            project_id, title, workspace_root, default_model_selection_json, scripts_json,
            created_at, updated_at, deleted_at
          ) VALUES (
            ${deletedProjectId}, 'Deleted profile project', '/tmp/deleted-profile', NULL, '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z'
          )
        `;
        const profile = (targetProjectId: ProjectId) => ({
          projectId: targetProjectId,
          modelSelection: null,
          runtimeMode: null,
          interactionMode: null,
          maxParallelTasks: 1,
          retry: { maxAttempts: 1, backoffMs: 0 },
          expectedRevision: 0,
        });

        const missing = yield* Effect.flip(
          service.updateProfile(profile(ProjectId.make("project:supervisor-missing-profile"))),
        );
        const deleted = yield* Effect.flip(service.updateProfile(profile(deletedProjectId)));

        assert.equal(missing._tag, "SupervisorControlPlaneError");
        assert.equal(deleted._tag, "SupervisorControlPlaneError");
        assert.isNull(yield* service.getProfile(deletedProjectId));
      }),
    ),
  );

  it.effect("links and reconciles terminal delegated attempts idempotently by node id", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const created = yield* service.updateGoal(goalInput);
        const settings = {
          goalId: created.goal.id,
          taskKey: "build",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          interactionMode: "plan" as const,
        };
        const prepared = yield* service.prepareAttempt(settings);
        const nodeId = NodeId.make("node:goal-build");
        const threadId = ThreadId.make("thread:goal-build");
        const runId = RunId.make("run:goal-build");
        const linked = yield* service.linkAttempt({
          attemptId: prepared.attempt.id,
          nodeId,
          threadId,
          runId,
        });
        const linkedAgain = yield* service.linkAttempt({
          attemptId: prepared.attempt.id,
          nodeId,
          threadId,
          runId,
        });
        assert.equal(linkedAgain.nodeId, linked.nodeId);

        yield* service.reconcileAttemptByNodeId({ nodeId, status: "completed" });
        const afterFirst = (yield* service.readGoal(created.goal.id)).goal;
        yield* service.reconcileAttemptByNodeId({ nodeId, status: "completed" });
        const afterReplay = (yield* service.readGoal(created.goal.id)).goal;
        assert.equal(afterReplay.revision, afterFirst.revision);
        assert.equal(
          afterReplay.tasks.find((task) => task.taskKey === "build")?.status,
          "completed",
        );
        assert.equal(
          afterReplay.tasks.find((task) => task.taskKey === "build")?.attempts[0]?.status,
          "completed",
        );

        yield* service.reconcileAttemptByNodeId({
          nodeId: NodeId.make("node:not-a-goal-attempt"),
          status: "failed",
        });
        assert.equal((yield* service.readGoal(created.goal.id)).goal.revision, afterFirst.revision);
      }),
    ),
  );

  it.effect("keeps a completed goal immutable when cancellation arrives later", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const created = yield* service.updateGoal({
          ...goalInput,
          clientRequestId: "goal-completed-cancel",
          tasks: [goalInput.tasks[0]!],
        });
        const prepared = yield* service.prepareAttempt({
          goalId: created.goal.id,
          taskKey: "build",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        yield* service.updateAttemptStatus({
          attemptId: prepared.attempt.id,
          status: "completed",
        });
        const completed = (yield* service.readGoal(created.goal.id)).goal;
        const cancelled = yield* service.cancelGoal({
          goalId: created.goal.id,
          expectedRevision: completed.revision,
        });
        assert.equal(cancelled.goal.status, "completed");
        assert.isNull(cancelled.goal.cancelledAt);
      }),
    ),
  );

  it.effect("allows a configured retry after process-loss interruption", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        yield* service.updateProfile({
          projectId,
          modelSelection: null,
          runtimeMode: null,
          interactionMode: null,
          maxParallelTasks: 1,
          retry: { maxAttempts: 2, backoffMs: 0 },
          expectedRevision: 0,
        });
        const created = yield* service.updateGoal({
          ...goalInput,
          clientRequestId: "goal-process-loss-retry",
          tasks: [goalInput.tasks[0]!],
        });
        const settings = {
          goalId: created.goal.id,
          taskKey: "build",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          interactionMode: "plan" as const,
        };
        const first = yield* service.prepareAttempt(settings);
        yield* service.updateAttemptStatus({
          attemptId: first.attempt.id,
          status: "interrupted",
        });
        const retry = yield* service.prepareAttempt(settings);
        assert.equal(retry.attempt.attemptNumber, 2);
        assert.equal(retry.goal.status, "running");
      }),
    ),
  );

  it.effect("durably cancels linked attempts before interruption coordination", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const created = yield* service.updateGoal({
          ...goalInput,
          clientRequestId: "goal-linked-cancel",
          tasks: [goalInput.tasks[0]!],
        });
        const prepared = yield* service.prepareAttempt({
          goalId: created.goal.id,
          taskKey: "build",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        yield* service.linkAttempt({
          attemptId: prepared.attempt.id,
          nodeId: NodeId.make("node:linked-cancel"),
          threadId: ThreadId.make("thread:linked-cancel"),
          runId: RunId.make("run:linked-cancel"),
        });
        const cancelled = yield* service.cancelGoal({ goalId: created.goal.id });
        assert.equal(cancelled.goal.status, "cancelled");
        assert.equal(cancelled.goal.tasks[0]?.status, "cancelled");
        assert.equal(cancelled.goal.tasks[0]?.attempts[0]?.status, "cancelled");
        const blocked = yield* Effect.flip(
          service.prepareAttempt({
            goalId: created.goal.id,
            taskKey: "build",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          }),
        );
        assert.equal(blocked._tag, "SupervisorGoalTaskNotReadyError");
      }),
    ),
  );

  it.effect("converges every delegated terminal status and publishes the changed goal", () =>
    runWithService(
      Effect.gen(function* () {
        const service = yield* SupervisorControlPlaneService;
        const cases = [
          ["completed", "completed", "completed"],
          ["failed", "failed", "failed"],
          ["cancelled", "cancelled", "cancelled"],
          ["interrupted", "failed", "failed"],
        ] as const;
        for (const [attemptStatus, taskStatus, goalStatus] of cases) {
          const created = yield* service.updateGoal({
            clientRequestId: `terminal-${attemptStatus}`,
            title: `Terminal ${attemptStatus}`,
            prompt: `Reconcile ${attemptStatus}.`,
            tasks: [
              {
                projectId,
                taskKey: "only",
                title: "Only task",
                prompt: "Finish once.",
                role: "general",
                priority: 0,
                dependencies: [],
              },
            ],
          });
          const prepared = yield* service.prepareAttempt({
            goalId: created.goal.id,
            taskKey: "only",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          });
          const nodeId = NodeId.make(`node:terminal:${attemptStatus}`);
          yield* service.linkAttempt({
            attemptId: prepared.attempt.id,
            nodeId,
            threadId: ThreadId.make(`thread:terminal:${attemptStatus}`),
            runId: RunId.make(`run:terminal:${attemptStatus}`),
          });

          const updatesFiber =
            attemptStatus === "completed"
              ? yield* Effect.forkChild(
                  service.subscribeGoals({}).pipe(Stream.take(2), Stream.runCollect),
                )
              : null;
          if (updatesFiber !== null) yield* Effect.yieldNow;
          yield* service.reconcileAttemptByNodeId({ nodeId, status: attemptStatus });
          const first = (yield* service.readGoal(created.goal.id)).goal;
          yield* service.reconcileAttemptByNodeId({ nodeId, status: attemptStatus });
          const replay = (yield* service.readGoal(created.goal.id)).goal;

          assert.equal(first.tasks[0]?.attempts[0]?.status, attemptStatus);
          assert.equal(first.tasks[0]?.status, taskStatus);
          assert.equal(first.status, goalStatus);
          assert.equal(replay.revision, first.revision);
          if (updatesFiber !== null) {
            const updates = Array.from(yield* Fiber.join(updatesFiber));
            assert.equal(
              updates.at(-1)?.goals.find((goal) => goal.id === created.goal.id)?.status,
              "completed",
            );
          }
        }
      }),
    ),
  );
});
