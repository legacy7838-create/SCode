/**
 * The **consumed state** of the amend-resume import cache.
 *
 * The injected {@link ImportedRunCache} is read-only data built by the caller — the run service reads the predecessor journal to produce it, and a resume
 * after a crash rebuilds the very same table with the same pure function. So "how far it has been consumed" cannot be written back into that
 * table in place: it has to be the engine's own state. This module is that state plus every decision around it (hit / divergence / seed).
 *
 * Split out of scheduler.ts and engine.ts for the same reason scheduler was once split out of
 * engine: each of the three files stays focused and readable, and the per-file line cap is satisfied.
 */

import { canonicalJson } from "./hash.js";
import type {
  ActorRef,
  ActorSessionSeed,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedRunCache,
  ImportedWorldEntry,
  InstanceRef,
  NodeRecord,
  PersonaSpec,
} from "./types.js";

/**
 * The import consumption state of an actor that has an attached candidate: the consumption cursor plus the divergence flag.
 *
 * **Divergence is monotone**: once `diverged` is true the cache is never consulted again, and a discarded import suffix is never revived.
 */
export class ImportedActorState {
  /** The number of consumed import entries = the next hittable actorSeq (also the transcript truncation boundary index + 1). */
  private consumed = 0;
  private diverged = false;
  /**
   * The seq at which "the predecessor's in-flight ask was resumed" (absent when nothing was resumed). At most
   * one: resuming is itself a divergence, divergence is monotone, so there is never a second one.
   */
  private carriedSeq?: number;

  constructor(private readonly candidate: ImportedActorCandidate) {}

  /**
   * A fresh ask asks the cache at its seq: on a hit return the entry (advancing the cursor), otherwise set divergence and return undefined.
   *
   * Both kinds of miss are treated alike: a hash mismatch (the instruction changed) and `seq >= entries.length` (the new script added a new
   * ask for this actor). The **cascade** of divergence is free and dynamic — once an upstream ask goes live and yields a
   * new result, the instruction hash interpolated for the downstream one necessarily changes, so the downstream diverges automatically, with no explicit propagation anywhere.
   *
   * This method is only called while the import cache is **open** (once closed the call goes through {@link takeIfPure}), so a miss is allowed to talk about resumption.
   */
  take(seq: number, hash: string): ImportedAskEntry | undefined {
    if (this.diverged) return undefined;
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== hash) {
      this.diverge(seq, hash, true);
      return undefined;
    }
    this.consumed = seq + 1;
    return entry;
  }

  /**
   * How to ask once the cache is closed: only **pure** entries (those the predecessor recorded with `worldToolCalls === 0`) can still hit. A pure ask depends only on the instruction and the
   * transcript prefix — both are in the hash chain — and is unrelated to the workspace, so closing the cache does not change its answer. An entry that touched the outside
   * world gets nothing even at the same hash: the workspace it read may since have been rewritten, so that ask goes live and the actor diverges from there (the transcript
   * no longer matches the predecessor, and the suffix entries are not revivable). An old entry with no stats, or with no such key in its stats, is treated as "touched" (conservative).
   *
   * After closing, an in-flight ask is not resumed either: that half of the transcript is all observations the predecessor made of the **old** workspace, which is the same argument as for the tool-carrying entries.
   */
  takeIfPure(seq: number, hash: string): ImportedAskEntry | undefined {
    if (this.diverged) return undefined;
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== hash || entry.stats?.worldToolCalls !== 0) {
      this.diverge(seq, hash, false);
      return undefined;
    }
    this.consumed = seq + 1;
    return entry;
  }

  /** Whether the ask at this seq resumed the predecessor's in-flight ask (the scheduler decides from this whether the stats record worldToolCalls). */
  carriedAt(seq: number): boolean {
    return this.carriedSeq === seq;
  }

  /**
   * Re-derive the divergence state from one **recorded** ask row (used when resuming a crashed amended run).
   *
   * The divergence state is not persisted, and resuming an amended run rebuilds the whole import table. If the divergence point is not
   * re-derived from the journal rows, an actor that already diverged at seq k in the original execution could have its fresh ask at
   * seq k+n happen to match an imported entry's hash and be **imported wrongly** — that would push a stretch of history unrelated to this
   * run's actual transcript back in. Comparing each recorded row's inputHash with the imported entries, seq by seq, reproduces exactly the decision made during
   * the original execution (admission proceeds in ascending seq, and the hold rule guarantees that), so this re-derivation is exact, not a conservative approximation.
   * `wasLive` covers the one kind of live that the hash cannot see (a tool-carrying ask after the cache closed, see the scheduler's tryImportedSettle).
   *
   * `queuedBeforeClose` is the other half of the resume fact: resuming happens in the same synchronous slice of admission as that
   * ask's `node-queued`, so "the gate was open back then" is equivalent to "this node-queued came before the first import-cache-closed" (see
   * recoverImportClosure in engine-world.ts). It has to be exact — misjudging it as a resume makes seedActorTranscript copy one more stretch
   * of predecessor messages into an **already diverged** session (the driver's idempotency criterion only looks at whether the target is long enough).
   */
  reconcileRecorded(
    seq: number,
    recordedHash: string,
    wasLive: boolean,
    queuedBeforeClose: boolean,
  ): void {
    if (this.diverged) return;
    // After caching is turned off, an ask with a tool actor works even with the import
    // Entries and hashes are also run live - counting the hash as "consumed" will cause the seed boundary to be taken from the predecessor entry, and the current session's
    // The real transcription is not those messages at that location. Live or not is a fact in the event (node-queued), not a hash
    // It can be pushed out.
    if (wasLive) {
      this.diverge(seq, recordedHash, queuedBeforeClose);
      return;
    }
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== recordedHash) {
      // A line that has not been live cannot be a continuation (the continuation ask must have been dispatched and must be node-queued).
      this.diverged = true;
      return;
    }
    this.consumed = Math.max(this.consumed, seq + 1);
  }

  /**
   * The session seed of a diverged actor: the source session + how many messages to copy + the inherited model pin.
   *
   * The boundary is the bookkeeping value of the **last consumed** import entry: diverging at seq k means the exchanges 0..k-1 have all
   * settled from the cache, so the position the new session continues at is exactly the one after those k complete exchanges (their
   * repair / nudge rounds included). With nothing consumed there is no seed — a brand-new session, a brand-new model resolution, no
   * pin: a pin exists for "do not silently switch models under a transcript continuation", and without a continuation it has no use.
   *
   * **Resuming is the exception**: the boundary is taken from `inFlight.messageBoundary` (the predecessor's whole session), so even with nothing consumed there
   * is a seed — that is exactly the "amended while the first fan-out round was in flight" shape.
   */
  seed(): ActorSessionSeed | undefined {
    const inFlight = this.candidate.inFlight;
    if (this.carriedSeq !== undefined && inFlight !== undefined) {
      return this.seedAt(inFlight.messageBoundary);
    }
    if (this.consumed === 0) return undefined;
    const last = this.candidate.entries[this.consumed - 1];
    if (last === undefined) return undefined;
    return this.seedAt(last.messageBoundary);
  }

  /**
   * Set divergence, and while at it decide whether this miss is a **resume of the predecessor's in-flight ask**.
   *
   * All four resume conditions are required: not diverged before (otherwise this actor's transcript is no longer the predecessor's), `seq` exactly after the
   * prefix (the position of the in-flight ask), the whole prefix consumed, and an instruction hash matching the in-flight ask. `cacheOpen` is the fifth:
   * after closing, that half of the transcript is merely an observation of the old workspace, no more trustworthy than the cache's world reads.
   */
  private diverge(seq: number, hash: string, cacheOpen: boolean): void {
    const inFlight = this.candidate.inFlight;
    if (
      cacheOpen &&
      inFlight !== undefined &&
      seq === this.candidate.entries.length &&
      this.consumed === seq &&
      inFlight.inputHash === hash
    ) {
      this.carriedSeq = seq;
    }
    this.diverged = true;
  }

  private seedAt(messageCount: number): ActorSessionSeed {
    const seed: ActorSessionSeed = {
      sourceSessionId: this.candidate.transcriptSourceSessionId,
      messageCount,
    };
    if (this.candidate.resolvedModel !== undefined)
      seed.resolvedModel = this.candidate.resolvedModel;
    return seed;
  }
}

/**
 * The import queue consumption state of a world node: one cursor per content hash (the nth occurrence maps to
 * the nth record). As with {@link ImportedActorState}, the cursor is engine state and the injected queue stays read-only.
 */
export class ImportedWorldQueue {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly world: ReadonlyMap<string, ImportedWorldEntry[]>) {}

  /** Take the next record for that content hash; undefined when exhausted or never recorded (the caller goes live). */
  take(hash: string): ImportedWorldEntry | undefined {
    const queue = this.world.get(hash);
    if (queue === undefined) return undefined;
    const cursor = this.cursors.get(hash) ?? 0;
    const entry = queue[cursor];
    if (entry === undefined) return undefined;
    this.cursors.set(hash, cursor + 1);
    return entry;
  }
}

/**
 * Find an import candidate for a freshly created actor: look the table up by **effective name**, and accept it only if the canonical persona matches.
 *
 * The persona comparison uses `canonicalJson` — it skips undefined members and sorts object keys, which is exactly
 * the wanted normalization (`{name:"a"}` and `{name:"a", system: undefined}` are equal). A mismatch **discards the whole candidate** and the actor reruns from scratch, which
 * under full-fidelity transcripts is doubly correct — attaching a transcript produced by an old system prompt to a
 * new persona is an identity scramble, and the intent "I fixed the persona" is by definition a rerun.
 *
 * An anonymous actor never attaches: the name is the cache identity key, and without one there is no coordinate to compare against (that cost has
 * already been adjudicated). The comparison is done at **runtime** rather than by statically comparing two scripts at submit time: names and personas are runtime values (the
 * arguments of `agent()` may be dynamic expressions), and a static comparison would be a second source of truth — exactly what this package guards against everywhere.
 */
export function matchImportedActor(
  cache: ImportedRunCache | undefined,
  spec: PersonaSpec,
): ImportedActorState | undefined {
  if (cache === undefined) return undefined;
  const name = spec.name;
  if (name === undefined || name === "") return undefined;
  const candidate = cache.actors.get(name);
  if (candidate === undefined) return undefined;
  if (canonicalJson(spec) !== canonicalJson(candidate.persona)) return undefined;
  return new ImportedActorState(candidate);
}

/**
 * The **real** dwf_node row that an ask cache hit has to land (a new siteId, result / stats / boundary copied over).
 *
 * The boundary value has to be copied along, otherwise **this** run itself could never be amended
 * again — chain amendments rely on exactly that count offset being invariant when copied across prefixes.
 */
export function importedAskRecord(
  runId: string,
  instance: InstanceRef,
  actor: ActorRef,
  seq: number,
  hash: string,
  entry: ImportedAskEntry,
): NodeRecord {
  const record: NodeRecord = {
    runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "ask",
    actorSiteId: actor.siteId,
    actorOrdinal: actor.ordinal,
    actorSeq: seq,
    inputHash: hash,
    status: "completed",
    result: entry.result,
    messageBoundary: entry.messageBoundary,
  };
  if (entry.stats !== undefined) record.stats = entry.stats;
  return record;
}
