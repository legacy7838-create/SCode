import type {
  V4ConversationWorkflowRunSummary,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * The pure model of the run directory, whose single source of truth is the journal.
 *
 * The "Ended · N" on the task list footer row and those rows in the directory page **must come from
 * the same filter and the same bucketing**. Split into two implementations, the footer may show 5
 * entries while opening the directory yields only 4 rows. So only two entry points are exported
 * here, and by construction the count ≡ the length of the ended list (see `countEndedWorkflowRuns`
 * at the end of the file).
 */

/**
 * The number of entries fetched in one directory read.
 *
 * **Both callers must use the same value**: the directory page and the task list count each hold
 * their own hook instance, so a different depth equals a different convention (the CLI side
 * defaults to 16 with a cap of 64, see `DEFAULT_LIST_RUNS_LIMIT` in
 * `dynamic-workflow-run-service.ts`). The cap is taken rather than the default: this page is all
 * the history the user can see, and a 64-row journal summary is a bounded, cheap read.
 */
export const WORKFLOW_RUN_DIRECTORY_LIMIT = 64;

/**
 * A row in the directory. It is the summary from the discovery query with only `toolCallId`
 * tightened into a requirement — **the removal happens while the table is built**, so no downstream
 * consumer (the page, the count) can ever get a row with no detail page to open, and none of them
 * has to check for it again.
 */
export type WorkflowRunDirectoryRow = V4ConversationWorkflowRunSummary & { toolCallId: string };

interface WorkflowRunDirectory {
  /** `pending` / `running`: still moving. */
  running: WorkflowRunDirectoryRow[];
  /**
   * `completed` / `errored` / `stopped`: one bucket, with the status word on the row responsible
   * for spelling out the ending.
   */
  ended: WorkflowRunDirectoryRow[];
  /**
   * Whether this page is already filled (there may be more behind it). It is judged by **the number
   * of entries the query returned**, not by the row count after filtering: when a page is entirely
   * old runs missing `toolCallId`, zero rows show on screen while "that's all of them" would be a
   * lie.
   */
  truncated: boolean;
}

/**
 * A run missing `toolCallId` cannot open a detail page (the `workflow-run` tab needs it to find
 * the static-image row in the parent session projection), and users chose to remove such runs
 * wholesale rather than grey them out. The cost: old runs from before `tool_call_id` was
 * persisted therefore become unreachable in the GUI.
 */
function hasDetailAnchor(
  summary: V4ConversationWorkflowRunSummary,
): summary is WorkflowRunDirectoryRow {
  return summary.toolCallId !== undefined;
}

function isEnded(summary: V4ConversationWorkflowRunSummary): boolean {
  return summary.status !== "pending" && summary.status !== "running";
}

/**
 * A missing summary (not queried yet / capability absent) is an empty directory just like zero
 * entries: the caller tells the two apart via the hook's `null` and `[]`, and the model stays out
 * of it — it only does the bucketing.
 *
 * **No sorting**: order = query order = most recently updated first (sorting happens in the CLI
 * storage layer). Re-sorting here would fight the storage layer over the same decision, and once
 * the two disagree the list jumps around on every refetch.
 */
export function buildWorkflowRunDirectory(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): WorkflowRunDirectory {
  const rows = (summaries ?? []).filter(hasDetailAnchor);
  return {
    running: rows.filter((row) => !isEnded(row)),
    ended: rows.filter(isEnded),
    truncated: (summaries?.length ?? 0) >= WORKFLOW_RUN_DIRECTORY_LIMIT,
  };
}

/**
 * The count on the task list footer row. It goes through the same table-building function, so it is
 * **always equal to** the number of rows in the directory page's ended section — this invariant is
 * the reason this module exists; do not take a shortcut with `summaries.filter(...)` at the call
 * site.
 */
export function countEndedWorkflowRuns(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): number {
  return buildWorkflowRunDirectory(summaries).ended.length;
}

/**
 * The trigger key for "should this journal summary be refetched", derived from the **live
 * projection**.
 *
 * Its shape is "run count + settled count", because the directory expresses only two things:
 * whether a row is present, and which section it is in. So
 * - a new run starts → the former moves (it has to appear under "Running");
 * - a run finishes → the latter moves (it has to move to "Ended");
 * - node-level progress → neither moves.
 *
 * The last one is the point of this key. The projection's `revision` is bumped by every engine
 * event, so using it as the trigger turns a single paginated read into a stream that follows the
 * events; yet a reader on the directory page cannot tell any difference.
 *
 * **Both surfaces share this single derivation** (the task list count and the directory page), for
 * the same reason as `countEndedWorkflowRuns`: a consistent convention is not enough, freshness
 * must be consistent too — the staleness actually observed is exactly "the island updated, but the
 * page it opened did not".
 */
export function workflowRunDirectoryRefreshKey(
  runs: readonly WorkflowRunState[] | null | undefined,
): string {
  const all = runs ?? [];
  const settled = all.filter((run) => run.status !== "pending" && run.status !== "running").length;
  return `${all.length}:${settled}`;
}
