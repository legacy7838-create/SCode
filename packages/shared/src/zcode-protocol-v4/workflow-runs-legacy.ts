// ============================================================
// WorkflowRuns tailoring for consumers without the `workflowRunDeltas` capability
// ============================================================
// This item is not a display budget, but wire compatibility: the actors / nodes parity bound in the old consumer binary is 256
// ({@link WORKFLOW_RUNS_LEGACY_LIMITS}), whereas a parsing error on a known key does not strip a key -- it leaves the entire
// The `state.updated` patch fails, the entire frame is lost, and the subscription is silent from now on. So we raise the boundary to 1024 and send it to the old
// Every frame of the consumer (incrementally folded integer patches, and snapshots) must pass here first.
//
// Which 256 items are left behind is the same as the vacancy on the reduction side (workflow-runs-eviction.ts): **leave the ones that are still moving** first.
// The old phone painted the same thing as the new client - who is running at the moment - and blanketing the "first 256" would make a wide run in
// That generation of clients will always be stuck on the earliest batch that has ended. When there are more places, the earliest entry will be filled in table order, and the output will still be in the original table order.

import { canonicalWorkflowRun } from "./workflow-runs-delta.js";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * Clamps to the legacy bounds; a clamped run gets `truncated: true` (the read side uses it to show
 * "details for only N/M steps").
 *
 * **Nothing else is clamped**: new optional keys a legacy consumer does not recognize are harmless
 * (the container is not strict, the extra keys just get stripped), whereas stripping them for
 * "cleanliness" means maintaining a second field table and adding risk of field disagreement.
 *
 * When no clamping is needed it returns **the same object**: this function runs on every flush, so
 * needlessly building a fresh state would invalidate every downstream by-reference memo.
 */
export function clampWorkflowRunsForLegacy(state: WorkflowRunsState): WorkflowRunsState {
  let clamped = false;
  const runs = state.runs.map((run) => {
    const actors = clampKeepingLive(
      run.actors,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxActors,
      (actor: WorkflowRunActor) => actor.status !== "completed",
    );
    const nodes = clampKeepingLive(
      run.nodes,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes,
      (node: WorkflowRunNode) => node.phase !== "settled",
    );
    if (actors === run.actors && nodes === run.nodes) return run;
    clamped = true;
    // Follow the standard key sequence: `truncated` may be a new key on this run. Direct expansion will append it to the end of the object.
    // The same state elsewhere (reduce export, increment apply) is in schema order.
    return canonicalWorkflowRun({ ...run, actors, nodes, truncated: true });
  });
  return clamped ? { revision: state.revision, runs } : state;
}

/**
 * Trims to `limit` entries: first take the **still-moving** ones in table order, then fill the
 * remaining slots with the earliest entries in table order, and finally emit them in the **original
 * table order** (two passes collecting indices, one filter — so the order is table order, not
 * "live first").
 *
 * When the live entries alone exceed the quota, the first `limit` of them in table order are taken —
 * this bound still has to exist, the legacy consumer's validation bound accepts no explanation.
 * Within the bound it returns the same array.
 */
function clampKeepingLive<T>(
  list: readonly T[],
  limit: number,
  isLive: (entry: T) => boolean,
): T[] {
  if (list.length <= limit) return list as T[];
  const kept = new Set<number>();
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    if (isLive(list[index]!)) kept.add(index);
  }
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    kept.add(index);
  }
  return list.filter((_, index) => kept.has(index));
}
