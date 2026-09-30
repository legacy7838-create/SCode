// ============================================================
// Import construction of amend-resume: read predecessor journal → ImportedRunCache
// ============================================================
//
// This module is the only **reading precursor** of amend-resume, and it is shared by three call points:
//   1. **preflight** of `port.amend` ({@link preflightAmendImport}): stop before flying the front wheel
//      `run_not_found` / `missing_boundaries` - when rejected, the precursor is still running and no line is built;
//   2. `port.amend` builds the cache after precursor settlement ({@link buildImportedCache});
//   3. `port.resume` See `record.resumedFrom` present: Rebuild the same table after a crash.
//
// Both places share the same set of build rules: the journal of the revised run only contains consumed execution prefixes, and unconsumed imports need to be rebuilt.
// Completed entries are determined only by the journal, and the traversal order is taken from the insertion order of the journal; the boundaries of unfinished asks also depend on the source transcription.
//
// One exception, to be clear, is the first number in this table that is not a pure function of journal: the continuation of ask
// The boundary of (`inFlight`) is taken from the number of messages in the predecessor session at this moment, not a column in the journal.
//
// It is generally stable between builds, relying on the "session that the predecessor has settled and no one is writing it anymore":
//   - Guaranteed by {@link AmendImportOptions.quietSessions} when submitting (the replaced predecessor has just abort, the driver waits for it
//     The turn is landed; the unawaited session will not be continued);
//   - When rebuilding, the predecessor has already terminated, and there is no driver for it in this process. Naturally, no one is writing it, so this collection is not included (absent =
//     All silent).
//
// But "roughly" is not "certainly", and it doesn't have to be: two ways can allow reconstruction to calculate a larger M - the precursor is resumed
// After a few more rounds of writing (the superseded predecessor cannot be resumed, so the only option is to "revise a run that has already been stopped, and then
// resume it" constructor), or a late background notification message fell into that session. Both will only make M **bigger**,
// And correctness does not depend on M being stable:
//   - The door is closed on the side where you copied it in - `seedActorTranscript` only goes to "empty, or contains only this session seed"
//     Write it in the target of the message (property 2 of workflow-actor-transcript.ts). Once news of his successor leaks out, the bigger problem will be
//     Even if M is sent back, not a single byte will be written, so there is no such thing as "predecessor messages are appended to the end of this session history"
//     Silent confusion;
//   - Before the successor has released its own message, the larger M copies **a later snapshot** of the same ask, and the order is still determined by the subscript.
//     (The seed id presses (session, subscript) for pure confirmation, and re-copying is upsert), so it just adds a little more context and will not become wrong.
// This is also a guide for every non-journal fact in the future: there is no need to prove one by one that they will not grow larger, and the replication point will be blocked at once.
//
// The only I/O is journal reading and transcript reading (both are injected through narrow ports). This module does not touch the session storage implementation itself.

import type { Logger, SessionId } from "@zcode/contracts";
import type {
  ActorRecord,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedRunCache,
  ImportedWorldEntry,
  NodeRecord,
  RunRecord,
} from "@zcode/dynamic-workflow";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";

/**
 * The journal read surface that building the import cache needs: three read methods, all keyed by runId.
 *
 * Structurally a true subset of the engine's `JournalStorePort` (production passes the journal straight in); the reason for narrowing is the same as for
 * {@link ActorTranscriptStore}: the builder reads only these three, and declaring the whole port would make "import building depends on every capability of the journal
 * (writes included)" a true statement — yet it writes not a single byte. **The predecessor is read-only** is an invariant; let the type say it out loud.
 */
interface ImportedCacheJournalReader {
  getRun(runId: string): RunRecord | undefined;
  listActors(runId: string): ActorRecord[];
  listNodes(runId: string): NodeRecord[];
}

/**
 * The three reasons an import build can be refused. **A discriminant key, not prose**: the model picks its next action from it (switch run / wait
 * for it to settle / abandon the amendment), so the three must stay distinguishable; the actionable wording belongs to the tool layer.
 *
 * Literally the same set as the port's `DynamicWorkflowRunSubmitRefusalReason` (contracts): the service hands out the reason as-is, so drift
 * between the two is a compile error, not a discriminant key quietly becoming `undefined`. Deliberately not imported from
 * contracts: this module is the domain-side builder, and the port vocabulary depending on it is the correct direction around.
 */
type ImportedCacheRefusalReason =
  /** The journal has no such predecessor run. */
  | "run_not_found"
  /** The predecessor is still in flight (non-terminal). Amending a run in **any** terminal state is legal, completed included. */
  | "not_amendable"
  /** The predecessor has a completed ask with no message boundary: a marker-less predecessor is rejected wholesale (no fallback degradation). */
  | "missing_boundaries";

/** Build result: on success it carries the tables plus the lineage pointers, on failure only the discriminant key. */
type BuildImportedCacheResult =
  | { ok: true; cache: ImportedRunCache; resumedFrom: string }
  | { ok: false; reason: ImportedCacheRefusalReason };

/**
 * The two refusal reasons of the amend pre-check: literally the same set as the port's
 * `DynamicWorkflowRunAmendRefusalReason`. There is no `not_amendable` — an in-flight predecessor is stopped by the amend, not refused.
 */
type AmendPreflightRefusalReason = Exclude<ImportedCacheRefusalReason, "not_amendable">;

type AmendPreflightResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: AmendPreflightRefusalReason };

/**
 * The amend's **pre-check**: the predecessor exists ∧ every completed ask has a message boundary. **It does not look at state** — both are properties of
 * the predecessor's journal, stopping changes neither, so they can be decided before the stop; pre-check first, then stop, and a refused
 * amend never leaves behind a run stopped for nothing. A completed ask of an in-flight run was written to the
 * store together with its boundary, so the pre-check for an in-flight predecessor is exactly as decisive as for a settled one.
 */
export function preflightAmendImport(
  journal: Pick<ImportedCacheJournalReader, "getRun" | "listNodes">,
  predecessorRunId: string,
): AmendPreflightResult {
  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  if (!completedAsksHaveBoundaries(journal.listNodes(predecessorRunId))) {
    return { ok: false, reason: "missing_boundaries" };
  }
  return { ok: true, run };
}

/**
 * The predicate of gate 3, shared by the pre-check and the build: a missing marker has only two causes — a journal written before the
 * marker column was introduced, and driver-side bookkeeping failure — and both mean "this run's boundary bookkeeping is untrustworthy", so it is strict over the whole table,
 * not just the rows to be imported; an unfinished ask without a boundary is **normal** (it never enters the import prefix), so only completed rows count.
 */
function completedAsksHaveBoundaries(nodes: readonly NodeRecord[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "ask" || node.status !== "completed") continue;
    if (node.messageBoundary === undefined) return false;
  }
  return true;
}

/**
 * The three dependencies that building the import cache needs. The field names line up verbatim with `DynamicWorkflowRunServiceDeps` (this interface is a structural
 * subset of it), so both run-service call sites pass `deps` through unchanged — one more renaming layer is one more piece of wiring
 * that can drift, and its symptom is a silent degradation like "the transcript surface is clearly wired up yet no honesty check happens".
 */
interface AmendImportDeps {
  journal: ImportedCacheJournalReader;
  /**
   * The session transcript read surface. When present it adds one more **source honesty check** (see {@link honorsBoundary}); when absent,
   * candidates are still accepted — the driver-side seed fulfillment still fails loudly, and that is the corruption-level backstop.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
}

/**
 * The **runtime side evidence** visible at build time, as opposed to journal facts. Today there is only one: which predecessor sessions have finished writing.
 *
 * Deliberately kept out of {@link AmendImportDeps}: deps is the wiring (journal, transcript surface, logger), the same object
 * from start to finish within one process; this object is an observation that only holds **for this one build**, and two
 * builds may differ — folding it into deps would bend "the same deps always give the same tables".
 */
export interface AmendImportOptions {
  /**
   * The ids of predecessor sessions that have already gone **quiet** (no more turns being written). They only affect the resumption
   * of an in-flight ask: the completed prefix's boundary is a journal fact, unrelated to how long the session is right now.
   *
   * **Absent = all quiet**, not "none of them quiet". Each of the two call sites takes half: amend has just aborted an
   * in-flight predecessor and the aborted turn may still be landing its last few messages, so it comes in with the
   * set the driver computed; the resume-side rebuild ({@link rebuildImportedCacheForResume}) faces a predecessor that settled long ago with no driver
   * in this process, nothing writing its session — absent means exactly that. Reversed, the rebuilt table would come up one
   * `inFlight` short of the submitted one, and both sides must be the same table (see the head of this file).
   */
  quietSessions?: ReadonlySet<string>;
}

/**
 * Read the predecessor journal and the transcript state, and build an {@link ImportedRunCache}. The completed prefix is decided by
 * the journal; the resumption of an unfinished ask additionally depends on the source session's message count and quiescent status.
 *
 * Three gates, in order (gate first, then build: when a gate fails not one line need be read):
 *   1. the predecessor does not exist → `run_not_found`;
 *   2. the predecessor is non-terminal → `not_amendable`;
 *   3. the predecessor has a completed ask with no `messageBoundary` → `missing_boundaries`.
 *
 * The reason gate 3 is **strict over the whole table** (instead of only checking the rows that would really be imported): a missing marker has only
 * two causes — a journal written before the marker column was introduced, and driver-side bookkeeping failure — and both mean "this run's boundary
 * bookkeeping is untrustworthy", not "this one row just happens to be unrecorded". Letting rows through one by one means a half-broken-bookkeeping predecessor produces
 * a table that looks complete, truncated at the wrong place once it diverges (the context the model sees quietly offset from the
 * boundary the journal records). A journal missing the boundary of a completed ask is rejected wholesale; it does not synthesize a possibly-wrong transcript
 * boundary. An unfinished ask without a boundary is **normal** (they never enter the import prefix), so the gate only looks at completed rows.
 */
export async function buildImportedCache(
  deps: AmendImportDeps,
  predecessorRunId: string,
  options?: AmendImportOptions,
): Promise<BuildImportedCacheResult> {
  const { actorTranscriptStore: transcripts, journal, logger } = deps;

  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  // Revisable set = any final state, **intentionally not reusable** plain resume's isResumableRecord: that predicate is
  // byte-identical resume gate (stopped), and the revision excludes exactly the two categories
  // The most useful - script true failure (bug fix, cache save) and completed (warm startup extended analysis). Each of the two collections has its own story.
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { ok: false, reason: "not_amendable" };

  const nodes = journal.listNodes(predecessorRunId);
  if (!completedAsksHaveBoundaries(nodes)) return { ok: false, reason: "missing_boundaries" };

  const actors = new Map<string, ImportedActorCandidate>();
  for (const record of namedUniqueActors(journal.listActors(predecessorRunId), logger)) {
    const name = record.name!;
    const candidate = await buildActorCandidate({
      actor: record,
      journal,
      ...(logger === undefined ? {} : { logger }),
      nodes,
      predecessorRunId,
      ...(options?.quietSessions === undefined ? {} : { quietSessions: options.quietSessions }),
      ...(transcripts === undefined ? {} : { transcripts }),
    });
    if (candidate !== undefined) actors.set(name, candidate);
  }

  return {
    ok: true,
    cache: { actors, world: buildWorldQueues(nodes) },
    resumedFrom: predecessorRunId,
  };
}

/**
 * The predecessor's actor rows that are **eligible candidates**: non-empty name ∧ that name unique in this run.
 *
 * Anonymous ones are not taken (the name is the cache identity key; without one there is no coordinate to compare against); for a
 * duplicate name **neither is taken** — the engine's `DuplicateActorName` is a later runtime invariant, so journals written before it can really hold duplicate rows, and "look
 * the candidate up by name" on such a predecessor is a coin flip. Picking one is worse than picking neither: the price of
 * neither is that the two actors rerun from scratch, while the price of picking wrong is treating another actor's session prefix as prior context.
 */
function namedUniqueActors(records: ActorRecord[], logger?: Logger): ActorRecord[] {
  const byName = new Map<string, ActorRecord[]>();
  for (const record of records) {
    const name = record.name;
    if (name === undefined || name === "") continue;
    const bucket = byName.get(name);
    if (bucket === undefined) byName.set(name, [record]);
    else bucket.push(record);
  }
  const unique: ActorRecord[] = [];
  for (const [name, bucket] of byName) {
    if (bucket.length === 1) {
      unique.push(bucket[0]!);
      continue;
    }
    logger?.warn?.("Dynamic workflow amend: duplicate actor name in predecessor, skipped", {
      actorName: name,
      count: bucket.length,
      event: "dynamic_workflow.amend.duplicate_actor_name",
      module: "bootstrap.app",
    });
  }
  return unique;
}

/**
 * A candidate actor's importable prefix + transcript source; any missing link returns `undefined` (the actor reruns).
 *
 * **Degrade rather than fail** is the tone here (the opposite of the gates' "reject wholesale"): a missing prefix, a missing persona, no session on the
 * chain, a cleaned-up source session — all only mean "this actor has no cache", and no cache row in the journal means
 * none; it does not lie. Only untrustworthy boundary bookkeeping is rejected wholesale, because that would truncate an **already accepted** candidate at the wrong place.
 */
async function buildActorCandidate(input: {
  actor: ActorRecord;
  journal: ImportedCacheJournalReader;
  logger?: Logger;
  nodes: NodeRecord[];
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  transcripts?: ActorTranscriptStore;
}): Promise<ImportedActorCandidate | undefined> {
  const { actor, journal, logger, nodes, predecessorRunId, quietSessions, transcripts } = input;
  const name = actor.name!;

  // persona is a frozen identity that the engine sets simultaneously when creatingActor, so it must be present normally; absence can only be caused by external force
  // Rewritten lines. Without a comparison object, there is no way to talk about persona consistency during runtime comparison - discard the candidate instead of taking `{}` as the top one.
  if (actor.persona === undefined) return undefined;

  const { entries, next } = completedAskPrefix(nodes, actor);
  // There is neither a completion prefix nor a flying ask after the prefix: this actor really has nothing to import at all.
  // Leaving early saves the following chain walking and one-time transcription reading.
  if (entries.length === 0 && next?.status !== "running") return undefined;

  const source = resolveTranscriptSource({
    actorName: name,
    journal,
    startRunId: predecessorRunId,
  });
  if (source === undefined) {
    // There is no ancestor in the chain that holds a session for this actor (either it was never created, or the session has been cleaned up). Full fidelity transcription is a feature of this
    // Verdict, without transcription there is no continuation - downgraded to a completely new actor.
    logger?.info?.("Dynamic workflow amend: no transcript source for actor, import dropped", {
      actorName: name,
      event: "dynamic_workflow.amend.transcript_source_missing",
      module: "bootstrap.app",
      runId: predecessorRunId,
    });
    return undefined;
  }

  // The boundary for empty prefixes is 0 (there is no completion exchange, and the continuation position can only be counted from 0 onward).
  const boundary = entries.length === 0 ? 0 : entries[entries.length - 1]!.messageBoundary;
  // Number of transcripts **Read only once**: The source integrity check is the same number used in the continuation position of fly ask. Reading it twice equals giving
  // The same fact opens two observation windows, and they do not need to be equal.
  const messageCount =
    transcripts === undefined ? undefined : await countSource(transcripts, source.sessionId);
  if (transcripts !== undefined && (messageCount === undefined || messageCount < boundary)) {
    logger?.warn?.(
      "Dynamic workflow amend: transcript source shorter than boundary, import dropped",
      {
        actorName: name,
        event: "dynamic_workflow.amend.transcript_source_short",
        messageBoundary: boundary,
        module: "bootstrap.app",
        sessionId: source.sessionId,
      },
    );
    return undefined;
  }

  const inFlight = resolveInFlightAsk({
    actor,
    boundary,
    ...(logger === undefined ? {} : { logger }),
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(next === undefined ? {} : { next }),
    predecessorRunId,
    ...(quietSessions === undefined ? {} : { quietSessions }),
    sourceSessionId: source.sessionId,
  });
  // The prefix is ​​empty and the connection is not negotiated: this candidate cannot take away a single byte, and accepting it will only cause the engine to create a session for an empty table.
  if (entries.length === 0 && inFlight === undefined) return undefined;

  return {
    persona: actor.persona,
    entries,
    ...(inFlight === undefined ? {} : { inFlight }),
    transcriptSourceSessionId: source.sessionId,
    ...(source.resolvedModel === undefined ? {} : { resolvedModel: source.resolvedModel }),
  };
}

/**
 * The ask that was **still in flight** when the predecessor stopped. All five conditions are required:
 *
 *   1. there is a row at the slot right after the prefix, and it is `running` — a cancelled ask keeps its running row, so
 *      a stopped run has one too; neither `failed` nor a sequence gap is "still in flight", they are just the other two reasons the prefix stopped;
 *   2. the transcript source is the session of the predecessor's **own** row: that half-finished conversation exists only there, and a
 *      source resolved from a more distant ancestor carries only the completed prefix (every hop of the chain guarantees only prefix equivalence);
 *   3. the session's message count can be obtained (there is a transcript surface and it reads) — without a count there is no resumption position, and the driver has nothing to truncate at;
 *   4. the session has already gone **quiet**, see {@link AmendImportOptions.quietSessions};
 *   5. the count is **strictly greater** than the prefix boundary. A queued but never dispatched ask has no extra transcript to bring, and
 *      a messageCount equal to the boundary (or 0) would make the driver seed a segment that "is just the prefix" or is
 *      even empty, while still marking the actor as resumed — the divergence decision and the transcript content then stop matching each other.
 *
 * If any one of them fails, the only consequence is **no resumption** (the completed prefix is still imported), consistent with this module's overall "degrade rather than fail" tone.
 */
function resolveInFlightAsk(input: {
  actor: ActorRecord;
  boundary: number;
  logger?: Logger;
  messageCount?: number;
  next?: NodeRecord;
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  sourceSessionId: string;
}): ImportedInFlightAsk | undefined {
  const { actor, boundary, logger, messageCount, next, quietSessions, sourceSessionId } = input;
  if (next === undefined || next.status !== "running") return undefined;

  const drop = (reason: string): undefined => {
    logger?.info?.("Dynamic workflow amend: in-flight ask not carried", {
      actorName: actor.name,
      event: "dynamic_workflow.amend.in_flight_dropped",
      module: "bootstrap.app",
      reason,
      runId: input.predecessorRunId,
      sessionId: sourceSessionId,
    });
    return undefined;
  };

  if (actor.sessionId === undefined || actor.sessionId !== sourceSessionId) {
    return drop("transcript_source_is_ancestor");
  }
  if (messageCount === undefined) return drop("no_transcript_count");
  // Absent = all silent (see {@link AmendImportOptions.quietSessions}).
  if (quietSessions !== undefined && !quietSessions.has(sourceSessionId)) {
    return drop("session_not_quiescent");
  }
  if (messageCount <= boundary) return drop("no_transcript_beyond_prefix");

  return { inputHash: next.inputHash, messageBoundary: messageCount };
}

/**
 * This actor's **longest all-completed ask prefix** (consecutive by actorSeq 0..k), plus the row **immediately after** it.
 *
 * The prefix stops dead at the first non-completed entry, and all three ways of stopping are treated the same: failure, crashed mid-flight (running), and a
 * sequence gap. A failed ask **binds nothing** for the new run (the model is stochastic, and an amendment is often exactly about getting past a failure),
 * so it is not imported itself; but skipping it to import the entries after it smuggles in context — the skipped round's questions and answers
 * are still in the source session transcript while the cache claims it never happened. Stopping at the first non-completed entry is the only self-consistent reading.
 *
 * `next` is **the row that stopped the prefix** (absent when there is a gap). It travels with the prefix because
 * "the ask still in flight" is by definition that very row: starting another traversal to find
 * the row with `actorSeq === entries.length` computes the "right after the prefix" coordinate in two places at once.
 */
function completedAskPrefix(
  nodes: NodeRecord[],
  actor: ActorRecord,
): { entries: ImportedAskEntry[]; next?: NodeRecord } {
  const bySeq = new Map<number, NodeRecord>();
  for (const node of nodes) {
    if (node.kind !== "ask") continue;
    if (node.actorSiteId !== actor.siteId || node.actorOrdinal !== actor.ordinal) continue;
    if (node.actorSeq === undefined) continue;
    bySeq.set(node.actorSeq, node);
  }

  const entries: ImportedAskEntry[] = [];
  for (let seq = 0; ; seq++) {
    const node = bySeq.get(seq);
    if (node === undefined || node.status !== "completed") {
      return { entries, ...(node === undefined ? {} : { next: node }) };
    }
    // The boundary must be present: Gate 3 has checked the entire precursor, so this is not an optimistic reading but a fulfillment of the invariant.
    const entry: ImportedAskEntry = {
      inputHash: node.inputHash,
      result: node.result,
      messageBoundary: node.messageBoundary!,
    };
    if (node.stats !== undefined) entry.stats = node.stats;
    entries.push(entry);
  }
}

/**
 * Walk the `resumed_from` chain back to the **nearest** ancestor run that holds the session of an actor of that name.
 *
 * Why the chain is needed: an actor that hits the cache all the way through in run B means B never created a session for it (creation
 * is lazy), so when a B→C amendment wants to resume that actor the transcript exists only in A. A count boundary stays invariant when copied across prefixes,
 * so at any session-holding ancestor on the chain the boundary value B copied over is directly usable — that is exactly the ground chain amendments stand on.
 *
 * `resolvedModel` and the session come from the **same row**: the point of a pin is "do not switch models while resuming this
 * transcript", and taking it from a different row means making a promise on behalf of a transcript that is not its own.
 *
 * The cycle guard (seen) is pure defensiveness: supersede can only point at an earlier terminated run, so no cycle can be
 * constructed. But this while loop really would spin forever on corrupt data, and the price of the guard is one Set.
 */
function resolveTranscriptSource(input: {
  actorName: string;
  journal: ImportedCacheJournalReader;
  startRunId: string;
}): { sessionId: string; resolvedModel?: string } | undefined {
  const { actorName, journal, startRunId } = input;
  const seen = new Set<string>();
  let runId: string | undefined = startRunId;

  while (runId !== undefined && !seen.has(runId)) {
    seen.add(runId);
    const matches = journal.listActors(runId).filter((actor) => actor.name === actorName);
    // 0 = This actor does not exist in this generation (the chain is broken for this name); >1 = Duplicate name, session by name is a roll of the dice.
    // Both stop here instead of going back further: the session from the previous generation is not the source of this transcription.
    if (matches.length !== 1) return undefined;
    const actor = matches[0]!;
    if (actor.sessionId !== undefined) {
      return {
        sessionId: actor.sessionId,
        ...(actor.resolvedModel === undefined ? {} : { resolvedModel: actor.resolvedModel }),
      };
    }
    runId = journal.getRun(runId)?.resumedFrom;
  }
  return undefined;
}

/**
 * The number of messages in the source session right now; a read failure returns `undefined`.
 *
 * Two readers share this one read (see {@link buildActorCandidate}):
 * - Check whether the source session has reached the completed prefix's boundary. When the count is short or unreadable, the builder drops the candidate
 *   so the successor re-executes; the driver still refuses a source shorter than the boundary when copying the transcript, so an incomplete context never gets written.
 * - Compute the resumption position of an unfinished ask (see {@link resolveInFlightAsk}).
 *
 * The counting rule must agree with the driver's bookkeeping and with core history recovery; all three go through the same message store interface.
 */
async function countSource(
  transcripts: ActorTranscriptStore,
  sessionId: string,
): Promise<number | undefined> {
  try {
    return (await transcripts.messages({ sessionID: sessionId as SessionId })).length;
  } catch {
    return undefined;
  }
}

/**
 * The content table of world nodes: `inputHash` → a queue of records in journal insertion order (the nth occurrence maps to the nth record).
 *
 * The key uses the predecessor's recorded **inputHash** directly, without recomputing it: the engine's hashing rule for
 * `{op,args}` (worldRead in engine.ts) is exactly the value written into this column, and recomputing it here would
 * duplicate that hash contract in this place, where a drift shows up as "the cache mysteriously misses".
 *
 * Only completed entries are taken: a failed world read re-executes (a failure binds nothing for the new run), and
 * a running one even more so. world-run and world-read share one table — importing a world-run is a **safety feature**, not
 * an optimization: an amended resume must never silently replay an effect that was already journaled (running a deployment script twice).
 */
function buildWorldQueues(nodes: NodeRecord[]): ReadonlyMap<string, ImportedWorldEntry[]> {
  const world = new Map<string, ImportedWorldEntry[]>();
  for (const node of nodes) {
    if (node.kind !== "world-read" && node.kind !== "world-run") continue;
    if (node.status !== "completed") continue;
    const queue = world.get(node.inputHash);
    const entry: ImportedWorldEntry = {
      inputHash: node.inputHash,
      kind: node.kind,
      result: node.result,
    };
    if (queue === undefined) world.set(node.inputHash, [entry]);
    else queue.push(entry);
  }
  return world;
}

/**
 * The resume-side entry point: rebuild the import cache of an amended run. **Any failure only degrades, never refuses the resume.**
 *
 * It shares the submit side's {@link buildImportedCache} — not for convenience but as a correctness
 * prerequisite: an amended run's journal is self-contained only for the execution prefix already reached, and this
 * rebuild restores the unconsumed imports, so two different tables would turn "rebuild" into "building another one".
 *
 * Three reasons make "rebuild failed" categorically different from "the build failed at submit":
 *   - The amended run already exists; refusing the resume would wedge it for good;
 *   - A consumed hit is a **real row** in this run's journal, so replay does not need the table;
 *   - An unconsumed import degrades to a live re-execution: correct, only spending tokens that could have been saved.
 *
 * So not even the gates' three reasons are told apart: for a resume `run_not_found` (the predecessor was cleaned
 * up) and `missing_boundaries` are one thing — "no cache this time"; the predecessor journal is a **survival dependency but only an acceleration structure**, so
 * losing it costs tokens, not correctness. One info log is recorded so the bill can be explained afterwards.
 *
 * **No {@link AmendImportOptions.quietSessions}**: a predecessor that got this far is long terminal and nothing in this process
 * writes its session; an empty set would leave the rebuilt table one `inFlight` short of
 * the submitted one, yet both sides must be the same table (see this file's head).
 */
export async function rebuildImportedCacheForResume(
  deps: AmendImportDeps,
  /** The amended run being resumed and its `resumed_from` (the caller has already confirmed the latter is present). */
  run: { runId: string; predecessorRunId: string },
): Promise<ImportedRunCache | undefined> {
  const { predecessorRunId, runId } = run;
  const built = await buildImportedCache(deps, predecessorRunId);
  if (built.ok) return built.cache;
  deps.logger?.info?.("Dynamic workflow amend cache rebuild skipped; resuming without it", {
    event: "dynamic_workflow.amend.rebuild_skipped",
    module: "bootstrap.app",
    reason: built.reason,
    resumedFrom: predecessorRunId,
    runId,
  });
  return undefined;
}
