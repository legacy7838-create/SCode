/**
 * scheduler.ts has hit oxlint's max-lines limit (400 lines), so the scheduler's internal types (Deferred /
 * AskNode / Actor) and the dependency surface SchedulerHost injected by the engine are split into this file; the public surface is still exported from scheduler.ts
 * (SchedulerHost is re-exported in place there, so engine.ts's import path is unchanged).
 *
 * The reason for a file of its own is not just the line count: the free functions in scheduler-submit.ts also need AskNode / SchedulerHost,
 * and importing them from here means neither side has to import the scheduler body backwards.
 */

import { INSTRUCTIONS_HEAD_MAX_CHARS, refToString, WorkflowError } from "./types.js";
import type { ImportedActorState } from "./imported-cache.js";
import type {
  ActorId,
  ActorRef,
  AskSpec,
  AskStats,
  Caps,
  InstanceRef,
  PersonaSpec,
  RunEvent,
  SessionRef,
  ValidateFn,
  WorkflowDriver,
} from "./types.js";

/** A promise that can be settled from the outside. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The dependency surface the engine injects into the scheduler. */
export interface SchedulerHost {
  readonly runId: string;
  /**
   * The concurrency upper bound of this run. **Read fresh before every dispatch**, not a copy taken down at construction time: `setMaxConcurrency` replaces
   * the whole caps object the engine holds,
   * and the scheduler's dispatch decision has to see the new value. The engine side therefore implements this property as a getter.
   */
  readonly caps: Caps;
  readonly driver: WorkflowDriver;
  readonly validate: ValidateFn;
  /** Allocates the next execution ordinal for a site (sharing one set of counters with world-read/actor). */
  nextOrdinal(siteId: string): number;
  /**
   * Releases one hit, subject to the replay settlement order.
   * Not a resume, or the instance missing from the order table, executes `release` immediately.
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;
  /** An event that is both journaled and fanned out (Boundary C). */
  record(event: RunEvent): void;
  isRunSettled(): boolean;
  /** The error used to reject once the run has settled. */
  runError(): WorkflowError;
  /** A run-level failure. */
  failRun(error: WorkflowError): void;
  /**
   * Whether import caching has already been turned off (amend-resume). The engine itself does the turning off
   * (the driver reporting askMutating, or a live world-run), and the scheduler only reads this bit — an ask turning live does **not** turn it off
   * by itself: it has not changed anything yet.
   */
  importCacheClosed(): boolean;
  /** Whether this record row ran live before the crash (on resume the engine recovers it from the events; without a resume it is always false). */
  wasLiveBeforeResume(instance: InstanceRef): boolean;
  /**
   * Whether this record row's admission happened **before** import caching was turned off (recovered by event order, see recoverImportClosure in engine-world.ts).
   * Deciding whether a continuation may run a predecessor's in-flight ask needs it to be restored precisely on resume; without a resume it is always false.
   */
  wasQueuedBeforeImportClose(instance: InstanceRef): boolean;
}

/** An ask node that is live (and really has to be dispatched for execution). */
export interface AskNode {
  instance: InstanceRef;
  actor: Actor;
  actorSeq: number;
  instructions: string;
  hash: string;
  spec: AskSpec;
  deferred: Deferred<unknown>;
  repairsRemaining: number;
  nudgesRemaining: number;
  settled: boolean;
  dispatched: boolean;
  lastStats?: AskStats;
  /**
   * The head of the instructions, computed at admission time (the first N characters of {@link AskNode.instructions}). It lives on the node instead of being
   * computed in two places: `node-queued` and `node-dispatched` must carry the **same** string (dispatch repeats a birth fact,
   * see `node-dispatched` in types.ts), and storing it makes that a construction-time guarantee rather than something two call sites have to keep in sync.
   */
  instructionsHead?: string;
}

/** The running state of an actor, maintained by the scheduler. */
export interface Actor {
  ref: ActorRef;
  id: ActorId;
  persona: PersonaSpec;
  name?: string;
  /** The number of ask nodes already recorded for this actor in the journal — on replay a live node must wait until all of them are admitted. */
  recordedCount: number;
  /** The next actorSeq waiting for admission. */
  nextAdmitSeq: number;
  /** The release action of a record node that has arrived but is not yet admitted, held per actorSeq (the hold rule). */
  pendingRecorded: Map<number, () => void>;
  /** The release action of a live node that has arrived but is waiting for the record nodes to drain, in arrival order. */
  pendingLive: Array<() => void>;
  /** Live nodes that are admitted and waiting for dispatch (FIFO = admission order). */
  liveQueue: AskNode[];
  /** The live node currently executing (actors run serially, at most one). */
  current?: AskNode;
  /** Created lazily, with its promise cached (once per actor). */
  sessionPromise?: Promise<SessionRef>;
  session?: SessionRef;
  /**
   * The import consumption state of amend-resume (attached by the engine inside createActor after matching by name + persona, see
   * `matchImportedActor` in imported-cache.ts). Absent means that actor reruns from scratch.
   */
  imported?: ImportedActorState;
}

// Expanding according to the current formatting rules after merging would exceed the scheduler's 400-line limit; pure helper functions are included here with the existing defer, and the behavior is unchanged.
/** A replay hit whose inputHash does not match — the purity contract is broken, and the run fails loudly. */
export function hashMismatch(instance: InstanceRef, expected: string, got: string): WorkflowError {
  return new WorkflowError(
    "InputHashMismatch",
    `Replay hit at ${refToString(instance)} but inputHash differs (expected ${expected}, got ` +
      `${got}): the script is not deterministic, so the journal cannot be replayed.`,
    // Structured mismatch aligns with ScriptHashMismatch: two hash mismatch errors share the same field,
    // The reader no longer has to extract the hash from the message text.
    { mismatch: { expected, got } },
  );
}

/** cause → one line of bounded text (an Error takes its message, everything else String(); an empty one gets a placeholder). */
export function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * The head of the author's instructions ({@link INSTRUCTIONS_HEAD_MAX_CHARS} characters, trimmed at both ends, **with no ellipsis**).
 * Empty instructions return undefined: an absent key is more honest than an empty string — the read surfaces then fall back to "I don't know what it was told".
 */
export function headOfInstructions(instructions: string): string | undefined {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= INSTRUCTIONS_HEAD_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, INSTRUCTIONS_HEAD_MAX_CHARS);
}

/** Empties the actor queues in the existing admission order; dispatching remains the scheduler's sole responsibility. */
export function drainActorAdmission(actor: Actor): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
    if (release !== undefined) {
      actor.pendingRecorded.delete(actor.nextAdmitSeq);
      actor.nextAdmitSeq++;
      release();
      progressed = true;
      continue;
    }
    if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
      const admit = actor.pendingLive.shift()!;
      admit();
      progressed = true;
    }
  }
}
