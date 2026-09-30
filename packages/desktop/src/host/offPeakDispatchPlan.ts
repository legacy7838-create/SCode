import { OffPeakPermanentDispatchError } from "@zcode/services/node";

/**
 * Three branches are distributed during leisure time:
 * - resume: conversation_id has been backfilled = has been run, continue running the same session and send the prompt word for resuming;
 * - bound-first-run: The session_id is created and bound in the session but has not been run yet. Resume binds the session concurrent task to the original prompt.
 *   (Align dispatchCronRun's targetTaskId path);
 * - init: form creation, new exclusive session.
 */
type OffPeakDispatchKind = "resume" | "bound-first-run" | "init";

export function resolveOffPeakDispatchKind(request: {
  conversationId?: string;
  sessionId?: string;
}): OffPeakDispatchKind {
  if (request.conversationId?.trim()) return "resume";
  if (request.sessionId?.trim()) return "bound-first-run";
  return "init";
}

/** The binding session has been deleted by the user: retrying is meaningless and permanent (otherwise it will back off until the ticket expires and then retry the number). */
class OffPeakBoundSessionDeletedError extends OffPeakPermanentDispatchError {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session was deleted: ${sessionId}`);
    this.name = "OffPeakBoundSessionDeletedError";
  }
}

/**
 * The binding session is running user turn: transient and handed over to the scheduler to back off and try again.
 * Must be thrown before writing session mode - CLI session/send will reject with -32010,
 * However, setMode does not have an active turn check. Writing the configuration first and then being busy will quietly switch the user session to the permission mode of the task.
 */
class OffPeakBoundSessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session is busy: ${sessionId}`);
    this.name = "OffPeakBoundSessionBusyError";
  }
}

export function assertBoundSessionDispatchable(params: {
  sessionId: string;
  deleted: boolean;
  running: boolean;
}): void {
  if (params.deleted) throw new OffPeakBoundSessionDeletedError(params.sessionId);
  if (params.running) throw new OffPeakBoundSessionBusyError(params.sessionId);
}
