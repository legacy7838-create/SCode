import type { Model, ModelOptions } from "@zcode/contracts";

const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;

/**
 * Auxiliary calls uniformly use the lowest item of the public tiers and cap the output budget; the tier order comes from
 * Model Config, and protocol behavior can no longer be inferred from names such as disabled/off.
 */
export function auxiliaryModelOptions(model: Model): Required<ModelOptions> {
  return {
    reasoningLevel: model.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, model.optionSpecs.maxOutputTokens.max),
  };
}
