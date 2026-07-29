import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  SupervisorTaskAttemptId,
} from "@t3tools/contracts";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { __testing } from "./OrchestratorMcpService.ts";

const callerThreadId = ThreadId.make("thread:idempotency-caller");
const targetThreadId = ThreadId.make("thread:idempotency-target");
const projectId = ProjectId.make("project:idempotency");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:idempotency"),
  threadId: callerThreadId,
  providerSessionId: "mcp-credential-before-restart",
  runtimeProviderSessionId: ProviderSessionId.make("runtime-session-before-restart"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

it("keeps MCP idempotency ids stable across credential and runtime session rotation", () => {
  const rotatedScope: McpInvocationScope = {
    ...scope,
    providerSessionId: "mcp-credential-after-restart",
    runtimeProviderSessionId: ProviderSessionId.make("runtime-session-after-restart"),
    issuedAt: 2,
  };
  const request = {
    requestKey: "client-request-1",
    operation: "thread-send",
    projectId,
    threadId: targetThreadId,
  } as const;

  expect(__testing.stableCommandId({ scope, ...request })).toBe(
    __testing.stableCommandId({ scope: rotatedScope, ...request }),
  );
  expect(__testing.stableThreadId({ scope, requestKey: request.requestKey, index: 0 })).toBe(
    __testing.stableThreadId({ scope: rotatedScope, requestKey: request.requestKey, index: 0 }),
  );
  expect(__testing.stableMessageId({ scope, requestKey: request.requestKey, index: 0 })).toBe(
    __testing.stableMessageId({ scope: rotatedScope, requestKey: request.requestKey, index: 0 }),
  );
  expect(__testing.stableOperationMessageId({ scope, ...request })).toBe(
    __testing.stableOperationMessageId({ scope: rotatedScope, ...request }),
  );
});

it("derives goal-attempt delegation identity independently of supervisor scope", () => {
  const attemptId = SupervisorTaskAttemptId.make("goal-attempt:handoff:1");
  expect(__testing.supervisorAttemptDelegationCommandId(attemptId)).toBe(
    "command:supervisor-goal-attempt:goal-attempt%3Ahandoff%3A1:delegate-task",
  );
});

it("separates MCP idempotency ids by caller, project, thread, and operation", () => {
  const base = {
    scope,
    requestKey: "client-request-1",
    operation: "thread-send",
    projectId,
    threadId: targetThreadId,
  } as const;
  const commandId = __testing.stableCommandId(base);
  const messageId = __testing.stableOperationMessageId(base);

  expect(
    __testing.stableCommandId({
      ...base,
      scope: { ...scope, threadId: ThreadId.make("thread:other-caller") },
    }),
  ).not.toBe(commandId);
  expect(
    __testing.stableCommandId({ ...base, projectId: ProjectId.make("project:other") }),
  ).not.toBe(commandId);
  expect(
    __testing.stableCommandId({ ...base, threadId: ThreadId.make("thread:other-target") }),
  ).not.toBe(commandId);
  expect(__testing.stableCommandId({ ...base, operation: "thread-interrupt" })).not.toBe(commandId);

  expect(
    __testing.stableOperationMessageId({
      ...base,
      scope: { ...scope, threadId: ThreadId.make("thread:other-caller") },
    }),
  ).not.toBe(messageId);
  expect(
    __testing.stableOperationMessageId({
      ...base,
      projectId: ProjectId.make("project:other"),
    }),
  ).not.toBe(messageId);
  expect(
    __testing.stableOperationMessageId({
      ...base,
      threadId: ThreadId.make("thread:other-target"),
    }),
  ).not.toBe(messageId);
  expect(__testing.stableOperationMessageId({ ...base, operation: "thread-interrupt" })).not.toBe(
    messageId,
  );
});

it("binds global caller authority to the active provider thread runtime", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:active-caller");
  const activeRun = {
    ordinal: 1,
    status: "running",
    providerInstanceId: scope.providerInstanceId,
    providerThreadId,
  } as OrchestrationV2ThreadProjection["runs"][number];
  const parent = {
    runs: [activeRun],
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId: scope.runtimeProviderSessionId,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;

  expect(__testing.activeCallerRunForScope(scope, parent)).toBe(activeRun);
  expect(
    __testing.activeCallerRunForScope(
      {
        ...scope,
        runtimeProviderSessionId: ProviderSessionId.make("runtime-session-stale"),
      },
      parent,
    ),
  ).toBeUndefined();
  expect(
    __testing.activeCallerRunForScope(
      { ...scope, providerInstanceId: ProviderInstanceId.make("claudeAgent") },
      parent,
    ),
  ).toBeUndefined();
});

it("applies project execution defaults only when delegation omits explicit settings", () => {
  const profile = {
    projectId,
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    maxParallelTasks: 2,
    retry: { maxAttempts: 2, backoffMs: 100 },
    revision: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  } as const;
  expect(__testing.executionProfileDefaults({}, profile)).toMatchObject({
    target: { providerInstanceId: "claudeAgent", model: "sonnet" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
  });
  expect(
    __testing.executionProfileDefaults(
      {
        target: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "auto",
        interactionMode: "default",
      },
      profile,
    ),
  ).toMatchObject({
    target: { providerInstanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "auto",
    interactionMode: "default",
  });
});

it("reports the persisted delegated-task provider instance instead of its driver", () => {
  const task = {
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex-work"),
  } as OrchestrationV2ThreadProjection["subagents"][number];
  expect(__testing.delegatedTaskProviderInstanceId(task)).toBe("codex-work");
});
