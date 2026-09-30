import type { ModelSelection } from "@zcode/shared";
import type { IModelSelectionService } from "@zcode/services";

/** Pins the model identity at the boundary where an Automation Select becomes a single Submission. */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // Fixed run is an execution fact; retry cannot re-correspond to the account, nor can it be changed by the current read failure.
  if (params.fixedSelection) return params.fixedSelection;
  // Scheduler's snapshot may be earlier than Host's one-way import; the first execution of the new version of the intent after verification with the persistence layer.
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error(
        "Automation model selection is unavailable, select a model and reasoning level again",
      );
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation could not resolve a preferred model from the target host");
  }
  return preferredSelection;
}
