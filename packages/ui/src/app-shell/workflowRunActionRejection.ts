// ============================================================
// Detail page Cancel / Resume Structured explanation when rejected
// ============================================================
// When the old run is left running by mistake, click Cancel and the CLI will check that there is no such task.
// Resume ran into an old script that was no longer compiled - both commands only recorded a line of warn on the console, and the user saw "no response after clicking".
// Now the reasonCode on ACK is reversed into one sentence according to two word lists and hung under the status header; all copywriting with code outside the word list is universal.

import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  type CommandAck,
} from "@zcode/shared/zcode-protocol-v4";

export type WorkflowRunAction = "cancel" | "resume";

/**
 * The same capability-absent fault as useSavedWorkflowLauncher (the gateway's reasonCode for
 * V4CapabilityUnsupportedError).
 */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";

/**
 * The closed set of core stopBackgroundTask reasons with the `background_task_` prefix stripped
 * (minted by the bootstrap handler).
 */
const CANCEL_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_running",
  "cancel_not_supported",
]);
/** The closed set of reasons ported from DynamicWorkflowRunResumeErrorReason. */
const RESUME_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_resumable",
  "superseded",
  "already_running",
  "script_missing",
  "script_mismatch",
  "compile_failed",
]);

export interface WorkflowRunActionRejection {
  action: WorkflowRunAction;
  /**
   * A reason from the vocabulary, or `unsupported` (capability absent) / `generic` (outside the
   * vocabulary, the message carries the code).
   */
  reason: string;
  /**
   * The raw reasonCode (ack.status when absent); it is what the generic message shows and what the
   * log records.
   */
  code: string;
  /** The human-readable details carried by the ACK (bounded diagnostics for compile_failed). */
  message?: string;
}

/**
 * accepted / noop are not rejections → undefined; everything else is normalized against the
 * vocabulary.
 */
export function describeWorkflowRunActionRejection(
  action: WorkflowRunAction,
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunActionRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  const prefix =
    action === "cancel"
      ? BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX
      : WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX;
  const known = action === "cancel" ? CANCEL_REASONS : RESUME_REASONS;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(prefix)) {
    const suffix = ack.reasonCode.slice(prefix.length);
    if (known.has(suffix)) reason = suffix;
  }
  return { action, reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/**
 * Message key: `chat.toolCall.workflow.run.rejection.<action>.<reason>`; both vocabularies plus
 * unsupported and generic all live in the locale files.
 */
export function workflowRunActionRejectionMessageId(rejection: WorkflowRunActionRejection): string {
  return `chat.toolCall.workflow.run.rejection.${rejection.action}.${rejection.reason}`;
}
