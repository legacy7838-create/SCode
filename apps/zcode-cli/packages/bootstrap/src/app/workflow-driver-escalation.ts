// ============================================================
// AgentRuntime-backed WorkflowDriver: Upgrade Q&A bridge (escalate)
// ============================================================
// workflow-driver.ts reaches the upper limit of oxlint max-lines (400 lines), and combines the four methods of the fourth sequence (upgrade Q&A) - session-level escalate port, qid casting, answer settlement,
// Remove the entire session - split this file into free functions; only a thin delegate is left on the driver class. The public aspect remains unchanged and remains from
// workflow-driver.ts export.
//
// All touches of the driver state by the four functions are explicitly passed in through {@link EscalationHost} (session table, qid lookup table,
// deps, per-run serial number, dual-track record), this file does not hold any state of its own - the original method body is retained verbatim, only
// `this.` is replaced with `host.`.

import type {
  EscalateQuestionRequest,
  SessionId,
  WorkflowEscalateOutcome,
  WorkflowEscalatePort,
} from "@zcode/contracts";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type PersonaSpec,
  type RunEvent,
} from "@zcode/dynamic-workflow";
import {
  ESCALATION_BUDGET_EXHAUSTED,
  MAX_ESCALATIONS_PER_ASK,
  defer,
  effectiveActorName,
  normalizeEscalationContext,
  questionIdFragments,
} from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * The host surface the driver hands to the escalation bridge. Everything is a **reference** to driver private state (not a copy): `sessions` /
 * `qidToSession` are the two tables inside the class itself, `nextEscalationSeq` increments the class's per-run sequence number, and `record` is the
 * class's dual-track sink (journal + emit, and the order is not swappable -- see the record comment in the driver).
 */
export interface EscalationHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly qidToSession: Map<string, SessionState>;
  /** Takes the next per-run monotonic escalation sequence number (the second segment of the qid). */
  nextEscalationSeq(): number;
  record(event: RunEvent): void;
}

/**
 * Settles one parked escalation Q&A (called in by the run service through the registry). Of the same family as {@link AgentRuntimeWorkflowDriver.respondToSubmit}:
 * it resolves the deferred, turning the tool result of `escalate` into that answer, and the actor's turn continues in place.
 *
 * Returning false means this driver has no such qid (the wrong run, or it was just withdrawn by cancelAsk). The registry has already retired the qid before
 * calling this method, so nothing is written back into the registry here -- deleting it in both places would let the two retirement reasons "already answered" and
 * "withdrawn" overwrite each other.
 */
export function respondToParkedEscalation(
  host: EscalationHost,
  qid: string,
  answer: string,
): boolean {
  const state = host.qidToSession.get(qid);
  if (state === undefined) return false;
  const deferred = state.pendingEscalations.get(qid);
  host.qidToSession.delete(qid);
  state.pendingEscalations.delete(qid);
  if (deferred === undefined) return false;
  try {
    host.record({ type: "escalation-resolved", qid, answer });
  } catch (error) {
    // The **opposite** choice to the raise path, the reason is also the opposite: if you can't write it there, no one will see the problem, and parking will only
    // Let the actor block permanently, so withdraw and throw up; at this point, the actor is already waiting for this answer, for an observation event
    // Leaving it hanging would be worse. Remember to warn and send the answer accordingly.
    host.deps.logger?.warn?.("Dynamic workflow escalation resolved event not journaled", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.escalation.resolved_journal_failed",
      module: "bootstrap.app",
      qid,
      runId: host.deps.runId ?? "run",
    });
  }
  deferred.resolve(answer);
  return true;
}

/**
 * Withdraws all parked escalations on a given session: the deferred is rejected (the handler no longer hangs) and the registry entries retire
 * (answering those qids afterwards yields `run_not_in_flight`).
 *
 * The three call sites cover every exceptional path by which an ask can end: `cancelAsk` (the engine actively cancels), `onTurnRejected`
 * (the turn itself throws -- at that point nobody reads the tool result any more) and `startAsk` (a different ask takes over on the same session).
 * The normal path does not need it: a parked escalate blocks the turn, so an ask cannot settle while it still owes an answer.
 */
export function withdrawSessionEscalations(host: EscalationHost, state: SessionState): void {
  if (state.pendingEscalations.size === 0) return;
  const entries = [...state.pendingEscalations];
  state.pendingEscalations.clear();
  for (const [qid, deferred] of entries) {
    host.qidToSession.delete(qid);
    host.deps.escalationRegistry.withdraw(qid);
    deferred.reject(
      new WorkflowError("Cancelled", `Escalation ${qid} was cancelled along with its ask.`),
    );
  }
}

/**
 * Creates a session-level escalation port: the `escalate` handler calls it mid-turn and blocks waiting for the main agent's answer.
 *
 * It is point-by-point symmetric with {@link AgentRuntimeWorkflowDriver.makeSubmitPort}, and the only two differences both come from the peer being the main agent rather than the engine:
 *   1. **No sink reporting**. The engine core needs zero changes -- an escalation happens entirely within the boundary where the driver executes an ask (the same
 *      level as repair / nudge turns), and the zero-I/O state machine is unaware of it. Its events travel the journal + emit tracks.
 *   2. **There can be several parked items** (key = qid), because the model may fire several escalate calls in parallel within one turn.
 *
 * Both early returns yield an **ordinary tool result** instead of throwing: when the budget is exhausted, throwing would only make the model treat it
 * as a retryable failure and keep slamming into the same wall -- and eliminating exactly that spinning is the reason this feature exists.
 */
export function makeSessionEscalatePort(
  host: EscalationHost,
  sessionId: SessionId,
  actor: ActorRef,
  persona: PersonaSpec,
): WorkflowEscalatePort {
  const actorName = effectiveActorName(persona);
  return {
    escalate: (request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome> => {
      const state = host.sessions.get(sessionId);
      if (state === undefined || state.currentInstance === undefined) {
        // Nothing is flying ask: The question is nowhere to stop. Not parked, not suspended (same argument as submit's guard of the same name).
        return Promise.resolve({
          kind: "refused",
          reason: "no_active_ask",
          message:
            "No ask is in flight, so there is nowhere to park this question and nobody " +
            "would answer it. Escalate only while working on an ask.",
        });
      }
      if (state.escalationsUsed >= MAX_ESCALATIONS_PER_ASK) {
        // per-ask upper limit (nudge budget sibling): short-circuit from the 4th time onwards, never stop.
        return Promise.resolve({
          kind: "refused",
          reason: "budget_exhausted",
          message: ESCALATION_BUDGET_EXHAUSTED,
        });
      }
      state.escalationsUsed++;

      const qid = mintEscalationQuestionId(host);
      const deferred = defer<string>();
      state.pendingEscalations.set(qid, deferred);
      host.qidToSession.set(qid, state);
      const context = normalizeEscalationContext(request.context);
      // The clock is read only once, and events and dock records are shared: calling Date.now() once in both places will cause the same problem to appear in the event track.
      // The snapshot contains two question times that differ by a few milliseconds, and the downstream uses this to calculate "how long to wait."
      const askedAt = Date.now();
      host.deps.escalationRegistry.park(
        {
          qid,
          runId: host.deps.runId ?? "run",
          actor: refToString(actor),
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        },
        (answer) => {
          respondToParkedEscalation(host, qid, answer);
        },
      );
      try {
        host.record({
          type: "escalation-raised",
          qid,
          actor,
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        });
      } catch (error) {
        // If the journal cannot be written, there will be no durable question and answer records, and parking will cause the actor to block indefinitely in a
        // On issues that no one can see. Unregistering and handing the error over to the handler is more honest than parking quietly.
        state.pendingEscalations.delete(qid);
        host.qidToSession.delete(qid);
        host.deps.escalationRegistry.withdraw(qid);
        throw error;
      }
      return deferred.promise.then((answer) => ({ kind: "answered", answer, qid }) as const);
    },
  };
}

/**
 * Mints a globally unique question id: `dwfq-<runId fragment>-<seq>`.
 *
 * The fragment is for human debugging recognition (semantically opaque -- the model only passes it back as a token), and the seq is monotonic per run.
 * A short fragment (8 characters) can, in extreme cases, collide with another run's fragment, so the candidates are tried in increasing length and the first one
 * not taken in the registry is used: **the last candidate is the full runId**, and "unique runId x per-run monotonic seq" is collision-free by construction, so
 * this loop must terminate on an unoccupied id. All of them being occupied can only mean that two drivers share the
 * same runId (a wiring mistake), in which case it fails loudly rather than emitting an id that would misattribute answers.
 */
function mintEscalationQuestionId(host: EscalationHost): string {
  const seq = host.nextEscalationSeq();
  for (const fragment of questionIdFragments(host.deps.runId ?? "run")) {
    const candidate = `dwfq-${fragment}-${seq}`;
    if (!host.deps.escalationRegistry.isTaken(candidate)) return candidate;
  }
  throw new WorkflowError(
    "DriverError",
    `Cannot mint a free escalation question id for run ${host.deps.runId ?? "run"} ` +
      `(seq=${seq}): every candidate is already taken in the registry. Two drivers may be ` +
      `sharing one runId.`,
  );
}
