// ============================================================
// Attribution account of items outside the table: how to add, subtract, and when the entire cell of `unlistedByPhase` disappears
// ============================================================
// This module is a pure function and does not read the clock or perform I/O. Elimination rules determine who leaves the table, where a staged count after leaving is maintained.
//
// The reading surface is drawn by **station**: a station
// The roster, counting ring and "N more" all have to add back the off-table entries of their own grid. Two counters at run level
// (workflow-runs-caps.ts) You can tell how many columns are missing for a run, but you can’t tell which station is missing - this grid table is
// That gap.
//
// Each of the four numbers in one grid answers a question, and all four of them only describe the current moment (not the historical accumulation):
//   - `actors`: How many child agents are **not on the table at this moment** for this birth stage, whether it was rejected, eliminated, or
//     Orphans settled at birth. It can be added or subtracted - an eliminated subagent will return to the list the next time it is dispatched
//     (activation of workflow-runs-eviction.ts), at that moment this grid will be reduced;
//   - `actorsSettled` / `actorsFailed`: those that have **ended** and those that failed at the end;
//   - `settled`: The number of settled nodes outside the table recorded in this cell.
// The four squares with all zero numbers are completely discarded. When the last square is also discarded, the entire key disappears - the same as the other "no or absent" rules of this family.
//
// After each change, the entire grid is clipped to `actorsFailed ≤ actorsSettled ≤ actors`, which is the **law** of this grid rather than
// A patch: it's the exact rule that allows `actorsSettled` to rise as well as fall. It must be able to drop - a subagent on it twice
// It looks like "completed" between ask, so elimination stamps it as completed, and its next dispatch puts it back on the list. This box does not record who came back, so subtract it at the moment of activation.
// `actorsSettled` can only be guessed, and in a wide fan-out the guesses will be outrageous: at that stage hundreds of child agents are **at birth**
// For those that were rejected, they were never settled at all, and every time they returned the statement, an account that did not belong to them would be deducted. Clamping is only wrong when one square is crowded, and it is
// Temporary - the completed sub-agent returning to the table leaves its completed mark to another unlisted sub-agent in the same stage until this box
// Until it is empty; as the sub-agents are added to the table one after another, the numbers at each stage will go straight. The two run-level counters are accurate throughout.

import type { WorkflowRunState, WorkflowRunUnlistedPhase } from "./workflow-runs.js";

/** The increments added to one bucket. `actors` can be negative (a subagent returning to the table); the rest are only ever positive. */
export interface WorkflowRunUnlistedDelta {
  actors?: number;
  actorsSettled?: number;
  actorsFailed?: number;
  settled?: number;
}

/**
 * Adds a number to the bucket of a given birth phase.
 *
 * **When the bucket table is full, drop the attribution** (return the table unchanged): a station
 * may be short one number it never had, but a run-level count must not lie — the latter the caller
 * adds to regardless. The table is one longer than `maxPhases`: the extra slot is "no phase", and
 * it shares the same table with the named phases.
 *
 * Returning `undefined` always means "not a single bucket" (the key is absent), so decrementing the
 * last all-zero bucket collapses the whole table away.
 */
export function addToUnlistedBucket(
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
  phaseName: string | undefined,
  delta: WorkflowRunUnlistedDelta,
  maxPhases: number,
): WorkflowRunUnlistedPhase[] | undefined {
  const current = buckets ?? [];
  const index = current.findIndex((bucket) => bucket.phaseName === phaseName);
  if (index < 0 && current.length >= maxPhases + 1) {
    return buckets === undefined ? undefined : [...buckets];
  }
  const base = index < 0 ? undefined : current[index]!;
  // Clamp zero: The subtraction of `actors` has two out-of-reach premises (attribution is lost when the grid is full, the actual birth stage and
  // The one that distributes the reissue does not match). If you clip it, it will only count one less square. If you don't clip it, a negative number will be sent on the agreement line.
  const actors = atLeastZero((base?.actors ?? 0) + (delta.actors ?? 0));
  // Clip to `actorsFailed ≤ actorsSettled ≤ actors` (the law in the file header): I can’t identify who returned the table in this box.
  // Therefore, the number of "Ended" can only fall together with the number of "Not on the list".
  const actorsSettled = Math.min(
    atLeastZero((base?.actorsSettled ?? 0) + (delta.actorsSettled ?? 0)),
    actors,
  );
  const actorsFailed = Math.min(
    atLeastZero((base?.actorsFailed ?? 0) + (delta.actorsFailed ?? 0)),
    actorsSettled,
  );
  const settled = atLeastZero((base?.settled ?? 0) + (delta.settled ?? 0));
  if (actors === 0 && actorsSettled === 0 && actorsFailed === 0 && settled === 0) {
    if (index < 0) return buckets === undefined ? undefined : [...buckets];
    const remaining = current.filter((_, position) => position !== index);
    return remaining.length > 0 ? remaining : undefined;
  }
  // Key order = schema declaration order: This object will be incrementally moved online as it is, and the bytes on both sides must match.
  const merged: WorkflowRunUnlistedPhase = {
    ...(phaseName === undefined ? {} : { phaseName }),
    actors,
    ...(actorsSettled > 0 ? { actorsSettled } : {}),
    ...(actorsFailed > 0 ? { actorsFailed } : {}),
    settled,
  };
  if (index < 0) return [...current, merged];
  const next = [...current];
  next[index] = merged;
  return next;
}

/**
 * Writes a bucket table back onto the run: **an empty table removes the key** (rather than leaving
 * an empty array).
 *
 * "Zero entries ⇒ key absent" is the protocol contract of this field (see the schema comment) and
 * is also the idempotent pivot: a reduction that changed nothing has to produce a byte-for-byte
 * identical run object for the top-level structural comparison to return null.
 */
export function withUnlistedBuckets(
  run: WorkflowRunState,
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
): WorkflowRunState {
  if (buckets === run.unlistedByPhase) return run;
  if (buckets === undefined || buckets.length === 0) {
    if (run.unlistedByPhase === undefined) return run;
    const { unlistedByPhase: _emptied, ...withoutKey } = run;
    return withoutKey;
  }
  return { ...run, unlistedByPhase: [...buckets] };
}

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}
