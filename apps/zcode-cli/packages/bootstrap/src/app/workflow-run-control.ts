// ============================================================
// run's living control surface: one command falls to both the engine and the seat gate
// ============================================================
// The two execution points of a run on the fly live in different
// In the layer - the scheduler is in the engine (`@zcode/dynamic-workflow`), the seat gate is under the driver (this package) - and the command is issued
// That side (`retuneConcurrency` of the run service) is out of reach of both: the engine is harnessed after the child process is assembled
// It only exists, and the gate is made by launch.
//
// So run service first creates an **empty** handle and puts it into the registry entry, and both parties connect themselves at the moment they are born:
// The harness gets `bind(engine)` (passed through the same gap as `signal`), and the launch gets `bindSeatGate(gate)`.
// The handle itself does not judge anything: survival judgment, no-op semantics and dropout are all in the engine's `setMaxConcurrency`, and the gate is only in
// The engine said "it's really changed this time" before changing the upper bound - so it is impossible for the two execution points to insist on each other's opinions.
//
// The order is payload-based: **engine first**. The boolean value of the engine is the verdict of this command (settled / value unchanged ⇒ false, nothing
// did not happen), if the gate changes the upper bound beforehand, a settled run will leave a memory upper bound that is inconsistent with the journal row.

import type { RunControlBinding } from "@zcode/dynamic-workflow-runtime";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

export interface WorkflowRunControl extends RunControlBinding {
  /**
   * Modify run's own concurrency upper bound in place. Returns **Whether it is really changed this time**: `false` means nothing happened - the engine has not yet
   * It is connected (those microtasks before launch), the run has been resolved, or the new value is the same as the current value. The caller falls back accordingly.
   */
  setMaxConcurrency(maxConcurrency: number): boolean;
  /** Launch is connected after the seat gate is built; the absence means that this run has only one execution point of the scheduler. */
  bindSeatGate(gate: Pick<WorkflowRunSeatGate, "setLimit">): void;
}

export function createWorkflowRunControl(): WorkflowRunControl {
  let engine: { setMaxConcurrency(maxConcurrency: number): boolean } | undefined;
  let seatGate: Pick<WorkflowRunSeatGate, "setLimit"> | undefined;
  return {
    bind: (bound) => {
      engine = bound;
    },
    bindSeatGate: (gate) => {
      seatGate = gate;
    },
    setMaxConcurrency: (maxConcurrency) => {
      if (engine === undefined) return false;
      if (!engine.setMaxConcurrency(maxConcurrency)) return false;
      seatGate?.setLimit(maxConcurrency);
      return true;
    },
  };
}
