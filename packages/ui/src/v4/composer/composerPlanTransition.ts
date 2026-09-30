import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/**
 * A new tool result sets the flag directly; only already-processed results are deduplicated, and a
 * manual re-selection during that window is not protected.
 */
export function applyComposerPlanTransition(
  draft: V4ComposerDraft,
  transition: SessionConfigState["planTransition"],
): V4ComposerDraft {
  if (!transition || draft.lastPlanTransitionId === transition.toolCallId) return draft;
  return {
    ...draft,
    lastPlanTransitionId: transition.toolCallId,
    planEnabled: transition.planEnabled,
  };
}
