/**
 * Row ↔ record mapping for the dwf_* journal tables.
 *
 * Record types come in only via `import type` from @zcode/dynamic-workflow: the port lives in the domain package,
 * the SQLite store is just one of its adapters, and at runtime there must be no dependency on the domain package.
 *
 * Decoding rule: when a nullable column is NULL the **key is not written at all** (rather than written as undefined or null).
 * Contract tests do toEqual on the whole record, so an optional field absent from the input has to come back absent the same way.
 */

import type {
  ActorRecord,
  AskStats,
  Caps,
  NodeKind,
  NodeRecord,
  NodeRecordStatus,
  PersonaSpec,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
  WorkflowErrorJson,
  WorldReadInput,
} from "@zcode/dynamic-workflow";
import { decodeJson, encodeJson } from "../json.js";

/**
 * The **physical** vocabulary of `dwf_run.status` (the CHECK set of migration 0019, never migrated). The logical vocabulary is the engine's
 * `RunStatus` (`errored` / `stopped`), and the mapping between the two lives only in this file:
 *
 * | Logical                  | Physical status | failure_json                                        |
 * | ------------------------ | --------------- | --------------------------------------------------- |
 * | stopped{reason, error?}  | cancelled       | `{"stopReason": …, "error"?: WorkflowErrorJson}` envelope |
 * | errored{error}           | failed          | WorkflowErrorJson as-is                              |
 * | completed/pending/running | same name       | unchanged                                            |
 *
 * Decoding (historical rows need no backfill): `cancelled` → stopped, reason = the envelope's stopReason, absent (old rows) ⇒ `user`;
 * `failed` + code `Interrupted` → stopped(interrupted) (the convergence row for old orphans); every other `failed` → errored.
 * The accepted imprecision: a historical cancelled without a reason always decodes as user (including the ones TaskStop stopped).
 */
export type DwfRunPhysicalStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type RunStopReason = NonNullable<RunRecord["stopReason"]>;

/**
 * The envelope in a stopped row's failure_json (distinguished from WorkflowErrorJson by the `stopReason` key).
 * `supersededBy` and `stopReason: "superseded"` are written by the same write — the envelope is rewritten as a whole, so it lives
 * here with zero migration.
 */
interface DwfStoppedEnvelope {
  stopReason: RunStopReason;
  supersededBy?: string;
  error?: WorkflowErrorJson;
}

/** The triple of the logical terminal state: status + stop reason (+ successor) + structured failure. */
interface DwfRunSettlementFields {
  status: RunStatus;
  stopReason?: RunStopReason;
  supersededBy?: string;
  failure?: WorkflowErrorJson;
}

const INTERRUPTED_CODE = "Interrupted";
// Envelope sniffing whitelist: One value is missing. For this reason, the entire envelope cannot be decoded and the line degenerates into stopped(user).
const STOP_REASONS: ReadonlySet<string> = new Set([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);

/** Logical status (+ settlement bag) → physical column values. The single entry point on the write side (shared by createRun / updateRunStatus). */
export function encodeRunSettlement(
  status: RunStatus,
  settlement?: Pick<RunSettlementRecord, "stopReason" | "supersededBy" | "failure">,
): { status: DwfRunPhysicalStatus; failureJson: string | null } {
  switch (status) {
    case "stopped": {
      const envelope: DwfStoppedEnvelope = { stopReason: settlement?.stopReason ?? "user" };
      if (settlement?.supersededBy !== undefined) envelope.supersededBy = settlement.supersededBy;
      if (settlement?.failure !== undefined) envelope.error = settlement.failure;
      return { status: "cancelled", failureJson: JSON.stringify(envelope) };
    }
    case "errored":
      return { status: "failed", failureJson: encodeJson(settlement?.failure) };
    case "completed":
      return { status: "completed", failureJson: encodeJson(settlement?.failure) };
    case "pending":
    case "running":
      return { status, failureJson: null };
  }
}

/** Physical column values → the logical terminal-state triple. The single entry point on the read side (shared by full records and enumerated rows). */
function decodeRunSettlement(
  status: DwfRunPhysicalStatus,
  failureJson: string | null,
): DwfRunSettlementFields {
  const raw = decodeJson<Record<string, unknown>>(failureJson);
  switch (status) {
    case "cancelled": {
      const fields: DwfRunSettlementFields = { status: "stopped", stopReason: "user" };
      if (raw !== undefined && isStoppedEnvelope(raw)) {
        fields.stopReason = raw.stopReason;
        if (typeof raw.supersededBy === "string" && raw.supersededBy.length > 0) {
          fields.supersededBy = raw.supersededBy;
        }
        if (raw.error !== undefined) fields.failure = raw.error;
      }
      return fields;
    }
    case "failed": {
      const failure = raw as WorkflowErrorJson | undefined;
      if (failure?.code === INTERRUPTED_CODE) {
        return { status: "stopped", stopReason: "interrupted", failure };
      }
      return failure === undefined ? { status: "errored" } : { status: "errored", failure };
    }
    case "completed": {
      const failure = raw as WorkflowErrorJson | undefined;
      return failure === undefined ? { status: "completed" } : { status: "completed", failure };
    }
    case "pending":
    case "running":
      return { status };
  }
}

function isStoppedEnvelope(
  value: Record<string, unknown>,
): value is DwfStoppedEnvelope & Record<string, unknown> {
  return typeof value.stopReason === "string" && STOP_REASONS.has(value.stopReason);
}

/**
 * Logical status filter → SQL predicate (the statuses pushdown of `listRuns`). At the physical layer `stopped` / `errored` share
 * the `failed` column value and are told apart by the code inside `failure_json` — use SQLite's json_extract to separate them in SQL
 * rather than fetching a page and filtering (the latter would make limit and truncation probing lie).
 */
export function encodeRunStatusPredicate(statuses: readonly RunStatus[]): {
  sql: string;
  params: string[];
} {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const status of statuses) {
    switch (status) {
      case "stopped":
        clauses.push(
          "(status = 'cancelled' or (status = 'failed' and json_extract(failure_json, '$.code') = ?))",
        );
        params.push(INTERRUPTED_CODE);
        break;
      case "errored":
        clauses.push(
          "(status = 'failed' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)",
        );
        params.push(INTERRUPTED_CODE);
        break;
      default:
        clauses.push("status = ?");
        params.push(status);
    }
  }
  return { sql: clauses.length === 0 ? "0" : `(${clauses.join(" or ")})`, params };
}

export interface DwfRunRow {
  args_json: string | null;
  caps_max_concurrency: number;
  cwd: string | null;
  failure_json: string | null;
  id: string;
  name: string | null;
  parent_session_id: string | null;
  result_json: string | null;
  /** The lineage pointer for amend-resume (added by a newer migration). The narrow projection selects it too: see {@link DwfRunMetadataRow}. */
  resumed_from: string | null;
  script_hash: string | null;
  script_text: string | null;
  /** Run-level token usage (formerly budget_spent; the same number, it is just no longer called a budget). */
  spent_tokens: number;
  /** Physical vocabulary (see the mapping table at the top of the file); the logical status is decoded by {@link decodeRunSettlement} together with failure_json. */
  status: DwfRunPhysicalStatus;
  time_created: number;
  time_updated: number;
  tool_call_id: string | null;
}

/**
 * The **metadata columns** of dwf_run (excluding the possibly huge result_json). Enumeration queries select only these columns:
 * decoding result_json for a 50-row page amounts to reading the whole database's artifacts into memory, and the list surface never shows it.
 *
 * The physical `failed` can be either errored or
 * stopped(interrupted), and the logical status is only decodable together with failure_json; it is a small
 * structured object (code + message + envelope), so decoding it row by row carries no memory risk. Enumerated rows still carry **no** `failure` field.
 *
 * The argument is a small JSON bag that has been schema-validated
 * — the GUI hub's run history rows display it — while failure / result are the unbounded artifact columns.
 *
 * `resumed_from` belongs to this layer (it is not one of the omitted large columns): it is a short string, and the "absent = not a revision"
 * decoding rule requires the column to actually be selected — miss it and `row.resumed_from` is undefined in the narrow query,
 * which takes a different branch from NULL, so the enumerated row ends up carrying a key whose value is undefined.
 */
export type DwfRunMetadataRow = Omit<DwfRunRow, "result_json">;

/** The journal-side row timestamps. `RunRecord` deliberately carries no time (the engine does not care), but the read surfaces report created/updated. */
export interface DwfRunTimestamps {
  timeCreated: number;
  timeUpdated: number;
}

/**
 * One row of an enumeration query: run metadata + timestamps, **without** failure / result.
 * A detail row is a superset of it, so the list and get read surfaces can share one set of labels and attribution derivations.
 */
export type DwfRunListItem = Omit<RunRecord, "failure" | "result"> & DwfRunTimestamps;

/** One row of a detail query: the full `RunRecord` (with failure / result) + timestamps. */
export type DwfRunDetailRow = RunRecord & DwfRunTimestamps;

/**
 * One row of a session enumeration query: {@link DwfRunListItem} + `failure`, **still without result**.
 *
 * Why not just use {@link DwfRunListItem}: the session enumeration surface (`listRunsForSession` → `/dwf list`)
 * has to report failureCode/failureMessage, and the `resumable` predicate is exactly "failed with code
 * Interrupted" — dropping failure_json would make every interrupted run count as unrecoverable,
 * which is a silently wrong answer rather than one column less to display.
 *
 * Why result_json is still not fetched: that column is genuinely unbounded (a script's top-level return value), and the list surface never shows
 * artifacts. failure_json is a small structured object (code + message), so decoding it row by row carries no memory risk.
 */
export type DwfRunSessionRow = DwfRunMetadataRow;

/** The record shape of {@link DwfRunSessionRow}. */
export type DwfRunSessionListItem = DwfRunListItem & Pick<RunRecord, "failure">;

export interface DwfActorRow {
  id: number;
  name: string | null;
  ordinal: number;
  persona_json: string | null;
  resolved_model: string | null;
  run_id: string;
  session_id: string | null;
  site_id: string;
  time_created: number;
  time_updated: number;
}

export interface DwfNodeRow {
  actor_ordinal: number | null;
  actor_seq: number | null;
  actor_site_id: string | null;
  /**
   * The id of a user-facing artifact (added by a newer migration). Rows with `kind = 'artifact'` carry the artifact they published / declared;
   * tagged `kind = 'report'` rows carry the predefined artifact they fed. Every other row is NULL.
   * ⚠ Unrelated to `RunSettlement.artifact` (a script's top-level return value).
   */
  artifact_id: string | null;
  error_json: string | null;
  id: number;
  input_hash: string;
  /** The bounded `{op, args}` of a world-read / world-run row (added by a newer migration); every other row is NULL as before. */
  input_json: string | null;
  kind: NodeKind;
  /** The length (count offset) of the actor conversation message log after an ask settles (added by a newer migration). */
  message_boundary: number | null;
  ordinal: number;
  result_json: string | null;
  run_id: string;
  site_id: string;
  stats_json: string | null;
  status: NodeRecordStatus;
  time_created: number;
  time_updated: number;
}

/**
 * One row of the workspace read surface: the `NodeRecord` of a world-read / world-run
 * (**without `result`** — the body has its own read surface keyed by (siteId, ordinal)) + journal timestamps +
 * the byte count of `result_json` (the "how big" on the manifest, reportable without decoding the body).
 */
export interface DwfWorldNodeRow extends Omit<NodeRecord, "result">, DwfRunTimestamps {
  /** The UTF-8 byte count of `result_json`; absent while the row is unsettled or settlement failed. */
  resultBytes?: number;
  /**
   * The element count when the body is a JSON array (the file count of `glob`, the match count of `grep`, the path count of `git.changedFiles`).
   * Computed inside the query by SQLite's JSON functions; the body itself never leaves the database.
   */
  resultCount?: number;
  /** The `exitCode` on the body after `world.run` settles; absent for other ops and for unsettled rows. */
  exitCode?: number;
  /** The UTF-8 byte counts of `stdout` / `stderr` after `world.run` settles. */
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface DwfEventRow {
  id: number;
  payload_json: string;
  run_id: string;
  sequence: number;
  time_created: number;
  type: string;
}

/**
 * The encoding dedicated to the `result` column. `null` is a legal ask result (`ask<T | null>` returns it),
 * while the shared encodeJson squashes undefined and null together into SQL NULL — then `result: null` stored and read back
 * turns into "there is no result". Here only undefined maps to SQL NULL.
 */
export function encodeResultJson(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : text;
}

/**
 * Shared decoding of run metadata. Full records and enumerated rows both start from here, so the two read surfaces
 * can never diverge over "which optional columns count as absent".
 */
function decodeRunMetadata(row: DwfRunMetadataRow): Omit<RunRecord, "failure" | "result"> {
  const caps: Caps = { maxConcurrency: row.caps_max_concurrency };

  const settlement = decodeRunSettlement(row.status, row.failure_json);
  const record: Omit<RunRecord, "failure" | "result"> = {
    runId: row.id,
    caps,
    spentTokens: row.spent_tokens,
    status: settlement.status,
  };
  if (settlement.stopReason !== undefined) record.stopReason = settlement.stopReason;
  if (settlement.supersededBy !== undefined) record.supersededBy = settlement.supersededBy;
  if (row.parent_session_id !== null) record.parentSessionId = row.parent_session_id;
  if (row.cwd !== null) record.cwd = row.cwd;
  // The row name before the column is introduced is NULL (new column, no backfill): it is resolved into **absent key**, and the reader will follow the first line of the script accordingly.
  if (row.name !== null) record.name = row.name;
  // The rows that were dropped into the database early do not have the value of this column (NULL means absent), so they are resolved into absent keys, and the historical run reads them back as usual.
  if (row.tool_call_id !== null) record.toolCallId = row.tool_call_id;
  if (row.script_text !== null) record.scriptText = row.script_text;
  if (row.script_hash !== null) record.scriptHash = row.script_hash;
  // Rows dropped early, and every non-revised run (the vast majority) have this column NULL: interpreted as an absent key.
  // The reading side determines "whether this run needs to rebuild the import cache" based on this.
  if (row.resumed_from !== null) record.resumedFrom = row.resumed_from;
  // The rows dropped early do not have the value of this column (NULL means absent): interpret it as **absent key** instead of `{}`, so that "no actual parameters"
  // It remains distinguishable from "the actual parameter is an empty bag" at the record level; the sandbox side uniformly reads the absence as `{}` (invariant 7).
  if (row.args_json !== null) record.args = JSON.parse(row.args_json) as Record<string, unknown>;
  return record;
}

export function decodeRun(row: DwfRunRow): RunRecord {
  const record: RunRecord = decodeRunMetadata(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) record.failure = failure;
  // Rows dropped early have no value (the column is newly added and the value is NULL): it must be resolved into **absent key**, not undefined
  // value or an error will be thrown, otherwise all historical runs will not be read back after the upgrade. `result: null` follows the same JSON.parse
  // path, so legal null products still appear in the record (same convention as node's result_json).
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  return record;
}

/** Enumerated row: metadata + timestamps. */
export function decodeRunListItem(row: DwfRunMetadataRow): DwfRunListItem {
  return {
    ...decodeRunMetadata(row),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}

/** Detail row: full record + timestamps. */
export function decodeRunDetailRow(row: DwfRunRow): DwfRunDetailRow {
  return { ...decodeRun(row), timeCreated: row.time_created, timeUpdated: row.time_updated };
}

/** Session enumerated row: metadata + timestamps + failure (result_json is not decoded — that column was not selected). */
export function decodeRunSessionListItem(row: DwfRunSessionRow): DwfRunSessionListItem {
  const item: DwfRunSessionListItem = decodeRunListItem(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) item.failure = failure;
  return item;
}

export function decodeActor(row: DwfActorRow): ActorRecord {
  const record: ActorRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
  };
  if (row.name !== null) record.name = row.name;
  const persona = decodeJson<PersonaSpec>(row.persona_json);
  if (persona !== undefined) record.persona = persona;
  if (row.session_id !== null) record.sessionId = row.session_id;
  // The column in the row before the column is introduced is NULL: resolved into **absent key**, historical actor records can still be retrieved.
  if (row.resolved_model !== null) record.resolvedModel = row.resolved_model;
  return record;
}

export function decodeNode(row: DwfNodeRow): NodeRecord {
  const record: NodeRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
    kind: row.kind,
    inputHash: row.input_hash,
    status: row.status,
  };
  if (row.actor_site_id !== null) record.actorSiteId = row.actor_site_id;
  if (row.actor_ordinal !== null) record.actorOrdinal = row.actor_ordinal;
  if (row.actor_seq !== null) record.actorSeq = row.actor_seq;
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  const error = decodeJson<WorkflowErrorJson>(row.error_json);
  if (error !== undefined) record.error = error;
  const stats = decodeJson<AskStats>(row.stats_json);
  if (stats !== undefined) record.stats = stats;
  // Rows dropped early, non-ask nodes, and ask whose boundaries have not been filled by the driver are all NULL → absent keys.
  // `0` is a **legal boundary** (zero messages are copied), so the test must be `!== null` rather than a truth test.
  if (row.message_boundary !== null) record.messageBoundary = row.message_boundary;
  // Rows dropped early and every report / ask / world-* row that is neither a product row nor a label are NULL
  // → Resolves to **absent keys** (not undefined values). Kanban access is filtered by "artifact_id matching".
  // A key with a value of undefined will cause the entire toEqual test to fail.
  if (row.artifact_id !== null) record.artifactId = row.artifact_id;
  // The lines before 0030 and the ask / report / artifact lines are NULL → absent keys (readers return static tags accordingly).
  const input = decodeJson<WorldReadInput>(row.input_json);
  if (input !== undefined) record.input = input;
  return record;
}

export function decodeEvent(row: DwfEventRow): StoredEvent {
  return {
    sequence: row.sequence,
    event: JSON.parse(row.payload_json) as RunEvent,
    // The only clock in the event log: log line age, subagent
    // The time of the last action is calculated from it. The column always has a value starting from 0019, so it is written unconditionally here.
    timeCreated: row.time_created,
  };
}
