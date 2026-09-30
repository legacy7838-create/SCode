import type { AccountProviderStates } from "./account-provider-state.js";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
export type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import {
  validateModelSelectionOptions,
  type ModelSelection,
  type ProviderRegistryView,
} from "./registry.js";

export type ModelSelectionProviderKind = "ordinary" | "account-plan" | "account-offpeak";
export type ModelSelectionProviderClassifier = (providerId: string) => ModelSelectionProviderKind;

/**
 * Only resolves the intent for future execution; it never mutates the original selection, the
 * persisted record, or requests already pinned.
 * Why: clearing during a read would make a temporary unavailability permanent, and account
 * mapping must never degrade into matching a same-named model across arbitrary providers.
 */
export function resolveEffectiveModelSelection(input: {
  readonly selection: ModelSelection | null;
  readonly registry: ProviderRegistryView;
  readonly accountStates?: AccountProviderStates;
  readonly classifyProvider: ModelSelectionProviderClassifier;
  readonly resolveLegacyReasoningLevel?: (selection: ModelSelection) => string | undefined;
}): EffectiveModelSelectionResult {
  const original = input.selection;
  if (!original)
    return Object.freeze({ effectiveSelection: null, selectionIssue: "selection-missing" });
  const kind = input.classifyProvider(original.providerId);
  let providerId = original.providerId;
  if (kind === "account-plan") {
    const current = Object.entries(input.accountStates ?? {}).filter(
      ([id, state]) => state.current === true && input.classifyProvider(id) === "account-plan",
    );
    if (current.length !== 1) {
      return Object.freeze({
        effectiveSelection: null,
        selectionIssue: "account-connection-unavailable",
      });
    }
    providerId = current[0]![0];
  }
  const provider = input.registry.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!provider || (provider.config.visibility === "hidden" && kind !== "account-offpeak")) {
    return Object.freeze({ effectiveSelection: null, selectionIssue: "provider-not-found" });
  }
  const model = provider.models.find((candidate) => candidate.modelId === original.modelId);
  if (!model) return Object.freeze({ effectiveSelection: null, selectionIssue: "model-not-found" });
  let normalized = original;
  let validation = validateModelSelectionOptions(model, normalized);
  if (!validation.ok && validation.code === "reasoning-level-not-supported") {
    const reasoningLevel = input.resolveLegacyReasoningLevel?.({ ...original, providerId });
    if (reasoningLevel !== undefined) {
      const candidate = { ...original, options: { ...original.options, reasoningLevel } };
      const checked = validateModelSelectionOptions(model, candidate);
      if (checked.ok) {
        normalized = candidate;
        validation = checked;
      }
    }
  }
  const selection = Object.freeze({
    providerId,
    modelId: original.modelId,
    ...(validation.ok && normalized.options
      ? { options: Object.freeze({ ...normalized.options }) }
      : {}),
  });
  return Object.freeze({
    effectiveSelection: selection,
    ...(!validation.ok &&
    (validation.code === "reasoning-level-missing" ||
      validation.code === "reasoning-level-not-supported")
      ? { selectionIssue: validation.code }
      : {}),
  });
}
