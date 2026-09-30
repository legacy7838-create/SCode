import type { ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";

/** Read the thought levels from the ModelConfig Option Specs in the Registry. */
export function resolveModelThoughtOption(params: {
  modelSelectionView: ModelSelectionView;
  providerId: string;
  modelId: string;
  currentValue?: string;
  formatLevelName?: (level: string) => string;
}): ZCodeConfigOption | null {
  const provider = params.modelSelectionView.providers.find(
    (candidate) => candidate.providerId === params.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.modelId === params.modelId);
  const reasoning = model?.config.optionSpecs.reasoningLevel;
  if (!reasoning || reasoning.values.length === 0) return null;

  return {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    // Reasoning has no default gear; an empty string indicates that the model has been selected but the user has not selected reasoning.
    currentValue:
      params.currentValue && reasoning.values.includes(params.currentValue)
        ? params.currentValue
        : "",
    options: reasoning.values.map((level) => ({
      value: level,
      name: params.formatLevelName?.(level) ?? level,
    })),
  };
}
