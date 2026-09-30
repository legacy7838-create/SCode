import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/**
 * Only explicit approval facts are consumed; a repeated snapshot must not re-apply yolo to a
 * permission the user later changed back.
 */
export function applyComposerPermissionGrant(
  draft: V4ComposerDraft,
  grant: SessionConfigState["permissionGrant"],
): V4ComposerDraft {
  if (!grant || draft.lastPermissionGrantId === grant.interactionId) return draft;
  return { ...draft, mode: "yolo", lastPermissionGrantId: grant.interactionId };
}
