/**
 * The in-memory {@link JournalStorePort}: used in phase one for fake-driver tests and for replay/resume. Purely in memory and synchronous;
 * values are deep-copied in and out so that a reference the caller holds can never be changed by a later
 * write behind its back (simulating the storage boundary). The production implementation sits on the zcode session store's node:sqlite (DatabaseSync, synchronous)
 * and shares the JournalStorePort; transactional behavior is not part of the port surface — the driver composes the journal+session writes.
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
} from "./types.js";

/** A structured deep copy: it isolates the references on both sides of the storage boundary. The values are all JSON-compatible or pure data such as PersonaSpec. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The composite key of an actor / node. */
function key(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

export class InMemoryJournalStore implements JournalStorePort {
  // Buckets are divided by runId, which conforms to the storage semantics of "one store can host multiple runs".
  private readonly runs = new Map<string, RunRecord>();
  private readonly actors = new Map<string, Map<string, ActorRecord>>();
  private readonly nodes = new Map<string, Map<string, NodeRecord>>();
  private readonly events = new Map<string, StoredEvent[]>();

  createRun(record: RunRecord): void {
    if (this.runs.has(record.runId)) {
      throw new Error(`journal: run ${record.runId} already exists`);
    }
    this.runs.set(record.runId, clone(record));
    this.actors.set(record.runId, new Map());
    this.nodes.set(record.runId, new Map());
    this.events.set(record.runId, []);
  }

  getRun(runId: string): RunRecord | undefined {
    const r = this.runs.get(runId);
    return r === undefined ? undefined : clone(r);
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.status = status;
    if (status === "pending" || status === "running") {
      // Non-final state = no settlement: resume When turning run back to running, the residue from the previous life must be cleared, otherwise
      // The failure_json written by orphan convergence will coexist with running (journal snapshot reading will report "running" and
      // "has failed"). Contradictory settlement bags (non-final state but carrying failure/result) are also treated as cleared.
      delete r.failure;
      delete r.result;
      delete r.stopReason;
      delete r.supersededBy;
      return;
    }
    // Failure Trio (failure/stopReason/supersededBy) **Overall rewrite**: The settlement bag is the one that failed at this moment
    // The whole truth, absence is no failure. Under the old "absent = no touch" semantics, external writing failed + Interrupted
    // will survive subsequent completed settlements, and the line will say both "completed" and "interrupted"
    // (The SQLite side is the same coalesce, and the two implementations have the same semantics).
    if (settlement?.stopReason === undefined) delete r.stopReason;
    else r.stopReason = settlement.stopReason;
    if (settlement?.supersededBy === undefined) delete r.supersededBy;
    else r.supersededBy = settlement.supersededBy;
    if (settlement?.failure === undefined) delete r.failure;
    else r.failure = clone(settlement.failure);
    // Product is the opposite: an absent key means "no touch", and a repeated settlement without a product will not erase the settled product.
    // `result: null` is a legal product, only undefined is considered absent.
    if (settlement?.result !== undefined) r.result = clone(settlement.result);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.spentTokens = spentTokens;
  }

  updateRunCaps(runId: string, caps: Caps): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    // Deep copies work the same as other writes (no references are shared on either side of the storage boundary): the caller's copy of the caps is subsequently replaced,
    // You should not easily change the rows that have been dropped into the library.
    r.caps = clone(caps);
  }

  putActor(record: ActorRecord): void {
    const bucket = this.requireActorBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const a = this.actors.get(runId)?.get(key(siteId, ordinal));
    return a === undefined ? undefined : clone(a);
  }

  listActors(runId: string): ActorRecord[] {
    const bucket = this.actors.get(runId);
    return bucket === undefined ? [] : [...bucket.values()].map(clone);
  }

  putNode(record: NodeRecord): void {
    const bucket = this.requireNodeBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    const n = this.nodes.get(runId)?.get(key(siteId, ordinal));
    return n === undefined ? undefined : clone(n);
  }

  listNodes(runId: string): NodeRecord[] {
    const bucket = this.nodes.get(runId);
    return bucket === undefined ? [] : [...bucket.values()].map(clone);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // Orphan events (run has not yet createdRun) are contract violations like putActor/putNode: silent bucket creation
    // A batch of events that can never be attributed to any run will be written; there is FK on the SQLite side, and this sentence on the memory side.
    const list = this.events.get(runId);
    if (list === undefined) throw new Error(`journal: unknown run ${runId}`);
    // The appended time has the same semantics as `dwf_event.time_created` on the SQLite side (the two implementations share a contract test): in the event log
    // All "how long ago" can only be calculated from it. Let the reader retrieve Date.now() now and the entire history of cold replay will be marked as "just now".
    const stored: StoredEvent = {
      sequence: list.length,
      event: clone(event),
      timeCreated: Date.now(),
    };
    list.push(stored);
    return clone(stored);
  }

  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[] {
    const list = this.events.get(runId);
    if (list === undefined) return [];
    // sequence and array subscript are identical in the memory implementation (appendEvent is allocated using list.length), but here it is still
    // sequence comparison instead of offset by subscript: cursor's semantics are "strictly greater than the sequence", and so is the SQLite side
    // `where sequence > ?`. Both sides share the same contract test, and the semantics must be the same word-for-word.
    const after = opts?.afterSequence;
    const filtered = after === undefined ? list : list.filter((e) => e.sequence > after);
    const limited =
      opts?.limit === undefined ? filtered : filtered.slice(0, Math.max(0, opts.limit));
    return limited.map(clone);
  }

  private requireActorBucket(runId: string): Map<string, ActorRecord> {
    const bucket = this.actors.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }

  private requireNodeBucket(runId: string): Map<string, NodeRecord> {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }
}
