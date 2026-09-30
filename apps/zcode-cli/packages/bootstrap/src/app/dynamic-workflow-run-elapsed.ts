// The activity duration of dwf run is used to complete the "time" grid of the card.
// Each start of this run, and each predecessor traced along `resumedFrom`, are summed according to their respective activity intervals;
// The gap between stopping or process exit and before the next resume is not counted.
//
// You cannot just use the current registry entry's `completedAt - startedAt`: resume or revision to reset the clock,
// thus missing previous running times. The duration and token usage should cover the entire lineage.
//
// The event log has recorded the starting point and last activity moment of each interval, so only the summation is required and no additional persistence is required.

import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { supportsRunLifeSpans } from "./dynamic-workflow-run-journal.js";

/**
 * The hop limit when walking lineage upward. One revision is one hop and the chain is really single-digit; the cap only exists to put a gate against "a row's `resumedFrom` was written by an outside force into a long chain" -- reading one run's elapsed time must not sweep over an arbitrary number of rows.
 */
const LINEAGE_HOP_LIMIT = 64;

/**
 * The active duration (in milliseconds) of this run and its lineage, or `undefined` (no evidence of any generation at all).
 *
 * `undefined` and `0` are two different things: the former means "the journal cannot speak" (the reading surface is not present, the run's events predate this bookkeeping, the row has already been cleaned up), and callers fall back to the generation they observed themselves; the latter means "there definitely is a generation, but its duration is under 1 millisecond".
 *
 * Loop protection is not defensive-programming decoration: `resumedFrom` is metadata frozen at the moment the run is created and theoretically cannot form a cycle, but this loop's termination condition depends on **the data in the store** rather than on this process's logic -- a row that an outside force wrote to point at itself would turn a snapshot read into an infinite loop, and snapshot reads sit on the background tracker's polling path.
 */
export function runLineageActiveMs(journal: JournalStorePort, runId: string): number | undefined {
  if (!supportsRunLifeSpans(journal)) return undefined;
  let total = 0;
  let sawLife = false;
  let cursor: string | undefined = runId;
  const visited = new Set<string>();
  for (let hop = 0; cursor !== undefined && hop < LINEAGE_HOP_LIMIT; hop += 1) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    for (const life of journal.listRunLifeSpans(cursor)) {
      sawLife = true;
      // Clamp to non-negative: Both moments originate from `dwf_event.time_created`, but that is a **wall clock** - a system time adjustment can
      // Let the "last item" be earlier than the "first item". Negative numbers subtract the true duration of other lifetimes from the total, which is worse than losing this lifetime.
      total += Math.max(0, life.lastActivityAt - life.startedAt);
    }
    // Only trace up lineage, not down supersededBy: The revision is "the next version of the same work", and the replaced activity of the predecessor
    // is the base for this version; the successor in the opposite direction has nothing to do with the duration of this run (it has its own card).
    cursor = journal.getRun(cursor)?.resumedFrom;
  }
  return sawLife ? total : undefined;
}
