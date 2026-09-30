/* oxlint-disable eslint(max-lines) -- The Draft, the validation, and the sparse Overlay of the
 * Model Config dialog must share one field mapping, so the UI cannot grow a second set of rules.
 */
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import type { ModelInputFormatData } from "@zcode/shared/model-config";
import {
  EnumOptionSpecConfig,
  extractManualModelConfig,
  clearManualModelConfig,
  type ModelConfigObject,
} from "@zcode/provider";

export type ProviderModelInputFormatDraft = ModelInputFormatData;

export interface ProviderModelDraftValues {
  idValue: string;
  contextWindowValue: string;
  maxOutputTokensValue: string;
  inputFormatValue: ProviderModelInputFormatDraft;
  enabledValue?: boolean;
  useRecommendedConfigValue?: boolean;
  /**
   * The existing Overlay is cleared only when this Draft switches from fixed mode back to
   * recommended mode.
   */
  clearPersonalConfigValue?: boolean;
  /**
   * The source of a field is the user's intent; it does not depend on whether the whole form is
   * valid or whether the value happens to equal the recommendation.
   */
  overriddenFieldsValue?: readonly string[];
  supportsJsonSchemaOutputValue?: boolean;
  supportsNativeWebSearchValue?: boolean;
  supportsMidConversationSystemValue?: boolean;
  reasoningLevelValuesValue: readonly string[];
  reasoningLevelMapValue: string;
}

export type ProviderModelDraftCommitResult =
  | { status: "commit"; model: ProviderSettingsFormModel }
  | {
      status: "invalid";
      field:
        | "id"
        | "contextWindow"
        | "maxOutputTokens"
        | "inputFormat"
        | "reasoningLevelValues"
        | "reasoningLevelMap";
    };

export function createProviderModelDraftValues(
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  // When the configuration is incomplete, the editor is the entrance to repair and cannot throw an error before opening; keep empty input for values, and use conservative initial values ​​for capability controls.
  const properties = model.config.properties ?? {};
  const inputFormat = properties?.inputFormat;
  return {
    idValue: model.modelId,
    // The editor only treats the Personal Overlay as real input; inherited values ​​are displayed by the UI as placeholders.
    contextWindowValue:
      model.personalConfig.properties?.contextWindow == null
        ? ""
        : String(model.personalConfig.properties.contextWindow),
    maxOutputTokensValue:
      model.personalConfig.optionSpecs?.maxOutputTokens?.max == null
        ? ""
        : String(model.personalConfig.optionSpecs.maxOutputTokens.max),
    inputFormatValue: {
      supportsText: inputFormat?.supportsText ?? true,
      supportsImage: inputFormat?.supportsImage ?? false,
      supportsVideo: inputFormat?.supportsVideo ?? false,
      supportsAudio: inputFormat?.supportsAudio ?? false,
      supportsPdf: inputFormat?.supportsPdf ?? false,
    },
    enabledValue: model.config.enabled !== false,
    useRecommendedConfigValue: model.useRecommendedConfig !== false,
    clearPersonalConfigValue: false,
    overriddenFieldsValue: personalDraftFieldKeys(model.personalConfig),
    supportsJsonSchemaOutputValue: properties.supportsJsonSchemaOutput ?? false,
    supportsNativeWebSearchValue: properties.supportsNativeWebSearch ?? false,
    supportsMidConversationSystemValue: properties.supportsMidConversationSystem ?? false,
    reasoningLevelValuesValue: [...(model.config.optionSpecs?.reasoningLevel?.values ?? [])],
    reasoningLevelMapValue:
      typeof model.personalConfig.optionSpecs?.reasoningLevel?.map === "string"
        ? model.personalConfig.optionSpecs.reasoningLevel.map
        : "",
  };
}

function personalDraftFieldKeys(config: ModelConfigObject): string[] {
  const result: string[] = [];
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    if (config.properties?.[key] != null) result.push(`${key}Value`);
  }
  if (config.optionSpecs?.reasoningLevel?.values != null) result.push("reasoningLevelValuesValue");
  for (const [key, value] of Object.entries(config.properties?.inputFormat ?? {})) {
    if (value != null) result.push(`inputFormatValue.${key}`);
  }
  return result;
}

function parsePositiveIntegerDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveProviderModelDraftCommit({
  currentModel,
  draft,
}: {
  currentModel: ProviderSettingsFormModel;
  draft: ProviderModelDraftValues;
}): ProviderModelDraftCommitResult {
  if (draft.clearPersonalConfigValue && currentModel.inheritedConfig) {
    // When switching back, it is recommended to only reset the comparison baseline and not clear it unconditionally during the final submission, otherwise the new edits after the reset will be swallowed.
    currentModel = {
      ...currentModel,
      personalConfig: clearManualModelConfig(currentModel.personalConfig),
      config: { ...currentModel.inheritedConfig, enabled: currentModel.config.enabled },
    };
  }
  const modelId = draft.idValue.trim();
  if (!modelId) {
    return { status: "invalid", field: "id" };
  }

  const useRecommendedConfig = draft.useRecommendedConfigValue !== false;
  const inherited = useRecommendedConfig ? currentModel.inheritedConfig : undefined;
  const contextWindow = draft.contextWindowValue.trim()
    ? parsePositiveIntegerDraft(draft.contextWindowValue)
    : (inherited?.properties?.contextWindow ?? null);
  if (contextWindow === null) {
    return { status: "invalid", field: "contextWindow" };
  }

  const maxOutputTokens = draft.maxOutputTokensValue.trim()
    ? parsePositiveIntegerDraft(draft.maxOutputTokensValue)
    : undefined;
  if (maxOutputTokens === null || (!useRecommendedConfig && maxOutputTokens === undefined)) {
    return { status: "invalid", field: "maxOutputTokens" };
  }

  if (!draft.inputFormatValue.supportsText) {
    return { status: "invalid", field: "inputFormat" };
  }

  const reasoningLevelValues = draft.reasoningLevelValuesValue.map((value) => value.trim());
  if (
    reasoningLevelValues.length === 0 ||
    reasoningLevelValues.some((value) => !value) ||
    new Set(reasoningLevelValues).size !== reasoningLevelValues.length
  ) {
    return { status: "invalid", field: "reasoningLevelValues" };
  }
  const inheritedReasoning = inherited?.optionSpecs?.reasoningLevel;
  const reasoningLevelMap = draft.reasoningLevelMapValue.trim();
  const effectiveReasoningMap = reasoningLevelMap || inheritedReasoning?.map;
  if (
    !effectiveReasoningMap ||
    new EnumOptionSpecConfig({
      values: reasoningLevelValues,
      map: effectiveReasoningMap,
    }).validateComplete(["optionSpecs", "reasoningLevel"]).length > 0
  ) {
    return { status: "invalid", field: "reasoningLevelMap" };
  }
  const effectiveEnabled = draft.enabledValue ?? currentModel.config.enabled ?? true;
  const currentEffectiveEnabled = currentModel.config.enabled ?? true;
  const effectiveProperties = {
    // System fields are not generated by editing drafts; manual saving is uniformly extracted according to the editable schema.
    requiresMfjsToolSchema: currentModel.config.properties?.requiresMfjsToolSchema,
    contextWindow,
    inputFormat: {
      ...currentModel.config.properties?.inputFormat,
      supportsImage: draft.inputFormatValue.supportsImage,
      supportsVideo: draft.inputFormatValue.supportsVideo,
      supportsPdf: draft.inputFormatValue.supportsPdf,
    },
    outputFormat: currentModel.config.properties?.outputFormat,
    supportsToolCall: currentModel.config.properties?.supportsToolCall,
    supportsJsonSchemaOutput:
      draft.supportsJsonSchemaOutputValue ??
      currentModel.config.properties?.supportsJsonSchemaOutput ??
      false,
    supportsNativeWebSearch:
      draft.supportsNativeWebSearchValue ??
      currentModel.config.properties?.supportsNativeWebSearch ??
      false,
    supportsMidConversationSystem:
      draft.supportsMidConversationSystemValue ??
      currentModel.config.properties?.supportsMidConversationSystem ??
      false,
  };
  const personalProperties = buildPersonalProperties({
    current: currentModel.personalConfig.properties,
    inherited: inherited?.properties,
    currentEffective: currentModel.config.properties,
    effective: effectiveProperties,
  });
  // Explicitly filling in the value is overwriting; even if it is equal to the recommendation, it is retained. Clearing the input means canceling the override.
  if (draft.contextWindowValue.trim())
    assignMutable(personalProperties, "contextWindow", contextWindow);
  else deleteMutable(personalProperties, "contextWindow");
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    if (draft.overriddenFieldsValue?.includes(`${key}Value`))
      assignMutable(personalProperties, key, effectiveProperties[key]);
  }
  for (const key of ["supportsImage", "supportsVideo", "supportsPdf"] as const) {
    if (
      draft.overriddenFieldsValue?.includes(`inputFormatValue.${key}`) ||
      draft.inputFormatValue[key] !== currentModel.config.properties?.inputFormat?.[key]
    ) {
      assignMutable(personalProperties, "inputFormat", {
        ...personalProperties.inputFormat,
        [key]: draft.inputFormatValue[key],
      });
    }
  }
  const sparsePersonalConfig: ModelConfigObject = {
    ...currentModel.personalConfig,
    ...resolvePersonalBoolean(
      "enabled",
      effectiveEnabled,
      currentEffectiveEnabled,
      inherited?.enabled,
      currentModel.personalConfig.enabled,
    ),
    ...(Object.keys(personalProperties).length > 0 ? { properties: personalProperties } : {}),
  };
  if (Object.keys(personalProperties).length === 0)
    deleteMutable(sparsePersonalConfig, "properties");

  const inheritedMaxOption = inherited?.optionSpecs?.maxOutputTokens;
  // Option Spec no longer has a default; this input box uniquely expresses the model's hard upper limit, max.
  const currentEffectiveMaxOption = {
    ...currentModel.config.optionSpecs?.maxOutputTokens,
  };
  const resolvedMaxOutputSpec =
    maxOutputTokens === undefined
      ? undefined
      : {
          ...currentEffectiveMaxOption,
          max: maxOutputTokens,
        };
  const personalOptionSpecs = { ...currentModel.personalConfig.optionSpecs };
  applyPersonalReasoning({
    target: personalOptionSpecs,
    values: reasoningLevelValues,
    map: reasoningLevelMap,
    currentEffective: currentModel.config.optionSpecs?.reasoningLevel?.values ?? undefined,
    inherited: inheritedReasoning,
    currentPersonal: currentModel.personalConfig.optionSpecs?.reasoningLevel,
  });
  if (draft.overriddenFieldsValue?.includes("reasoningLevelValuesValue")) {
    personalOptionSpecs.reasoningLevel = {
      ...personalOptionSpecs.reasoningLevel,
      values: [...reasoningLevelValues],
    };
  }
  if (reasoningLevelMap)
    personalOptionSpecs.reasoningLevel = {
      ...personalOptionSpecs.reasoningLevel,
      map: reasoningLevelMap,
    };
  if (resolvedMaxOutputSpec !== undefined) {
    const currentPersonalMax = currentModel.personalConfig.optionSpecs?.maxOutputTokens;
    personalOptionSpecs.maxOutputTokens = {
      ...(currentPersonalMax?.map === undefined ? {} : { map: currentPersonalMax.map }),
      max: resolvedMaxOutputSpec.max,
    };
  } else {
    const currentPersonalMap = currentModel.personalConfig.optionSpecs?.maxOutputTokens?.map;
    if (currentPersonalMap === undefined) deleteMutable(personalOptionSpecs, "maxOutputTokens");
    else personalOptionSpecs.maxOutputTokens = { map: currentPersonalMap };
  }
  if (Object.keys(personalOptionSpecs).length > 0) {
    assignMutable(sparsePersonalConfig, "optionSpecs", personalOptionSpecs);
  } else {
    deleteMutable(sparsePersonalConfig, "optionSpecs");
  }
  const effectiveOptionSpecs = { ...currentModel.config.optionSpecs };
  effectiveOptionSpecs.reasoningLevel = {
    values: [...reasoningLevelValues],
    map: effectiveReasoningMap,
  };
  if (resolvedMaxOutputSpec !== undefined) {
    effectiveOptionSpecs.maxOutputTokens = resolvedMaxOutputSpec;
  } else if (inheritedMaxOption !== undefined) {
    effectiveOptionSpecs.maxOutputTokens = inheritedMaxOption;
  } else {
    deleteMutable(effectiveOptionSpecs, "maxOutputTokens");
  }
  const personalConfig = useRecommendedConfig
    ? sparsePersonalConfig
    : materializeEditorManagedPersonalConfig({
        current: sparsePersonalConfig,
        effective: {
          ...currentModel.config,
          enabled: effectiveEnabled,
          properties: effectiveProperties,
          optionSpecs: effectiveOptionSpecs,
        },
      });
  return {
    status: "commit",
    model: {
      ...currentModel,
      modelId,
      useRecommendedConfig,
      hasPersonalConfig: Object.keys(personalConfig).length > 0,
      personalConfig,
      config: {
        ...currentModel.config,
        enabled: effectiveEnabled,
        properties: effectiveProperties,
        optionSpecs: effectiveOptionSpecs,
      },
    },
  };
}

function preserveEnabledPersonalConfig(config: ModelConfigObject): ModelConfigObject {
  return config.enabled === undefined ? {} : { enabled: config.enabled };
}

function materializeEditorManagedPersonalConfig({
  current,
  effective,
}: {
  current: ModelConfigObject;
  effective: ModelConfigObject;
}): ModelConfigObject {
  // enabled is managed separately by the model list row and is not materialized or cleared with the "Follow recommended configuration" mode.
  // Only editable leaves are extracted; hidden request mappings must come from current identity rules and cannot be frozen by an old model draft.
  return extractManualModelConfig({
    ...preserveEnabledPersonalConfig(current),
    properties: effective.properties,
    optionSpecs: effective.optionSpecs,
  });
}

function resolvePersonalBoolean<K extends string>(
  key: K,
  value: boolean,
  currentEffective: boolean,
  inherited: unknown,
  currentPersonal: boolean | null | undefined,
) {
  // Untouched controls must retain their existing sparse overlay and cannot be written false out of thin air due to the Effective default value.
  if (value === currentEffective) {
    return currentPersonal === undefined || currentPersonal === null
      ? {}
      : ({ [key]: currentPersonal } as Record<K, boolean>);
  }
  return inherited === value ? {} : ({ [key]: value } as Record<K, boolean>);
}

function buildPersonalProperties({
  current,
  inherited,
  currentEffective,
  effective,
}: {
  current: ModelConfigObject["properties"];
  inherited: ModelConfigObject["properties"];
  currentEffective: ModelConfigObject["properties"];
  effective: NonNullable<ModelConfigObject["properties"]>;
}): NonNullable<ModelConfigObject["properties"]> {
  const result: Record<string, unknown> = { ...current };
  applySparseLeaf(result, "contextWindow", effective.contextWindow, inherited?.contextWindow);
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    applyInteractiveSparseLeaf(
      result,
      key,
      effective[key],
      currentEffective?.[key],
      inherited?.[key],
    );
  }
  const input = { ...current?.inputFormat } as Record<string, unknown>;
  applyInteractiveSparseLeaf(
    input,
    "supportsImage",
    effective.inputFormat?.supportsImage,
    currentEffective?.inputFormat?.supportsImage,
    inherited?.inputFormat?.supportsImage,
  );
  applyInteractiveSparseLeaf(
    input,
    "supportsVideo",
    effective.inputFormat?.supportsVideo,
    currentEffective?.inputFormat?.supportsVideo,
    inherited?.inputFormat?.supportsVideo,
  );
  if (Object.keys(input).length > 0) result.inputFormat = input;
  else delete result.inputFormat;
  return result as NonNullable<ModelConfigObject["properties"]>;
}

function applyInteractiveSparseLeaf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  currentEffective: unknown,
  inherited: unknown,
) {
  if (value === currentEffective) return;
  applySparseLeaf(target, key, value, inherited);
}

function applySparseLeaf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  inherited: unknown,
) {
  if (value === inherited) delete target[key];
  else target[key] = value;
}

function applyPersonalReasoning({
  target,
  values,
  map,
  currentEffective,
  inherited,
  currentPersonal,
}: {
  target: Record<string, unknown>;
  values: readonly string[];
  map: string;
  currentEffective: readonly string[] | undefined;
  inherited: NonNullable<ModelConfigObject["optionSpecs"]>["reasoningLevel"] | undefined;
  currentPersonal: NonNullable<ModelConfigObject["optionSpecs"]>["reasoningLevel"] | undefined;
}) {
  const next = { ...currentPersonal };
  if (!arraysEqual(values, currentEffective)) {
    if (arraysEqual(values, inherited?.values)) deleteMutable(next, "values");
    else assignMutable(next, "values", [...values]);
  }
  if (!map || map === inherited?.map) deleteMutable(next, "map");
  else assignMutable(next, "map", map);
  if (Object.keys(next).length === 0) delete target.reasoningLevel;
  else target.reasoningLevel = next;
}

function arraysEqual(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
) {
  if (left === right) return true;
  if ((left?.length ?? 0) === 0 && (right?.length ?? 0) === 0) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function assignMutable(target: object, key: PropertyKey, value: unknown) {
  (target as Record<PropertyKey, unknown>)[key] = value;
}

function deleteMutable(target: object, key: PropertyKey) {
  delete (target as Record<PropertyKey, unknown>)[key];
}
