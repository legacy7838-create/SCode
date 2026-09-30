import { CREATE_WORKFLOW_TOOL_NAME, type TraceContext } from "@zcode/contracts";
import type { ExecutableToolCall } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Bring a **resumed** dwf run back under background tracking.
 *
 * Tracking on the submit path is done automatically by the tool executor when CreateWorkflow returns
 * backgrounded; resume is a v4 command with no in-flight tool call, so nobody performs the four things: the
 * runtime-task registry entry (**the session reclamation guard**: without it a session running a run is
 * reclaimed as idle and the completion notification has nowhere to be delivered), BackgroundTaskStarted
 * (the backgroundWorks panel and the cancellable flag), the polling / terminal-state waiter, and the
 * settlement notification. This method synthesizes one tool descriptor and runs it through the executor's
 * same trackBackgroundTask, getting all four back at once.
 *
 * The trade-offs behind the descriptor's fields:
 *   - `id` uses the **original toolCallId** (recovered from the persisted dwf_run.tool_call_id), because it is
 *     the tool card -> detail page linking key and the registry's parentToolCallId; when an old run lacks it,
 *     a resume-prefixed id is synthesized (observable, and impersonating no real tool row).
 *   - `name` is always CreateWorkflow: per-tool lifecycle dispatch (snapshot / waiting / cancellation /
 *     notification formatting) all looks it up by that name.
 *   - `input.name` feeds the display-name fallback chain (workflowTaskSubject): the resume command may carry
 *     it, and when absent the tracker falls back to taskId, which the UI side handles as fallbackName (the same
 *     semantics as the submit path).
 *
 * turnId is deliberately absent: resume is initiated by a UI command and belongs to no model turn (the same
 * reasoning as the rootTraceContext of run progress events, see dynamic-workflow-run-progress.ts).
 */
export async function trackResumedDynamicWorkflowRun(
  this: AgentRuntimeInternal,
  input: { runId: string; toolCallId?: string; name?: string; traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const toolCall: ExecutableToolCall = {
    id: input.toolCallId ?? `resume-${input.runId}`,
    name: CREATE_WORKFLOW_TOOL_NAME,
    input: input.name === undefined ? {} : { name: input.name },
  };
  await this.executor.trackExternalBackgroundTask(
    toolCall,
    { backgroundTaskId: input.runId, status: "backgrounded" },
    traceContext,
    undefined,
  );
}
