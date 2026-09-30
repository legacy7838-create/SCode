import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import { clearManualModelConfig } from "@zcode/provider";
import {
  createProviderModelDraftValues,
  type ProviderModelDraftValues,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";

const CONFIG_VALUE_FIELDS = [
  "supportsJsonSchemaOutputValue",
  "supportsNativeWebSearchValue",
  "supportsMidConversationSystemValue",
  "reasoningLevelValuesValue",
] as const;

/**
 * Projects only the controls that are not overridden; the Host is the sole resolver of the
 * recommendation rules, and the draft does not keep a second, writable Effective Config.
 */
export function projectModelDraft(
  draft: ProviderModelDraftValues,
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  if (draft.useRecommendedConfigValue === false) return draft;
  const defaults = createProviderModelDraftValues({
    ...model,
    personalConfig: {},
    config: model.inheritedConfig ?? model.config,
  });
  const explicit = new Set(draft.overriddenFieldsValue ?? []);
  const next = { ...draft, inputFormatValue: { ...draft.inputFormatValue } };
  for (const field of CONFIG_VALUE_FIELDS) {
    if (!explicit.has(field)) Object.assign(next, { [field]: defaults[field] });
  }
  for (const field of Object.keys(
    next.inputFormatValue,
  ) as (keyof typeof next.inputFormatValue)[]) {
    if (!explicit.has(`inputFormatValue.${field}`))
      next.inputFormatValue[field] = defaults.inputFormatValue[field];
  }
  return next;
}

export function updateModelDraft(
  draft: ProviderModelDraftValues,
  patch: Partial<ProviderModelDraftValues>,
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  if (
    patch.useRecommendedConfigValue !== undefined &&
    patch.useRecommendedConfigValue !== (draft.useRecommendedConfigValue !== false)
  ) {
    if (patch.useRecommendedConfigValue) {
      return restoreModelDraft(draft, model);
    }
    const projected = projectModelDraft(draft, model);
    const inherited = model.inheritedConfig ?? model.config;
    // Only empty inheritance input is filled; erroneous non-empty user input is retained, allowing save to point out the error and not swallowing edits in switching modes.
    return {
      ...projected,
      contextWindowValue:
        projected.contextWindowValue || String(inherited.properties?.contextWindow ?? ""),
      maxOutputTokensValue:
        projected.maxOutputTokensValue || String(inherited.optionSpecs?.maxOutputTokens?.max ?? ""),
      reasoningLevelMapValue:
        projected.reasoningLevelMapValue || inherited.optionSpecs?.reasoningLevel?.map || "",
      useRecommendedConfigValue: false,
    };
  }
  const explicit = new Set(draft.overriddenFieldsValue ?? []);
  for (const field of CONFIG_VALUE_FIELDS) if (field in patch) explicit.add(field);
  if (patch.inputFormatValue) {
    for (const field of Object.keys(
      patch.inputFormatValue,
    ) as (keyof typeof patch.inputFormatValue)[]) {
      if (patch.inputFormatValue[field] !== draft.inputFormatValue[field])
        explicit.add(`inputFormatValue.${field}`);
    }
  }
  return { ...draft, ...patch, overriddenFieldsValue: [...explicit] };
}

/**
 * Restoring is an explicit draft action that clears the editable overrides even when smart
 * configuration was already on.
 */
export function restoreModelDraft(
  draft: ProviderModelDraftValues,
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  return {
    ...createProviderModelDraftValues({
      ...model,
      config: model.inheritedConfig ?? {},
      personalConfig: clearManualModelConfig(model.personalConfig),
      useRecommendedConfig: true,
    }),
    idValue: draft.idValue,
    enabledValue: draft.enabledValue,
    clearPersonalConfigValue: true,
  };
}

export function modelDraftOverrides(draft: ProviderModelDraftValues): ReadonlySet<string> {
  if (draft.useRecommendedConfigValue === false) return new Set();
  const result = new Set(draft.overriddenFieldsValue ?? []);
  for (const field of [
    "contextWindowValue",
    "maxOutputTokensValue",
    "reasoningLevelMapValue",
  ] as const) {
    if (draft[field].trim()) result.add(field);
    else result.delete(field);
  }
  return result;
}
