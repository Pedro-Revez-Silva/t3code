import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
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
  supervisorProfileDraft,
  supervisorProfileUpdateInput,
  supervisorDraftDialogCopy,
  supervisorThreadReplacementDialogCopy,
  updatePendingGoalCancellations,
} from "./SupervisorSettings.logic";

describe("supervisor settings helpers", () => {
  it("only offers top-level active threads from the primary environment", () => {
    const primary = EnvironmentId.make("primary");
    const eligible = makeThreadFixture({ environmentId: primary, title: "Eligible" });
    const child = makeThreadFixture({
      environmentId: primary,
      lineage: {
        rootThreadId: eligible.id,
        parentThreadId: eligible.id,
        relationshipToParent: "fork",
      },
    });
    const archived = makeThreadFixture({
      environmentId: primary,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeThreadFixture({ environmentId: EnvironmentId.make("remote") });

    expect(eligibleSupervisorThreads([eligible, child, archived, remote], primary)).toEqual([
      eligible,
    ]);
  });

  it("preserves provider options while the provider and model stay unchanged", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoning", value: "high" }],
    };

    expect(modelSelectionForUpdate(selection, selection.instanceId, selection.model)).toBe(
      selection,
    );
    expect(modelSelectionForUpdate(selection, selection.instanceId, "gpt-5.5")).toEqual({
      instanceId: selection.instanceId,
      model: "gpt-5.5",
    });
    expect(
      modelSelectionForUpdate(
        selection,
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
      ),
    ).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
    });
  });

  it("uses revision zero for an absent profile", () => {
    expect(profileRevision(undefined)).toBe(0);
  });

  it("keeps inherited nullable fields null in retry-only update payloads", () => {
    const draft = {
      ...supervisorProfileDraft(undefined),
      retryAttempts: "3",
      retryBackoffMs: "500",
    };

    expect(supervisorProfileUpdateInput(ProjectId.make("project-one"), draft, 0)).toEqual({
      projectId: "project-one",
      modelSelection: null,
      runtimeMode: null,
      interactionMode: null,
      maxParallelTasks: 4,
      retry: { maxAttempts: 3, backoffMs: 500 },
      expectedRevision: 0,
    });
  });

  it("reconciles live profile changes into pristine fields without replacing dirty edits", () => {
    const current = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: null,
      interactionMode: null,
      maxParallelTasks: "4",
      retryAttempts: "3",
      retryBackoffMs: "0",
    } as const;
    const source = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      maxParallelTasks: "8",
      retryAttempts: "1",
      retryBackoffMs: "200",
    } as const;

    expect(
      reconcileSupervisorProfileDraft(
        current,
        source,
        new Set(["modelSelection", "retryAttempts"]),
      ),
    ).toEqual({
      modelSelection: current.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      maxParallelTasks: "8",
      retryAttempts: "3",
      retryBackoffMs: "200",
    });
    expect(
      reconcileSupervisorProfileRevision(3, 4, new Set(["modelSelection", "retryAttempts"])),
    ).toBe(3);
    expect(reconcileSupervisorProfileRevision(3, 4, new Set())).toBe(4);
  });

  it("waits for the conflicting live profile before rebasing dirty edits", () => {
    const current = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: null,
      interactionMode: "plan" as const,
      maxParallelTasks: "4",
      retryAttempts: "3",
      retryBackoffMs: "0",
    };
    const remote = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required" as const,
      interactionMode: null,
      maxParallelTasks: "8",
      retryAttempts: "1",
      retryBackoffMs: "500",
    };
    const dirtyFields = new Set(["interactionMode", "retryAttempts"] as const);
    const pendingRevision = pendingSupervisorProfileRevision(null, 4);
    const expectedRevision = expectedRevisionAfterSupervisorProfileSave(2, {
      type: "revision-conflict",
      actualRevision: 4,
    });
    const reconciled = reconcileSupervisorProfileDraft(current, remote, dirtyFields);

    expect(expectedRevision).toBe(2);
    expect(reconcileSupervisorProfileRevision(2, 3, dirtyFields, pendingRevision)).toBe(2);
    expect(reconciled).toEqual({
      modelSelection: remote.modelSelection,
      runtimeMode: remote.runtimeMode,
      interactionMode: current.interactionMode,
      maxParallelTasks: remote.maxParallelTasks,
      retryAttempts: current.retryAttempts,
      retryBackoffMs: remote.retryBackoffMs,
    });
    expect(reconcileSupervisorProfileRevision(2, 4, dirtyFields, pendingRevision)).toBe(4);
    expect(supervisorProfileUpdateInput(ProjectId.make("project-one"), reconciled, 4)).toEqual({
      projectId: "project-one",
      modelSelection: remote.modelSelection,
      runtimeMode: remote.runtimeMode,
      interactionMode: current.interactionMode,
      maxParallelTasks: 8,
      retry: { maxAttempts: 3, backoffMs: 500 },
      expectedRevision: 4,
    });
  });

  it("waits for the newest live revision across repeated conflicts", () => {
    const dirtyFields = new Set(["retryAttempts"] as const);
    const firstConflict = pendingSupervisorProfileRevision(null, 4);
    const repeatedConflict = pendingSupervisorProfileRevision(firstConflict, 6);

    expect(firstConflict).toBe(4);
    expect(repeatedConflict).toBe(6);
    expect(
      expectedRevisionAfterSupervisorProfileSave(2, {
        type: "revision-conflict",
        actualRevision: 4,
      }),
    ).toBe(2);
    expect(
      expectedRevisionAfterSupervisorProfileSave(2, {
        type: "revision-conflict",
        actualRevision: 6,
      }),
    ).toBe(2);
    expect(reconcileSupervisorProfileRevision(2, 5, dirtyFields, repeatedConflict)).toBe(2);
    expect(reconcileSupervisorProfileRevision(2, 6, dirtyFields, repeatedConflict)).toBe(6);
    expect(expectedRevisionAfterSupervisorProfileSave(6, { type: "failure" })).toBe(6);
  });

  it("retains eligible thread selection across shell updates and resets when required", () => {
    const configuredThreadId = ThreadId.make("thread-configured");
    const selectedThreadId = ThreadId.make("thread-selected");
    const eligibleThreadIds = [configuredThreadId, selectedThreadId];

    expect(
      reconcileSupervisorThreadSelection({
        currentSelection: selectedThreadId,
        configuredThreadId,
        eligibleThreadIds,
        contextChanged: false,
      }),
    ).toBe(selectedThreadId);
    expect(
      reconcileSupervisorThreadSelection({
        currentSelection: selectedThreadId,
        configuredThreadId,
        eligibleThreadIds: [configuredThreadId],
        contextChanged: false,
      }),
    ).toBe(configuredThreadId);
    expect(
      reconcileSupervisorThreadSelection({
        currentSelection: selectedThreadId,
        configuredThreadId,
        eligibleThreadIds,
        contextChanged: true,
      }),
    ).toBe(configuredThreadId);
  });

  it("tracks concurrent goal cancellations independently", () => {
    const firstPending = updatePendingGoalCancellations(new Set(), "goal-one", true);
    const bothPending = updatePendingGoalCancellations(firstPending, "goal-two", true);
    const secondOnly = updatePendingGoalCancellations(bothPending, "goal-one", false);

    expect([...bothPending]).toEqual(["goal-one", "goal-two"]);
    expect([...secondOnly]).toEqual(["goal-two"]);
  });

  it("requires successful designation before draft navigation may continue", async () => {
    await expect(requireSuccessfulSupervisorDesignation(true)).resolves.toBeUndefined();
    await expect(requireSuccessfulSupervisorDesignation(false)).rejects.toMatchObject({
      name: "SupervisorDesignationFailedError",
    });
  });

  it("makes replacement authority cutover explicit", () => {
    expect(supervisorDraftDialogCopy(true)).toEqual({
      title: "Replace global supervisor?",
      description:
        "Opening the draft immediately revokes the current supervisor's authority, before the first send. If you abandon the draft, the previous supervisor is not restored automatically.",
      buttonLabel: "Replace and open draft",
    });
    expect(supervisorDraftDialogCopy(false).buttonLabel).toBe("Open draft");
  });

  it("confirms replacements, directly designates the first thread, and ignores reselection", () => {
    const currentThreadId = ThreadId.make("thread-current");

    expect(
      existingSupervisorDesignationDecision(currentThreadId, ThreadId.make("thread-replacement")),
    ).toBe("confirm");
    expect(existingSupervisorDesignationDecision(currentThreadId, currentThreadId)).toBe(
      "unchanged",
    );
    expect(
      existingSupervisorDesignationDecision(null, ThreadId.make("thread-first-supervisor")),
    ).toBe("designate");
  });

  it("describes the immediate cutover when confirming an existing thread", () => {
    expect(supervisorThreadReplacementDialogCopy("Release manager")).toEqual({
      title: "Replace global supervisor?",
      description:
        "Designating Release manager immediately revokes the current supervisor's authority. This change takes effect as soon as you confirm.",
      buttonLabel: "Replace supervisor",
    });
  });

  it("allows failed goals to be explicitly cancelled", () => {
    expect(canCancelSupervisorGoal("pending")).toBe(true);
    expect(canCancelSupervisorGoal("running")).toBe(true);
    expect(canCancelSupervisorGoal("failed")).toBe(true);
    expect(canCancelSupervisorGoal("completed")).toBe(false);
    expect(canCancelSupervisorGoal("cancelled")).toBe(false);
  });

  it("counts completed goal tasks", () => {
    expect(
      goalTaskProgress([
        { status: "completed" },
        { status: "running" },
        { status: "completed" },
      ] as never),
    ).toEqual({ completed: 2, total: 3 });
  });
});
