import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/**
 * A plain new task and the first-share import share one initialization; the original Recent intent
 * is preserved, and the public View resolves the effective selection.
 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/**
 * Called before activating the first-import Session; it does not depend on a runnable model, and it
 * does not carry the original new-task body into the share.
 */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
  // Import the created real Session. The old initialization regards the empty snapshot as the final selection and skips the new task rules.
  // Explicitly mark the source of first import rather than guessing by "session model"; the explicit empty selection of Root must also be retained.
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          planEnabled: root.planEnabled ?? false,
          modelSelection: root.modelSelection,
        }
      : { text: "", initializeFromNewTask: true },
  );
}
