// ============================================================
// Upsert semantics of several **bounded tables** in workflowRuns
// ============================================================
// Pure function, responsible for table entry update and capacity judgment, and does not read the clock or perform I/O.
//
// These two functions talk about two halves of the same sentence: how to recognize "this is the same record" in a table, and what to do when it cannot be loaded.
// The semantics of hitting the boundary are to reject new ones and still update existing ones - freezing the phase of a running instance on "queued", which is one less than queued
// Examples are more likely to mislead readers (the box on the picture will always show that it has not started). Who can make way for the newcomer is another matter.
// workflow-runs-eviction.ts.

import type { WorkflowRunPendingQuestion } from "./workflow-runs.js";

/** The result of one bounded upsert. `truncated` = this record **did not make it into the table** (rather than "already in the table, updated in place"). */
export interface BoundedUpsert<T> {
  list: T[];
  truncated: boolean;
}

/**
 * Upserts into a bounded list by (siteId, ordinal) (that is the dedup key of all three tables:
 * actors / nodes / reports).
 *
 * `admitNew: false` widens "do not accept new entries" beyond the bound to other reasons (a
 * replayed event, an intermediate phase of an off-table instance; see `born` in the node branch
 * of the reducer), and produces **word-for-word the same** result as a bound rejection —
 * because it says the same thing: this instance is not in the table. The caller counts it as
 * usual on that basis.
 */
export function upsertBoundedByInstance<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  entry: T,
  limit: number,
  options: { admitNew?: boolean } = {},
): BoundedUpsert<T> {
  const index = list.findIndex(
    (item) => item.siteId === entry.siteId && item.ordinal === entry.ordinal,
  );
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (options.admitNew === false || list.length >= limit) {
    return { list: [...list], truncated: true };
  }
  return { list: [...list, entry], truncated: false };
}

/**
 * Upserts into the bounded table of parked questions by `qid`.
 *
 * Same bound semantics as {@link upsertBoundedByInstance} (refuse new, still update existing),
 * only the key differs: an escalation has no site-instance identity, and the qid is its key.
 * The two were not merged into one generic function because **how the key is derived** is the
 * only thing this file has to say — after merging, the call sites would have to pass a key
 * extractor and the reader would lose sight of "what this table is deduped by".
 */
export function upsertBoundedByQid(
  list: readonly WorkflowRunPendingQuestion[],
  entry: WorkflowRunPendingQuestion,
  limit: number,
): BoundedUpsert<WorkflowRunPendingQuestion> {
  const index = list.findIndex((item) => item.qid === entry.qid);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}
