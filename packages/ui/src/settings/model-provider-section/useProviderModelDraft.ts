import { useCallback, useRef, useState } from "react";
import type { ModelConfigObject, ModelConfigResolution } from "@zcode/provider";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
  type ProviderModelDraftValues,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import {
  modelDraftOverrides,
  projectModelDraft,
  updateModelDraft,
  restoreModelDraft,
} from "@/settings/model-provider-section/ProviderModelDraftState.js";
import { useModelConfigResolution } from "@/settings/model-provider-section/useModelConfigResolution.js";

/**
 * Adding and editing share the recommendation lifecycle; the business entry points keep only
 * initialization, permissions and their own save transactions.
 */
export function useProviderModelDraft({
  model,
  open,
  scopeKey,
  resolve,
}: {
  model: ProviderSettingsFormModel;
  open: boolean;
  scopeKey: string;
  resolve?: (modelId: string, personalConfig: ModelConfigObject) => Promise<ModelConfigResolution>;
}) {
  const [rawDraft, setRawDraft] = useState(() => createProviderModelDraftValues(model));
  const [draftScope, setDraftScope] = useState(scopeKey);
  const editGeneration = useRef(0);
  if (draftScope !== scopeKey) {
    // Switching providers must discard old drafts and requests at the same time, and cannot bring the user intent of the previous provider to the new target.
    setDraftScope(scopeKey);
    setRawDraft(createProviderModelDraftValues(model));
  }
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const resolveRecommended = useCallback(
    (id: string) => {
      if (!resolveRef.current) throw new Error("Model Config Resolution is not configured");
      // Public drafts hold personal intent; only take recommended baselines from the Host, without assembling a second Overlay using a semi-valid form.
      return resolveRef.current(id, {});
    },
    [scopeKey],
  );
  const smart = rawDraft.useRecommendedConfigValue !== false;
  const originalModelId =
    model.useRecommendedConfig !== false && !rawDraft.clearPersonalConfigValue
      ? model.modelId
      : undefined;
  const config = useModelConfigResolution({
    open,
    enabled: smart,
    modelId: rawDraft.idValue,
    originalModelId,
    resolve: resolve ? resolveRecommended : undefined,
  });
  const modelWithResolution = (
    resolution: ModelConfigResolution | null | undefined,
  ): ProviderSettingsFormModel => {
    if (resolution)
      return {
        ...model,
        inheritedConfig: resolution.inheritedConfig,
        config: resolution.inheritedConfig,
      };
    if (rawDraft.idValue.trim() === model.modelId) return model;
    return { ...model, config: {}, inheritedConfig: undefined };
  };
  const currentModel = modelWithResolution(config.resolution);
  const draft = projectModelDraft(rawDraft, currentModel);
  const change = (patch: Partial<ProviderModelDraftValues>) => {
    editGeneration.current += 1;
    setRawDraft(updateModelDraft(draft, patch, currentModel));
  };
  const reset = (nextModel: ProviderSettingsFormModel) => {
    editGeneration.current += 1;
    config.cancel();
    setRawDraft(createProviderModelDraftValues(nextModel));
  };
  const restore = async () => {
    const generation = ++editGeneration.current;
    const apply = (resolvedModel: ProviderSettingsFormModel) =>
      setRawDraft(restoreModelDraft(draft, resolvedModel));
    if (!draft.idValue.trim() || !resolve) {
      config.cancel();
      apply(currentModel);
      return;
    }
    await config.restore({
      isCurrent: () => editGeneration.current === generation,
      apply: (resolution) => apply(modelWithResolution(resolution)),
    });
  };
  const commit = async () => {
    editGeneration.current += 1;
    const requiresResolution = smart && resolve && rawDraft.idValue.trim() !== originalModelId;
    const resolution = requiresResolution
      ? (config.resolution ?? (await config.flush()))
      : config.resolution;
    if (requiresResolution && !resolution)
      throw new Error("Model Config Resolution is not ready yet");
    const resolvedModel = modelWithResolution(resolution);
    return resolveProviderModelDraftCommit({
      currentModel: resolvedModel,
      draft: projectModelDraft(rawDraft, resolvedModel),
    });
  };
  return {
    draft,
    change,
    reset,
    restore,
    commit,
    overrides: modelDraftOverrides(draft),
    inheritedConfig: currentModel.inheritedConfig,
    pending:
      smart &&
      Boolean(resolve) &&
      rawDraft.idValue.trim() !== originalModelId &&
      !config.resolution,
    defaultsLoaded: smart && config.defaultsLoaded,
    flush: config.flush,
    cancel: config.cancel,
  };
}
