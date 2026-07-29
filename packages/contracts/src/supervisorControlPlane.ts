import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NodeId,
  PositiveInt,
  ProjectId,
  RunId,
  SupervisorGoalId,
  SupervisorGoalTaskId,
  SupervisorTaskAttemptId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BoundedTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
const TaskKey = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const SupervisorConfiguration = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  revision: Revision,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type SupervisorConfiguration = typeof SupervisorConfiguration.Type;

export const SupervisorConfigurationReadInput = Schema.Struct({});
export type SupervisorConfigurationReadInput = typeof SupervisorConfigurationReadInput.Type;
export const SupervisorConfigurationReadResult = Schema.Struct({
  configuration: SupervisorConfiguration,
});
export type SupervisorConfigurationReadResult = typeof SupervisorConfigurationReadResult.Type;
export const SupervisorConfigurationUpdateInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  expectedRevision: Revision,
});
export type SupervisorConfigurationUpdateInput = typeof SupervisorConfigurationUpdateInput.Type;
export const SupervisorConfigurationUpdateResult = SupervisorConfigurationReadResult;
export type SupervisorConfigurationUpdateResult = typeof SupervisorConfigurationUpdateResult.Type;

export const ProjectExecutionProfile = Schema.Struct({
  projectId: ProjectId,
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: Schema.NullOr(RuntimeMode),
  interactionMode: Schema.NullOr(ProviderInteractionMode),
  maxParallelTasks: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  retry: Schema.Struct({
    maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    backoffMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 })),
  }),
  revision: Revision,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectExecutionProfile = typeof ProjectExecutionProfile.Type;

export const ProjectExecutionProfileListInput = Schema.Struct({});
export type ProjectExecutionProfileListInput = typeof ProjectExecutionProfileListInput.Type;
export const ProjectExecutionProfileListResult = Schema.Struct({
  profiles: Schema.Array(ProjectExecutionProfile),
});
export type ProjectExecutionProfileListResult = typeof ProjectExecutionProfileListResult.Type;
export const ProjectExecutionProfileUpdateInput = Schema.Struct({
  projectId: ProjectId,
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(Schema.NullOr(RuntimeMode)),
  interactionMode: Schema.optional(Schema.NullOr(ProviderInteractionMode)),
  maxParallelTasks: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  retry: Schema.Struct({
    maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    backoffMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 })),
  }),
  expectedRevision: Revision,
});
export type ProjectExecutionProfileUpdateInput = typeof ProjectExecutionProfileUpdateInput.Type;
export const ProjectExecutionProfileUpdateResult = Schema.Struct({
  profile: ProjectExecutionProfile,
});
export type ProjectExecutionProfileUpdateResult = typeof ProjectExecutionProfileUpdateResult.Type;

export const SupervisorGoalStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SupervisorGoalStatus = typeof SupervisorGoalStatus.Type;
export const SupervisorGoalTaskStatus = Schema.Literals([
  "pending",
  "reserved",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SupervisorGoalTaskStatus = typeof SupervisorGoalTaskStatus.Type;
export const SupervisorTaskAttemptStatus = Schema.Literals([
  "reserved",
  "delegated",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type SupervisorTaskAttemptStatus = typeof SupervisorTaskAttemptStatus.Type;
export const SupervisorGoalTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type SupervisorGoalTaskRole = typeof SupervisorGoalTaskRole.Type;

export const SupervisorTaskAttempt = Schema.Struct({
  id: SupervisorTaskAttemptId,
  goalId: SupervisorGoalId,
  taskId: SupervisorGoalTaskId,
  attemptNumber: PositiveInt,
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  status: SupervisorTaskAttemptStatus,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  nodeId: Schema.NullOr(NodeId),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(20_000))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SupervisorTaskAttempt = typeof SupervisorTaskAttempt.Type;

export const SupervisorGoalTask = Schema.Struct({
  id: SupervisorGoalTaskId,
  goalId: SupervisorGoalId,
  projectId: ProjectId,
  taskKey: TaskKey,
  title: BoundedTitle,
  prompt: BoundedPrompt,
  role: SupervisorGoalTaskRole,
  priority: Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })),
  dependencies: Schema.Array(TaskKey).check(Schema.isMaxLength(100)),
  status: SupervisorGoalTaskStatus,
  attempts: Schema.Array(SupervisorTaskAttempt).check(Schema.isMaxLength(20)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SupervisorGoalTask = typeof SupervisorGoalTask.Type;

export const SupervisorGoal = Schema.Struct({
  id: SupervisorGoalId,
  title: BoundedTitle,
  prompt: BoundedPrompt,
  status: SupervisorGoalStatus,
  revision: Revision,
  tasks: Schema.Array(SupervisorGoalTask).check(Schema.isMaxLength(100)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  cancelledAt: Schema.NullOr(IsoDateTime),
});
export type SupervisorGoal = typeof SupervisorGoal.Type;

export const SupervisorGoalTaskDefinition = Schema.Struct({
  projectId: ProjectId,
  taskKey: TaskKey,
  title: BoundedTitle,
  prompt: BoundedPrompt,
  role: SupervisorGoalTaskRole,
  priority: Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })),
  dependencies: Schema.Array(TaskKey).check(Schema.isMaxLength(100)),
});
export type SupervisorGoalTaskDefinition = typeof SupervisorGoalTaskDefinition.Type;

export const SupervisorGoalListInput = Schema.Struct({
  status: Schema.optional(SupervisorGoalStatus),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type SupervisorGoalListInput = typeof SupervisorGoalListInput.Type;
export const SupervisorGoalListResult = Schema.Struct({
  goals: Schema.Array(SupervisorGoal),
});
export type SupervisorGoalListResult = typeof SupervisorGoalListResult.Type;
export const SupervisorGoalReadInput = Schema.Struct({ goalId: SupervisorGoalId });
export type SupervisorGoalReadInput = typeof SupervisorGoalReadInput.Type;
export const SupervisorGoalReadResult = Schema.Struct({ goal: SupervisorGoal });
export type SupervisorGoalReadResult = typeof SupervisorGoalReadResult.Type;
export const SupervisorGoalUpdateInput = Schema.Struct({
  goalId: Schema.optional(SupervisorGoalId),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  expectedRevision: Schema.optional(Revision),
  title: BoundedTitle,
  prompt: BoundedPrompt,
  tasks: Schema.Array(SupervisorGoalTaskDefinition).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export type SupervisorGoalUpdateInput = typeof SupervisorGoalUpdateInput.Type;
export const SupervisorGoalUpdateResult = SupervisorGoalReadResult;
export type SupervisorGoalUpdateResult = typeof SupervisorGoalUpdateResult.Type;
export const SupervisorGoalCancelInput = Schema.Struct({
  goalId: SupervisorGoalId,
  expectedRevision: Schema.optional(Revision),
});
export type SupervisorGoalCancelInput = typeof SupervisorGoalCancelInput.Type;
export const SupervisorGoalCancelResult = SupervisorGoalReadResult;
export type SupervisorGoalCancelResult = typeof SupervisorGoalCancelResult.Type;

export class SupervisorControlPlaneError extends Schema.TaggedErrorClass<SupervisorControlPlaneError>()(
  "SupervisorControlPlaneError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
export class SupervisorRevisionConflictError extends Schema.TaggedErrorClass<SupervisorRevisionConflictError>()(
  "SupervisorRevisionConflictError",
  { expectedRevision: Revision, actualRevision: Revision, message: Schema.String },
) {}
export class SupervisorGoalValidationError extends Schema.TaggedErrorClass<SupervisorGoalValidationError>()(
  "SupervisorGoalValidationError",
  { message: Schema.String, taskKey: Schema.optional(TaskKey) },
) {}
export class SupervisorGoalNotFoundError extends Schema.TaggedErrorClass<SupervisorGoalNotFoundError>()(
  "SupervisorGoalNotFoundError",
  { goalId: SupervisorGoalId, message: Schema.String },
) {}
export class SupervisorGoalTaskNotReadyError extends Schema.TaggedErrorClass<SupervisorGoalTaskNotReadyError>()(
  "SupervisorGoalTaskNotReadyError",
  { goalId: SupervisorGoalId, taskKey: TaskKey, message: Schema.String },
) {}

export const SupervisorControlPlaneRpcError = Schema.Union([
  SupervisorControlPlaneError,
  SupervisorRevisionConflictError,
  SupervisorGoalValidationError,
  SupervisorGoalNotFoundError,
  SupervisorGoalTaskNotReadyError,
]);
