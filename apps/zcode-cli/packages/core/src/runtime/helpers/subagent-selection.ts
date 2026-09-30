import { createCoreError, CoreErrorType, type ModelSelection } from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";

const SUBAGENT_SELECTION_MESSAGES = {
  "selection-missing": "No model selected",
  "account-connection-unavailable": "Account connection unavailable",
  "provider-not-found": "Provider unavailable",
  "model-not-found": "Model unavailable",
  "reasoning-level-missing": "No reasoning level selected",
  "reasoning-level-not-supported": "Reasoning level unsupported",
} satisfies Record<NonNullable<EffectiveModelSelectionResult["selectionIssue"]>, string>;

/** An explicit profile is an intent still to be resolved; inheritance and internal override already have execution ownership and are not mapped to an account again. */
export function resolveSubagentSelection(input: {
  profileSelection?: ModelSelection | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
}): { hasConcreteModel: boolean; selection: ModelSelection } {
  const explicit = input.profileSelection;
  const result: EffectiveModelSelectionResult = input.overrideSelection
    ? { effectiveSelection: input.overrideSelection }
    : explicit
      ? input.resolveSelection
        ? input.resolveSelection(cloneModelSelection(explicit))
        : { effectiveSelection: explicit }
      : { effectiveSelection: input.parentSelection ?? null };
  if (!result.effectiveSelection || result.selectionIssue) {
    const reason = result.selectionIssue ?? "selection-missing";
    const requested = input.overrideSelection ?? explicit ?? input.parentSelection;
    const identity = requested ? `; selection=${requested.providerId}/${requested.modelId}` : "";
    // Parsing failure cannot fall back to the parent model, otherwise it will quietly change the subtask model explicitly specified by the user.
    // Public error projection does not read structured fields (the consumer cannot see it when there is only selectionIssue); only message is retained in the background.
    // Therefore, reasons are added to the existing reasons and messages at the same time, and both consumption paths can be located without adding a dedicated error protocol.
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Cannot start subagent: ${SUBAGENT_SELECTION_MESSAGES[reason]} [reason=${reason}${identity}]`,
      {
        recoverable: true,
        context: {
          selectionIssue: reason,
          reason,
          ...(result.effectiveSelection
            ? {
                providerId: result.effectiveSelection.providerId,
                modelId: result.effectiveSelection.modelId,
              }
            : {}),
        },
      },
    );
  }
  return {
    hasConcreteModel: explicit != null,
    selection: cloneModelSelection(result.effectiveSelection),
  };
}
