/**
 * The single adjudication function for review monotonicity.
 *
 * Background: the rule "`reviewFlowId`/`generation` are monotonic only within a single Runtime
 * controller" was independently re-implemented in three places — product projection (event
 * replay), prompt-turn observer (live monitor), and renderer review store (binding display) —
 * and has already drifted mechanically, so relying on byte-identical comments to keep them in
 * sync is fragile. This module converges the "adjudication" into a pure function; the "application
 * policy" (drop / defer / accept a new flow) still belongs to each consumer. New mirrored consumers
 * must consume this function instead of hand-writing comparisons.
 */

/** Identity triple of a review: only these three fields are compared; the other payload fields take no part in monotonicity. */
export interface WorkspaceHookReviewIdentity {
  reviewFlowId: string;
  generation: number;
  interactionId: string;
}

/**
 * - no_current: there is no current authority, the candidate takes over;
 * - same_flow_advance: same flow with a higher generation, accept (supersede);
 * - same_flow_replay: same flow, same generation and same interactionId, an idempotent replay, ignore;
 * - same_flow_conflict: same flow and same generation but a different interactionId, which violates
 *   controller monotonicity, ignore;
 * - same_flow_stale: same flow with a lower generation, a late event, ignore;
 * - cross_flow: different flows (Runtime generation change), generations are not comparable across
 *   flows; the caller adjudicates from its own epoch evidence (projection drop / prompt-turn defer /
 *   store accepts the new authority).
 */
export type WorkspaceHookReviewMonotonicityVerdict =
  | "no_current"
  | "same_flow_advance"
  | "same_flow_replay"
  | "same_flow_conflict"
  | "same_flow_stale"
  | "cross_flow";

export function verdictWorkspaceHookReviewRequest(
  current: WorkspaceHookReviewIdentity | undefined,
  candidate: WorkspaceHookReviewIdentity,
): WorkspaceHookReviewMonotonicityVerdict {
  if (!current) return "no_current";
  if (candidate.reviewFlowId !== current.reviewFlowId) return "cross_flow";
  if (candidate.generation > current.generation) return "same_flow_advance";
  if (candidate.generation < current.generation) return "same_flow_stale";
  return candidate.interactionId === current.interactionId
    ? "same_flow_replay"
    : "same_flow_conflict";
}
