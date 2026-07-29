import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  GoalCreateTool,
  GoalTaskStartTool,
  ScheduleTaskTool,
  ThreadRespondTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent/subagent");
    assert.include(DelegateTaskTool.description ?? "", "cross-provider");
    assert.include(DelegateTaskTool.description ?? "", "cross-project");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
    assert.include(ThreadRespondTool.description ?? "", "accepted_for_delivery");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "STRUCTURED OBJECT");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });

  it("publishes provider-compatible approval and structured answer inputs", () => {
    const schema = Tool.getJsonSchema(ThreadRespondTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "projectId",
      "threadId",
      "requestId",
      "decision",
      "answers",
      "clientRequestId",
    ]);
  });

  it("publishes durable goal DAG and idempotent start tools", () => {
    const createSchema = Tool.getJsonSchema(GoalCreateTool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    assert.hasAllKeys(createSchema.properties ?? {}, [
      "title",
      "prompt",
      "tasks",
      "clientRequestId",
    ]);
    assert.include(GoalCreateTool.description ?? "", "complete task DAG");
    assert.include(GoalTaskStartTool.description ?? "", "deterministic idempotency keys");
  });
});
