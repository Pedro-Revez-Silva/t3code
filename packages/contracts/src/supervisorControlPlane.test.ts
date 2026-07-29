import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ProjectExecutionProfileUpdateInput,
  SupervisorConfigurationUpdateInput,
  SupervisorGoalUpdateInput,
} from "./supervisorControlPlane.ts";

const decodeProfile = Schema.decodeUnknownSync(ProjectExecutionProfileUpdateInput);
const decodeGoal = Schema.decodeUnknownSync(SupervisorGoalUpdateInput);
const decodeConfigurationUpdate = Schema.decodeUnknownSync(SupervisorConfigurationUpdateInput);

describe("supervisor control plane contracts", () => {
  it("decodes bounded profiles and complete goal DAG definitions", () => {
    const profile = decodeProfile({
      projectId: "project:one",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      maxParallelTasks: 3,
      retry: { maxAttempts: 2, backoffMs: 500 },
      expectedRevision: 0,
    });
    assert.equal(profile.maxParallelTasks, 3);

    const goal = decodeGoal({
      clientRequestId: "goal-1",
      title: "Ship durable supervisor",
      prompt: "Implement and verify the control plane.",
      tasks: [
        {
          projectId: "project:one",
          taskKey: "implement",
          title: "Implement",
          prompt: "Implement the backend.",
          role: "implementation",
          priority: 10,
          dependencies: [],
        },
        {
          projectId: "project:one",
          taskKey: "review",
          title: "Review",
          prompt: "Review the backend.",
          role: "review",
          priority: 0,
          dependencies: ["implement"],
        },
      ],
    });
    assert.equal(goal.tasks.length, 2);
  });

  it("rejects unbounded profile and DAG values", () => {
    assert.throws(() =>
      decodeProfile({
        projectId: "project:one",
        maxParallelTasks: 65,
        retry: { maxAttempts: 1, backoffMs: 0 },
        expectedRevision: 0,
      }),
    );
    assert.throws(() =>
      decodeGoal({
        title: "Empty",
        prompt: "No tasks",
        tasks: [],
      }),
    );
  });

  it("represents an explicit disabled supervisor as a revisioned null designation", () => {
    assert.deepEqual(decodeConfigurationUpdate({ threadId: null, expectedRevision: 3 }), {
      threadId: null,
      expectedRevision: 3,
    });
  });
});
