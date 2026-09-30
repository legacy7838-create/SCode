/**
 * engine.ts hit oxlint's max-lines ceiling (400 lines), so the run's three terminal paths
 * (completed / stopped / errored) and the finishRun they share were split into this file; the
 * public surface is still exported from engine.ts.
 *
 * The free functions read and write engine state through the {@link EngineState} seam;
 * WorkflowEngine's complete / stop / failRun are thin delegations. First-wins is guarded by
 * `isRunSettled()` on the first line of every path.
 */

import type { EngineState } from "./engine-state.js";
import type { RunSettlementRecord, RunStatus, RunStopReason } from "./types.js";
import { WorkflowError } from "./types.js";

/**
 * The sandbox script successfully returned a top-level artifact; settle as completed.
 *
 * Asks may still be in flight when the script returns (the losers of a `Promise.race`, asks
 * with no `await`). They are aborted exactly as on the cancel path: cancelAsk on the driver
 * side, the deferred rejects with Cancelled, and a node-settled(cancelled) is re-emitted. The
 * consequences of not aborting them are threefold: the scheduler's liveNodes hold the node
 * forever, the driver-side turn keeps burning tokens, and a node-dispatched in the event log
 * never gets its node-settled.
 */
export function settleCompleted(state: EngineState, artifact: unknown): void {
  if (state.isRunSettled()) return;
  state.markSettled();
  state.abortInFlight(
    new WorkflowError("Cancelled", "Run completed; in-flight subagent tasks were abandoned."),
    true,
  );
  // The product is dropped into the inventory along with the final state. Writing in two strokes will create a crash window of "completed but product lost", and journal
  // The row is the only persister of the product (the `run-settled` event is deliberately not widened).
  finishRun(state, "completed", { result: artifact });
  state.resolveSettled({ status: "completed", artifact });
}

/**
 * External stop: abort the in-flight asks (the deferreds reject with Cancelled, and
 * node-settled(cancelled) is re-emitted), the run settles as `stopped(reason)`, and finished
 * journal entries are kept (so it can be resumed). All four reasons take the same path:
 * `user` / `model` (the initiator passed in by the cancel entry point), `interrupted` (a
 * sandbox failure in the harness), `provider` (a deterministic model-side error the driver
 * reported via `stopRun`). `error` is present only for the latter two.
 */
export function settleStopped(
  state: EngineState,
  reason: RunStopReason,
  error?: WorkflowError,
  supersededBy?: string,
): void {
  if (state.isRunSettled()) return;
  state.markSettled();
  state.abortInFlight(new WorkflowError("Cancelled", "Run stopped."), true);
  // The successor id of `superseded` is dropped into the database with the same reason:
  // Stopped. Rewrite the entire envelope. If you write it in two strokes, there will be a window saying "It has been superseded but I don't know who replaced it."
  finishRun(state, "stopped", {
    stopReason: reason,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(error === undefined ? {} : { failure: error.toJSON() }),
  });
  state.resolveSettled({
    status: "stopped",
    reason,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(error === undefined ? {} : { error }),
  });
}

/** A run-level failure (a bug in the script): abort the in-flight asks (rejecting with the run error) and settle the run as errored. */
export function settleFailed(state: EngineState, error: WorkflowError): void {
  if (state.isRunSettled()) return;
  state.markSettled(error);
  state.abortInFlight(error, false);
  finishRun(state, "errored", { failure: error.toJSON() });
  state.resolveSettled({ status: "errored", error });
}

/**
 * The `run-settled` event carries only {status, stopReason?, error?}: artifacts stay off the
 * high-frequency progress pipeline and land in the journal only.
 *
 * All three terminal paths pass through here, so the driver's dispose happens exactly once
 * and first-wins holds naturally. It is placed **after** `run-settled`: dispose is
 * post-settlement resource release (the actor runtime's close chain), not part of
 * settlement, and the event log gets no extra entry because of it.
 */
function finishRun(state: EngineState, status: RunStatus, settlement?: RunSettlementRecord): void {
  state.journal.updateRunStatus(state.runId, status, settlement);
  state.record({
    type: "run-settled",
    status,
    ...(settlement?.stopReason === undefined ? {} : { stopReason: settlement.stopReason }),
    ...(settlement?.supersededBy === undefined ? {} : { supersededBy: settlement.supersededBy }),
    ...(settlement?.failure === undefined ? {} : { error: settlement.failure }),
  });
  state.driver.dispose?.();
}
