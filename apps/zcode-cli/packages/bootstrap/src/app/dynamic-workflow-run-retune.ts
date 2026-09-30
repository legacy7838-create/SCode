// ============================================================
// Dynamic Workflow Run Service: Change the concurrency upper bound of an on-the-fly run in place
// ============================================================
// This is the implementation of `DynamicWorkflowRunPort.retuneConcurrency`, deliberately separated from the three startup entries (dynamic-workflow-run-submit.ts): those three
// Each one casts a run, but this one doesn't cast a run - it only issues a command to the one that's already flying.
//
// The two kinds of rejection are judged in **different places**, which is what makes them separate:
//   - `unchanged` is the module's own answer. It reads the upper bound held by the service at the moment and is completed before the handle is transferred;
//   - So the engine's setter has only one reason to say false - run was resolved between these two steps - and the port reports it as `not_live`.
//
// The order is also payload-based: handle first (engine changes caps + write line + record event + gate changes to upper bound, a synchronization piece), and then it is moved.
// Serve its own in-memory copy. This, in turn, will leave an upper memory bound inconsistent with the `dwf_run` line at the moment run happens to settle.
// The snapshot and details are exactly what you read.

import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import { clampRunConcurrency } from "./workflow-concurrency-ceiling.js";

/** The service-internal state this module borrows; all of it is references, this file holds no state of its own. */
export interface DynamicWorkflowRunRetuneContext {
  runs: Map<string, RunRegistryEntry>;
  journal: JournalStorePort;
  /** The very same function as the caps starting point and the two read-surface criteria (see the run service's `concurrencyCeiling`). */
  concurrencyCeiling: () => number;
}

export function retuneRunConcurrency(
  ctx: DynamicWorkflowRunRetuneContext,
  request: DynamicWorkflowRunRetuneRequest,
): DynamicWorkflowRunRetuneResult {
  const ceiling = ctx.concurrencyCeiling();
  // `null` = ceiling = lift this run's own restrictions. The same clamp as when submitted (the tool layer has been clamped once to allow
  // The confirmation window displays the value that will take effect; port re-clamping is the port's own contract, and the value must be the same twice).
  const next = clampRunConcurrency(request.maxConcurrency ?? undefined, ceiling);

  const entry = ctx.runs.get(request.runId);
  if (entry === undefined || entry.terminal !== undefined || entry.control === undefined) {
    // This service does not have this live entry: it has never been a run of this process, a run that has already been settled, or a run left before the upgrade.
    // No control plane entry. All three represent the same next step for the caller - a real revision.
    return { ok: false, reason: "not_live" };
  }

  // The upper bound that takes effect at this time: **If there is an entry, read the entry** (the three paths to create an entry all fall into the value), and then the cold run will fall back to the journal.
  // Neither of them exists. It may be a wiring abnormality in the microtasks between submit → createRun. Press "Run on the ceiling" to read.
  const current =
    entry.maxConcurrency ?? ctx.journal.getRun(request.runId)?.caps.maxConcurrency ?? ceiling;
  if (current === next) return { ok: false, reason: "unchanged", current };

  if (!entry.control.setMaxConcurrency(next)) {
    // The entry is still there, but the engine says it has not changed: the run was resolved between the survival decision and this line (race condition), or the engine has not been connected yet.
    // (The few microtasks before launch). Both are "cannot be changed at this moment".
    return { ok: false, reason: "not_live", current };
  }
  // The memory copy is moved together: the snapshot reads the `entry.maxConcurrency ?? line`, and the entry takes precedence - if it is not moved, it will be retune
  // Then continue to report the number when submitted, and the resolveInput of `AmendWorkflow` reads this snapshot to determine "what to use."
  entry.maxConcurrency = next;
  return { ok: true, maxConcurrency: next, previous: current, ceiling };
}
