import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectExecutionProfileUpdateInput,
  ProjectExecutionProfile,
  ProjectId,
  ProviderInteractionMode,
  ProviderInstanceId,
  RuntimeMode,
  SupervisorGoalTask,
  SupervisorGoalStatus,
  ThreadId,
} from "@t3tools/contracts";

export const DEFAULT_SUPERVISOR_MAX_PARALLEL_TASKS = 4;
export const DEFAULT_SUPERVISOR_RETRY_ATTEMPTS = 1;
export const DEFAULT_SUPERVISOR_RETRY_BACKOFF_MS = 0;

export function eligibleSupervisorThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.lineage.parentThreadId === null &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
  );
}

export function modelSelectionForUpdate(
  baseSelection: ModelSelection | null,
  instanceId: ProviderInstanceId,
  model: string,
): ModelSelection {
  if (baseSelection?.instanceId === instanceId && baseSelection.model === model) {
    return baseSelection;
  }
  return { instanceId, model };
}

export function profileRevision(profile: ProjectExecutionProfile | undefined): number {
  return profile?.revision ?? 0;
}

export interface SupervisorProfileDraft {
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
  readonly maxParallelTasks: string;
  readonly retryAttempts: string;
  readonly retryBackoffMs: string;
}

export type SupervisorProfileDraftField = keyof SupervisorProfileDraft;

export type SupervisorProfileSaveResult =
  | { readonly type: "success"; readonly profile: ProjectExecutionProfile }
  | { readonly type: "revision-conflict"; readonly actualRevision: number }
  | { readonly type: "failure" };

export function supervisorProfileDraft(
  profile: ProjectExecutionProfile | undefined,
): SupervisorProfileDraft {
  return {
    modelSelection: profile?.modelSelection ?? null,
    runtimeMode: profile?.runtimeMode ?? null,
    interactionMode: profile?.interactionMode ?? null,
    maxParallelTasks: String(profile?.maxParallelTasks ?? DEFAULT_SUPERVISOR_MAX_PARALLEL_TASKS),
    retryAttempts: String(profile?.retry.maxAttempts ?? DEFAULT_SUPERVISOR_RETRY_ATTEMPTS),
    retryBackoffMs: String(profile?.retry.backoffMs ?? DEFAULT_SUPERVISOR_RETRY_BACKOFF_MS),
  };
}

export function reconcileSupervisorProfileDraft(
  current: SupervisorProfileDraft,
  source: SupervisorProfileDraft,
  dirtyFields: ReadonlySet<SupervisorProfileDraftField>,
): SupervisorProfileDraft {
  return {
    modelSelection: dirtyFields.has("modelSelection")
      ? current.modelSelection
      : source.modelSelection,
    runtimeMode: dirtyFields.has("runtimeMode") ? current.runtimeMode : source.runtimeMode,
    interactionMode: dirtyFields.has("interactionMode")
      ? current.interactionMode
      : source.interactionMode,
    maxParallelTasks: dirtyFields.has("maxParallelTasks")
      ? current.maxParallelTasks
      : source.maxParallelTasks,
    retryAttempts: dirtyFields.has("retryAttempts") ? current.retryAttempts : source.retryAttempts,
    retryBackoffMs: dirtyFields.has("retryBackoffMs")
      ? current.retryBackoffMs
      : source.retryBackoffMs,
  };
}

export function reconcileSupervisorProfileRevision(
  currentRevision: number,
  sourceRevision: number,
  dirtyFields: ReadonlySet<SupervisorProfileDraftField>,
  requiredSourceRevision: number | null = null,
): number {
  if (requiredSourceRevision !== null) {
    return sourceRevision >= requiredSourceRevision ? sourceRevision : currentRevision;
  }
  return dirtyFields.size === 0 ? sourceRevision : currentRevision;
}

export function pendingSupervisorProfileRevision(
  currentRevision: number | null,
  conflictingRevision: number,
): number {
  return Math.max(currentRevision ?? 0, conflictingRevision);
}

export function expectedRevisionAfterSupervisorProfileSave(
  currentRevision: number,
  result: SupervisorProfileSaveResult,
): number {
  if (result.type === "success") return result.profile.revision;
  return currentRevision;
}

function parseBoundedInt(value: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function supervisorProfileUpdateInput(
  projectId: ProjectId,
  draft: SupervisorProfileDraft,
  expectedRevision: number,
): ProjectExecutionProfileUpdateInput {
  return {
    projectId,
    modelSelection: draft.modelSelection,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
    maxParallelTasks: parseBoundedInt(
      draft.maxParallelTasks,
      DEFAULT_SUPERVISOR_MAX_PARALLEL_TASKS,
      1,
      64,
    ),
    retry: {
      maxAttempts: parseBoundedInt(draft.retryAttempts, DEFAULT_SUPERVISOR_RETRY_ATTEMPTS, 1, 20),
      backoffMs: parseBoundedInt(
        draft.retryBackoffMs,
        DEFAULT_SUPERVISOR_RETRY_BACKOFF_MS,
        0,
        86_400_000,
      ),
    },
    expectedRevision,
  };
}

export function reconcileSupervisorThreadSelection(input: {
  readonly currentSelection: string;
  readonly configuredThreadId: ThreadId | null;
  readonly eligibleThreadIds: ReadonlyArray<ThreadId>;
  readonly contextChanged: boolean;
}): string {
  if (
    !input.contextChanged &&
    input.eligibleThreadIds.includes(input.currentSelection as ThreadId)
  ) {
    return input.currentSelection;
  }
  if (
    input.configuredThreadId !== null &&
    input.eligibleThreadIds.includes(input.configuredThreadId)
  ) {
    return input.configuredThreadId;
  }
  return input.eligibleThreadIds[0] ?? "";
}

export function updatePendingGoalCancellations(
  current: ReadonlySet<string>,
  goalId: string,
  pending: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  if (pending) next.add(goalId);
  else next.delete(goalId);
  return next;
}

export function canCancelSupervisorGoal(status: SupervisorGoalStatus): boolean {
  return status === "pending" || status === "running" || status === "failed";
}

export class SupervisorDesignationFailedError extends Error {
  constructor() {
    super("Supervisor designation failed.");
    this.name = "SupervisorDesignationFailedError";
  }
}

export async function requireSuccessfulSupervisorDesignation(
  result: boolean | Promise<boolean>,
): Promise<void> {
  if (!(await result)) {
    throw new SupervisorDesignationFailedError();
  }
}

export function supervisorDraftDialogCopy(replacing: boolean): {
  readonly buttonLabel: string;
  readonly description: string;
  readonly title: string;
} {
  return replacing
    ? {
        title: "Replace global supervisor?",
        description:
          "Opening the draft immediately revokes the current supervisor's authority, before the first send. If you abandon the draft, the previous supervisor is not restored automatically.",
        buttonLabel: "Replace and open draft",
      }
    : {
        title: "Create supervisor",
        description:
          "Choose a project, then configure provider and model in the normal draft composer.",
        buttonLabel: "Open draft",
      };
}

export function existingSupervisorDesignationDecision(
  currentThreadId: ThreadId | null,
  targetThreadId: ThreadId,
): "confirm" | "designate" | "unchanged" {
  if (currentThreadId === targetThreadId) return "unchanged";
  return currentThreadId === null ? "designate" : "confirm";
}

export function supervisorThreadReplacementDialogCopy(targetTitle: string): {
  readonly buttonLabel: string;
  readonly description: string;
  readonly title: string;
} {
  return {
    title: "Replace global supervisor?",
    description: `Designating ${targetTitle} immediately revokes the current supervisor's authority. This change takes effect as soon as you confirm.`,
    buttonLabel: "Replace supervisor",
  };
}

export function goalTaskProgress(tasks: ReadonlyArray<SupervisorGoalTask>): {
  readonly completed: number;
  readonly total: number;
} {
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
  };
}
