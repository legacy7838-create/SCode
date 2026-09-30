// ============================================================
// The traces left behind by the world: counters for rejected instances, entry budgets for integer keys, and unique step readouts for readers.
// ============================================================
// Pure function, responsible for capacity and counting rules, does not read the clock or perform I/O.
//
// Instances that cannot be entered into the table when they hit the boundary also need to be counted; existing entries are updated as usual, and elimination and re-entering into the table are handled by corresponding rules.
// Three types of rules are responsible for:
//   - Counters make them **countable** - `truncated` can only say "something didn't come in", but not much;
//   - The entry budget makes the entire state key **bounded** - the bound of a single run multiplied by maxRuns is too close to the snapshot upper limit;
//   - workflowRunStepCounts is the only allowed step count reading method - inside the table + outside the table, reading in three places (run card, timeline summary,
//     TUI mirror) share the same calculation to ensure that the number of displayed steps for the same run is consistent.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunState,
  type WorkflowRunUsage,
} from "./workflow-runs.js";

/** How one event of a rejected instance affects the two counters. */
export interface UnlistedInstanceEvent {
  /** This instance did not make it into the table (the upsert refused it on hitting a bound), rather than "already in the table, updated in place". */
  rejected: boolean;
  /** This event pushed past that run's watermark. false = retransmit/late arrival, not one counter moves. */
  advancesWaterMark: boolean;
  eventType: string;
  /** The `cached` flag of `node-settled`: a cache-hit settlement has no queued event, it is its own birth event. */
  cached: boolean;
}

/**
 * Records an event of a **rejected** instance into the two usage counters.
 *
 * There are two birth events (the exact same rule as the phaseName / node-progress check in the
 * main reducer): `node-queued`, and the `node-settled { cached: true }` emitted directly on a
 * replay hit. None of the intermediate phases count — they describe the same instance in
 * motion, not one more instance.
 *
 * Why `nodesUnlistedSettled` needs no clamp against `nodesUnlisted`: within **one life** the
 * engine emits at most one `node-queued` per instance (repair / nudge do not re-enqueue, and
 * there is no backoff retry) and at most one `node-settled` (the scheduler's settled latch), and
 * a cache-hit settlement carries its own birth. So "settled count ≤ birth count" is structural.
 * If that ever stops holding, the engine or the `run-started` reset is broken — clamping would
 * only hide it.
 */
export function countUnlistedInstance(
  usage: WorkflowRunUsage,
  event: UnlistedInstanceEvent,
): WorkflowRunUsage {
  if (!event.rejected || !event.advancesWaterMark) return usage;
  const settled = event.eventType === "node-settled";
  const born = event.eventType === "node-queued" || (settled && event.cached);
  if (!born && !settled) return usage;
  const nodesUnlisted = (usage.nodesUnlisted ?? 0) + (born ? 1 : 0);
  const nodesUnlistedSettled = (usage.nodesUnlistedSettled ?? 0) + (settled ? 1 : 0);
  return {
    ...usage,
    // At zero time, the entire key is absent (same as reports / pendingQuestions): there are not many new keys in the run that have not hit the boundary.
    ...(nodesUnlisted > 0 ? { nodesUnlisted } : {}),
    ...(nodesUnlistedSettled > 0 ? { nodesUnlistedSettled } : {}),
  };
}

/**
 * An **off-table** instance came back into the node table (the activation in
 * workflow-runs-eviction.ts: it was dispatched work, so it takes its seat back with the work):
 * `nodesUnlisted` goes down by one.
 *
 * Clamped at zero rather than allowed to go negative: this counter is **accumulated**, it has no
 * identity to dedup by, and an instance that returns to the table should in theory always have
 * been counted once already (a rejected birth, or the moment it was evicted). Clamping would
 * only undercount by one; not clamping would put a negative number on the protocol wire, and the
 * read side adds it straight into the step total. Zeroing means the whole key is absent (the
 * same rule as {@link countUnlistedInstance}), so the key is dropped explicitly here rather than
 * written as a 0.
 */
export function discountUnlistedInstance(usage: WorkflowRunUsage): WorkflowRunUsage {
  const current = usage.nodesUnlisted ?? 0;
  if (current === 0) return usage;
  const { nodesUnlisted: _returned, nodesUnlistedSettled: settled, ...head } = usage;
  return {
    ...head,
    ...(current > 1 ? { nodesUnlisted: current - 1 } : {}),
    ...(settled === undefined ? {} : { nodesUnlistedSettled: settled }),
  };
}

/**
 * The whole-key entry budget ({@link WORKFLOW_RUNS_LIMITS.maxTotalEntries}): over it, evict the
 * **oldest terminal runs** until back within budget or there is nothing left to evict.
 *
 * Three things never move: runs in flight (`pending` / `running`) — it is producing facts, and
 * pulling its table out would blind the panel on the spot; the run the event belongs to — a fact
 * that just arrived has to be kept; and the **partial** entries of any run — this protocol has
 * no per-entry removal syntax, so dropping half of them would desync the downstream delta (a
 * diff can only resend the whole key).
 *
 * Pure and deterministic: it looks only at the order of `runs` (oldest first) and at each
 * status, so replaying a cold recovery event by event evicts the same set. While within budget it
 * returns **the same array**, keeping both the untouched runs' references and the delta fast
 * path intact.
 */
export function evictForEntryBudget(
  runs: WorkflowRunState[],
  eventRunId: string,
): WorkflowRunState[] {
  let total = 0;
  for (const run of runs) total += run.nodes.length + run.actors.length;
  if (total <= WORKFLOW_RUNS_LIMITS.maxTotalEntries) return runs;
  let remaining = runs;
  while (total > WORKFLOW_RUNS_LIMITS.maxTotalEntries) {
    const index = remaining.findIndex(
      (run) => run.runId !== eventRunId && run.status !== "pending" && run.status !== "running",
    );
    // No one can be eliminated (all are running, or only the event itself is left): even if it exceeds the budget, keep it. A little more honestly,
    // Better than erasing a live run from the board just to hold on to a number.
    if (index < 0) break;
    total -= remaining[index]!.nodes.length + remaining[index]!.actors.length;
    remaining = [...remaining.slice(0, index), ...remaining.slice(index + 1)];
  }
  return remaining;
}

/**
 * How many steps a run took and how many of them settled — **in-table + off-table**.
 *
 * The read side (run card, timeline summary, TUI mirror) must all go through this one function:
 * they previously counted `nodes` themselves, so the same run that had hit a bound showed three
 * different numbers in three places, and all three were smaller than the true step count.
 */
export function workflowRunStepCounts(run: WorkflowRunState): { total: number; settled: number } {
  let settledInList = 0;
  for (const node of run.nodes) if (node.phase === "settled") settledInList += 1;
  return {
    total: run.nodes.length + (run.usage.nodesUnlisted ?? 0),
    settled: settledInList + (run.usage.nodesUnlistedSettled ?? 0),
  };
}
