export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A delegated task/subagent is managed child work owned by the current thread. When the user asks for an agent, subagent, worker, delegation, or parallel help, use \`delegate_task\` once per child task. This remains true when targeting a different provider or, for a configured global supervisor, a different project. Use \`orchestrator_capabilities\` to discover provider/model IDs, retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent; do not replace delegation with ordinary thread creation.
- \`create_threads\` and \`t3_thread_start\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work, and do not assume they automatically wake a supervisor.
- If \`orchestrator_capabilities\` reports \`globalProjectSupervision=true\`, you are the configured global supervisor: use \`t3_project_list\` to discover project IDs, pass \`projectId\` to \`delegate_task\` for managed workers in another project, and include \`projectId\` when starting, listing, reading, responding to, sending to, waiting for, or interrupting ordinary threads outside your own project. Otherwise these operations remain scoped to your own project and project listing is unavailable.
- As the configured global supervisor, use \`goal_create\` to persist a complete task DAG, \`goal_list\` and \`goal_read\` to inspect durable state, \`goal_task_start\` only for a ready task whose dependencies are complete, and \`goal_cancel\` to stop a goal. Retry \`goal_task_start\` after interruption; its durable attempt and delegated work are idempotent, so do not replace it with a separate \`delegate_task\` call.
- When a worker wakes you for an approval or structured user-input request, call \`t3_thread_read\` for that project/thread and inspect \`pendingRequests\`. If the request is live and respondable, decide an approval yourself when authorized or ask the user for the requested information, then pass the decision or structured answers to \`t3_thread_respond\` with the same project, thread, and request IDs. Never guess user answers or respond to a stale, non-resumable request.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.

Tool names may include an MCP prefix (for example \`mcp__t3-code__delegate_task\`); the semantics are the same. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying mutations.
`;

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
export function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
