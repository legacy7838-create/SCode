// ============================================================
// **Event Index** of Situation Section: Scan the journal events in one go and get everything "how long ago"
// ============================================================
// Phase table, sub-agent roster, and health three groups of readings
// There is only one source of the required time - `StoredEvent.timeCreated`, which is the moment when the event is written into the journal. Node row
// (`NodeRecord`) does not have any time column, so "when did this ask start" and "when did it last move"
// Can only be taken from the event track.
//
// This module is that scan, and only that scan: pure function, no I/O, and does not know the port type. three consumers
// (-roster-phases / -roster-subagents / -roster) share its products, so one getRunDetail
// Only read the event once - the longer the run is, the more expensive this reading will be. Reading it twice is double the cost.

import type { StoredEvent } from "@zcode/dynamic-workflow";

/**
 * The event types that **count** toward "is it still moving": the script itself moved forward, or some ask moved forward.
 *
 * `phase-entered` and `log` are among them, because they are exactly the evidence that the **script** is moving: a script
 * that runs a series of world reads between two asks emits not a single ask event, and excluding them would misreport that stretch as stalled.
 *
 * `node-waiting` is deliberately **not** among them: waiting for a slot and waiting out a backoff are stalled itself;
 * counting them as progress means `stalledSince` would never be present — and that is the most typical shape of a stall.
 * `concurrency-changed` and `run-stalled` are excluded for the same reason: they are **observations about not moving**, not movement.
 */
const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-settled",
  "node-progress",
  "phase-entered",
  "log",
  "report",
  "artifact-published",
  "usage-updated",
]);

/**
 * Node **lifecycle** events (phase transitions). `node-progress` is not among them — a resolved turn is not a
 * lifecycle transition, which is the exact same discipline as on the reducer side; the subagent's `waiting` criterion is therefore never interrupted by a progress event.
 */
const NODE_LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-waiting",
  "node-repairing",
  "node-nudged",
  "node-settled",
]);

/** Instance key: `siteId@ordinal`, the same shape as the engine's `refToString`. */
export function instanceKey(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

/** What the current ask is waiting on (the observation from the last `node-waiting` plus the moment it entered this wait). */
export interface RosterWaitTrace {
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  since?: number;
}

/** The trace a node instance leaves on the event track. */
export interface RosterNodeTrace {
  /** The moment of the last `node-dispatched` in this incarnation (`node-queued` clears it: re-queueing starts a new incarnation). */
  dispatchedAt?: number;
  /** The type of the last lifecycle event; the subagent's `waiting` criterion only looks at whether it is `node-waiting`. */
  lastLifecycleType?: string;
  /** Present only when currently in the waiting phase (any other lifecycle event clears it). */
  wait?: RosterWaitTrace;
  /** The moment of the last `node-progress` event that **carried a lastTool**. */
  lastToolAt?: number;
  /** The moment of the last progress-type event of this instance. */
  lastActivityAt?: number;
}

/** The most recent enter and leave moments of one phase. */
export interface RosterPhaseTrace {
  enteredAt?: number;
  exitedAt?: number;
}

/** One node settlement (in event order); the losing streak and the cache hits of the health surface are both computed from this stream. */
export interface RosterSettlement {
  key: string;
  outcome: string;
  cached: boolean;
}

/** Everything one scan pass produced. */
export interface RosterEventIndex {
  nodes: ReadonlyMap<string, RosterNodeTrace>;
  phases: ReadonlyMap<string, RosterPhaseTrace>;
  settlements: readonly RosterSettlement[];
  /** The moment of the last progress-type event across the whole run. */
  lastProgressAt?: number;
  /** The moment of the last `run-stalled`, provided no progress-type event followed it; otherwise absent. */
  stalledSince?: number;
  /** The reason and moment of the last `concurrency-changed` (the numeric bound is supplied by the reducer side). */
  concurrencyReason?: string;
  concurrencySince?: number;
}

/**
 * Walk the events once and get every moment the situation snapshot needs.
 *
 * `now` is the moment of this read and only performs an **upper clamp**: a journal can be carried to another machine and read there, and a
 * moment later than "now" would be rendered as a negative age — which reads like a broken tool rather than a skewed clock.
 * Events without a timestamp (the old in-memory journal doubles) always leave the corresponding field absent, and `now` is never used as a fallback: that would label a whole week of history as "just now".
 */
export function indexRosterEvents(events: readonly StoredEvent[], now: number): RosterEventIndex {
  const nodes = new Map<string, RosterNodeTrace>();
  const phases = new Map<string, RosterPhaseTrace>();
  const settlements: RosterSettlement[] = [];
  let lastProgressAt: number | undefined;
  let stalledAt: number | undefined;
  let stalledPending = false;
  let concurrencyReason: string | undefined;
  let concurrencySince: number | undefined;
  let lastPhaseName: string | undefined;

  for (const stored of events) {
    const { event } = stored;
    const at = timeOf(stored, now);

    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      lastProgressAt = laterOf(lastProgressAt, at);
      // As long as there is any progress after the stagnation observation, the stagnation has ended - even if this progress does not have a timestamp:
      // "It moved again" and "When did it move" are two different questions. The former does not rely on a clock.
      stalledPending = false;
    }

    if (event.type === "run-stalled") {
      stalledAt = at;
      stalledPending = true;
      continue;
    }
    if (event.type === "concurrency-changed") {
      concurrencyReason = event.reason;
      concurrencySince = at;
      continue;
    }
    if (event.type === "phase-entered") {
      lastPhaseName = trackPhase(phases, event.name, lastPhaseName, at);
      continue;
    }
    if (!("instance" in event)) continue;

    const key = instanceKey(event.instance.siteId, event.instance.ordinal);
    const trace = nodes.get(key) ?? {};
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      trace.lastActivityAt = laterOf(trace.lastActivityAt, at);
    }
    if (NODE_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      trackLifecycle(trace, event.type, at);
    }
    if (event.type === "node-waiting") {
      // If you are already waiting, keep **the moment you enter**: the escape ladder will send several node-waiting messages in succession, and the reader is asking
      // "How long has it been stuck", not "when was the last observation posted". The latest reason and retry interval are used.
      const since = trace.wait?.since ?? at;
      trace.wait = {
        cause: event.cause,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
        ...(since === undefined ? {} : { since }),
      };
    }
    if (event.type === "node-progress" && event.lastTool !== undefined && at !== undefined) {
      trace.lastToolAt = at;
    }
    if (event.type === "node-settled") {
      settlements.push({ key, outcome: event.outcome, cached: event.cached === true });
    }
    nodes.set(key, trace);
  }

  return {
    nodes,
    phases,
    settlements,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    ...(stalledPending && stalledAt !== undefined ? { stalledSince: stalledAt } : {}),
    ...(concurrencyReason === undefined ? {} : { concurrencyReason }),
    ...(concurrencySince === undefined ? {} : { concurrencySince }),
  };
}

/**
 * Records one `phase-entered`: it opens its own stretch and also ends the previous **differently named** phase.
 * Re-entering under the same name (a back edge) only moves the enter moment earlier; it does not count as leaving itself. Returns the new "last entered phase name".
 */
function trackPhase(
  phases: Map<string, RosterPhaseTrace>,
  name: string,
  lastPhaseName: string | undefined,
  at: number | undefined,
): string {
  if (lastPhaseName !== undefined && lastPhaseName !== name && at !== undefined) {
    const previous = phases.get(lastPhaseName);
    if (previous !== undefined) previous.exitedAt = at;
  }
  // Take the most recent entry instead of the first time: in the stage where you have been circled three times, the question you need to ask is "how long has it been since you came in this circle?"
  // Reentering clears the exit time of the previous circle - it is now open again.
  phases.set(name, at === undefined ? {} : { enteredAt: at });
  return name;
}

/** Records a lifecycle event: re-queueing clears the previous incarnation's dispatch moment, any non-waiting event clears the wait. */
function trackLifecycle(trace: RosterNodeTrace, type: string, at: number | undefined): void {
  trace.lastLifecycleType = type;
  if (type !== "node-waiting") trace.wait = undefined;
  if (type === "node-queued") trace.dispatchedAt = undefined;
  if (type === "node-dispatched" && at !== undefined) trace.dispatchedAt = at;
}

/**
 * The moment an event was persisted. Absent, non-finite and non-positive values all read as "no clock" — `0`
 * is 1970, and it can only be a field someone forgot to fill in, never a real moment.
 */
function timeOf(stored: StoredEvent, now: number): number | undefined {
  const time = stored.timeCreated;
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) return undefined;
  return Math.min(time, now);
}

/** The later of two possibly-absent moments. */
export function laterOf(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
