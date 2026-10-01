/**
 * The `JournalStorePort` adapter for the `dwf_*` tables.
 *
 * The port is synchronous and repository-shaped. The SQL lives in the
 * `zcode-events` Rust crate's synchronous `DwfJournal` surface
 * (spec §14): `this.db.exec(op, payload)` performs one native op, and the frozen
 * row ⇄ record codecs of `dwf-journal-codecs.ts` (unchanged) build the contract
 * records. There is no `node:sqlite` handle any more.
 *
 * The dependency direction against @zcode/dynamic-workflow: `import type` only. The port belongs to the domain package and this file is
 * one of its adapters; at runtime no value may be taken from the domain package (`implements` is erased at compile time).
 *
 * Transactionality is not part of the port surface: scenarios that need the same atomicity as a session write are composed by the driver with `begin immediate`.
 */

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
import type { DwfJournalClient } from "@zcode/rust/events";
import { createDwfJournal } from "@zcode/rust/events";
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

export class SqliteDwfJournalStore implements JournalStorePort, DwfRunIntrospectionQueries {
  constructor(private readonly db: DwfJournalClient) {}

  /**
   * Releases the native journal connection. The store owns it, so the store
   * closes it (parity with the `DatabaseSync` handle this replaced): the journal
   * runs on its own connection and must not outlive the session store.
   */
  close(): void {
    this.db.close();
  }

  createRun(record: RunRecord): void {
    const now = Date.now();
    // Logical → Physical (zero migration final state encoding, see dwf-journal-codecs.ts file header).
    const settlement = encodeRunSettlement(record.status, record);
    this.db.exec("createRun", {
      runId: record.runId,
      parentSessionId: record.parentSessionId ?? null,
      cwd: record.cwd ?? null,
      // name is in the same metadata path as scriptText/cwd: it is only written at the moment of build run, and nothing thereafter.
      name: record.name ?? null,
      scriptText: record.scriptText ?? null,
      scriptHash: record.scriptHash ?? null,
      toolCallId: record.toolCallId ?? null,
      // args is write-once metadata; resume re-reads the approved copy.
      argsJson: encodeJson(record.args),
      // lineage belongs to this write-once metadata path.
      resumedFrom: record.resumedFrom ?? null,
      // caps is not write-once metadata: `updateRunCaps` is the second writer.
      capsMaxConcurrency: record.caps.maxConcurrency,
      spentTokens: record.spentTokens,
      physicalStatus: settlement.status,
      failureJson: settlement.failureJson,
      resultJson: encodeResultJson(record.result),
      now,
    });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.exec<DwfRunRow | null>("getRun", { runId });
    return row ? decodeRun(row) : undefined;
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const now = Date.now();
    // Non-final state = None settlement: turning a run back to running clears the previous
    // life's failure_json / result_json (the native op branches on physicalStatus).
    if (status === "pending" || status === "running") {
      this.db.exec("updateRunStatus", {
        runId,
        physicalStatus: status,
        failureJson: null,
        resultJson: null,
        now,
      });
      return;
    }
    // Final state and product are written in one stroke (single UPDATE, no crash window).
    const encoded = encodeRunSettlement(status, settlement);
    this.db.exec("updateRunStatus", {
      runId,
      physicalStatus: encoded.status,
      failureJson: encoded.failureJson,
      resultJson: encodeResultJson(settlement?.result),
      now,
    });
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    this.db.exec("updateRunUsage", { runId, spentTokens, now: Date.now() });
  }

  /**
   * In-place update of this run's concurrency ceiling.
   * A narrow write: only caps_max_concurrency is listed (the native op's SQL lists one column).
   */
  updateRunCaps(runId: string, caps: Caps): void {
    this.db.exec("updateRunCaps", { runId, maxConcurrency: caps.maxConcurrency, now: Date.now() });
  }

  /**
   * All **non-terminal** runs under a given parent session (host-side orphan convergence).
   * Deliberately absent from `JournalStorePort` (same rationale as the deleted body).
   */
  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    const rows = this.db.exec<DwfRunRow[]>("listNonTerminalRuns", { parentSessionId });
    return rows.map(decodeRun);
  }

  // ---- Host side run introspection reading surface: delegation to dwf-journal-introspection.ts.

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
    this.db.exec("putActor", {
      runId: record.runId,
      siteId: record.siteId,
      ordinal: record.ordinal,
      name: record.name ?? null,
      personaJson: encodeJson(record.persona),
      sessionId: record.sessionId ?? null,
      resolvedModel: record.resolvedModel ?? null,
      now,
    });
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const row = this.db.exec<DwfActorRow | null>("getActor", { runId, siteId, ordinal });
    return row ? decodeActor(row) : undefined;
  }

  listActors(runId: string): ActorRecord[] {
    const rows = this.db.exec<DwfActorRow[]>("listActors", { runId });
    return rows.map(decodeActor);
  }

  putNode(record: NodeRecord): void {
    // Admission (running) → settlement → statistics backfill all follow the same upsert, and the key is (run_id, site_id, ordinal).
    this.db.exec("putNode", {
      runId: record.runId,
      siteId: record.siteId,
      ordinal: record.ordinal,
      kind: record.kind,
      actorSiteId: record.actorSiteId ?? null,
      actorOrdinal: record.actorOrdinal ?? null,
      actorSeq: record.actorSeq ?? null,
      inputHash: record.inputHash,
      status: record.status,
      resultJson: encodeResultJson(record.result),
      errorJson: encodeJson(record.error),
      statsJson: encodeJson(record.stats),
      // Driver supplementary column of the same family as stats_json: upsert replaces the entire column.
      messageBoundary: record.messageBoundary ?? null,
      // The product id and kind both belong to the engine and carry the identity column in both writes.
      artifactId: record.artifactId ?? null,
      // 0030: bounded input and kind/artifact_id belong to the same column that "the engine writes twice".
      inputJson: encodeJson(record.input),
      now: Date.now(),
    });
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    const row = this.db.exec<DwfNodeRow | null>("getNode", { runId, siteId, ordinal });
    return row ? decodeNode(row) : undefined;
  }

  listNodes(runId: string): NodeRecord[] {
    const rows = this.db.exec<DwfNodeRow[]>("listNodes", { runId });
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
    // The moment when time_created is written must be returned to the caller unchanged; the native
    // op allocates sequence with `coalesce(max(sequence)+1, 0)` in the same statement (legacy).
    const timeCreated = Date.now();
    const sequence = this.db.exec<number>("appendEvent", {
      runId,
      eventType: event.type,
      eventJson: JSON.stringify(event),
      timeCreated,
    });
    return { sequence, event, timeCreated };
  }

  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[] {
    // Both cursor and limit are pushed down into SQL by the native op (legacy semantics).
    const rows = this.db.exec<DwfEventRow[]>("listEvents", {
      runId,
      afterSequence: opts?.afterSequence,
      limit: opts?.limit,
    });
    return rows.map(decodeEvent);
  }
}

/** Open a dwf journal view over the session database; the tables are created by migration `0019_dwf_journal`. */
export function createDwfJournalStore(dbPath: string): SqliteDwfJournalStore {
  return new SqliteDwfJournalStore(createDwfJournal(dbPath));
}
