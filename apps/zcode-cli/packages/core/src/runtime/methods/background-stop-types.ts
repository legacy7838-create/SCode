// ============================================================
// Background stop dispatching share type
// ============================================================
// Extracted from background.ts for use with each stop branch module dispatched by RuntimeTaskType
// (See background-stop-dynamic-workflow.ts). Separate files are used so that branch modules do not need to import
// background.ts, prevent the two from importing types from each other, and also limit the size of background.ts.
//
// background.ts continues to re-export these names, so agent-runtime.ts /
// The existing import path of internal-turn-methods.ts remains unchanged.

import type { BackgroundTaskInfo, BackgroundTaskInfoStatus } from "../deps.js";
import type { RuntimeTaskSnapshot, RuntimeTaskType } from "../../runtime-task/registry.js";
import type { TraceContext } from "../deps.js";

export type RuntimeBackgroundStopFailureReason =
  | "background_task_cancel_not_supported"
  | "background_task_not_found"
  | "background_task_not_running";

export type RuntimeBackgroundStopStatus = BackgroundTaskInfoStatus | RuntimeTaskSnapshot["status"];

export type RuntimeBackgroundStopResult =
  | {
      alreadyTerminal?: boolean;
      command?: string;
      ok: true;
      status: RuntimeBackgroundStopStatus;
      taskId: string;
      type: RuntimeTaskType;
    }
  | {
      reason: RuntimeBackgroundStopFailureReason;
      ok: false;
      status?: RuntimeBackgroundStopStatus;
      taskId: string;
      type?: RuntimeTaskType;
    };

/**
 * What arrives from the GUI / background panel via
 * `runtime.cancelBackgroundTask` is `"user"`, the model's `TaskStop` is `"model"`; system paths such as the runtime
 * sweep leave it unset. The dwf branch records it on the registry entry, and the terminal-state notification uses it to tell the model "this is the user's
 * decision, do not resume it on your own".
 */
export type RuntimeBackgroundStopInitiator = "user" | "model";

export interface RuntimeBackgroundStopOptions {
  initiator?: RuntimeBackgroundStopInitiator;
  strict?: boolean;
  traceContext?: TraceContext;
}

export interface RuntimeBackgroundStopTarget {
  currentStatus: RuntimeBackgroundStopStatus | undefined;
  existing: BackgroundTaskInfo | undefined;
  registryTask: RuntimeTaskSnapshot | undefined;
  taskId: string;
  taskType: RuntimeTaskType | undefined;
}

/** A stop target whose taskType is already determined; the branch modules accept only this shape. */
export type TypedRuntimeBackgroundStopTarget = RuntimeBackgroundStopTarget & {
  taskType: RuntimeTaskType;
};
