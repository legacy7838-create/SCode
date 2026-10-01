/**
 * dwf-journal.ts hit the oxlint max-lines limit (400 lines), so the host-side family of **run introspection read
 * surfaces** (`DwfRunIntrospectionQueries` and its SQL) is split into this file; the public surface is still exported from
 * dwf-journal.ts, and `SqliteDwfJournalStore` only delegates.
 *
 * The same split as dwf-journal-artifacts.ts: these queries need only a db handle and share no state with the write-read side of
 * run/actor/node/event, while each carries a long argument for "why this table is the data source and why this is the ordering".
 * The engine's `JournalStorePort` write surface is not here — there is no writer in this file.
 */

import type { DwfJournalClient } from "@zcode/rust/events";
import type { NodeRecord, NodeRecordStatus, RunStatus, StoredEvent } from "@zcode/dynamic-workflow";
import type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
import {
  decodeEvent,
  decodeNode,
  decodeRunDetailRow,
  decodeRunListItem,
  decodeRunSessionListItem,
  type DwfEventRow,
  type DwfNodeRow,
  type DwfWorldNodeRow,
  type DwfRunDetailRow,
  type DwfRunListItem,
  type DwfRunMetadataRow,
  type DwfRunRow,
  type DwfRunSessionListItem,
  type DwfRunSessionRow,
} from "./dwf-journal-codecs.js";

/** The query bag of {@link DwfRunIntrospectionQueries.listRuns}. */
export interface DwfListRunsQuery {
  /**
   * The project key. Literal equality match against `dwf_run.cwd` (the write side stores it as-is, the read side queries it as-is).
   *
   * **Optional**: omitting it means no cwd predicate, so the enumeration spans every project. A global workflow's run history spans
   * every project it was launched from (`workflows/runs` `scope: "global"`); the project-scoped variant still passes cwd, behaviour unchanged.
   */
  cwd?: string;
  /**
   * The upper bound on returned rows, **required**. The clamping policy belongs to the caller (the tool surface clamps to
   * [1, 50]); the storage layer does not guess a default for it — an unbounded enumeration query is the one shape that does not belong here.
   *
   * But **do not add your own ceiling here** (e.g. `Math.min(50, limit)`). Callers legitimately pass "clamp ceiling + 1": the
   * run service fetches one extra row to decide `truncated` (and that extra row does not enter the page). A hard ceiling of 50 silently
   * eats the probe row, so `truncated` is permanently missing at **exactly** limit = 50 — precisely the page size where a user most
   * needs to know "there is more" — and no test on any other limit would ever catch it.
   */
  limit: number;
  /** An optional subset of statuses. Omitting it means no filtering; an empty array means "matches no status" (an empty page comes back). */
  statuses?: readonly RunStatus[];
  /**
   * An optional run name (literal equality against `dwf_run.name`). The GUI hub attributes run history by "workflow name = run name",
   * and that filter is pushed down into SQL rather than fetching a page and filtering it afterwards — otherwise a high-frequency
   * workflow pushes other workflows off the page and the "last run" on the card is simply wrong.
   */
  name?: string;
}

/** Three-way counts over dwf_node (every value of `NodeRecordStatus`; all three keys are always present). */
export interface DwfNodeStatusCounts {
  completed: number;
  failed: number;
  running: number;
}

/**
 * The start and end of one **incarnation** of a run (one `run-started` up to its last event), in epoch milliseconds.
 *
 * An incarnation is "one stretch during which the engine was alive": the incarnation that crashed or stopped has no
 * `run-settled`, so its end can only be bounded by "the last event this incarnation recorded" — which is exactly the
 * moment it last moved. Both moments come from the same `dwf_event.time_created` (the only clock behind every "how long
 * ago" in the event log), so the difference never crosses clocks.
 */
export interface DwfRunLifeSpan {
  startedAt: number;
  lastActivityAt: number;
}

/**
 * The host-side run introspection query surface (the data foundation for the two read-only tools `ListWorkflowRuns` / `GetWorkflowRun`).
 *
 * Deliberately **not widening** the engine's `JournalStorePort`, for the exact same argument as {@link SqliteDwfJournalStore.listNonTerminalRuns}:
 * the engine only reads and writes its own row by runId, never enumerates runs and never does aggregate counts — adding these to the
 * domain port would hold every journal implementation (including the engine's own in-memory one) responsible for something the engine does not do.
 *
 * Consumers probe by capability (`typeof journal.listRuns === "function"`) to decide tool availability, so this interface is the **only**
 * source of the signature between host and adapter: a signature written in two places drifts, and drift makes the tool silently
 * degrade into "this session does not have that capability".
 */
export interface DwfRunIntrospectionQueries {
  countNodesByStatus(runId: string): DwfNodeStatusCounts;
  getRunRow(runId: string): DwfRunDetailRow | undefined;
  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): DwfArtifactItem[];
  listArtifactRows(runId: string): NodeRecord[];
  listRecentLogEvents(runId: string, limit: number): StoredEvent[];
  listRuns(query: DwfListRunsQuery): DwfRunListItem[];
  /**
   * The activity interval of every incarnation of this run, in chronological order (the "time" cell of the completion card). A
   * run can have several incarnations (one per resume), and only the event log knows the wall clock of each one.
   */
  listRunLifeSpans(runId: string): DwfRunLifeSpan[];
  /**
   * The world-read / world-run rows of this run, in insertion order (`order by id`), with journal timestamps. **`result_json` is
   * not fetched**: this read surface is the manifest (op / args / status / time), and the bodies have a separate read surface keyed by
   * (siteId, ordinal) — decoding a 256 KB stdout for each of 256 nodes in one page is the same as reading the whole journal into memory.
   */
  listWorldNodes(runId: string): DwfWorldNodeRow[];
}

/**
 * Enumerate runs by project (cwd), most recently updated first. The same argument as {@link SqliteDwfJournalStore.listNonTerminalRuns}: the
 * engine never enumerates runs, this is a host-side read need (the `ListWorkflowRuns` tool), so it does not enter the domain port.
 *
 * cwd / statuses / ordering / limit are **all pushed down into SQL**: `dwf_run_cwd_idx` (0021) is exactly this shape; fetching
 * everything in JS and filtering there wastes both the index and the limit. cwd is a **literal** equality match — the write side
 * stores `context.workingDirectory` as-is and the read side queries it as-is, and any one-sided path normalization would only
 * produce non-matches.
 *
 * Rows are a narrow projection ({@link DwfRunListItem}, without failure / result): the listing surface does not show artifacts, and
 * artifacts can be large.
 */
export function listRuns(db: DwfJournalClient, query: DwfListRunsQuery): DwfRunListItem[] {
  // The semantics of an empty state set is "not matching any state" rather than "no filtering", and limit ≤ 0 is an empty page.
  // The native op keeps both guards; they are repeated here so the contract is visible at the boundary.
  if (query.statuses !== undefined && query.statuses.length === 0) return [];
  if (query.limit <= 0) return [];
  // cwd / statuses / ordering / limit are all pushed down into SQL by the native op (the same
  // predicate `encodeRunStatusPredicate` produced; it moved into the crate with the SQL).
  const rows = db.exec<DwfRunMetadataRow[]>("listRuns", {
    cwd: query.cwd,
    limit: query.limit,
    statuses: query.statuses,
    name: query.name,
  });
  return rows.map(decodeRunListItem);
}

/**
 * The full row of a single run plus journal timestamps. The `RunRecord` returned by `getRun` carries no timestamps (the engine does
 * not care), while the detail surface has to report createdAt / updatedAt, and it **must read the journal directly** — the in-memory
 * snapshot reports a fake start time once the entry has evaporated.
 */
export function getRunRow(db: DwfJournalClient, runId: string): DwfRunDetailRow | undefined {
  const row = db.exec<DwfRunRow | null>("getRunRow", { runId });
  return row ? decodeRunDetailRow(row) : undefined;
}

/**
 * Aggregate counts of this run's nodes by status. The counting happens in SQL: the detail surface only needs three numbers, and
 * reading whole dwf_node rows out and counting them is an expensive version of the same answer (with no guarantee on node counts).
 *
 * All three keys are always present (0 when a node is missing): downstream adds them directly to compute nodesObserved, and a
 * missing key would turn "no nodes yet" into NaN. The vocabulary is the three values of `NodeRecordStatus` — `queued` exists only in
 * the event phase and is never persisted.
 */
export function countNodesByStatus(db: DwfJournalClient, runId: string): DwfNodeStatusCounts {
  const rows = db.exec<{ status: NodeRecordStatus; total: number }[]>("countNodesByStatus", {
    runId,
  });
  const counts: DwfNodeStatusCounts = { running: 0, completed: 0, failed: 0 };
  for (const row of rows) counts[row.status] = Number(row.total);
  return counts;
}

/**
 * The last N `log` events of this run, returned in chronological order (sequence ascending).
 *
 * The fetch is `order by sequence desc limit ?` followed by a reversal in JS: for a long run, dwf_event is its largest table, and
 * reading the whole journal into memory for a few tail rows is exactly what the existence of pagination rules out. The type filter
 * is pushed down as well — the `type` column is redundancy stored for this purpose (payload_json holds a copy too).
 */
export function listRecentLogEvents(
  db: DwfJournalClient,
  runId: string,
  limit: number,
): StoredEvent[] {
  if (limit <= 0) return [];
  // The native op fetched `order by sequence desc limit ?` and re-sorted ascending in SQL.
  const rows = db.exec<DwfEventRow[]>("listRecentLogEvents", { runId, limit });
  return rows.map(decodeEvent);
}

/**
 * The activity interval of every incarnation of this run (the moment of `run-started` → the moment of that incarnation's last event),
 * in chronological order.
 *
 * The duration on the completion card is the sum of the lineage's **active** durations, and each incarnation of a run counts its
 * own segment — the gap between incarnations (process dead, not yet resumed) has nothing running and must not be counted.
 *
 * One SQL statement does it, and **not a single payload is decoded**: `lead()` pairs each incarnation's start with the next
 * incarnation's start into an interval, and a correlated subquery takes the timestamp of the row with the largest sequence inside
 * that interval. Both predicates land on `unique(run_id, sequence)`; the `type` column is redundancy stored for exactly this kind
 * of filter (payload_json holds a copy too). A run with 18k events therefore reads only a few rows instead of decoding 2.8 MB of
 * payload into memory — the latter being the very reason this read surface deliberately avoids `listEvents`.
 *
 * The subquery always has a solution (the interval contains at least `run-started` itself), so a normal row never returns null; it
 * is still narrowed defensively — this is a read surface that crosses a storage boundary, and a null would silently become NaN milliseconds.
 */
export function listRunLifeSpans(db: DwfJournalClient, runId: string): DwfRunLifeSpan[] {
  const rows = db.exec<{ started_at: number; last_activity_at: number | null }[]>(
    "listRunLifeSpans",
    { runId },
  );
  return rows.map((row) => ({
    startedAt: Number(row.started_at),
    lastActivityAt:
      typeof row.last_activity_at === "number"
        ? Number(row.last_activity_at)
        : Number(row.started_at),
  }));
}

/**
 * The runs under a given parent session (most recently updated first, up to `limit` rows), serving the host-side enumeration
 * surface behind `DynamicWorkflowRunPort.listRunsForSession` (the UI's post-restart discovery query). The `workflowRuns`
 * projection does not survive across processes, so the tool card join and Resume button availability can only be reconstructed from this table.
 *
 * A sibling of {@link SqliteDwfJournalStore.listNonTerminalRuns}: a narrow host query, deliberately kept out of the engine's
 * JournalStorePort. No index: the row count of dwf_run is on the order of "workflows per session" (single to double digits), so a full
 * scan is acceptable; should that order of magnitude ever change, the index shape should be (parent_session_id, time_updated).
 *
 * Rows are a narrow projection ({@link DwfRunSessionListItem}): **`result_json` is not selected** — that column holds the script's
 * top-level return value and is genuinely unbounded, while the listing surface never shows artifacts. `failure_json`, on the other
 * hand, must be fetched: the session enumeration surface has to report failureCode, and the predicate for `resumable` is precisely
 * "failed with code Interrupted" — dropping it would make every interrupted run silently count as unrecoverable. Timestamps come back
 * with the rows (`RunRecord` deliberately carries none).
 */
export function listRunsByParentSession(
  db: DwfJournalClient,
  parentSessionId: string,
  limit: number,
): DwfRunSessionListItem[] {
  const rows = db.exec<DwfRunSessionRow[]>("listRunsByParentSession", {
    parentSessionId,
    limit: Math.max(0, limit),
  });
  return rows.map(decodeRunSessionListItem);
}

export function listWorldNodes(db: DwfJournalClient, runId: string): DwfWorldNodeRow[] {
  const rows = db.exec<
    (Omit<DwfNodeRow, "id" | "result_json"> & {
      result_bytes: number | null;
      result_count: number | null;
      exit_code: number | null;
      stdout_bytes: number | null;
      stderr_bytes: number | null;
    })[]
  >("listWorldNodes", { runId });
  return rows.map((row) => {
    const record = decodeNode({ ...row, id: 0, result_json: null });
    return {
      ...record,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      ...(row.result_bytes === null ? {} : { resultBytes: row.result_bytes }),
      ...(row.result_count === null ? {} : { resultCount: row.result_count }),
      ...(typeof row.exit_code === "number" ? { exitCode: row.exit_code } : {}),
      ...(row.stdout_bytes === null ? {} : { stdoutBytes: row.stdout_bytes }),
      ...(row.stderr_bytes === null ? {} : { stderrBytes: row.stderr_bytes }),
    };
  });
}
