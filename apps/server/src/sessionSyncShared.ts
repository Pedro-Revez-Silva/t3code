import { createHash } from "node:crypto";
import { basename } from "node:path";

import { type ModelSelection, ProjectId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { type ProjectionRepositoryError } from "./persistence/Errors.ts";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "./persistence/Services/ProjectionThreads.ts";

export function makeHashedProjectId(prefix: string, workspaceRoot: string): ProjectId {
  const digest = createHash("sha1").update(workspaceRoot).digest("hex");
  return ProjectId.make(`${prefix}-${digest.slice(0, 16)}`);
}

export function makeCanonicalWorkspaceProjectId(workspaceRoot: string): ProjectId {
  return makeHashedProjectId("project", workspaceRoot);
}

export function makeProjectTitleFromRoot(workspaceRoot: string): string {
  return basename(workspaceRoot) || "project";
}

export function truncateSessionSummary(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function compareIso(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function chooseCanonicalWorkspaceProject<
  Project extends {
    readonly id: ProjectId;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
>(projects: ReadonlyArray<Project>): Project {
  const [first, ...rest] = projects;
  if (!first) {
    throw new Error("chooseCanonicalWorkspaceProject requires at least one project.");
  }

  return rest.reduce((canonical, project) => {
    const createdAtComparison = compareIso(project.createdAt, canonical.createdAt);
    if (createdAtComparison < 0) {
      return project;
    }
    if (createdAtComparison > 0) {
      return canonical;
    }

    const updatedAtComparison = compareIso(project.updatedAt, canonical.updatedAt);
    if (updatedAtComparison < 0) {
      return project;
    }
    if (updatedAtComparison > 0) {
      return canonical;
    }

    return project.id < canonical.id ? project : canonical;
  }, first);
}

export function ensureCanonicalWorkspaceProject(input: {
  readonly workspaceRoot: string;
  readonly projectTitle: string;
  readonly defaultModelSelection: ModelSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
}): Effect.Effect<
  ProjectId,
  ProjectionRepositoryError,
  ProjectionProjectRepository | ProjectionSnapshotQuery
> {
  return Effect.gen(function* () {
    const projectionProjects = yield* ProjectionProjectRepository;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const existingProjectOption = yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
      input.workspaceRoot,
    );
    const existingProject = Option.getOrUndefined(existingProjectOption);
    const projectId = existingProject?.id ?? makeCanonicalWorkspaceProjectId(input.workspaceRoot);

    yield* projectionProjects.upsert({
      projectId,
      title: existingProject?.title ?? input.projectTitle,
      workspaceRoot: input.workspaceRoot,
      defaultModelSelection: existingProject?.defaultModelSelection ?? input.defaultModelSelection,
      scripts: existingProject?.scripts ?? [],
      createdAt:
        existingProject && compareIso(existingProject.createdAt, input.createdAt) <= 0
          ? existingProject.createdAt
          : input.createdAt,
      updatedAt:
        existingProject && compareIso(existingProject.updatedAt, input.updatedAt) >= 0
          ? existingProject.updatedAt
          : input.updatedAt,
      deletedAt: null,
    });

    return projectId;
  });
}

export function reconcileWorkspaceProjectDuplicates(): Effect.Effect<
  boolean,
  ProjectionRepositoryError,
  ProjectionProjectRepository | ProjectionThreadRepository | ProjectionSnapshotQuery
> {
  return Effect.gen(function* () {
    const projectionProjects = yield* ProjectionProjectRepository;
    const projectionThreads = yield* ProjectionThreadRepository;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const activeProjectsByWorkspaceRoot = new Map<
      string,
      Array<{
        readonly id: ProjectId;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>
    >();

    for (const project of snapshot.projects) {
      const projectsForWorkspace = activeProjectsByWorkspaceRoot.get(project.workspaceRoot);
      if (projectsForWorkspace) {
        projectsForWorkspace.push(project);
      } else {
        activeProjectsByWorkspaceRoot.set(project.workspaceRoot, [project]);
      }
    }

    let changed = false;
    for (const projects of activeProjectsByWorkspaceRoot.values()) {
      if (projects.length < 2) {
        continue;
      }

      const canonicalProject = chooseCanonicalWorkspaceProject(projects);
      const duplicateProjectIds = new Set(
        projects
          .filter((project) => project.id !== canonicalProject.id)
          .map((project) => project.id),
      );
      if (duplicateProjectIds.size === 0) {
        continue;
      }

      for (const thread of snapshot.threads) {
        if (!duplicateProjectIds.has(thread.projectId)) {
          continue;
        }

        const storedThreadOption = yield* projectionThreads.getById({ threadId: thread.id });
        if (Option.isNone(storedThreadOption)) {
          continue;
        }

        yield* projectionThreads.upsert({
          ...storedThreadOption.value,
          projectId: canonicalProject.id,
        });
        changed = true;
      }

      for (const duplicateProjectId of duplicateProjectIds) {
        yield* projectionProjects.deleteById({ projectId: duplicateProjectId });
        changed = true;
      }
    }

    return changed;
  });
}
