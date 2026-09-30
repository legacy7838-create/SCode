// ============================================================
// Workflow Escalate Port - Actor escalation boundaries for blocking issues to the master agent
// ============================================================
// Completely isomorphic and deliberately separate from {@link WorkflowSubmitPort}:
// Submit settles **the result of this ask** (engine decision), escalate settles **a question and answer** (the main agent answers),
// The two endpoints, life cycles, and failure modes are different. Merging them into one port will only make the two timings unclear to each other.

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface EscalateQuestionRequest {
  /** The tool call id inside the actor child session that initiated the `escalate` call. */
  toolCallId: ToolCallId | string;
  /** The blocking point itself: a focused question that can be answered in one sentence. */
  question: string;
  /** Optional extra context (what the actor already tried, which line it is stuck on). */
  context?: string;
  trace: TraceContext;
}

/**
 * The outcome of one escalation. **Both branches are ordinary tool results**, not errors: when the
 * budget is exhausted a normal "proceed on your own" result is returned instead of throwing (an error
 * would make the model treat it as a retryable failure and keep hitting the same wall).
 *
 * A discriminated union rather than plain text, because the caller (core's tool handler) uses it to decide what kind of tool_result to render (house rule: flow decisions are made by error code, not by error text).
 */
export type WorkflowEscalateOutcome =
  | {
      kind: "answered";
      /** The answer text the main agent gives through `ResolveWorkflowQuestion`, becoming the tool result verbatim. */
      answer: string;
      /** The globally unique id of this question (for logs and human tracing; the model does not need to read it). */
      qid: string;
    }
  | {
      kind: "refused";
      /**
       * `budget_exhausted`: this ask's escalations are used up (the per-ask ceiling, of the same family as the nudge budget).
       * `no_active_ask`: this session has no in-flight ask at this moment, so the question has nowhere to park (it should not happen, but it must never hang).
       */
      reason: "budget_exhausted" | "no_active_ask";
      /** Text for the model's benefit, stating the situation and the next step. */
      message: string;
    };

export interface WorkflowEscalatePort {
  /**
   * Escalate a blocking question and **block** waiting for the main agent's answer.
   *
   * The same discipline as {@link WorkflowSubmitPort.respond}: a resolve can take an arbitrarily long time (by design there is
   * no timeout — "after the timeout, judge for yourself" is exactly the speculative bypass this feature exists to eliminate).
   * The escape hatch is the existing cancellation: the driver's `cancelAsk` rejects together with the parked escalation
   * deferred, so run cancellation and process death behave exactly as they do today.
   *
   * Routing identity (run/actor/session/instance) is bound by the port closure and the model cannot override it.
   */
  escalate(request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome>;
}
