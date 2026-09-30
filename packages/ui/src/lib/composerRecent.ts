import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { logger } from "@/logger.js";

// The old key is used, and only the history of ModelSelection is saved when reading.
const COMPOSER_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ComposerRecent {
  readonly modelSelection?: ModelSelection;
  readonly mode?: SubmissionMode;
}

let submissionSequence = 0;
const acceptedSequences = new WeakMap<StorageLike, Map<string, number>>();

function resolveComposerRecentKey(workspacePath: string, workspaceIdentity?: string): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${COMPOSER_RECENT_KEY_PREFIX}:${workspaceKey}`;
}

export function readComposerRecent(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): ComposerRecent | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(resolveComposerRecentKey(workspacePath, workspaceIdentity));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    // The two leaves are independently verified: expired models or bad data cannot also lose legal permissions, and vice versa.
    const selection = modelSelectionSchema.safeParse(
      "modelSelection" in record ? record.modelSelection : record,
    );
    const mode = submissionModeSchema.safeParse("mode" in record ? record.mode : undefined);
    if (!selection.success && !mode.success) return null;
    return {
      ...(selection.success ? { modelSelection: selection.data } : {}),
      ...(mode.success ? { mode: mode.data } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Captured when a real Submission is initiated; the returned function is only called after an
 * accepted ACK.
 */
export function captureComposerRecentSubmission(
  workspacePath: string,
  submission: { readonly modelSelection: ModelSelection; readonly mode: SubmissionMode },
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): () => void {
  if (!storage) return () => {};
  const key = resolveComposerRecentKey(workspacePath, workspaceIdentity);
  const mode = submissionModeSchema.safeParse(submission.mode);
  const modelSelection = normalizeSparseModelSelection(submission.modelSelection);
  if (!mode.success || !modelSelection) {
    // Recent is an attached preference after sending; when input is abnormal, only the record is discarded and the authoritative command cannot be blocked.
    logger.warn("[ComposerRecent] invalid recent submission payload, skipping preference capture", {
      workspacePath,
      workspaceIdentity,
    });
    return () => {};
  }
  const sequence = ++submissionSequence;
  const recent = {
    modelSelection,
    mode: mode.data,
  };
  let accepted = acceptedSequences.get(storage);
  if (!accepted) {
    accepted = new Map();
    acceptedSequences.set(storage, accepted);
  }
  return () => {
    // Saving only the model will cause the first migration of Root to lose permissions; both fields must be saved together.
    // Within the same Renderer, the most recently accepted submissions are fetched in order of initiation to prevent late ACKs across Panes from writing back old preferences.
    // Unaccepted candidates do not advance the watermark and do not change the draft or CLI input queue.
    if (sequence <= (accepted.get(key) ?? 0)) return;
    accepted.set(key, sequence);
    try {
      storage.setItem(key, JSON.stringify(recent));
    } catch (error) {
      // The authoritative send has been accepted and the local preference write failure must not report it as a send failure.
      logger.warn("[ComposerRecent] failed to save recent submission payload", {
        workspacePath,
        workspaceIdentity,
        error,
      });
    }
  };
}

export function resolveDraftInitialModelSelection(
  view: ModelSelectionView | null,
  recent: ModelSelection | null,
): { readonly selection: ModelSelection | null; readonly invalidated: boolean } {
  // When the Registry has not yet arrived, the existing draft intention cannot be mistakenly judged as invalid; first keep it as it is, which is equivalent to the same Hook
  // After receiving the View, perform semantic verification.
  if (!view) return { selection: recent, invalidated: false };
  if (recent) {
    const model = findModel(view, recent);
    if (!model) return { selection: null, invalidated: true };
    const reasoning = recent.options?.reasoningLevel;
    if (
      reasoning === undefined ||
      !model.config.optionSpecs.reasoningLevel.values.includes(reasoning)
    ) {
      // Still retains the Provider/Model identity, but clears the invalid position; Composer does not pop up the generalization notification.
      // Let the empty Reasoning control directly ask the user to make a new explicit choice.
      return {
        selection: { providerId: recent.providerId, modelId: recent.modelId },
        invalidated: true,
      };
    }
    return { selection: recent, invalidated: false };
  }
  return {
    selection:
      view.preferredSelection && isSelectionInView(view, view.preferredSelection)
        ? view.preferredSelection
        : null,
    invalidated: recent !== null,
  };
}

function isSelectionInView(view: ModelSelectionView, selection: ModelSelection): boolean {
  const model = findModel(view, selection);
  if (!model) return false;
  const reasoning = selection.options?.reasoningLevel;
  const reasoningSpec = model.config.optionSpecs.reasoningLevel;
  return reasoning !== undefined && reasoningSpec.values.includes(reasoning);
}

function findModel(view: ModelSelectionView, selection: ModelSelection) {
  return view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
}

function normalizeSparseModelSelection(selection: ModelSelection): ModelSelection | null {
  const candidate =
    selection && typeof selection === "object" && !Array.isArray(selection) ? selection : null;
  const options = candidate?.options;
  const normalizedOptions =
    options?.reasoningLevel !== undefined ? { reasoningLevel: options.reasoningLevel } : {};
  const parsed = modelSelectionSchema.safeParse({
    providerId: candidate?.providerId,
    modelId: candidate?.modelId,
    ...(Object.keys(normalizedOptions).length > 0 ? { options: normalizedOptions } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
