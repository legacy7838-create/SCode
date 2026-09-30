// ============================================================
// Import cache for amend-resume
// ============================================================
// Detached from engine/types.ts (the file has reached the oxlint max-lines limit): pure data structure, run service reads the precursor
// The journal is built, and the engine only looks up the table.

import type { AskStats, NodeKind, PersonaSpec } from "./types.js";

/**
 * One importable completed ask: the result of a named actor's `actorSeq`-th exchange in the predecessor run.
 * The array index is the actorSeq (see {@link ImportedActorCandidate.entries}), so no seq is stored here.
 */
export interface ImportedAskEntry {
  /** The inputHash recorded by the predecessor (over the instruction body). At runtime it is compared with this ask's hash entry by entry, and only a match counts as a hit. */
  inputHash: string;
  result: unknown;
  stats?: AskStats;
  /**
   * The number of messages in the source session after that ask settled ({@link NodeRecord.messageBoundary}). **Required**: the
   * run service's "reject a marker-less predecessor wholesale" gate guarantees that every importable entry carries a boundary, so
   * the engine side needs no absent branch at all — seed truncation is meaningless without a boundary.
   */
  messageBoundary: number;
}

/**
 * The one ask **still in flight** when the predecessor stopped (`actorSeq === entries.length`, the running row right after the prefix).
 *
 * It has no result to import; what gets imported is **the transcript it has already produced**: if the amendment re-issues the same instruction at the same
 * position (matching `inputHash`), the new session continues from here instead of throwing that half of the conversation away and starting over.
 */
export interface ImportedInFlightAsk {
  /** The inputHash recorded by the predecessor (over the instruction body). Only a match with this ask's hash makes resuming possible at all. */
  inputHash: string;
  /**
   * The message count of the predecessor's **entire settled session** (not one ask's bookkeeping boundary — an unfinished ask has none
   * to record): the prefix's complete exchanges plus that half-finished Q&A, the very position a resume has to continue from.
   */
  messageBoundary: number;
}

/**
 * The importable prefix of a named actor in the predecessor run. Built by the run service from the predecessor journal (purely deterministic, rebuildable).
 */
export interface ImportedActorCandidate {
  /** The canonical persona recorded by the predecessor — compared by createActor at runtime (a mismatch drops that candidate). */
  persona: PersonaSpec;
  /**
   * The longest all-completed ask prefix, indexed by actorSeq 0..n-1. **It may be empty**: a candidate with
   * {@link inFlight} often finished nothing at all (amended while the first fan-out round was in flight).
   */
  entries: ImportedAskEntry[];
  /**
   * The ask still in flight when the predecessor stopped (if any), imported only when the transcript source is the predecessor's
   * own row — that half of the conversation exists only there, while a more distant ancestor carries just the completed prefix.
   */
  inFlight?: ImportedInFlightAsk;
  /**
   * The id of the transcript source session resolved along the `resumed_from` chain; the service guarantees it is present,
   * since a candidate with no ancestor session for that actor is already dropped there (degraded to a brand-new actor).
   */
  transcriptSourceSessionId: string;
  /**
   * The model pin resolved from the predecessor, handed to the driver along with the
   * seed. **It applies only when a transcript was really imported**: an actor that hit nothing resolves freshly, pin-less (see the scheduler's ensureSession).
   */
  resolvedModel?: string;
}

/** One importable world node (world-read / world-run), matched by content plus occurrence order. */
export interface ImportedWorldEntry {
  inputHash: string;
  kind: NodeKind;
  result: unknown;
}

/**
 * The import cache injected into the engine (the acceleration structure of amend-resume). **Pure data**: the
 * engine stays I/O-free, and the run service builds this table by reading the predecessor journal. It is not
 * the source of truth — every hit lands a real dwf_node row, and losing it can be rebuilt from `resumed_from`.
 */
export interface ImportedRunCache {
  /** The key = the effective actor name (those unique within the predecessor and non-empty). */
  actors: ReadonlyMap<string, ImportedActorCandidate>;
  /**
   * The key = `inputHash({op, args})`; the value = a queue ordered by the predecessor's listNodes insertion order —
   * the nth occurrence of the same `{op,args}` maps to the nth record, and the queue head is the next hit.
   */
  world: ReadonlyMap<string, ImportedWorldEntry[]>;
}

/**
 * The session seed: handed to {@link WorkflowDriver.createActorSession} when a diverged actor is dispatched live
 * for the first time, so that the new session opens with the source session's **full-fidelity transcript prefix**.
 */
export interface ActorSessionSeed {
  /** The session the transcript comes from (the predecessor's session for that actor name, or a more distant ancestor's). */
  sourceSessionId: string;
  /**
   * How many messages to copy from the source session = the {@link NodeRecord.messageBoundary} of the last consumed import ask; the
   * count offset is invariant when copied across prefixes, so the value is directly usable at any session-holding ancestor on the chain.
   */
  messageCount: number;
  /** The inherited model pin (silently switching models under a transcript continuation is exactly the identity mutation a pin prevents). */
  resolvedModel?: string;
}
