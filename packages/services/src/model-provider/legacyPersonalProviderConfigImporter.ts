import { BUILTIN_PROVIDER_TEMPLATE_IDS } from "@zcode/shared";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import {
  isModelProviderModelConfig,
  normalizeModelProviderConfiguredBaseUrl,
  resolveModelProviderApiFormat,
  resolveModelProviderRuntimeBaseUrl,
  type ModelProviderConfig,
  type ModelProviderModelEntry,
} from "./legacyModelProviderSerialized.js";

interface LegacyPersonalProviderConfigImportInput {
  readonly legacyProviders: readonly ModelProviderConfig[];
}

interface LegacyPersonalModelMember {
  readonly modelId: string;
  readonly contextWindow?: number;
}

/**
 * Extracts only the still-confirmable Personal user intent from the legacy Effective Store.
 *
 * The legacy Store wrote Built-in, Catalog enrichment, settings-page defaults and user input
 * into the same model object. Migrating the whole object, or diffing it against the current
 * Built-in, would freeze system-generated facts into a Personal Overlay; so only custom Provider
 * invocation config, member order and context are kept here.
 */
export function importLegacyPersonalProviderConfig(
  input: LegacyPersonalProviderConfigImportInput,
): ProviderConfigLayerUpdate {
  let providers = ProviderConfigMap.empty();
  let models = ModelConfigRules.empty();

  for (const legacy of input.legacyProviders) {
    const providerId = legacy.id.trim();
    if (!providerId) continue;
    // Published config.json also marks builtin:* as custom; retention identity must precede source.
    // Only the key of the volume API is user input, and the template association uses the current identity; the old file is only reserved for rollback, and double writing is not continued.
    const apiTemplateId =
      providerId === "builtin:bigmodel"
        ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
        : providerId === "builtin:zai"
          ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
          : undefined;
    if (apiTemplateId) {
      const apiKey = legacy.apiKey.trim();
      if (apiKey)
        providers = providers.setRule({
          providerId: apiTemplateId,
          templateId: apiTemplateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey }),
          }),
        });
      continue;
    }
    if (providerId.startsWith("builtin:") || providerId.startsWith("account:")) continue;
    // Built-in is rebuilt as a whole from the current ZCode Built-in Config and Account Overlay; models-dev has been
    // Retired, workspace is not a global Personal input either. Only old custom providers are allowed into the new file.
    if (legacy.source !== undefined && legacy.source !== "custom") continue;

    const members = collectLegacyPersonalModelMembers(legacy.models);
    const modelIds = members.map((member) => member.modelId);
    const providerName = legacy.name.trim();
    providers = providers.setRule({
      providerId,
      // The old start and stop are user intentions; omitting false will be re-enabled by the unified default value and must be kept outside the rules.
      ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
      ...(providerName && providerName !== providerId ? { providerName } : {}),
      config: createPersonalProviderConfig(legacy, modelIds),
    });

    for (const member of members) {
      if (member.contextWindow === undefined) continue;
      models = models.setExact(
        providerId,
        member.modelId,
        new ModelConfig({
          properties: new ModelPropertiesConfig({
            contextWindow: member.contextWindow,
          }),
        }),
      );
    }
  }

  return Object.freeze({ providers, models });
}

function createPersonalProviderConfig(
  legacy: ModelProviderConfig,
  modelIds: readonly string[],
): ProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({
      apiKey: legacy.apiKey.trim() || undefined,
      apiKeyManagementUrl: legacy.apiKeyUrl,
    }),
    api: new ProviderApiConfig({
      type: resolveModelProviderApiFormat(legacy),
      baseUrl:
        resolveModelProviderRuntimeBaseUrl(legacy) ||
        normalizeModelProviderConfiguredBaseUrl(legacy.endpoints.baseURL ?? ""),
      headers: legacy.headers,
    }),
    ...(modelIds.length > 0 ? { personalModelIds: modelIds, modelOrder: modelIds } : {}),
  });
}

function collectLegacyPersonalModelMembers(
  entries: readonly ModelProviderModelEntry[],
): readonly LegacyPersonalModelMember[] {
  const seen = new Set<string>();
  const members: LegacyPersonalModelMember[] = [];

  for (const entry of entries) {
    const modelId = (typeof entry === "string" ? entry : entry.id).trim();
    if (!modelId || seen.has(modelId)) continue;
    if (isModelProviderModelConfig(entry) && entry.deleted === true) continue;
    seen.add(modelId);
    members.push({
      modelId,
      ...(isModelProviderModelConfig(entry) && isPositiveInteger(entry.contextWindow)
        ? { contextWindow: entry.contextWindow }
        : {}),
    });
  }

  return members;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
