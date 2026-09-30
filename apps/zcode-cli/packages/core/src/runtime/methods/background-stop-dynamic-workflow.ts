// ============================================================
// Background stop branch of workflow run (local_dynamic_workflow dispatch of runtime.stopBackgroundTask)
// ============================================================
//
// This is the end of the only cancellation path. Both entries flow into the same implementation:
//   1. GUI: v4 `cancelBackgroundWork {workId}` → `app.cancelBackgroundTask`
//      → `runtime.cancelBackgroundTask` → `runtime.stopBackgroundTask` (lenient)
//   2. Model: `TaskStop` tool → `backgroundTaskControlPort.stopBackgroundTask`
//      (runtime-tools.ts binds it to the same `runtime.stopBackgroundTask`, strict: true)
// The two only differ in strict (strict allows terminated tasks to return not_running instead of relaxed success),
// Dispatch behaves exactly as this module does later - there is no second cancel semantics.
//
// The purpose of forming a separate module is to limit the size of background.ts and avoid further increasing the branch complexity.
// The background.ts side only keeps one import and one line of dispatch.

import type { AgentRuntimeInternal } from "../internal.js";
import type {
  RuntimeBackgroundStopInitiator,
  RuntimeBackgroundStopResult,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";

/**
 * Stops a workflow run: hands the taskId (≡ runId ≡ workId, there is no identity mapping table) to
 * `DynamicWorkflowRunPort.cancel`.
 *
 * The port aborts the AbortController in its registry: it aborts the in-flight asks, kills the sandbox child processes, and has the engine settle the run as
 * `stopped(user | model)` via `stop(initiator)` (**not** `errored` — the journal is a persistent record the app reads, and the semantics of the two states differ from each other and
 * from the resume UX, so the harness never encodes a failure as a stop).
 *
 * Both degradations return a structured result instead of pretending to succeed:
 *   - the port is absent entirely (an unwired host) → the capability is not supported;
 *   - the port returns false for an unknown/settled run → not_found.
 */
export async function stopDynamicWorkflowBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  unsupported: (target: TypedRuntimeBackgroundStopTarget) => RuntimeBackgroundStopResult,
  initiator?: RuntimeBackgroundStopInitiator,
): Promise<RuntimeBackgroundStopResult> {
  const port = this.dynamicWorkflowRunPort;
  if (!port) {
    return unsupported(target);
  }
  // First remember "who stopped it" and then abort: the final notification is cast when the waiter is settled later, and the registry entry is between the two.
  // Unique shared state. Written before abort,
  // Otherwise, the settlement may read a null value first.
  if (initiator !== undefined && target.registryTask !== undefined) {
    this.runtimeTaskRegistry.update(target.taskId, (current) => ({
      ...current,
      stopInitiator: initiator,
    }));
  }
  // The reason is as follows: cancel is dropped into the library: run is settled as `stopped(user|model)`,
  // Final state notification and GetWorkflowRun read "who stopped" from the journal, instead of just relying on the registry above to find out.
  // The fact that the user manually stopped is also the one read by AmendWorkflow's confirmation-free rule: the user has just expressed "stop" and the model should be revised and asked again.
  const cancelled = await port.cancel(target.taskId, initiator);
  if (!cancelled) {
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      type: "local_dynamic_workflow",
    };
  }
  return {
    ok: true,
    status: "cancelled",
    taskId: target.taskId,
    type: "local_dynamic_workflow",
  };
}
