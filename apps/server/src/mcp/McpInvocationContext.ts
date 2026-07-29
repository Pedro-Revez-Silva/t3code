import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const ALL_MCP_CAPABILITIES = ["preview", "orchestration", "worktree"] as const;
export const GLOBAL_ORCHESTRATION_MCP_CAPABILITY = "global-orchestration" as const;
export type McpCapability =
  | (typeof ALL_MCP_CAPABILITIES)[number]
  | typeof GLOBAL_ORCHESTRATION_MCP_CAPABILITY;

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Random MCP credential id retained for credential-scoped routing and revocation. */
  readonly providerSessionId: string;
  /** V2 provider runtime session that caused this credential to be issued. */
  readonly runtimeProviderSessionId: ProviderSessionId;
  /** Durable ownership generation for this thread/provider runtime. */
  readonly runtimeGeneration?: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
