/**
 * Whether a review has just ended (the “has review → no review” transition).
 *
 * A Trust mutation in the runtime may come from another capable attachment; when the review
 * settles, the store clears the binding, so this transition can be used to fill in one refresh of
 * the static Trust snapshot.
 *
 * It is not enough to test “there is no review right now”: that is also true on first mount, where
 * it would trigger one redundant load right after initialize and race with it.
 */
export function didWorkspaceHookReviewSettle(input: {
  previousInteractionId: string | undefined;
  currentInteractionId: string | undefined;
}): boolean {
  return input.previousInteractionId !== undefined && input.currentInteractionId === undefined;
}

/**
 * reasonCode → i18n key mapping.
 *
 * When a command is rejected, the inline Trust/revoke renders the raw reasonCode (e.g.
 * workspace_hooks_review_superseded) straight to the user—unreadable in either language. A missing
 * key puts the raw id on screen. Mappings are centralized here, with unknown codes falling back to
 * a generic “operation rejected” instead of the raw id, so that internal enum literals are not
 * leaked.
 */
const WORKSPACE_HOOK_REASON_CODE_MESSAGE_IDS: Record<string, string> = {
  workspace_hooks_review_superseded: "settings.hooks.review.reason.review_superseded",
  workspace_hooks_snapshot_mismatch: "settings.hooks.review.reason.snapshot_mismatch",
  workspace_hooks_bundle_changed: "settings.hooks.review.reason.bundle_changed",
  workspace_hooks_config_unreadable: "settings.hooks.review.reason.config_unreadable",
  workspace_hooks_config_write_failed: "settings.hooks.review.reason.config_write_failed",
  workspace_hooks_config_rebuild_failed: "settings.hooks.review.reason.config_rebuild_failed",
  workspace_hooks_trust_store_corrupt: "settings.hooks.review.reason.trust_store_corrupt",
  workspace_hooks_blocked_by_policy: "settings.hooks.review.reason.blocked_by_policy",
  workspace_hooks_policy_requires_pretrust: "settings.hooks.review.reason.policy_requires_pretrust",
  workspace_hooks_interaction_timeout: "settings.hooks.review.reason.interaction_timeout",
  workspace_hooks_require_trust_capable_host: "settings.hooks.review.reason.host_unavailable",
};

const WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID = "settings.hooks.review.reason.rejected";

export function resolveWorkspaceHookReasonCodeMessageId(reasonCode: string | undefined): string {
  if (!reasonCode) return WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID;
  return (
    WORKSPACE_HOOK_REASON_CODE_MESSAGE_IDS[reasonCode] ?? WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID
  );
}

/**
 * Decides whether a rejected command should settle silently (without showing the user an error).
 *
 * When the inline Trust button is double-clicked, each click produces a new commandId. The first
 * click succeeds and the review flow ends (the store clears the binding); the second click's
 * commandId is validated against the already-finished flow and returns
 * workspace_hooks_review_superseded. The panel must not show that to the user as a real error—yet
 * the user's intent already succeeded, the error copy is confusing, and it trains us to distrust
 * genuine superseded errors.
 *
 * Decision rule: stay silent only when the rejection is of the superseded kind **and** there is no
 * live pending binding left locally (i.e. the review has ended and the binding has been
 * cleared/advanced). A genuine superseded case (the bundle changed during the review, the binding
 * is still pending and the user has to review again) must be shown—nothing is silenced while
 * hasLivePendingBinding is true.
 *
 * This function is pure and does not read the store—hasLivePendingBinding is extracted by the
 * caller from the store's current snapshot after the await completes (see
 * useWorkspaceHookInlineTrust).
 */
export function shouldSilenceStaleRejection(input: {
  reasonCode: string | undefined;
  hasLivePendingBinding: boolean;
}): boolean {
  if (input.reasonCode !== "workspace_hooks_review_superseded") return false;
  return !input.hasLivePendingBinding;
}
