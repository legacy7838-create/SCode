// ============================================================
// Workflow Submit Port - actor terminal-result verdict boundary
// ============================================================

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

/**
 * A single violation produced by the validator, designed to go straight into a tool_result for repair: one per line, containing
 * the JSON path, what was expected (expected) and what was actually got (got).
 *
 * The structure matches the Violation on the dynamic-workflow synthesis side; the driver is responsible for mapping the engine's
 * Violation onto this port as-is, and contracts does not depend on dynamic-workflow in the other direction.
 */
export interface SubmitViolation {
  /** The JSON path of the violation's location, shaped like `$`, `$.foo` or `$.items[0]`. */
  path: string;
  /** A short description of the expected shape/value. */
  expected: string;
  /** A short description of the value actually obtained. */
  got: string;
}

export interface SubmitResultRequest {
  /** The tool call id within the actor child session that made the submit_result call. */
  toolCallId: ToolCallId | string;
  /** The raw structured result the model submitted (arbitrary JSON not validated by this port). */
  result: unknown;
  trace: TraceContext;
}

/** The engine accepted this submission: the actor turn should end once the result is returned. */
export interface SubmitAccepted {
  accept: true;
}

/** The engine rejected this submission: the violation list is returned so the model can repair and retry within the same session. */
export interface SubmitRejected {
  accept: false;
  violations: readonly SubmitViolation[];
}

export type SubmitVerdict = SubmitAccepted | SubmitRejected;

export interface WorkflowSubmitPort {
  /**
   * Submits the actor's structured terminal result and waits for the engine's adjudication.
   *
   * Unlike CoordinatorResponsePort, this **blocks** until the engine has finished validating: the engine may run several rounds of
   * repair / budget judgment out of band, so resolve may take arbitrarily long. Cancellation is not expressed through this port -- it is handled by aborting
   * that tool call, and the driver turns an out-of-band ask cancellation into a turn abort.
   *
   * The routing identity (instance/actor/session) is bound by the port's closure and cannot be overridden by the model.
   */
  respond(request: SubmitResultRequest): Promise<SubmitVerdict>;
}
