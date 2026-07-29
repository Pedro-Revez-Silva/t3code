import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProjectExecutionProfile,
  type ProjectExecutionProfileUpdateInput,
  type ProviderInteractionMode,
  type RuntimeMode,
  type SupervisorGoal,
  type SupervisorGoalStatus,
  type SupervisorGoalTaskStatus,
  SupervisorRevisionConflictError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  BanIcon,
  BrainCircuitIcon,
  CircleDotIcon,
  PlusIcon,
  SaveIcon,
  TargetIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  canCancelSupervisorGoal,
  eligibleSupervisorThreads,
  expectedRevisionAfterSupervisorProfileSave,
  existingSupervisorDesignationDecision,
  goalTaskProgress,
  modelSelectionForUpdate,
  pendingSupervisorProfileRevision,
  profileRevision,
  reconcileSupervisorProfileDraft,
  reconcileSupervisorProfileRevision,
  reconcileSupervisorThreadSelection,
  requireSuccessfulSupervisorDesignation,
  SupervisorDesignationFailedError,
  type SupervisorProfileDraftField,
  type SupervisorProfileSaveResult,
  supervisorProfileDraft,
  supervisorProfileUpdateInput,
  supervisorDraftDialogCopy,
  supervisorThreadReplacementDialogCopy,
  updatePendingGoalCancellations,
} from "./SupervisorSettings.logic";

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan",
};

const isSupervisorRevisionConflictError = Schema.is(SupervisorRevisionConflictError);

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

function FormField({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="block text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function QueryMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      className={
        error ? "px-4 py-5 text-xs text-destructive" : "px-4 py-5 text-xs text-muted-foreground"
      }
    >
      {children}
    </div>
  );
}

function goalStatusVariant(status: SupervisorGoalStatus) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "info";
  if (status === "cancelled") return "outline";
  return "warning";
}

function taskStatusVariant(status: SupervisorGoalTaskStatus) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running" || status === "reserved") return "info";
  if (status === "cancelled") return "outline";
  return "warning";
}

interface ProfileCardProps {
  readonly project: EnvironmentProject;
  readonly profile: ProjectExecutionProfile | undefined;
  readonly inheritedSelection: ModelSelection | null;
  readonly inheritedRuntimeMode: RuntimeMode;
  readonly inheritedInteractionMode: ProviderInteractionMode;
  readonly instanceEntries: ReturnType<typeof deriveProviderInstanceEntries>;
  readonly modelOptionsByInstance: ReturnType<typeof getCustomModelOptionsByInstance>;
  readonly onSave: (
    input: ProjectExecutionProfileUpdateInput,
  ) => Promise<SupervisorProfileSaveResult>;
}

function ProfileCard({
  project,
  profile,
  inheritedSelection,
  inheritedRuntimeMode,
  inheritedInteractionMode,
  instanceEntries,
  modelOptionsByInstance,
  onSave,
}: ProfileCardProps) {
  const [optimisticProfile, setOptimisticProfile] = useState<ProjectExecutionProfile | null>(null);
  const profileRevisionFromServer = profileRevision(profile);
  const effectiveProfile =
    optimisticProfile !== null && optimisticProfile.revision > profileRevisionFromServer
      ? optimisticProfile
      : profile;
  const sourceDraft = useMemo(() => supervisorProfileDraft(effectiveProfile), [effectiveProfile]);
  const [draft, setDraft] = useState(sourceDraft);
  const [dirtyFields, setDirtyFields] = useState<ReadonlySet<SupervisorProfileDraftField>>(
    () => new Set(),
  );
  const [expectedRevision, setExpectedRevision] = useState(() => profileRevision(effectiveProfile));
  const [pendingConflictRevision, setPendingConflictRevision] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const sourceRevision = profileRevision(effectiveProfile);

  useEffect(() => {
    if (optimisticProfile !== null && profileRevisionFromServer >= optimisticProfile.revision) {
      setOptimisticProfile(null);
    }
  }, [optimisticProfile, profileRevisionFromServer]);

  useEffect(() => {
    setDraft((current) => reconcileSupervisorProfileDraft(current, sourceDraft, dirtyFields));
    setExpectedRevision((current) =>
      reconcileSupervisorProfileRevision(
        current,
        sourceRevision,
        dirtyFields,
        pendingConflictRevision,
      ),
    );
    if (pendingConflictRevision !== null && sourceRevision >= pendingConflictRevision) {
      setPendingConflictRevision(null);
    }
  }, [dirtyFields, pendingConflictRevision, sourceDraft, sourceRevision]);

  const updateDraftField = <Field extends SupervisorProfileDraftField>(
    field: Field,
    value: (typeof draft)[Field],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setDirtyFields((current) => {
      if (current.has(field)) return current;
      return new Set([...current, field]);
    });
  };

  const save = async () => {
    if (saving || pendingConflictRevision !== null) return;
    setSaving(true);
    const result = await onSave(supervisorProfileUpdateInput(project.id, draft, expectedRevision));
    if (result.type === "success") {
      setOptimisticProfile(result.profile);
      setDraft(supervisorProfileDraft(result.profile));
      setDirtyFields(new Set());
    }
    if (result.type === "revision-conflict") {
      setPendingConflictRevision((current) =>
        pendingSupervisorProfileRevision(current, result.actualRevision),
      );
    } else if (result.type !== "failure") {
      setExpectedRevision((current) => expectedRevisionAfterSupervisorProfileSave(current, result));
    }
    setSaving(false);
  };

  const inheritedSelectionLabel = inheritedSelection
    ? `${inheritedSelection.instanceId} / ${inheritedSelection.model}`
    : "No supervisor model available";

  return (
    <article className="rounded-xl border border-border/60 bg-card/20 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{project.title}</h3>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
            {project.workspaceRoot}
          </p>
        </div>
        <Badge variant={profile ? "info" : "outline"}>
          {profile ? `Revision ${profile.revision}` : "Defaults"}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FormField label="Provider and model">
          <div className="space-y-2">
            <Select
              value={draft.modelSelection === null ? "inherit" : "override"}
              onValueChange={(value) => {
                if (value === "inherit") {
                  updateDraftField("modelSelection", null);
                } else if (value === "override" && inheritedSelection !== null) {
                  updateDraftField("modelSelection", inheritedSelection);
                }
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={`Provider and model source for ${project.title}`}
              >
                <SelectValue>
                  {draft.modelSelection === null ? "Inherit from supervisor" : "Override"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="inherit">Inherit from supervisor</SelectItem>
                <SelectItem value="override" disabled={inheritedSelection === null}>
                  Override
                </SelectItem>
              </SelectPopup>
            </Select>
            {draft.modelSelection !== null ? (
              <ProviderModelPicker
                activeInstanceId={draft.modelSelection.instanceId}
                model={draft.modelSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerAriaLabel={`Provider and model override for ${project.title}`}
                triggerVariant="outline"
                triggerClassName="w-full max-w-none justify-between text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) =>
                  updateDraftField(
                    "modelSelection",
                    modelSelectionForUpdate(draft.modelSelection, instanceId, model),
                  )
                }
              />
            ) : (
              <p
                className="truncate px-1 text-[10px] text-muted-foreground"
                title={inheritedSelectionLabel}
              >
                {inheritedSelectionLabel}
              </p>
            )}
          </div>
        </FormField>

        <FormField label="Runtime mode">
          <Select
            value={draft.runtimeMode ?? "inherit"}
            onValueChange={(value) =>
              value &&
              updateDraftField("runtimeMode", value === "inherit" ? null : (value as RuntimeMode))
            }
          >
            <SelectTrigger size="sm" aria-label={`Runtime mode for ${project.title}`}>
              <SelectValue>
                {draft.runtimeMode === null
                  ? `Inherit from supervisor (${RUNTIME_MODE_LABELS[inheritedRuntimeMode]})`
                  : RUNTIME_MODE_LABELS[draft.runtimeMode]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="inherit">Inherit from supervisor</SelectItem>
              {Object.entries(RUNTIME_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FormField>

        <FormField label="Interaction mode">
          <Select
            value={draft.interactionMode ?? "inherit"}
            onValueChange={(value) =>
              value &&
              updateDraftField(
                "interactionMode",
                value === "inherit" ? null : (value as ProviderInteractionMode),
              )
            }
          >
            <SelectTrigger size="sm" aria-label={`Interaction mode for ${project.title}`}>
              <SelectValue>
                {draft.interactionMode === null
                  ? `Inherit from supervisor (${INTERACTION_MODE_LABELS[inheritedInteractionMode]})`
                  : INTERACTION_MODE_LABELS[draft.interactionMode]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="inherit">Inherit from supervisor</SelectItem>
              {Object.entries(INTERACTION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FormField>

        <FormField label="Max parallel tasks">
          <Input
            nativeInput
            type="number"
            min={1}
            max={64}
            aria-label={`Max parallel tasks for ${project.title}`}
            value={draft.maxParallelTasks}
            onChange={(event) => updateDraftField("maxParallelTasks", event.target.value)}
          />
        </FormField>
        <FormField label="Retry attempts">
          <Input
            nativeInput
            type="number"
            min={1}
            max={20}
            aria-label={`Retry attempts for ${project.title}`}
            value={draft.retryAttempts}
            onChange={(event) => updateDraftField("retryAttempts", event.target.value)}
          />
        </FormField>
        <FormField label="Retry backoff (ms)">
          <Input
            nativeInput
            type="number"
            min={0}
            max={86_400_000}
            aria-label={`Retry backoff in milliseconds for ${project.title}`}
            value={draft.retryBackoffMs}
            onChange={(event) => updateDraftField("retryBackoffMs", event.target.value)}
          />
        </FormField>
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          size="sm"
          variant="outline"
          aria-label={`Save profile for ${project.title}`}
          disabled={saving || pendingConflictRevision !== null}
          onClick={() => void save()}
        >
          <SaveIcon className="size-3.5" />
          {saving
            ? "Saving..."
            : pendingConflictRevision !== null
              ? "Waiting for latest profile..."
              : "Save profile"}
        </Button>
      </div>
    </article>
  );
}

function GoalCard({
  goal,
  projects,
  cancelling,
  onCancel,
}: {
  readonly goal: SupervisorGoal;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
}) {
  const progress = goalTaskProgress(goal.tasks);
  const canCancel = canCancelSupervisorGoal(goal.status);
  return (
    <article className="rounded-xl border border-border/60 bg-card/20 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{goal.title}</h3>
            <Badge variant={goalStatusVariant(goal.status)}>{goal.status}</Badge>
          </div>
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {goal.prompt}
          </p>
          <p className="text-[11px] text-muted-foreground/75">
            {progress.completed} of {progress.total} tasks completed
          </p>
        </div>
        {canCancel ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`${cancelling ? "Cancelling" : "Cancel"} goal ${goal.title}`}
            disabled={cancelling}
            onClick={onCancel}
          >
            <XIcon className="size-3.5" />
            {cancelling ? "Cancelling..." : "Cancel"}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 divide-y divide-border/50 border-t border-border/50">
        {goal.tasks.map((task) => {
          const project = projects.find((candidate) => candidate.id === task.projectId);
          return (
            <div
              key={task.id}
              className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-xs font-medium text-foreground">{task.title}</span>
                  <Badge size="sm" variant={taskStatusVariant(task.status)}>
                    {task.status}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground/75">
                  {project?.title ?? task.projectId} / {task.role}
                </p>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {task.attempts.length} {task.attempts.length === 1 ? "attempt" : "attempts"}
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function SupervisorSettings() {
  const environment = usePrimaryEnvironment();
  const allProjects = useProjects();
  const allThreads = useThreadShells();
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const handleNewThread = useNewThreadHandler();
  const { draftsByThreadKey, draftThreadsByThreadKey } = useComposerDraftStore(
    useShallow((store) => ({
      draftsByThreadKey: store.draftsByThreadKey,
      draftThreadsByThreadKey: store.draftThreadsByThreadKey,
    })),
  );
  const environmentId = environment?.environmentId ?? null;
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const eligibleThreads = useMemo(
    () => (environmentId ? eligibleSupervisorThreads(allThreads, environmentId) : []),
    [allThreads, environmentId],
  );
  const configurationQuery = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.supervisorConfigurationLive({ environmentId, input: {} })
      : null,
  );
  const profilesQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.supervisorProfilesLive({ environmentId, input: {} }) : null,
  );
  const goalsQuery = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.supervisorGoalsLive({ environmentId, input: { limit: 100 } })
      : null,
  );
  const updateConfiguration = useAtomCommand(serverEnvironment.updateSupervisorConfiguration, {
    label: "supervisor configuration update",
  });
  const updateProfile = useAtomCommand(serverEnvironment.updateSupervisorProfile, {
    label: "supervisor profile update",
  });
  const cancelGoal = useAtomCommand(serverEnvironment.cancelSupervisorGoal, {
    label: "supervisor goal cancel",
  });
  const configuration = configurationQuery.data?.configuration ?? null;
  const profiles = profilesQuery.data?.profiles ?? [];
  const goals = goalsQuery.data?.goals ?? [];
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const threadSelectionContextRef = useRef<string | null>(null);
  const [designationBusy, setDesignationBusy] = useState(false);
  const [pendingDesignationThreadId, setPendingDesignationThreadId] = useState<ThreadId | null>(
    null,
  );
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [creating, setCreating] = useState(false);
  const [cancellingGoalIds, setCancellingGoalIds] = useState<ReadonlySet<string>>(() => new Set());

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const firstEntry = instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const firstSelection = firstEntry?.models[0]
    ? ({
        instanceId: firstEntry.instanceId,
        model: firstEntry.models[0].slug,
      } satisfies ModelSelection)
    : null;

  const eligibleThreadIds = useMemo(
    () => eligibleThreads.map((thread) => thread.id),
    [eligibleThreads],
  );
  const threadSelectionContext = `${environmentId ?? ""}:${configuration?.threadId ?? ""}`;

  useEffect(() => {
    const contextChanged = threadSelectionContextRef.current !== threadSelectionContext;
    threadSelectionContextRef.current = threadSelectionContext;
    setSelectedThreadId((currentSelection) =>
      reconcileSupervisorThreadSelection({
        currentSelection,
        configuredThreadId: configuration?.threadId ?? null,
        eligibleThreadIds,
        contextChanged,
      }),
    );
  }, [configuration?.threadId, eligibleThreadIds, threadSelectionContext]);

  useEffect(() => {
    if (!projects.some((project) => project.id === createProjectId)) {
      setCreateProjectId(projects[0]?.id ?? "");
    }
  }, [createProjectId, projects]);

  const designatedThread = configuration?.threadId
    ? (allThreads.find(
        (thread) => thread.environmentId === environmentId && thread.id === configuration.threadId,
      ) ?? null)
    : null;
  const designatedDraftEntry = configuration?.threadId
    ? (Object.entries(draftThreadsByThreadKey).find(
        ([, draft]) =>
          draft.environmentId === environmentId && draft.threadId === configuration.threadId,
      ) ?? null)
    : null;
  const designatedDraft = designatedDraftEntry?.[1] ?? null;
  const designatedComposer = designatedDraftEntry
    ? (draftsByThreadKey[designatedDraftEntry[0]] ?? null)
    : null;
  const designatedDraftSelection = designatedComposer?.activeProvider
    ? (designatedComposer.modelSelectionByProvider[designatedComposer.activeProvider] ?? null)
    : null;
  const designatedSelection = designatedThread?.modelSelection ?? designatedDraftSelection;
  const designatedProjectId = designatedThread?.projectId ?? designatedDraft?.projectId ?? null;
  const designatedProject = projects.find((project) => project.id === designatedProjectId) ?? null;
  const designatedProvider = designatedSelection
    ? instanceEntries.find((entry) => entry.instanceId === designatedSelection.instanceId)
    : null;
  const inheritedRuntimeMode =
    designatedThread?.runtimeMode ?? designatedDraft?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const inheritedInteractionMode =
    designatedThread?.interactionMode ??
    designatedDraft?.interactionMode ??
    DEFAULT_PROVIDER_INTERACTION_MODE;
  const replacingSupervisor = configuration?.threadId != null;
  const createDialogCopy = supervisorDraftDialogCopy(replacingSupervisor);
  const pendingDesignationThread = pendingDesignationThreadId
    ? eligibleThreads.find((thread) => thread.id === pendingDesignationThreadId)
    : undefined;
  const existingThreadDialogCopy = supervisorThreadReplacementDialogCopy(
    pendingDesignationThread?.title ?? pendingDesignationThreadId ?? "the selected thread",
  );

  const designate = async (threadId: ThreadId | null, expectedRevision: number) => {
    if (!environmentId) return false;
    setDesignationBusy(true);
    const result = await updateConfiguration({
      environmentId,
      input: { threadId, expectedRevision },
    });
    setDesignationBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not update supervisor", squashAtomCommandFailure(result));
      }
      return false;
    }
    return true;
  };

  const createSupervisor = async () => {
    if (!environmentId || !configuration || !createProjectId || creating) return;
    const project = projects.find((candidate) => candidate.id === createProjectId);
    if (!project) return;
    setCreating(true);
    try {
      await handleNewThread(scopeProjectRef(environmentId, project.id), {
        onDraftReady: async (draft) => {
          await requireSuccessfulSupervisorDesignation(
            designate(draft.threadId, configuration.revision),
          );
        },
      });
      setCreateDialogOpen(false);
    } catch (error) {
      if (!(error instanceof SupervisorDesignationFailedError)) {
        reportFailure("Could not create supervisor draft", error);
      }
    } finally {
      setCreating(false);
    }
  };

  const requestExistingThreadDesignation = () => {
    if (!configuration || !selectedThreadId || designationBusy) return;
    const targetThreadId = selectedThreadId as ThreadId;
    const decision = existingSupervisorDesignationDecision(configuration.threadId, targetThreadId);
    if (decision === "unchanged") return;
    if (decision === "confirm") {
      setPendingDesignationThreadId(targetThreadId);
      return;
    }
    void designate(targetThreadId, configuration.revision);
  };

  const confirmExistingThreadDesignation = async () => {
    if (!configuration || !pendingDesignationThreadId || designationBusy) return;
    if (pendingDesignationThreadId === configuration.threadId) {
      setPendingDesignationThreadId(null);
      return;
    }
    if (await designate(pendingDesignationThreadId, configuration.revision)) {
      setPendingDesignationThreadId(null);
    }
  };

  const saveProfile = async (input: ProjectExecutionProfileUpdateInput) => {
    if (!environmentId) return { type: "failure" } as const;
    const result = await updateProfile({ environmentId, input });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      if (isSupervisorRevisionConflictError(error)) {
        reportFailure(
          "Execution profile changed",
          new Error(
            "Your edits were kept. Waiting for the latest profile before you can save again.",
          ),
        );
        return { type: "revision-conflict", actualRevision: error.actualRevision } as const;
      }
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save execution profile", error);
      }
      return { type: "failure" } as const;
    }
    return { type: "success", profile: result.value.profile } as const;
  };

  const handleCancelGoal = async (goal: SupervisorGoal) => {
    if (!environmentId || cancellingGoalIds.has(goal.id)) return;
    setCancellingGoalIds((current) => updatePendingGoalCancellations(current, goal.id, true));
    try {
      const result = await cancelGoal({
        environmentId,
        input: { goalId: goal.id, expectedRevision: goal.revision },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not cancel goal", squashAtomCommandFailure(result));
      }
    } finally {
      setCancellingGoalIds((current) => updatePendingGoalCancellations(current, goal.id, false));
    }
  };

  return (
    <SettingsPageContainer className="max-w-4xl">
      <SettingsSection
        title="Supervisor Identity"
        icon={<BrainCircuitIcon className="size-4" />}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!configuration || projects.length === 0}
            onClick={() => setCreateDialogOpen(true)}
          >
            <PlusIcon className="size-3.5" />
            {replacingSupervisor ? "Replace supervisor" : "Create supervisor"}
          </Button>
        }
      >
        {!environmentId ? (
          <QueryMessage>No primary environment is connected.</QueryMessage>
        ) : configurationQuery.error ? (
          <QueryMessage error>{configurationQuery.error}</QueryMessage>
        ) : !configuration ? (
          <QueryMessage>Loading supervisor configuration...</QueryMessage>
        ) : (
          <div className="space-y-4 rounded-xl border border-border/60 bg-card/20 px-4 py-4 sm:px-5">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CircleDotIcon className="size-3.5 text-muted-foreground" />
                  <span className="text-sm font-semibold text-foreground">
                    {configuration.threadId
                      ? (designatedThread?.title ??
                        (designatedDraft ? "Unstarted supervisor draft" : "Designated thread"))
                      : "Supervision disabled"}
                  </span>
                  <Badge variant={configuration.threadId ? "success" : "outline"}>
                    {configuration.threadId ? "Global Supervisor" : "Disabled"}
                  </Badge>
                </div>
                {configuration.threadId ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>Project: {designatedProject?.title ?? "Unavailable"}</span>
                    <span>
                      Provider:{" "}
                      {designatedProvider?.displayName ??
                        designatedSelection?.instanceId ??
                        "Pending"}
                    </span>
                    <span>Model: {designatedSelection?.model ?? "Choose before first send"}</span>
                    <span className="font-mono">{configuration.threadId}</span>
                  </div>
                ) : null}
              </div>
              {configuration.threadId ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={designationBusy}
                  onClick={() => void designate(null, configuration.revision)}
                >
                  <BanIcon className="size-3.5" />
                  Disable
                </Button>
              ) : null}
            </div>

            <div className="border-t border-border/55 pt-4">
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                Designate an existing top-level thread, or create a normal draft. The provider
                harness becomes immutable after the thread starts; provider and model controls
                remain available in the draft composer before the first send.
              </p>
              {eligibleThreads.length === 0 ? (
                <p className="text-xs text-muted-foreground">No eligible existing threads.</p>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select
                    value={selectedThreadId}
                    onValueChange={(value) => setSelectedThreadId(value ?? "")}
                  >
                    <SelectTrigger
                      size="sm"
                      className="min-w-0 flex-1"
                      aria-label="Existing supervisor thread"
                    >
                      <SelectValue placeholder="Select a thread">
                        {eligibleThreads.find((thread) => thread.id === selectedThreadId)?.title}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {eligibleThreads.map((thread) => {
                        const project = projects.find(
                          (candidate) => candidate.id === thread.projectId,
                        );
                        return (
                          <SelectItem key={thread.id} value={thread.id}>
                            {thread.title} / {project?.title ?? "Unknown project"}
                          </SelectItem>
                        );
                      })}
                    </SelectPopup>
                  </Select>
                  <Button
                    size="sm"
                    disabled={
                      designationBusy ||
                      !selectedThreadId ||
                      selectedThreadId === configuration.threadId
                    }
                    onClick={requestExistingThreadDesignation}
                  >
                    Designate
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Goals" icon={<TargetIcon className="size-4" />}>
        {!environmentId ? (
          <QueryMessage>No primary environment is connected.</QueryMessage>
        ) : goalsQuery.error ? (
          <QueryMessage error>{goalsQuery.error}</QueryMessage>
        ) : !goalsQuery.data ? (
          <QueryMessage>Loading supervisor goals...</QueryMessage>
        ) : goals.length === 0 ? (
          <QueryMessage>No supervisor goals yet.</QueryMessage>
        ) : (
          <div className="space-y-3">
            {goals.map((goal) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                projects={projects}
                cancelling={cancellingGoalIds.has(goal.id)}
                onCancel={() => void handleCancelGoal(goal)}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Execution Profiles" icon={<WorkflowIcon className="size-4" />}>
        <p className="px-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
          Defaults used when the supervisor delegates work to each project. Existing task overrides
          still take precedence.
        </p>
        {!environmentId ? (
          <QueryMessage>No primary environment is connected.</QueryMessage>
        ) : profilesQuery.error ? (
          <QueryMessage error>{profilesQuery.error}</QueryMessage>
        ) : !profilesQuery.data ? (
          <QueryMessage>Loading execution profiles...</QueryMessage>
        ) : projects.length === 0 ? (
          <QueryMessage>No projects are available in the primary environment.</QueryMessage>
        ) : (
          <div className="space-y-3">
            {projects.map((project) => {
              const profile = profiles.find((candidate) => candidate.projectId === project.id);
              return (
                <ProfileCard
                  key={`${project.environmentId}:${project.id}`}
                  project={project}
                  profile={profile}
                  inheritedSelection={
                    designatedSelection ?? project.defaultModelSelection ?? firstSelection
                  }
                  inheritedRuntimeMode={inheritedRuntimeMode}
                  inheritedInteractionMode={inheritedInteractionMode}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  onSave={saveProfile}
                />
              );
            })}
          </div>
        )}
      </SettingsSection>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{createDialogCopy.title}</DialogTitle>
            <DialogDescription>{createDialogCopy.description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <FormField label="Project">
              <Select
                value={createProjectId}
                onValueChange={(value) => setCreateProjectId(value ?? "")}
              >
                <SelectTrigger size="sm" aria-label="Supervisor project">
                  <SelectValue placeholder="Select a project">
                    {projects.find((project) => project.id === createProjectId)?.title}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </FormField>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={!createProjectId || creating}
              onClick={() => void createSupervisor()}
            >
              {creating ? "Creating..." : createDialogCopy.buttonLabel}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingDesignationThreadId !== null}
        onOpenChange={(open) => {
          if (!open && !designationBusy) setPendingDesignationThreadId(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{existingThreadDialogCopy.title}</DialogTitle>
            <DialogDescription>{existingThreadDialogCopy.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="outline" disabled={designationBusy} />}>
              Cancel
            </DialogClose>
            <Button
              size="sm"
              disabled={designationBusy || pendingDesignationThreadId === null}
              onClick={() => void confirmExistingThreadDesignation()}
            >
              {designationBusy ? "Replacing..." : existingThreadDialogCopy.buttonLabel}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
