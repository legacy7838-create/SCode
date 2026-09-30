/**
 * The SQLite implementation of `JournalStorePort` (the dwf_* tables).
 *
 * The port is synchronous and repository-shaped, which fits node:sqlite's DatabaseSync exactly — so the engine
 * needs no async seam for persistence, and the determinism of replay no longer depends on the storage implementation.
 *
 * The dependency direction against @zcode/dynamic-workflow: `import type` only. The port belongs to the domain package and this file is
 * one of its adapters; at runtime no value may be taken from the domain package (`implements` is erased at compile time).
 *
 * Transactionality is not part of the port surface: scenarios that need the same atomicity as a session write are composed by the driver with `begin immediate`.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  ListEventsOptions,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import { encodeJson } from "../json.js";
// The product reading surface is a module of its own: it only has a db handle and has no shared state with the write-read of run/actor/node/event.
// And its two queries each carry a long argument about "why this number source, this sorting, and this cursor".
import {
  listArtifactItems,
  listArtifactRows,
  type DwfArtifactItem,
  type DwfArtifactItemsQuery,
} from "./dwf-journal-artifacts.js";
import {
  decodeActor,
  decodeEvent,
  decodeNode,
  decodeRun,
  encodeResultJson,
  encodeRunSettlement,
  type DwfActorRow,
  type DwfEventRow,
  type DwfNodeRow,
  type DwfWorldNodeRow,
  type DwfRunDetailRow,
  type DwfRunListItem,
  type DwfRunRow,
  type DwfRunSessionListItem,
} from "./dwf-journal-codecs.js";
import {
  countNodesByStatus,
  getRunRow,
  listRecentLogEvents,
  listRunLifeSpans,
  listRuns,
  listRunsByParentSession,
  listWorldNodes,
  type DwfListRunsQuery,
  type DwfNodeStatusCounts,
  type DwfRunIntrospectionQueries,
  type DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

export type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
// The run introspection reading surface (DwfRunIntrospectionQueries and its SQL) lives in dwf-journal-introspection.ts
//(max-lines splitting); the type is still exported from this file, and the existing importer does not need to change the path.
export type {
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

class SqliteDwfJournalStore implements JournalStorePort, DwfRunIntrospectionQueries {
  constructor(private readonly db: DatabaseSync) {}

  createRun(record: RunRecord): void {
    const now = Date.now();
    // Logical → Physical (zero migration final state encoding, see dwf-journal-codecs.ts file header).
    const settlement = encodeRunSettlement(record.status, record);
    try {
      this.db
        .prepare(
          `
          insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
            args_json, resumed_from, caps_max_concurrency,
            spent_tokens, status, failure_json, result_json, time_created, time_updated
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.runId,
          record.parentSessionId ?? null,
          record.cwd ?? null,
          // name is in the same metadata path as scriptText/cwd: it is only written at the moment of build run, and nothing thereafter.
          // The writer touches it (updateRunStatus intentionally does not list this column).
          record.name ?? null,
          record.scriptText ?? null,
          record.scriptHash ?? null,
          record.toolCallId ?? null,
          // Actually participates in the same metadata path of scriptText: it is only written at the moment of build run, and there is no writer after that.
          // Touch it - resume The approved copy must be read back and replayed.
          encodeJson(record.args),
          // lineage belongs to this write-once metadata path: revisions are supersede, predecessor lines are zero-touched,
          // Therefore, "Who revised this run from?" can only be written at the moment when the run is created.
          record.resumedFrom ?? null,
          // caps is not the same as the above columns: it is not write-once metadata. `updateRunCaps` is the second in this column
          // Writer - a revision that only changes `max_concurrency` is applied in-place on the living run, and resume inherits
          // The value in the row.
          record.caps.maxConcurrency,
          record.spentTokens,
          settlement.status,
          settlement.failureJson,
          encodeResultJson(record.result),
          now,
          now,
        );
    } catch (error) {
      // Repeated runs are contract errors on the caller's part and deserve a directly readable message; other failures (FK, disk, constraints) are thrown up as is.
      if (this.getRun(record.runId) !== undefined) {
        throw new Error(`dwf journal: run already exists: ${record.runId}`, { cause: error });
      }
      throw error;
    }
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("select * from dwf_run where id = ?").get(runId) as
      | DwfRunRow
      | undefined;
    return row ? decodeRun(row) : undefined;
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const now = Date.now();
    // Non-final state = None settlement: resume When turning run back to running, the failure_json of the previous life must be cleared /
    // result_json——The resume branch of the engine does not have a settlement bag, and the final state semantics of "absent key = not touched" will make the orphan converge.
    // Writing Interrupted fails concurrently with running. Conflicting settlement bag (not final but carrying failure/result)
    // It is also treated as clearing (the contract test is nailed, and the two implementations have the same semantics).
    if (status === "pending" || status === "running") {
      const { changes } = this.db
        .prepare(
          `
          update dwf_run set
            status = ?,
            failure_json = null,
            result_json = null,
            time_updated = ?
          where id = ?
          `,
        )
        .run(status, now, runId);
      this.assertRunTouched(changes, runId);
      return;
    }
    // Final state and product **written in one stroke**: two UPDATEs will open a crash window, creating "completed but result_json"
    // "Empty" run——It is the loss category that the 0020 column should be closed.
    //
    // `failure_json` **Whole column rewriting** (without coalesce). Orphans of the second desktop instance
    // Convergence writes failed + Interrupted on the run where the engine of this process is still alive; the engine then completes normally, and
    // coalesce leaves that external failure intact—the line says both "finished" and "interrupted." The settlement bag is that moment
    // The **full truth** of failure: stopped writes the envelope, errored writes its own failure (absent means NULL, that's the truth),
    // Completed is written as NULL.
    //
    // `result_json` reserved coalesce: The semantics of the product are "absent = not touched" (contract use case "keeps an
    // "already-settled artifact when a later write omits it"), a repeated settlement without artifacts should not erase it.
    const encoded = encodeRunSettlement(status, settlement);
    const { changes } = this.db
      .prepare(
        `
        update dwf_run set
          status = ?,
          failure_json = ?,
          result_json = coalesce(?, result_json),
          time_updated = ?
        where id = ?
        `,
      )
      .run(encoded.status, encoded.failureJson, encodeResultJson(settlement?.result), now, runId);
    this.assertRunTouched(changes, runId);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const { changes } = this.db
      .prepare("update dwf_run set spent_tokens = ?, time_updated = ? where id = ?")
      .run(spentTokens, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * In-place update of this run's concurrency ceiling.
   * A narrow write in the same family as `updateRunUsage`: **only caps_max_concurrency is listed** — status, usage and the settlement envelope
   * are not in this statement, each has its own write path, and mixing them in would let a ceiling change roll back a settlement as a side effect.
   * Zero migration: the column has existed for a long time, this method is simply its second writer.
   */
  updateRunCaps(runId: string, caps: Caps): void {
    const { changes } = this.db
      .prepare("update dwf_run set caps_max_concurrency = ?, time_updated = ? where id = ?")
      .run(caps.maxConcurrency, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * All **non-terminal** runs under a given parent session. Deliberately absent from `JournalStorePort`: the engine never looks up runs
   * by parent session, this query serves only host-side orphan convergence — a run whose process was killed stays `running`
   * forever, and the next app construction for the same session converges it away (`bootstrap/src/app/dynamic-workflow-run-service.ts`,
   * calls this method via capability probing).
   *
   * This method only emits SQL: the terminal-state set here is an **index-friendly pre-filter**, the authority for the decision stays on the service side (it filters the records again
   * with its own terminal set once it has them). `parent_session_id` must be part of the condition — a sweep without it would mark **in-flight** runs of a sibling
   * session in the same process as terminal (one sqlite, each with its own in-memory registry). SQL's `= ?` naturally does not match
   * `NULL`, so rows with no parent session belong to no session and are therefore never touched by any convergence pass.
   */
  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    // Physical final state set (failed/cancelled is the drop-out state of logical errored/stopped, and will not be migrated).
    const rows = this.db
      .prepare(
        `
        select * from dwf_run
        where parent_session_id = ?
          and status not in ('completed', 'failed', 'cancelled')
        order by id
        `,
      )
      .all(parentSessionId) as unknown as DwfRunRow[];
    return rows.map(decodeRun);
  }

  // ---- Host side run introspection reading surface: SQL and argument live in dwf-journal-introspection.ts, only delegation is done here.

  listRuns(query: DwfListRunsQuery): DwfRunListItem[] {
    return listRuns(this.db, query);
  }

  getRunRow(runId: string): DwfRunDetailRow | undefined {
    return getRunRow(this.db, runId);
  }

  countNodesByStatus(runId: string): DwfNodeStatusCounts {
    return countNodesByStatus(this.db, runId);
  }

  listRecentLogEvents(runId: string, limit: number): StoredEvent[] {
    return listRecentLogEvents(this.db, runId, limit);
  }

  listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
    return listRunLifeSpans(this.db, runId);
  }

  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[] {
    return listRunsByParentSession(this.db, parentSessionId, limit);
  }

  putActor(record: ActorRecord): void {
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_actor (
          run_id, site_id, ordinal, name, persona_json, session_id, resolved_model,
          time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          name = excluded.name,
          persona_json = excluded.persona_json,
          session_id = excluded.session_id,
          resolved_model = excluded.resolved_model,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.name ?? null,
        encodeJson(record.persona),
        record.sessionId ?? null,
        record.resolvedModel ?? null,
        now,
        now,
      );
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const row = this.db
      .prepare("select * from dwf_actor where run_id = ? and site_id = ? and ordinal = ?")
      .get(runId, siteId, ordinal) as DwfActorRow | undefined;
    return row ? decodeActor(row) : undefined;
  }

  listActors(runId: string): ActorRecord[] {
    const rows = this.db
      .prepare("select * from dwf_actor where run_id = ? order by id")
      .all(runId) as unknown as DwfActorRow[];
    return rows.map(decodeActor);
  }

  putNode(record: NodeRecord): void {
    // Admission (running) → settlement → statistics backfill all follow the same upsert, and the key is (run_id, site_id, ordinal).
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_node (
          run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq,
          input_hash, status, result_json, error_json, stats_json, message_boundary,
          artifact_id, input_json, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          kind = excluded.kind,
          actor_site_id = excluded.actor_site_id,
          actor_ordinal = excluded.actor_ordinal,
          actor_seq = excluded.actor_seq,
          input_hash = excluded.input_hash,
          status = excluded.status,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          stats_json = excluded.stats_json,
          message_boundary = excluded.message_boundary,
          artifact_id = excluded.artifact_id,
          input_json = excluded.input_json,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.kind,
        record.actorSiteId ?? null,
        record.actorOrdinal ?? null,
        record.actorSeq ?? null,
        record.inputHash,
        record.status,
        encodeResultJson(record.result),
        encodeJson(record.error),
        encodeJson(record.stats),
        // Driver supplementary column of the same family as stats_json: upsert replaces the entire column, so the supplementary party must first getNode
        // Then spread out and rewrite the entire record (contract this read-write mode).
        record.messageBoundary ?? null,
        // The product id and kind both belong to the ** engine and carry the identity column of ** in both writes (access running and settlement
        // completed/failed (the same id is written): upsert is replaced in its entirety, so writing it once less is equivalent to replacing
        // The product attribution of the settlement line is erased, and the post disappears directly from the reading page of "What products are available in this run?"
        record.artifactId ?? null,
        // 0030: Bounded input and kind/artifact_id belong to the same column that "the engine writes twice" - upsert replaces the entire line.
        // If the settlement is omitted once, the op/args recorded in the admission will be erased back to NULL.
        encodeJson(record.input),
        now,
        now,
      );
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    const row = this.db
      .prepare("select * from dwf_node where run_id = ? and site_id = ? and ordinal = ?")
      .get(runId, siteId, ordinal) as DwfNodeRow | undefined;
    return row ? decodeNode(row) : undefined;
  }

  listNodes(runId: string): NodeRecord[] {
    const rows = this.db
      .prepare("select * from dwf_node where run_id = ? order by id")
      .all(runId) as unknown as DwfNodeRow[];
    return rows.map(decodeNode);
  }

  listArtifactRows(runId: string): NodeRecord[] {
    return listArtifactRows(this.db, runId);
  }

  listWorldNodes(runId: string): DwfWorldNodeRow[] {
    return listWorldNodes(this.db, runId);
  }

  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): DwfArtifactItem[] {
    return listArtifactItems(this.db, runId, artifactId, query);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // The moment when time_created is written, it must be returned to the caller unchanged: decodeEvent gives the same number when reading this line back.
    // If you add a path but cannot get it, there will be an inconsistency like "the event just written does not have a time, it only exists when it is read back".
    const timeCreated = Date.now();
    // Sequence number allocation and writing must be the same statement: MAX(sequence)+1. Reading it once and then inserting it will cause the problem in multiple processes.
    // (Zcode under WAL allows multiple Agents to share the same library) to compete for duplicate serial numbers.
    const row = this.db
      .prepare(
        `
        insert into dwf_event (run_id, sequence, type, payload_json, time_created)
        values (
          ?,
          coalesce((select max(sequence) + 1 from dwf_event where run_id = ?), 0),
          ?, ?, ?
        )
        returning sequence
        `,
      )
      .get(runId, runId, event.type, JSON.stringify(event), timeCreated) as
      | Pick<DwfEventRow, "sequence">
      | undefined;
    if (row === undefined) {
      throw new Error(`dwf journal: event insert returned no sequence for run: ${runId}`);
    }
    return { sequence: row.sequence, event, timeCreated };
  }

  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[] {
    // Both cursor and limit are pushed down to SQL: take the full amount here and then slice it, which is equivalent to slicing the entire journal every time you turn a page.
    // Reading into memory - the reason paging exists is not to do this. Cursor semantics are "strictly greater than" (memory implementation is the same).
    const after = opts?.afterSequence;
    const limit = opts?.limit;
    const where = after === undefined ? "run_id = ?" : "run_id = ? and sequence > ?";
    const params: Array<string | number> = after === undefined ? [runId] : [runId, after];
    // `limit -1` is SQLite's "unlimited" way of writing, so the default and explicit limit share the same statement shape.
    const rows = this.db
      .prepare(`select * from dwf_event where ${where} order by sequence limit ?`)
      .all(...params, limit === undefined ? -1 : Math.max(0, limit)) as unknown as DwfEventRow[];
    return rows.map(decodeEvent);
  }

  /** An UPDATE affecting 0 rows means an "unknown run" — SQLite does not error on that, so it must be detected explicitly and fail loudly. */
  private assertRunTouched(changes: number | bigint, runId: string): void {
    if (Number(changes) === 0) throw new Error(`dwf journal: unknown run: ${runId}`);
  }
}

/** Open a dwf journal view over an existing session database; the tables are created by migration `0019_dwf_journal`. */
export function createDwfJournalStore(db: DatabaseSync): JournalStorePort {
  return new SqliteDwfJournalStore(db);
}
