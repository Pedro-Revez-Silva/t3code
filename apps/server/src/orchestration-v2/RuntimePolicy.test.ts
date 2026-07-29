import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import { layerFromProjectRepository, RuntimePolicyV2 } from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}

function makeTestLayer(input?: { readonly workspaceRoot?: string; readonly deletedAt?: string }) {
  return layerFromProjectRepository.pipe(
    Layer.provide(
      Layer.mock(ProjectionProjects.ProjectionProjectRepository)({
        getById: () =>
          Effect.succeed(
            Option.some({
              projectId,
              title: "Project",
              workspaceRoot: input?.workspaceRoot ?? "/project-root",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
              deletedAt: input?.deletedAt ?? null,
            }),
          ),
      }),
    ),
  );
}

const TestLayer = makeTestLayer();

it.layer(TestLayer)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );
});

it.layer(makeTestLayer({ deletedAt: "2026-06-22T00:00:00.000Z" }))(
  "RuntimePolicyV2 deleted project validation",
  (it) => {
    it.effect("rejects a deleted project before using a provisioned worktree", () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicyV2;
        const now = yield* DateTime.now;
        const exit = yield* Effect.exit(
          policy.resolve({
            thread: makeThread({ now, worktreePath: "/project-worktree" }),
            modelSelection,
          }),
        );
        assert.equal(exit._tag, "Failure");
      }),
    );
  },
);

it.layer(makeTestLayer({ workspaceRoot: "   " }))(
  "RuntimePolicyV2 workspace root validation",
  (it) => {
    it.effect("rejects a blank project root before using a provisioned worktree", () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicyV2;
        const now = yield* DateTime.now;
        const exit = yield* Effect.exit(
          policy.resolve({
            thread: makeThread({ now, worktreePath: "/project-worktree" }),
            modelSelection,
          }),
        );
        assert.equal(exit._tag, "Failure");
      }),
    );
  },
);
