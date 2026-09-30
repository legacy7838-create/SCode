import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  type ModelSelection,
  type ProviderRegistryServiceSnapshot,
} from "@zcode/provider";
import { legacyReasoningLevelRenames as renames } from "./legacy-reasoning-level-renames.js";

const oldRulesCache = new WeakMap<ModelConfigRules, ModelConfigRules>();

/** Exists only to restore the known legacy Built-in value range for historic Selections; it does not migrate Personal config nor relax validation in the execution layer. */
export function resolveLegacyReasoningLevel(
  snapshot: ProviderRegistryServiceSnapshot,
  selection: ModelSelection,
): string | undefined {
  const oldLevel = selection.options?.reasoningLevel;
  if (oldLevel !== "off" && oldLevel !== "nothink") return undefined;
  const personal = snapshot.config.personalModels.getExactRule(
    selection.providerId,
    selection.modelId,
  );
  if (
    personal &&
    (personal.type === "manual-provider-model" ||
      personal.config.optionSpecs?.reasoningLevel?.values !== undefined ||
      personal.config.optionSpecs?.reasoningLevel?.map !== undefined)
  )
    return undefined;
  const provider = snapshot.resolution.effectiveProviders.get(selection.providerId);
  if (!provider) return undefined;
  const builtin = snapshot.config.zcodeBuiltinModelRules;
  let oldRules = oldRulesCache.get(builtin);
  if (!oldRules) {
    oldRules = new ModelConfigRules(
      builtin.rules().map((rule) => {
        // It must be the original adjudicated no-site/no-API restriction rule; newly added site rules with the same name cannot inherit the old alias by mistake.
        const rename =
          rule.type === "model"
            ? renames.find((entry) => entry.modelMatch === rule.modelMatch)
            : undefined;
        const values = rule.config.optionSpecs?.reasoningLevel?.values;
        return rename && values?.includes("disabled")
          ? {
              ...rule,
              config: rule.config.overlay(
                new ModelConfig({
                  optionSpecs: new ModelOptionSpecsConfig({
                    reasoningLevel: {
                      values: values.map((value) =>
                        value === "disabled" ? rename.oldLevel : value,
                      ),
                    },
                  }),
                }),
              ),
            }
          : rule;
      }),
    );
    oldRulesCache.set(builtin, oldRules);
  }
  // Use the original rule engine to handle case, suffix, API/site and subsequent coverage, without duplicating the second set of matching logic.
  const values = oldRules.resolve({
    providerId: selection.providerId,
    modelId: selection.modelId,
    templateId: snapshot.resolution.effectiveProviders.getRule(selection.providerId)?.templateId,
    apiType: provider.api?.type,
    baseUrl: provider.api?.baseUrl,
  }).optionSpecs?.reasoningLevel?.values;
  return values?.includes(oldLevel) ? "disabled" : undefined;
}
