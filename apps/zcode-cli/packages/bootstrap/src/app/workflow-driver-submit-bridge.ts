// ============================================================
// AgentRuntime-backed WorkflowDriver: submission bridge for typed results (submit_result)
// ============================================================
// Reason for repair: workflow-driver.ts has reached the upper limit of oxlint max-lines (400 lines), and the session-level submit port has been removed.
// This file becomes a free function and is connected to the upgrade bridge next door (`makeSessionEscalatePort` of workflow-driver-escalation.ts)
// Symmetrical one by one - the two are originally two sequences of the same shape (mid-turn blocking → reporting → engine response → unblocking deferred).
// The public side remains unchanged, there is only one call left on the driver class.
//
// All touches to driver state are passed in explicitly via {@link SubmitBridgeHost} (session table + reporting upward),
// This file does not hold any state of its own - the original method body is retained verbatim, just replacing `this.` with `host.`.

import type {
  SessionId,
  SubmitResultRequest,
  SubmitVerdict as ContractsSubmitVerdict,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import { WorkflowError, type WorkflowReportSink } from "@zcode/dynamic-workflow";
import { defer, rejectWith } from "./workflow-driver-helpers.js";
import type { SessionState } from "./workflow-driver-types.js";

/**
 * The host surface the driver hands to the submit bridge. Both are **references** to driver-private state (not copies): `sessions` is
 * the session table inside the class, and `sink` is Boundary B's upward reporting surface (`askSubmitAttempted` is resolved synchronously
 * by the engine within this call stack, so these two must be the matching pair of the very same generation).
 */
export interface SubmitBridgeHost {
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly sink: WorkflowReportSink;
}

/**
 * Builds a session-level submit port: the `submit_result` handler calls it mid-turn and blocks waiting for the verdict.
 *
 * The closure binds this session, so the model cannot override the routing identity (the instance is taken from `currentInstance`).
 */
export function makeSessionSubmitPort(
  host: SubmitBridgeHost,
  sessionId: SessionId,
): WorkflowSubmitPort {
  return {
    respond: (request: SubmitResultRequest): Promise<ContractsSubmitVerdict> => {
      const state = host.sessions.get(sessionId);
      const instance = state?.currentInstance;
      if (state === undefined || instance === undefined) {
        // Wu Zaifei asked but received submit: not routed to the engine, rejected directly (to avoid hanging).
        return Promise.resolve(rejectWith("no active ask is awaiting a submitted result"));
      }
      // An ask that does not declare a result type may still register submit_result; here the submission is immediately rejected and a normal reply is prompted.
      // You cannot hand it over to the engine and then wait for a decision: the engine does not handle submit for untyped ask, and the pending deferred will not end.
      if (!state.currentTyped) {
        return Promise.resolve(
          rejectWith(
            "this ask does not accept submit_result; provide your answer as your final message",
          ),
        );
      }
      // Current instance invariant: at most one pending deferred. If there is already (should not happen), reject the old one first to avoid leakage.
      state.pendingSubmit?.reject(
        new WorkflowError("DriverError", "This submit was superseded by a newer submit."),
      );
      const deferred = defer<ContractsSubmitVerdict>();
      state.pendingSubmit = deferred;
      // Synchronous reporting: The engine verifies in this call stack and returns the decision via respondToSubmit (synchronously unlocking the deferred).
      host.sink.askSubmitAttempted(instance, request.result);
      return deferred.promise;
    },
  };
}
