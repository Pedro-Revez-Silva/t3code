# Orchestrator MCP Server

## Purpose

T3 exposes V2 orchestration through its app-owned MCP endpoint. A provider
agent can use this endpoint to:

- create an app-owned sub-agent on any supported provider instance;
- wait for or poll the sub-agent's durable result;
- cancel an active delegated task; and
- create one or more ordinary top-level T3 threads;
- list and incrementally read project threads;
- send or steer follow-up messages; and
- wait for or interrupt ordinary thread runs.

These are T3 orchestration operations, not provider-native sub-agent APIs.
Delegated tasks always create a T3 child thread and run. The child receives
only the supplied task prompt, plus an optional role instruction supplied in
the same tool call. Parent conversation history is not copied into the child.

`ThreadManagementService` is the shared server application boundary for V2
WebSocket commands and MCP. It owns project-scoped lookup, listing, send-mode
selection, durable send postconditions, wait polling, and interrupt selection;
`OrchestratorV2` remains the lower-level command/event processor. Transport
adapters only authenticate, resolve transport-specific inputs, and shape
responses.

## Transport And Authentication

The orchestration tools share the existing authenticated HTTP MCP endpoint:

```text
http://127.0.0.1:<server-port>/mcp
```

The provider-visible server key is `t3-code`. The endpoint registers both the
preview toolkit and the orchestration toolkit.

Before `ProviderSessionManager` opens a new V2 provider session, it asks
`McpSessionRegistry` for a credential scoped to:

- the T3 environment;
- the parent T3 thread;
- the concrete provider instance; and
- the provider session.

The credential grants `preview` and `orchestration` capabilities. Credentials
are process-local, are lost on server restart, and are revoked when the provider
session or owning thread is torn down. They currently have no time-based expiry.
The raw token is not persisted in orchestration state.

The MCP HTTP server resolves the bearer token and supplies the resulting
`McpInvocationScope` to tool handlers. Orchestration handlers additionally
check the `orchestration` capability before reading or mutating state.

### Experimental global supervisor

`T3CODE_EXPERIMENTAL_GLOBAL_SUPERVISOR_THREAD_ID` is a one-time compatibility
bootstrap: when no persisted designation exists, startup stores that ordinary
T3 thread as the supervisor. After bootstrap, authenticated environment RPC is
the only way to reassign the persisted designation. MCP tools cannot designate
a supervisor. Setting the authenticated configuration RPC's `threadId` to
`null` creates a revisioned disabled state. That differs from an uninitialized
revision-0 database, and later process starts do not let the environment
bootstrap overwrite it.

While it has an active run owned by the credential's provider instance, the
configured thread can call `t3_project_list`, then pass a returned `projectId`
to `delegate_task`, `t3_thread_start`, `t3_thread_list`, `t3_thread_read`,
`t3_thread_respond`, `t3_thread_send`, `t3_thread_wait`, or
`t3_thread_interrupt`. Cross-project starts use the selected project's root
workspace and normal setup workflow. They do not accept arbitrary workspace
paths.

This is an experimental single-environment capability. Every global operation
reads the persisted designation and verifies the exact active provider runtime
session. Reassignment takes effect immediately: credentials for the old thread
lose new global calls without a restart. The capability advertised when an MCP
credential is issued is only feature-discovery metadata, not authorization.

The current supervisor can use `goal_create` to persist a complete, acyclic task
DAG, `goal_list`/`goal_read` to inspect it, and `goal_task_start` for one ready
task whose dependencies are complete. Task starts reserve deterministic durable
attempts before calling the existing idempotent delegated-task path; retry the
same start after a crash rather than calling `delegate_task` separately.
`goal_cancel` closes the goal and requests cancellation of linked delegated work.
Per-project execution profiles supply default model/runtime/interaction values,
parallel limits, and bounded retries; explicit delegation settings still win and
parent runtime/interaction privilege ceilings still apply.
Terminal app-owned task events also reconcile linked goal attempts by durable
node ID during supervisor wake processing. Completion, failure, cancellation,
and interruption therefore update goal subscriptions without requiring a
`goal_read`; replay is idempotent and does not repeatedly increment revisions.

Configured supervisors use `delegate_task` with `projectId` for managed workers.
One atomic `delegated_task.request` creates the parent task relationship, child
thread, and child run. A foreign child belongs to the selected project and does
not inherit the parent's branch or worktree, so runtime policy resolves the
selected project's root.

A pending runtime request in an app-owned delegated child or its durable
terminal `subagent_result` transfer queues a server-authored internal message in
the parent. Wake processing replays the stored V2 event stream before following
live events. Each event receives bounded handler retries; stream failures
resubscribe with backoff. Command and message IDs are derived from the durable
task source, so full restart replay converges on the existing command receipt.
An invalid event is logged and skipped after bounded retries so later work can
continue.

`t3_thread_start` remains available as a top-level conversation convenience,
including across projects, but it creates no durable supervisor watch
relationship and does not promise automatic wake-up. Wake messages do not
bypass project authorization; follow-up foreign-project operations still
require the active global supervisor scope.

## Provider Injection

### Codex V2

Codex app-server receives the remote MCP server through command-line config
overrides:

```text
-c mcp_servers.t3-code.url=http://127.0.0.1:<port>/mcp
-c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"
```

The provider-session token is placed in `T3_MCP_BEARER_TOKEN`. Both the
production Codex launcher and the injectable test launcher use the same
projection helper.

### Claude Agent SDK V2

Claude receives an HTTP MCP server in its query options:

```ts
{
  mcpServers: {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:<port>/mcp",
      headers: {
        Authorization: "Bearer <provider-session-token>",
      },
    },
  },
  allowedTools: [
    // existing allowed tools
    "mcp__t3-code__*",
  ],
}
```

The adapter logs only whether MCP configuration exists; it does not log the
server headers or token.

### Cursor Agent SDK V2

Cursor receives the same authenticated HTTP MCP endpoint through the SDK's
`mcpServers` agent and send options. The adapter passes the authorization header
to the SDK but projects only redacted option metadata into protocol diagnostics.

### Grok ACP V2

Grok receives the authenticated HTTP MCP endpoint through the ACP
`session/new`, `session/load`, and `session/fork` `mcpServers` field. The shared
ACP adapter owns standard protocol behavior; the Grok flavor adds xAI extension
requests such as structured user questions.

ACP does not define native subagents or active steering. Grok therefore uses
orchestrator-owned child threads and implements steering through
cancel-and-restart. Its current driver also lacks `session/fork`, so app forks
use portable context transfer. These are orchestrator policies, not
provider-specific MCP tools.

### ACP Registry V2

The `acpRegistry` driver is the generic flavor of the same shared ACP adapter.
Each provider instance names an agent from the official ACP Registry. At
session startup the driver resolves the current platform distribution, uses a
managed binary cache or the declared `npx`/`uvx` package, and then negotiates
standard ACP capabilities during `initialize`. A local executable may override
the managed command without changing the registry-declared arguments or
environment.

Capabilities such as session loading, session forking, models, modes, and MCP
transport are enabled only when the selected agent advertises them. Missing
features degrade through V2 policy: steering uses interrupt-and-restart,
forking uses portable context when native `session/fork` is unavailable, and
subagents use orchestrator-owned child threads. Registry agents do not receive
provider-specific extensions; those remain in flavors such as Grok.

### Initial Provider Support

The V2 provider adapters are Codex, Claude Agent SDK, Cursor Agent SDK, and
Grok plus generic registry agents over ACP.
Capability discovery still reports other registered provider instances, but marks them
unavailable for orchestration when no V2 adapter exists. This keeps provider
selection model-visible without allowing a request that cannot run.

## Tool Surface

The server exposes the following orchestration tools.

### `orchestrator_capabilities`

Returns:

- the inherited provider instance and model;
- the parent runtime and interaction modes;
- registered provider instances and advertised models;
- whether each provider can run a child task; and
- feature flags for polling, cancellation, and batch thread creation.

Unavailable providers include model-visible constraints such as missing V2
adapter support, disabled state, missing executable, or missing authentication.

### `delegate_task`

Creates a T3-owned child thread and immediately dispatches the supplied task
prompt.

```ts
type DelegateTaskInput = {
  projectId?: string;
  task: string;
  target?: {
    providerInstanceId?: string;
    driverKind?: string;
    model?: string;
  };
  title?: string;
  role?: "implementation" | "research" | "review" | "design" | "test" | "general";
  mode?: "async" | "wait";
  timeoutMs?: number;
  clientRequestId?: string;
  runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode?: "inherit" | "plan" | "default";
};
```

Provider, model, runtime mode, and interaction mode inherit from the parent
when omitted. Selecting a different provider without a model uses that
provider's first advertised model. A configured global supervisor may select a
foreign project; the child then uses that project and a root workspace rather
than inheriting the parent's branch or worktree.

Delegation requires an active parent run owned by the MCP credential's
provider session. The request becomes the V2 command
`delegated_task.request`.

`mode: "async"` returns the current durable state immediately.
`mode: "wait"` polls the same durable state until it becomes terminal or the
timeout expires. A wait timeout does not cancel the child; the result sets
`waitTimedOut: true`, and the caller can continue with `task_status`.

```ts
type DelegateTaskResult = {
  taskId: string;
  childThreadId: string;
  childRunId: string | null;
  childNodeId: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  providerInstanceId: string;
  model: string | null;
  summary: string | null;
  resultContextTransferId: string | null;
  waitTimedOut: boolean;
};
```

### `task_status`

Reads a delegated task from the parent thread's durable projection. A task ID
from another parent thread is rejected. Terminal results include the child
summary and the durable `subagent_result` context transfer ID when available.

### `task_cancel`

Interrupts the active child run through the normal V2 `run.interrupt` command.
It is idempotent for terminal tasks and accepts an optional cancellation
reason.

### `create_threads`

Creates between one and twenty ordinary top-level T3 threads:

```ts
type CreateThreadsInput = {
  threads: Array<{
    prompt?: string;
    title?: string;
    target?: {
      providerInstanceId?: string;
      driverKind?: string;
      model?: string;
    };
    runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
    interactionMode?: "inherit" | "plan" | "default";
  }>;
  clientRequestId?: string;
};
```

Each entry independently resolves provider, model, and modes. The new threads
inherit the parent's project, branch, and worktree path, but they have no
sub-agent lineage. Entries with a prompt immediately dispatch a run; entries
without a prompt remain idle.

### `t3_thread_start`

Creates one ordinary top-level thread and immediately dispatches its first
prompt. It is the single-thread convenience form of `create_threads` and
returns the created thread and run IDs. Use `clientRequestId` when a caller may
retry the request. The configured global supervisor can supply `projectId` to
start the thread in another project.

### `t3_project_list`

Lists project IDs and titles for the configured global supervisor. Ordinary
thread credentials receive `capability_denied`. A global credential whose
caller thread no longer has an active run owned by that provider instance
receives `parent_not_active`.

### `t3_thread_list`

Lists durable thread shells in the calling thread's project, newest first. The
configured global supervisor can select another project with `projectId`.
Callers can filter by title, run status, and whether app-owned sub-agent threads
are included. Results are bounded and offset-paginated. Deleted threads and
threads outside the selected project are never exposed.

### `t3_thread_read`

Reads a project-scoped thread's durable state, recent runs, and visible
timeline. The default `messages` view returns user messages, assistant
messages, and proposed plans. The `activity` view also returns summarized tool,
reasoning, checkpoint, handoff, and runtime-request items. Large item text is
bounded and reports whether it was truncated. `afterPosition` and
`nextPosition` support incremental reads.

Thread and message results include required `createdBy` and `creationSource`
provenance. MCP-created threads and user-role messages use `createdBy: "agent"`
and `creationSource: "mcp"`; provider output uses `creationSource: "provider"`.
Actor and ingress are separate so agent-authored user-role messages remain
distinguishable from human-authored messages.

### `t3_thread_send`

Sends a message to an ordinary or delegated thread in the calling project:

- `auto` starts an idle thread, steers a fully active turn, or queues behind a
  turn that is not yet steerable;
- `queue` creates a separate follow-up run after active work;
- `steer` requires a steerable active provider turn; and
- `restart` requires an active provider turn and uses the orchestrator's
  interrupt-and-restart path.

The target runtime and interaction modes may not be broader than the caller's.
Stable command and message IDs are derived from `clientRequestId` for
idempotent retries.

### `t3_thread_wait`

Waits for a selected run to become `completed`, `failed`, `cancelled`,
`interrupted`, or `rolled_back`. Without `runId`, it pins the latest run at call
time; an idle thread returns immediately. A timeout reports the latest durable
status and does not cancel work.

### `t3_thread_interrupt`

Interrupts a selected active run through the normal V2 `run.interrupt` command.
Without `runId`, it selects the newest interruptible run. A terminal run is
returned unchanged, and a thread with no active provider turn returns
`no_active_run`.

## Delegated Task Lifecycle

The MCP server is a command ingress into V2. It does not call provider adapters
directly.

```text
provider model
  -> MCP tools/call delegate_task
  -> authenticated OrchestratorMcpService
  -> shared ThreadManagementService
  -> V2 delegated_task.request command
  -> child thread + child run
  -> parent app_owned subagent projection
  -> parent/child execution nodes
  -> consumed subagent_spawn context transfer
  -> normal provider effect and runtime ingestion
  -> child run reaches a terminal state
  -> parent subagent/node/turn item finalized
  -> consumed subagent_result context transfer
  -> wait result or later task_status result
```

The child thread has lineage relationship `subagent` and points back to the
parent node. The parent gets an `app_owned` sub-agent projection and a
sub-agent turn item so the existing debug UI can render progress.

Terminal provider events trigger finalization. The event stream first replays
persisted events and then follows live events, so finalization also runs after
a server restart. An existing `subagent_result` transfer makes finalization
idempotent.

The result summary prefers the latest assistant content from the child run and
falls back to a terminal-status message when no assistant text exists.

Thread reads also return `pendingRequests`, a sanitized structured projection of
durable runtime requests and their approval or user-input turn items. Entries
include the request kind and status, associated run/node IDs, whether the request
is currently respondable, a non-resumable reason where applicable, approval
prompt/kind, and structured questions. Provider credentials and native session
identifiers are not exposed.

### `t3_thread_respond`

Responds to a live pending request from `t3_thread_read.pendingRequests`.
Approval requests require `decision`; user-input requests require structured
`answers`. Supplying both, neither, or the wrong payload for the request kind is
rejected. `clientRequestId` makes a retry idempotent. The configured global
supervisor may supply `projectId` for a foreign project; ordinary credentials
remain limited to their current project. Stale and non-resumable requests cannot
be answered. The response status is `accepted_for_delivery`: V2 durably accepts
the command and queues process-bound provider delivery, but this result does not
claim provider acknowledgement or outbox success. The request, node, and turn
item remain nonterminal until the provider accepts the response. A terminal
delivery failure releases the request and advances its durable delivery
generation; retry with the same `clientRequestId` to enqueue that new attempt.
Retries while an attempt is still reserved remain idempotent with the in-flight
command. Process loss expires the request rather than falsely marking it
resolved, although provider delivery can still be unknown if the process ended
between provider acknowledgement and durable completion.

## Policy And Idempotency

- A child runtime mode may stay equal to or become narrower than the parent
  mode. It may not escalate privileges.
- A child interaction mode may stay equal to or narrow from `default` to
  `plan`. It may not escalate from `plan` to `default`.
- General thread management is limited to the calling thread's project unless
  its credential has the experimental `global-orchestration` capability and its
  caller thread currently has an active run owned by the credential's exact V2
  provider runtime session. Send and runtime-request response additionally enforce the same
  runtime and interaction privilege ceiling as child creation.
- Provider instances must be enabled, installed, available, authenticated, and
  backed by a V2 adapter.
- A requested model must be advertised by the selected provider when the
  provider publishes a model list.
- `clientRequestId` derives stable command, thread, and message IDs within the
  caller thread. Retrying the same call returns the same durable work across MCP
  credential rotation and server restart.
- Calls without `clientRequestId` receive a generated request key and create
  new work.

Expected denials use the typed `OrchestratorMcpFailure` result:

```text
capability_denied
parent_not_active
provider_unavailable
model_unavailable
runtime_mode_escalation_denied
interaction_mode_escalation_denied
task_not_found
task_not_cancellable
project_not_found
thread_not_found
run_not_found
thread_not_sendable
thread_not_interruptible
invalid_request
orchestration_error
```

## Code Ownership

- Shared schemas: `packages/contracts/src/orchestratorMcp.ts`
- MCP service: `apps/server/src/mcp/OrchestratorMcpService.ts`
- Tool definitions and handlers:
  `apps/server/src/mcp/toolkits/orchestrator/`
- HTTP registration and authentication:
  `apps/server/src/mcp/McpHttpServer.ts`
- Credential lifecycle: `apps/server/src/mcp/McpSessionRegistry.ts`
- Provider injection:
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts` and V2 adapters
- Durable delegated-task command and finalization:
  `apps/server/src/orchestration-v2/Orchestrator.ts`

## Verification

The integration test uses the real MCP toolkit registration, V2 orchestrator,
SQL persistence, event ingestion, projections, and checkpoints. Only the
external provider adapters are deterministic test implementations.

Coverage includes:

- capability discovery;
- cross-provider delegated completion;
- prompt-only child context;
- parent and child lineage projections;
- spawn and result context transfers;
- async status polling;
- cancellation;
- batch ordinary-thread creation;
- project-scoped thread listing and timeline reads;
- ordinary-thread send, wait, steering, and interruption;
- inheritance and per-thread provider overrides; and
- idempotent retries.

Provider adapter tests separately verify Codex, Claude, Cursor, Grok, and ACP
Registry behavior and MCP injection. The provider-session manager test verifies
that credentials exist before an adapter opens and are revoked when it closes.
