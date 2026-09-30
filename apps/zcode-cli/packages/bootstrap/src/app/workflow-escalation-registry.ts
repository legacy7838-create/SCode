// ============================================================
// Workflow upgrade Q&A docking registry (the only connection between the driver and run service)
// ============================================================
// The actor's `escalate` resides in the driver (it holds the ask turn
// context), and the answer entry `resolveQuestion` is on the run service (which is the holder of the port) - there is a need between the two
// A table looked up by qid. This file is that table, and only that table: no I/O, no persistence, no engine knowledge.
//
// Why not give the driver instance to the service: driver by `makeDriver(sink)` in `runWorkflowScript`
// **Internal** construct, service never sees it. Passing a table in is better than adding a capture in launch in order to get the instance.
// The hook needs one less timing (the table exists before launch, and registration and query naturally have the same life cycle).
//
// **Pure memory, same fate as parked deferred**. Deliberately not persistent: after the process dies, the deferred dies and a persistent
// The pending table just lies (it leaves the master agent to answer a question that no one is waiting for anymore). Self-healing relies on resume—that
// ask will live re-run, the actor will re-ask and get a new qid, and the stale id will get a structured rejection.
//
// The scope is **one per run service instance** (≈ each app session), not a module-level singleton: one is shared across sessions
// The table is equivalent to opening a cross-session response hole, which is the same as the existing "enumeration side only looks at this session" rule in this warehouse. One table is under the name of this service
// **All on the fly**, this is exactly why qid must be globally unique.

import type {
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPendingQuestion,
} from "@zcode/contracts";

/**
 * How many retired qids are remembered. **Bounded**: a long-running session can ask and answer arbitrarily many
 * times, and an unbounded history table is a place where memory grows silently. Once an entry is evicted
 * `resolveQuestion` only buckets it under `unknown_question` — an honest degradation ("I do not know this id"), not
 * a wrong answer.
 */
const RETIRED_HISTORY_LIMIT = 256;

/** The facts one parking registration needs (supplied by the driver; the qid has already been minted by the driver). */
export interface ParkedQuestionInput {
  qid: string;
  runId: string;
  /** The actor that asked, in `refToString` form (e.g. `actor#1@1`). */
  actor: string;
  /** The actor's effective name (the `"poet"` of `agent("poet")`); absent for anonymous actors, with no synthesized fallback label. */
  actorName?: string;
  question: string;
  context?: string;
  askedAt: number;
}

/** Why a qid retired: it decides which structured rejection a later resolve receives. */
type RetiredReason = "resolved" | "withdrawn";

export interface WorkflowEscalationRegistry {
  /**
   * Registers a parked question. `settle` is supplied by the driver and unwraps that deferred when the answer arrives.
   *
   * The caller must first use {@link isTaken} to guarantee the qid is unclaimed (the driver's minting loop does this) —
   * registering twice silently overwrites the previous parked item, which is exactly what causes answers to be mismatched.
   */
  park(entry: ParkedQuestionInput, settle: (answer: string) => void): void;
  /** Whether a qid is already claimed (parked or retired). The driver relies on it to guarantee global uniqueness when minting a qid. */
  isTaken(qid: string): boolean;
  /**
   * Withdraws a parked item **without answering it**: the driver calls this when an ask is cancelled or a turn fails
   * (the driver rejects the deferred side itself). A later resolve on that qid gets `run_not_in_flight`.
   */
  withdraw(qid: string): void;
  /** Settles a parked item. The three kinds of structured rejection each state the current situation and the next step. */
  resolve(qid: string, answer: string): DynamicWorkflowResolveQuestionResult;
  /** The questions parked on a run at this moment, in asking order. The projection source for the `pendingQuestions` snapshot. */
  pendingFor(runId: string): DynamicWorkflowRunPendingQuestion[];
}

interface ParkedQuestion extends ParkedQuestionInput {
  settle: (answer: string) => void;
}

export function createWorkflowEscalationRegistry(): WorkflowEscalationRegistry {
  // The insertion order of Map is the query order (pendingFor directly relies on it and does not save the sequence number separately).
  const parked = new Map<string, ParkedQuestion>();
  const retired = new Map<string, RetiredReason>();

  const retire = (qid: string, reason: RetiredReason): void => {
    parked.delete(qid);
    retired.set(qid, reason);
    while (retired.size > RETIRED_HISTORY_LIMIT) {
      // The iteration order of Map is insertion order, so the first key is the oldest one.
      const oldest = retired.keys().next();
      if (oldest.done === true) break;
      retired.delete(oldest.value);
    }
  };

  return {
    park(entry, settle) {
      parked.set(entry.qid, { ...entry, settle });
    },

    isTaken(qid) {
      return parked.has(qid) || retired.has(qid);
    },

    withdraw(qid) {
      // Only meaningful for docked items: resolved qid should not be downgraded to `run_not_in_flight`
      // (That would rewrite "the answer has been delivered" to "no one is waiting", which are two different facts for the main agent).
      if (!parked.has(qid)) return;
      retire(qid, "withdrawn");
    },

    resolve(qid, answer) {
      const entry = parked.get(qid);
      if (entry === undefined) {
        const reason = retired.get(qid);
        if (reason === "resolved") {
          return {
            ok: false,
            reason: "already_resolved",
            message:
              `Question ${qid} was already answered and the subagent has moved on with that ` +
              `answer. No need to answer again; if you have more to add, wait for its next ` +
              `escalation.`,
          };
        }
        if (reason === "withdrawn") {
          return {
            ok: false,
            reason: "run_not_in_flight",
            message:
              `The ask that raised question ${qid} is no longer in flight (the run was ` +
              `cancelled, or that ask already failed), so nobody is waiting for this answer. ` +
              `Use GetWorkflowRun to see the run's current state before deciding what to do next.`,
          };
        }
        return {
          ok: false,
          reason: "unknown_question",
          message:
            `Unknown question id ${qid}. It may be misspelled, or it may come from a process ` +
            `that is gone: parked questions are not persisted, so they vanish on restart (a ` +
            `resume makes the subagent ask again under a new id). Use GetWorkflowRun to read ` +
            `the run's pendingQuestions for the ids that are actually awaiting an answer.`,
        };
      }
      retire(qid, "resolved");
      // settle is called after exit: it will synchronously unwind the deferred on that side of the actor, and any re-entry on that chain will
      // (For example, if there is another escalate in the same round), you must see a table that does not contain this qid.
      entry.settle(answer);
      return { ok: true, qid };
    },

    pendingFor(runId) {
      const out: DynamicWorkflowRunPendingQuestion[] = [];
      for (const entry of parked.values()) {
        if (entry.runId !== runId) continue;
        out.push({
          qid: entry.qid,
          actor: entry.actor,
          ...(entry.actorName === undefined ? {} : { actorName: entry.actorName }),
          question: entry.question,
          ...(entry.context === undefined ? {} : { context: entry.context }),
          askedAt: entry.askedAt,
        });
      }
      return out;
    },
  };
}
