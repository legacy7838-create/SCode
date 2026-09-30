// ============================================================
// Run-level seat gate: press this run's own concurrency upper bound to the **next model request**
// ============================================================
// The scheduler is the first execution point, but it is only
// Look at the upper bound when dispatching, and an ask is a whole round of sub-agents, which can take several minutes at any time - for a run that already has eight questions flying.
// "Two at most", the scheduler alone has to wait for six ask to run before it can be seen. This gate is the second execution point: the subagent beyond the upper bound
// After running the request at hand, stop before the next turn step, and the session, transcription, and its position in the run will not be lost.
//
// Three disciplines:
//   1. **Pure**: No clock reading, no I/O, no subscription to anything. Both facts (who has the flying ask and who has the tool running) are determined by
//      The existing observation surface of the driver is fed in (startAsk/emit of workflow-driver.ts,
//      workflow-driver-tool-activity.ts (counting on the fly), the gate itself will no longer keep a second account.
//   2. **Zero shared state** with the scheduler, and the two never call each other. What makes them consistent is arithmetic: `activeAsks = working +
//      parked`——The parked subagent ask is still alive and is still counted in the upper bound of the scheduler. So as long as someone stops,
//      If `activeAsks ≥ limit`, the scheduler will not be able to dispatch new ask, and it will never be inserted in front of a parker.
//   3. **Upper bound ≥ 1 ⇒ Never deadlock**: The premise of stopping is that "the number of people working has exceeded the upper bound", so there is always someone working;
//      The last seat cannot be empty when the FIFO is not empty.
//
// Tool-side requests **never** stop: that subagent is already there
// For work, you are occupying your seat. If you let WebSearch rank it behind you, you will be queuing for yourself. There is only `{model}` on the admission call,
// It can't tell what the request is, so the gate reads the fact that the driver has remembered for this subagent - whether it has any tools running at the moment.

import type { ModelRequestAdmission } from "@zcode/contracts";
import { refToString, type InstanceRef } from "@zcode/dynamic-workflow";

/** The only piece of subagent fact the gate asks the driver for (implemented in workflow-driver-tool-activity.ts). */
export interface SeatGateSubagent {
  /** How many tool calls are running right now; > 0 means this request is on the tool side and is let through directly. */
  toolsInFlight(): number;
}

/** The gate's two counts right now (the observation surface: the `activeAsks = working + parked` assertion reads it). */
export interface SeatGateStats {
  limit: number;
  working: number;
  parked: number;
}

export interface WorkflowRunSeatGate {
  /**
   * Replaces the ceiling. After raising it, admission immediately proceeds in FIFO order up to the new ceiling; lowering it recalls nobody -- the ones over the limit finish
   * the request they are holding and park themselves at the next turn step.
   */
  setLimit(limit: number): void;
  /** An ask was dispatched to this subagent (the very moment of driver.startAsk). */
  askStarted(key: string, instance: InstanceRef): void;
  /** The engine recorded `node-settled` for this instance (the **only** terminal point of an ask, see the emit in workflow-driver.ts). */
  askSettled(instance: InstanceRef): void;
  /**
   * Wraps one subagent's admission port into the "seat first, then governor" one. `inner` being absent means this runtime
   * is simply not subject to the gate (an assembly with no governor port), and the gate does not conjure one out of thin air -- either both gates are present,
   * or neither is.
   */
  wrap(
    key: string,
    subagent: SeatGateSubagent,
    inner: ModelRequestAdmission | undefined,
  ): ModelRequestAdmission | undefined;
  stats(): SeatGateStats;
}

/** One slot in the FIFO: its key, the two openings that release it, and the hand that removes the abort listener. */
interface ParkedSeat {
  key: string;
  grant: () => void;
  refuse: (reason: unknown) => void;
}

export function createWorkflowRunSeatGate(input: { limit: number }): WorkflowRunSeatGate {
  let limit = Math.max(1, Math.floor(input.limit));
  /** Subagents with an ask in flight and **no** parked ask. At the moment of parking they are moved out of here, and added back when admitted. */
  const working = new Set<string>();
  /** Subagents waiting for a seat, first come first served. */
  const parked: ParkedSeat[] = [];
  /** `refToString(instance)` -> the subagent key: the end of an ask only carries the instance, so without mapping it back to the subagent there is no way to free a seat. */
  const instances = new Map<string, string>();

  const parkedIndexOf = (key: string): number => parked.findIndex((seat) => seat.key === key);

  /** While there is room, admit in FIFO order. Admitting means "moving into working", not "handing out a ticket" -- a seat is a working slot. */
  const unpark = (): void => {
    while (working.size < limit && parked.length > 0) {
      const seat = parked.shift()!;
      working.add(seat.key);
      seat.grant();
    }
  };

  /** Whether this request has to go through a seat: only a subagent with an ask in flight and no tool currently running counts as a turn step. */
  const needsSeat = (key: string, subagent: SeatGateSubagent): boolean =>
    working.has(key) && subagent.toolsInFlight() === 0;

  const acquireSeat = async (key: string, signal: AbortSignal | undefined): Promise<void> => {
    // Within the upper boundary: Passing in place without moving in any state. Runs that have not been suppressed by retune will always take this route - the fast path has not changed at all.
    if (working.size <= limit) return;
    if (signal?.aborted === true) throw signal.reason;
    working.delete(key);
    return await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = parkedIndexOf(key);
        if (index >= 0) {
          parked.splice(index, 1);
          // **Return to working after leaving the queue**: "Not parked" in this gate has only one meaning, which is working. abort
          // It’s **this request**, not necessarily this ask—transient redrive, stream recovery, or any per-request signal on the driver side
          // They would all get here while ask is still alive. Leave it outside the two collections, and every turn request thereafter will be due to
          // `needsSeat` is false and no gate passes, and will never be counted as working: the upper bound will quietly float upward.
          //
          // Adding it back may cause working to temporarily exceed the upper bound, which is a legal transient (the same as the moment when the upper bound is lowered): Next
          // The person who requested the turn stops as usual and the count converges. When it is actually settled after abort, askSettled will
          // `working.delete` succeeds and calls unpark, but the `working.size < limit` guard of unpark blocks it.
          // "Vacate a seat it has never occupied" - when parking occurs, working ≥ limit, and adding it back is ≥ limit+1,
          // After deleting it, it is still ≥ limit, so none of them are released.
          working.add(key);
        }
        reject(signal?.reason);
      };
      const seat: ParkedSeat = {
        key,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        refuse: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      parked.push(seat);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    setLimit: (next) => {
      limit = Math.max(1, Math.floor(next));
      unpark();
    },

    askStarted: (key, instance) => {
      instances.set(refToString(instance), key);
      // A parked subagent cannot receive a new ask (its turn is stuck in acquire, and actor.current is still occupied by the engine).
      // But two sets accepting the same key at the same time will count it as two people - it's better to block here once.
      if (parkedIndexOf(key) >= 0) return;
      working.add(key);
    },

    askSettled: (instance) => {
      const ref = refToString(instance);
      const key = instances.get(ref);
      if (key === undefined) return;
      instances.delete(ref);
      const parkedIndex = parkedIndexOf(key);
      if (parkedIndex >= 0) {
        // Stopped ask ends: **No seat** (it doesn't have one), otherwise the seat will be counted twice.
        // It can only be that the engine cancels it voluntarily (the parked turn is stuck in acquire, and no turn ending can be reported), and that path
        // First call driver.cancelAsk (abort will reject the above wait) and then remember node-settled, so go here in the normal order.
        // It can no longer be found. When arriving in reverse order, reject the waiting list altogether to prevent an unasked ask from being released later.
        const [seat] = parked.splice(parkedIndex, 1);
        seat?.refuse(new Error("workflow ask settled while waiting for a concurrency seat"));
        return;
      }
      if (!working.delete(key)) return;
      unpark();
    },

    wrap: (key, subagent, inner) => {
      if (inner === undefined) return undefined;
      return {
        // Fast path: This request requires a seat, but the seat is full ⇒ Missed. The runner therefore issues `model_request_queued`,
        // The driver reports `askWaiting(slot)` - the one that is literally the same as the wait caused by the shared cap, no new vocabulary is needed.
        tryAcquire: (request) => {
          if (needsSeat(key, subagent) && working.size > limit) return undefined;
          return inner.tryAcquire?.(request);
        },
        // The order is load-based: first wait for the seat, and then pass the manager. In turn, a subagent that should be parked will be occupied first.
        // A ticket from the manager, and then sleeping on this side of the gate - that ticket is of no use to anyone.
        acquire: async (request) => {
          if (needsSeat(key, subagent)) await acquireSeat(key, request.signal);
          return await inner.acquire(request);
        },
      };
    },

    stats: () => ({ limit, working: working.size, parked: parked.length }),
  };
}
