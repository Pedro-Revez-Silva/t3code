import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreatedThread,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpGoalCancelInput,
  OrchestratorMcpGoalCreateInput,
  OrchestratorMcpGoalListInput,
  OrchestratorMcpGoalListResult,
  OrchestratorMcpGoalReadInput,
  OrchestratorMcpGoalResult,
  OrchestratorMcpGoalTaskStartInput,
  OrchestratorMcpGoalTaskStartResult,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpProjectListResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadRespondInput,
  OrchestratorMcpThreadRespondResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadStartInput,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorMcpService];

export const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the V2 provider instances, models, inherited runtime settings, and app-owned orchestration features available to this T3 thread.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Delegate one task to a T3-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Use this whenever the user asks for an agent, subagent, worker, delegated task, or parallel help, including cross-provider and configured-supervisor cross-project work. Configured global supervisors may select another project with projectId; that child uses the selected project's root and is created atomically with its parent task relationship. The childThreadId is backing storage, not an ordinary top-level thread. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. Prefer mode='async' and poll task_status for long work; mode='wait' blocks until completion or timeout.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read the latest durable state and final summary for a T3-owned delegated task created by this parent thread.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Request interruption of an active T3-owned delegated task. Completed tasks are returned unchanged.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

export const GoalCreateTool = Tool.make("goal_create", {
  description:
    "Create one durable supervisor goal as a complete task DAG. Every dependency must name another taskKey in the same request; keys must be unique and the graph must be acyclic. Reuse clientRequestId when retrying.",
  parameters: OrchestratorMcpGoalCreateInput,
  success: OrchestratorMcpGoalResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create a supervisor goal")
  .annotate(Tool.Destructive, true);

export const GoalListTool = Tool.make("goal_list", {
  description: "List durable supervisor goals and their task DAG state.",
  parameters: OrchestratorMcpGoalListInput,
  success: OrchestratorMcpGoalListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List supervisor goals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const GoalReadTool = Tool.make("goal_read", {
  description:
    "Read one durable supervisor goal, including dependencies, attempts, and reconciled delegated-task state.",
  parameters: OrchestratorMcpGoalReadInput,
  success: OrchestratorMcpGoalResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a supervisor goal")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const GoalTaskStartTool = Tool.make("goal_task_start", {
  description:
    "Start one ready task from a durable goal DAG. Dependencies must be complete. The reserved attempt and delegated work use deterministic idempotency keys, so retry this call after interruption instead of creating work manually.",
  parameters: OrchestratorMcpGoalTaskStartInput,
  success: OrchestratorMcpGoalTaskStartResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a ready goal task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const GoalCancelTool = Tool.make("goal_cancel", {
  description:
    "Cancel a durable supervisor goal and request cancellation of linked delegated work.",
  parameters: OrchestratorMcpGoalCancelInput,
  success: OrchestratorMcpGoalResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel a supervisor goal")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent recurring work in the app scheduler, which runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text: {type:'interval', everyMs:3600000} means hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} means weekday mornings. By default (bindToCurrentThread=true) each run posts into THIS thread; use false only when the user wants a fresh top-level thread per run. Provider, model, and runtime settings inherit from this thread. Report the returned schedule and nextRunAt after success.",
  parameters: OrchestratorMcpScheduleTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  description:
    "List the recurring scheduled tasks in the calling thread's project, including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

export const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Create one or more ORDINARY TOP-LEVEL T3 conversations. This is not delegation and does not create child agents/subagents. If the user asks for agents, subagents, workers, delegation, or parallel help, call delegate_task once per child instead—even when selecting different providers. Use create_threads only when the user explicitly asks for separate/new/top-level threads or conversations. Each entry may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create T3 threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadStartTool = Tool.make("t3_thread_start", {
  description:
    "Create an ordinary TOP-LEVEL T3 conversation and immediately start its first turn. This is not a managed child agent/subagent, has no automatic supervisor wake guarantee, and must not replace delegate_task for delegated work. The new thread inherits this thread's project, checkout, provider, model, and runtime settings unless overridden. Configured global supervisors may select another project by projectId; that launch uses the selected project's root workspace. Use t3_thread_wait and t3_thread_read to collect its result.",
  parameters: OrchestratorMcpThreadStartInput,
  success: OrchestratorMcpCreatedThread,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectListTool = Tool.make("t3_project_list", {
  description:
    "List project IDs and titles in this T3 environment. Available only to the configured global supervisor; use a returned projectId with cross-project thread tools.",
  success: OrchestratorMcpProjectListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List T3 projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List T3 threads in the calling thread's project, newest first. Configured global supervisors may select another project by projectId. Filter by durable run status or title and paginate with the returned cursor.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List T3 threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read durable state and a paginated timeline from a T3 thread in the selected project (the calling project by default). The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Continue with afterPosition=nextPosition.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadRespondTool = Tool.make("t3_thread_respond", {
  description:
    "Accept a command to deliver a response to one live pending runtime request returned by t3_thread_read.pendingRequests. Approval requests require decision; structured user-input requests require answers. Configured global supervisors may select another project by projectId. The result is accepted_for_delivery because V2 queues process-bound provider delivery after durable command acceptance; it does not claim provider acknowledgement. Reuse clientRequestId when retrying.",
  parameters: OrchestratorMcpThreadRespondInput,
  success: OrchestratorMcpThreadRespondResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Respond to a T3 thread request")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadSendTool = Tool.make("t3_thread_send", {
  description:
    "Send a message to a T3 thread in the calling project. mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for a T3 thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description:
    "Request interruption of a running turn in a T3 thread in the calling project. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a T3 thread")
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  GoalCreateTool,
  GoalListTool,
  GoalReadTool,
  GoalTaskStartTool,
  GoalCancelTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  CreateThreadsTool,
  ProjectListTool,
  ThreadStartTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadRespondTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
);
