/* oxlint-disable eslint(max-lines) -- Reading the multiple generations of Provider structures from published legacy ZCode config.json files is concentrated on this single boundary. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEnv,
} from "@zcode/shared";
import {
  createModelProviderModelConfig,
  getDefaultModelSupportedFormatsFromApiFormat,
  getDefaultModelSupportedFormatsFromEndpoints,
  getDefaultModelProviderEndpointPathForKind,
  getModelProviderModelIds,
  isModelProviderModelConfig,
  legacyModelProviderListSchema,
  mapModelProviderSupportedFormatToKind,
  migrateLegacyModelProviderConfig,
  MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW,
  modelProviderApiFormatSchema,
  modelProviderCatalogSourceIdSchema,
  modelProviderEndpointsSchema,
  modelProviderKindSchema,
  modelProviderReasoningSpecSchema,
  modelProviderSourceSchema,
  modelProviderSystemDisabledReasonSchema,
  normalizeModelProviderBaseUrlForKind,
  normalizeModelProviderConfiguredBaseUrl,
  resolveModelProviderDefaultKind,
  resolveModelProviderContextWindow,
  resolveModelProviderKindApiFormat,
  resolveModelProviderApiFormat,
  resolveModelProviderRuntimeBaseUrl,
  stripLegacyClaudeProviderMappings,
  stripModelProviderReasoningPatches,
  type ModelProviderApiFormat,
  type ModelProviderCatalogSourceId,
  type ModelProviderConfig,
  type ModelProviderEndpoints,
  type ModelProviderKind,
  type ModelProviderModelConfig,
  type ModelProviderModality,
  type ModelProviderReasoningSpec,
  type ModelProviderSource,
  type ModelProviderSystemDisabledReason,
  type ProviderModelMappings,
} from "./legacyModelProviderSerialized.js";
import { getAppConfigDir } from "../paths.js";

const LEGACY_PRESET_GLM_PROVIDER_IDS = new Set<string>([
  "zai-api",
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  "bigmodel-api",
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
]);

function isLegacyPresetGlmProviderId(providerId: string): boolean {
  return LEGACY_PRESET_GLM_PROVIDER_IDS.has(providerId);
}

const BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

function normalizeBigModelCodingPlanAnthropicBaseUrlForEnv(
  baseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const fallbackBaseUrl =
    resolveRuntimeZCodeEnv(env) === "production"
      ? BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL
      : `${resolveBigModelApiOrigin(env)}/api/anthropic`;
  const normalizedBaseUrl = normalizeModelProviderBaseUrlForKind(
    baseUrl ?? fallbackBaseUrl,
    "anthropic",
  );
  if (resolveRuntimeZCodeEnv(env) === "production") {
    return normalizedBaseUrl || fallbackBaseUrl;
  }

  try {
    const parsed = new URL(normalizedBaseUrl || fallbackBaseUrl);
    const productionParsed = new URL(BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL);
    // The old configuration may save the production domain name; the Team Plan Key of the test environment cannot call the production gateway.
    return parsed.origin === productionParsed.origin
      ? fallbackBaseUrl
      : normalizedBaseUrl || fallbackBaseUrl;
  } catch {
    return fallbackBaseUrl;
  }
}

function getZCodeConfigFilePath(): string {
  return join(getAppConfigDir(), "config.json");
}

const LEGACY_FALLBACK_CONTEXT_WINDOW = MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW;
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

type JsonObject = Record<string, unknown>;

interface ZCodeConfigFile {
  $schema?: string;
  provider?: Record<string, ZCodeOpenCodeProviderConfig>;
  [key: string]: unknown;
}

interface ZCodeOpenCodeProviderConfig {
  api?: string;
  name?: string;
  env?: string[];
  id?: string;
  kind?: ModelProviderKind;
  npm?: string;
  whitelist?: string[];
  blacklist?: string[];
  options?: JsonObject;
  enabled?: boolean;
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints?: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKeyUrl?: string;
  defaultKind?: ModelProviderKind;
  providerMappings?: ProviderModelMappings;
  createdAt?: number;
  updatedAt?: number;
  models?: Record<string, ZCodeOpenCodeModelConfig>;
  zcode?: ZCodeProviderConfigExtension;
  [key: string]: unknown;
}

interface ZCodeOpenCodeModelConfig {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean | ZCodeReasoningConfigExtension;
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?: unknown;
  cost?: JsonObject;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: {
    input?: ModelProviderModality[];
    output?: ModelProviderModality[];
  };
  experimental?: boolean;
  status?: string;
  provider?: {
    npm?: string;
    api?: string;
  };
  options?: JsonObject;
  headers?: Record<string, string>;
  variants?: Record<string, JsonObject>;
  kinds?: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  reasoningSpec?: ModelProviderReasoningSpec;
  hasMaxOutputTokens?: boolean;
  priority?: number;
  modified?: boolean;
  deleted?: boolean;
  zcode?: ZCodeModelConfigExtension;
  [key: string]: unknown;
}

interface ZCodeReasoningConfigExtension {
  enabled?: boolean;
  variants?: string[];
  defaultVariant?: string;
  aliases?: Record<string, string>;
}

interface ZCodeProviderConfigExtension {
  enabled?: boolean;
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints?: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKeyUrl?: string;
  defaultKind?: ModelProviderKind;
  providerMappings?: ProviderModelMappings;
  createdAt?: number;
  updatedAt?: number;
  deletedModels?: string[];
}

interface ZCodeModelConfigExtension {
  kinds?: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  reasoning?: ModelProviderReasoningSpec;
  hasMaxOutputTokens?: boolean;
  priority?: number;
  modified?: boolean;
  deleted?: boolean;
}

const jsonObjectSchema = z.record(z.string(), z.unknown());
const zcodeModelProviderModalitySchema = z.enum(["text", "image", "video", "audio", "pdf"]);
const zcodeProviderModelMappingsSchema = z.record(z.string(), z.unknown());

const zcodeReasoningConfigExtensionSchema = z
  .object({
    enabled: z.boolean().optional(),
    variants: z.array(z.string().min(1)).optional(),
    defaultVariant: z.string().min(1).optional(),
    aliases: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const zcodeModelConfigExtensionSchema = z
  .object({
    kinds: z.array(modelProviderKindSchema).optional(),
    defaultKind: modelProviderKindSchema.optional(),
    modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
    disabledReason: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    reasoning: modelProviderReasoningSpecSchema.optional(),
    hasMaxOutputTokens: z.boolean().optional(),
    priority: z.number().finite().optional(),
    modified: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .passthrough();

const zcodeOpenCodeModelConfigSchema: z.ZodType<ZCodeOpenCodeModelConfig> = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    reasoning: z.union([z.boolean(), zcodeReasoningConfigExtensionSchema]).optional(),
    limit: z
      .object({
        context: z.number().positive().optional(),
        input: z.number().positive().optional(),
        output: z.number().positive().optional(),
      })
      .optional(),
    contextWindow: z.number().positive().optional(),
    maxOutputTokens: z.number().positive().optional(),
    modalities: z
      .object({
        input: z.array(zcodeModelProviderModalitySchema).optional(),
        output: z.array(zcodeModelProviderModalitySchema).optional(),
      })
      .optional(),
    options: jsonObjectSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    variants: z.record(z.string(), jsonObjectSchema).optional(),
    kinds: z.array(modelProviderKindSchema).optional(),
    defaultKind: modelProviderKindSchema.optional(),
    modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
    disabledReason: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    reasoningSpec: modelProviderReasoningSpecSchema.optional(),
    hasMaxOutputTokens: z.boolean().optional(),
    priority: z.number().finite().optional(),
    modified: z.boolean().optional(),
    deleted: z.boolean().optional(),
    zcode: zcodeModelConfigExtensionSchema.optional(),
  })
  .passthrough();

const zcodeProviderConfigExtensionSchema = z
  .object({
    enabled: z.boolean().optional(),
    systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
    endpoints: modelProviderEndpointsSchema.optional(),
    apiFormat: modelProviderApiFormatSchema.optional(),
    source: modelProviderSourceSchema.optional(),
    catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
    catalogProviderId: z.string().optional(),
    modelsDevProviderId: z.string().optional(),
    apiKeyRequired: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    logoUrl: z.string().optional(),
    apiKeyUrl: z.string().optional(),
    defaultKind: modelProviderKindSchema.optional(),
    providerMappings: zcodeProviderModelMappingsSchema.optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    deletedModels: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

const zcodeOpenCodeProviderConfigSchema: z.ZodType<ZCodeOpenCodeProviderConfig> = z
  .object({
    api: z.string().optional(),
    name: z.string().optional(),
    env: z.array(z.string()).optional(),
    id: z.string().optional(),
    kind: modelProviderKindSchema.optional(),
    npm: z.string().optional(),
    whitelist: z.array(z.string()).optional(),
    blacklist: z.array(z.string()).optional(),
    options: jsonObjectSchema.optional(),
    enabled: z.boolean().optional(),
    systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
    endpoints: modelProviderEndpointsSchema.optional(),
    apiFormat: modelProviderApiFormatSchema.optional(),
    source: modelProviderSourceSchema.optional(),
    catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
    catalogProviderId: z.string().optional(),
    modelsDevProviderId: z.string().optional(),
    apiKeyRequired: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    logoUrl: z.string().optional(),
    apiKeyUrl: z.string().optional(),
    defaultKind: modelProviderKindSchema.optional(),
    providerMappings: zcodeProviderModelMappingsSchema.optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    models: z.record(z.string(), zcodeOpenCodeModelConfigSchema).optional(),
    zcode: zcodeProviderConfigExtensionSchema.optional(),
  })
  .passthrough();

const zcodeConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    provider: z.record(z.string(), zcodeOpenCodeProviderConfigSchema).optional(),
  })
  .passthrough();

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const normalizedKey = key.trim();
    const normalizedValue = readString(item);
    return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function inferModelProviderKindFromOpenCodeProvider(
  provider: ZCodeOpenCodeProviderConfig,
): ModelProviderKind {
  if (provider.kind) {
    return provider.kind;
  }
  const npm = provider.npm?.toLowerCase() ?? "";
  if (npm.includes("anthropic")) {
    return "anthropic";
  }
  if (npm.includes("openai-compatible")) {
    return "openai-compatible";
  }
  if (npm.includes("openai")) {
    return "openai";
  }
  return "openai-compatible";
}

function hasOpenCodeProviderRuntimeFields(provider: ZCodeOpenCodeProviderConfig): boolean {
  // The authoritative runtime field of config.json is kind/options.baseURL.
  // The old endpoints/apiFormat/defaultKind/zcode may be remnants of historical migration. If you continue to read them preferentially, the new configuration will be overwritten.
  return Boolean(
    provider.kind ||
    readString(provider.options?.baseURL) ||
    readString(provider.api) ||
    provider.npm?.trim(),
  );
}

function resolveOpenCodeProviderDefaultKind(
  provider: ZCodeOpenCodeProviderConfig,
): ModelProviderKind {
  if (provider.kind) {
    return provider.kind;
  }
  if (readString(provider.options?.baseURL) || readString(provider.api) || provider.npm?.trim()) {
    return inferModelProviderKindFromOpenCodeProvider(provider);
  }
  return (
    provider.defaultKind ??
    provider.zcode?.defaultKind ??
    inferModelProviderKindFromOpenCodeProvider(provider)
  );
}

function resolvePresetProviderKindFromRuntimeBaseUrl(
  providerId: string,
  baseURL: string | undefined,
): ModelProviderKind | undefined {
  if (!baseURL || !isLegacyPresetGlmProviderId(providerId)) {
    return undefined;
  }

  // The history config.json may be saved as kind=anthropic but the baseURL points to
  // /coding/paas/v4. The running protocol of this set of built-in providers ZAI/BigModel must be consistent with the known
  // The runtime URL is aligned, otherwise the agent will use the Anthropic adapter to request the OpenAI Chat endpoint.
  const normalized = baseURL.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const path = resolveRuntimeBaseUrlPath(normalized);

  if (isBigModelCodingPlanLegacyOpenAiRuntime(providerId, normalized)) {
    // The default runtime of BigModel Coding Plan has been unified back to Anthropic.
    // Historically installed /coding/paas/v4 cannot continue to infer the built-in provider as OpenAI-compatible.
    return "anthropic";
  }
  if (path.includes("/coding/paas/v4")) {
    return "openai-compatible";
  }
  if (path.includes("/api/anthropic") || path.includes("/zcode-plan/anthropic")) {
    return "anthropic";
  }
  return undefined;
}

function resolveRuntimeBaseUrlPath(baseURL: string): string {
  try {
    return new URL(baseURL).pathname.toLowerCase();
  } catch {
    // Non-URL historical values ​​continue to be conservatively matched according to the original string.
    return baseURL.toLowerCase();
  }
}

function isBigModelCodingPlanLegacyOpenAiRuntime(
  providerId: string,
  baseURL: string | undefined,
): boolean {
  if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan) {
    return false;
  }
  const normalized = baseURL?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  return resolveRuntimeBaseUrlPath(normalized).includes("/coding/paas/v4");
}

function resolveOpenCodeProviderEndpoints(
  provider: ZCodeOpenCodeProviderConfig,
  defaultKind: ModelProviderKind,
  providerId: string,
): ModelProviderEndpoints {
  const baseURL = readString(provider.options?.baseURL) ?? readString(provider.api);
  if (baseURL) {
    if (isBigModelCodingPlanLegacyOpenAiRuntime(providerId, baseURL)) {
      // The old version saves the BigModel Coding Plan to the coding endpoint of OpenAI Chat.
      // Now the built-in provider uses Anthropic endpoint by default, and the baseURL needs to be migrated when reading.
      return {
        baseURL: normalizeBigModelCodingPlanAnthropicBaseUrlForEnv(undefined),
        paths: {
          anthropic: "/v1/messages",
        },
      };
    }
    if (providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan) {
      return {
        baseURL: normalizeBigModelCodingPlanAnthropicBaseUrlForEnv(baseURL),
        paths: {
          anthropic: "/v1/messages",
        },
      };
    }
    // The options.baseURL of the new config.json structure is the runtime baseURL configured by the user.
    // When reading, you cannot press kind to delete path segments such as /v1 and /responses, otherwise the settings page will be defocused/refreshed and the user input will be rewritten.
    const normalizedBaseURL = normalizeModelProviderConfiguredBaseUrl(baseURL);
    return {
      baseURL: normalizedBaseURL,
      paths: {
        [defaultKind]: getDefaultModelProviderEndpointPathForKind(defaultKind),
      },
    };
  }
  return provider.endpoints ?? provider.zcode?.endpoints ?? {};
}

function stripZCodePrefixedProviderMappings(
  providerMappings: ProviderModelMappings | undefined,
): ProviderModelMappings | undefined {
  if (!providerMappings) {
    return undefined;
  }
  const entries = Object.entries(providerMappings ?? {}).filter(
    ([key]) => !key.toLowerCase().startsWith("zcode"),
  );
  return Object.fromEntries(entries);
}

function openCodeReasoningToModelReasoning(
  model: ZCodeOpenCodeModelConfig,
  options: { preferOpenCodeFields: boolean },
): ModelProviderReasoningSpec | undefined {
  if (!options.preferOpenCodeFields && model.reasoningSpec) {
    return stripModelProviderReasoningPatches(model.reasoningSpec);
  }
  if (!options.preferOpenCodeFields && model.zcode?.reasoning) {
    return stripModelProviderReasoningPatches(model.zcode.reasoning);
  }
  const reasoning = model.reasoning;
  if (reasoning === undefined || reasoning === false) {
    return undefined;
  }
  const reasoningConfig = typeof reasoning === "object" ? reasoning : undefined;
  if (reasoningConfig?.enabled === false) {
    return undefined;
  }
  const variantKeys = reasoningConfig?.variants ?? [];
  if (variantKeys.length === 0) {
    return undefined;
  }
  return {
    ...(reasoningConfig?.defaultVariant ? { defaultLevel: reasoningConfig.defaultVariant } : {}),
    levels: Object.fromEntries(variantKeys.map((level) => [level, {}])),
  };
}

function openCodeModelToModelProviderModel(
  modelId: string,
  model: ZCodeOpenCodeModelConfig,
  providerDefaultKind: ModelProviderKind,
  options: { preferOpenCodeFields: boolean },
): ModelProviderModelConfig {
  const zcode = options.preferOpenCodeFields ? undefined : model.zcode;
  const zcodeExtensions = model.zcode;
  const contextWindow =
    readPositiveNumber(model.limit?.context) ?? readPositiveNumber(model.contextWindow);
  const maxOutputTokens =
    readPositiveNumber(model.limit?.output) ??
    readPositiveNumber(model.options?.max_tokens) ??
    readPositiveNumber(model.maxOutputTokens);
  // Earlier provider configurations might only hold output values ​​in options.max_tokens or top-level maxOutputTokens.
  // Press limit > options > top-level compatibility when reading, and writeback still converges to the standard limit structure.
  const hasMaxOutputTokens =
    (!options.preferOpenCodeFields ? model.hasMaxOutputTokens : undefined) ??
    zcode?.hasMaxOutputTokens ??
    maxOutputTokens !== undefined;
  const kinds =
    !options.preferOpenCodeFields && model.kinds?.length
      ? model.kinds
      : zcode?.kinds?.length
        ? zcode.kinds
        : [providerDefaultKind];
  return createModelProviderModelConfig({
    id: model.id?.trim() || modelId,
    name: model.name,
    kinds,
    defaultKind:
      (!options.preferOpenCodeFields ? model.defaultKind : undefined) ??
      zcode?.defaultKind ??
      providerDefaultKind,
    contextWindow,
    maxOutputTokens: hasMaxOutputTokens ? maxOutputTokens : undefined,
    modalities: {
      input: model.modalities?.input,
      output: model.modalities?.output,
    },
    reasoning: openCodeReasoningToModelReasoning(model, options),
    priority: readFiniteNumber(model.priority) ?? readFiniteNumber(zcodeExtensions?.priority),
    disabledReason: model.disabledReason ?? zcode?.disabledReason,
    supportsTools: model.supportsTools ?? zcode?.supportsTools,
    supportsStructuredOutput: model.supportsStructuredOutput ?? zcode?.supportsStructuredOutput,
    modified: model.modified ?? zcodeExtensions?.modified,
    deleted: model.deleted ?? zcodeExtensions?.deleted,
  });
}

function normalizeDeletedModelIds(modelIds: readonly string[] | undefined): string[] {
  const deletedModels: string[] = [];
  const seen = new Set<string>();
  for (const rawModelId of modelIds ?? []) {
    const modelId = rawModelId.trim();
    const key = modelId.toLowerCase();
    if (!modelId || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deletedModels.push(modelId);
  }
  return deletedModels;
}

function createDeletedModelTombstone(
  modelId: string,
  providerDefaultKind: ModelProviderKind,
): ModelProviderModelConfig {
  return createModelProviderModelConfig({
    id: modelId,
    kinds: [providerDefaultKind],
    contextWindow: LEGACY_FALLBACK_CONTEXT_WINDOW,
    modalities: { input: ["text"], output: ["text"] },
    modified: true,
    deleted: true,
  });
}

function openCodeProviderToModelProviderConfig(
  providerId: string,
  provider: ZCodeOpenCodeProviderConfig,
): ModelProviderConfig {
  const zcode = provider.zcode;
  const preferOpenCodeFields = hasOpenCodeProviderRuntimeFields(provider);
  const configuredDefaultKind = resolveOpenCodeProviderDefaultKind(provider);
  const options = provider.options ?? {};
  const configuredRuntimeBaseURL = readString(options.baseURL) ?? readString(provider.api);
  const defaultKind =
    resolvePresetProviderKindFromRuntimeBaseUrl(providerId, configuredRuntimeBaseURL) ??
    configuredDefaultKind;
  const endpoints = resolveOpenCodeProviderEndpoints(provider, defaultKind, providerId);
  const apiKey = readString(options.apiKey) ?? "";
  const now = Date.now();
  const models = Object.entries(provider.models ?? {}).map(([modelId, model]) =>
    openCodeModelToModelProviderModel(modelId, model, defaultKind, {
      preferOpenCodeFields,
    }),
  );
  const modelKeys = new Set(models.map((model) => model.id.trim().toLowerCase()).filter(Boolean));
  for (const deletedModelId of normalizeDeletedModelIds(zcode?.deletedModels)) {
    const key = deletedModelId.toLowerCase();
    if (modelKeys.has(key)) {
      continue;
    }
    models.push(createDeletedModelTombstone(deletedModelId, defaultKind));
    modelKeys.add(key);
  }
  const apiKeyRequired =
    provider.apiKeyRequired ?? zcode?.apiKeyRequired ?? readBoolean(options.apiKeyRequired);
  const providerMappings = preferOpenCodeFields
    ? undefined
    : stripZCodePrefixedProviderMappings(provider.providerMappings ?? zcode?.providerMappings);
  return normalizeProviderForStore({
    id: provider.id?.trim() || providerId,
    name: provider.name?.trim() || providerId,
    ...(provider.enabled !== undefined
      ? { enabled: provider.enabled }
      : zcode?.enabled !== undefined
        ? { enabled: zcode.enabled }
        : {}),
    ...((provider.systemDisabledReason ?? zcode?.systemDisabledReason)
      ? {
          systemDisabledReason: provider.systemDisabledReason ?? zcode?.systemDisabledReason,
        }
      : {}),
    endpoints,
    apiFormat: preferOpenCodeFields
      ? resolveModelProviderKindApiFormat(defaultKind)
      : (provider.apiFormat ?? zcode?.apiFormat ?? resolveModelProviderKindApiFormat(defaultKind)),
    ...((provider.source ?? zcode?.source)
      ? { source: provider.source ?? zcode?.source }
      : { source: "custom" }),
    ...((provider.catalogSourceId ?? zcode?.catalogSourceId)
      ? { catalogSourceId: provider.catalogSourceId ?? zcode?.catalogSourceId }
      : {}),
    ...((provider.catalogProviderId ?? zcode?.catalogProviderId)
      ? {
          catalogProviderId: provider.catalogProviderId ?? zcode?.catalogProviderId,
        }
      : {}),
    ...((provider.modelsDevProviderId ?? zcode?.modelsDevProviderId)
      ? {
          modelsDevProviderId: provider.modelsDevProviderId ?? zcode?.modelsDevProviderId,
        }
      : {}),
    ...(apiKeyRequired !== undefined ? { apiKeyRequired } : {}),
    ...((provider.headers ?? zcode?.headers ?? readStringRecord(options.headers))
      ? {
          headers: provider.headers ?? zcode?.headers ?? readStringRecord(options.headers),
        }
      : {}),
    ...((provider.logoUrl ?? zcode?.logoUrl)
      ? { logoUrl: provider.logoUrl ?? zcode?.logoUrl }
      : {}),
    apiKey,
    ...((provider.apiKeyUrl ?? zcode?.apiKeyUrl)
      ? { apiKeyUrl: provider.apiKeyUrl ?? zcode?.apiKeyUrl }
      : {}),
    defaultKind,
    models,
    ...(providerMappings ? { providerMappings } : {}),
    createdAt:
      (!preferOpenCodeFields ? (provider.createdAt ?? zcode?.createdAt) : undefined) ?? now,
    updatedAt:
      (!preferOpenCodeFields ? (provider.updatedAt ?? zcode?.updatedAt) : undefined) ?? now,
  });
}

async function readRawZCodeConfigFile(): Promise<ZCodeConfigFile | null> {
  const filePath = getZCodeConfigFilePath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The old reader treated all failures as if the file did not exist, and the Importer would therefore commit an empty Personal configuration permanently.
    // Only ENOENT allows initialization of an empty configuration; other errors are left to the Repository to reserve the disk and report failure.
    if (code === "ENOENT") return null;
    throw new Error(
      `failed to read legacy provider config stage=io path=${filePath} code=${code ?? "unknown"}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    // JSON/Zod raw errors may contain input values ​​such as API Key; cannot be written to the log or passed out via cause.
    throw new Error(`failed to parse legacy provider config stage=json path=${filePath}`);
  }
  const parsed = zcodeConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join(".").slice(0, 256) ?? "";
    throw new Error(
      `failed to validate legacy provider config stage=schema path=${filePath} field=${field}`,
    );
  }
  return parsed.data;
}

async function readZCodeConfigProviders(): Promise<ModelProviderConfig[] | null> {
  const config = await readRawZCodeConfigFile();
  if (!config?.provider) {
    return null;
  }
  const providers = Object.entries(config.provider).map(([providerId, provider]) =>
    openCodeProviderToModelProviderConfig(providerId, provider),
  );
  return applyProviderStoreMigrations(providers);
}

function normalizeModelKindsFromProvider(
  provider: Pick<
    ModelProviderConfig,
    "apiFormat" | "defaultKind" | "endpoints" | "modelSupportedFormats"
  >,
  modelId: string,
): ModelProviderKind[] {
  const formats =
    provider.modelSupportedFormats?.[modelId] ??
    (provider.apiFormat
      ? getDefaultModelSupportedFormatsFromApiFormat(provider.apiFormat)
      : getDefaultModelSupportedFormatsFromEndpoints(provider.endpoints));
  const kinds = formats.flatMap((format) => {
    const kind = mapModelProviderSupportedFormatToKind(format);
    return kind ? [kind] : [];
  });
  if (kinds.length > 0) {
    return [...new Set(kinds)];
  }

  const defaultKind = resolveModelProviderDefaultKind(provider);
  return defaultKind ? [defaultKind] : [];
}

function normalizeModelProviderModelConfigEntry(
  model: ModelProviderModelConfig,
): ModelProviderModelConfig | null {
  const id = model.id.trim();
  if (!id) {
    return null;
  }

  return {
    ...model,
    id,
    name: model.name?.trim() || undefined,
    contextWindow: resolveModelProviderContextWindow(model.contextWindow),
    kinds: [...new Set(model.kinds)],
    modalities: {
      input: [...new Set(model.modalities.input)],
      output: [...new Set(model.modalities.output)],
    },
  };
}

function normalizeProviderModels(provider: ModelProviderConfig): ModelProviderModelConfig[] {
  const hasModelConfigs = provider.models.some(isModelProviderModelConfig);
  if (hasModelConfigs) {
    // Preset synchronization will produce a mixed list of "official string model + user-defined object model".
    // The mixed list cannot undergo legacy migration: metadata such as contextWindow/reasoning in the object will be lost.
    const seen = new Set<string>();
    return provider.models.flatMap((rawModel) => {
      const rawModelId = isModelProviderModelConfig(rawModel) ? rawModel.id : rawModel;
      const modelId = rawModelId.trim();
      if (!modelId) {
        return [];
      }

      const normalizedModel = isModelProviderModelConfig(rawModel)
        ? normalizeModelProviderModelConfigEntry(rawModel)
        : createModelProviderModelConfig({
            id: modelId,
            name: provider.modelDisplayNames?.[modelId],
            kinds: normalizeModelKindsFromProvider(provider, modelId),
            defaultKind: resolveModelProviderDefaultKind(provider),
          });
      if (!normalizedModel || seen.has(normalizedModel.id)) {
        return [];
      }

      seen.add(normalizedModel.id);
      return [normalizedModel];
    });
  }

  const migrated = legacyModelProviderListSchema.safeParse([provider]);
  if (migrated.success) {
    return migrateLegacyModelProviderConfig(migrated.data[0]!).models.filter(
      isModelProviderModelConfig,
    );
  }

  const seen = new Set<string>();
  return getModelProviderModelIds(provider).flatMap((modelId) => {
    if (seen.has(modelId)) {
      return [];
    }
    seen.add(modelId);
    return [
      createModelProviderModelConfig({
        id: modelId,
        name: provider.modelDisplayNames?.[modelId],
        kinds: normalizeModelKindsFromProvider(provider, modelId),
        defaultKind: resolveModelProviderDefaultKind(provider),
      }),
    ];
  });
}

function hasCanonicalEndpoints(endpoints: ModelProviderEndpoints): boolean {
  return Boolean(endpoints.baseURL?.trim() || endpoints.paths);
}

function resolveProviderDefaultKindForStore(provider: ModelProviderConfig): ModelProviderKind {
  if (provider.defaultKind || provider.apiFormat || hasCanonicalEndpoints(provider.endpoints)) {
    return resolveModelProviderDefaultKind(provider);
  }

  // Old v2 stores may still only carry endpoints.anthropic/openai.
  // The new runtime helper no longer reads the old fields. Here, defaultKind must be deduced at the migration boundary and then dropped into the runtime endpoint.
  if (provider.endpoints.anthropic?.trim()) {
    return "anthropic";
  }
  if (provider.endpoints.openai?.trim()) {
    return "openai-compatible";
  }
  return resolveModelProviderDefaultKind(provider);
}

function normalizeProviderForStore(provider: ModelProviderConfig): ModelProviderConfig {
  const defaultKind = resolveProviderDefaultKindForStore(provider);
  const normalizedEndpoints = normalizeEndpoints(provider.endpoints, defaultKind);
  const apiFormat = resolveModelProviderApiFormat({
    apiFormat: provider.apiFormat,
    defaultKind,
    endpoints: normalizedEndpoints,
  });
  const normalizedModels = normalizeProviderModels({
    ...provider,
    apiFormat,
    defaultKind,
    endpoints: normalizedEndpoints,
    modelSupportedFormats: provider.modelSupportedFormats,
  });

  return {
    ...provider,
    apiFormat,
    defaultKind,
    endpoints: normalizedEndpoints,
    models: normalizedModels,
    modelDisplayNames: undefined,
    modelSupportedFormats: undefined,
    providerMappings: stripZCodePrefixedProviderMappings(
      stripLegacyClaudeProviderMappings(provider.providerMappings),
    ),
  };
}

function applyProviderStoreMigrations(providers: ModelProviderConfig[]): ModelProviderConfig[] {
  // default-* preset templates are not distributed with the product: an empty API Key means the user has never enabled the provider.
  // Clear these old presets at the migration boundary to avoid continuing to occupy the settings page and model menu after refreshing.
  let next = providers.filter(
    (provider) =>
      provider.id !== RETIRED_ZAPI_PROVIDER_ID &&
      !(provider.id.startsWith("default-") && provider.apiKey.trim().length === 0),
  );

  // Migration boundaries only normalize values ​​that actually exist in the old file. Model Properties, Option Specs and
  // reasoning mapping is parsed in the Registry by ZCode Built-in/Personal ModelConfigRules;
  // The old Store can no longer replenish values from another Catalog by Model ID and persist the replenished values back to the user file.
  return next.map(normalizeProviderForStore);
}

/** Reads only from published legacy config.json; the even older standalone Provider Store has left every migration path. */
export async function readLegacyZCodeConfigProviders(): Promise<ModelProviderConfig[]> {
  const configProviders = await readZCodeConfigProviders();
  return configProviders ? filterDeletedProviderModelsForRead(configProviders) : [];
}

function filterDeletedProviderModelsForRead(
  providers: ModelProviderConfig[],
): ModelProviderConfig[] {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.filter(
      (model) => !isModelProviderModelConfig(model) || model.deleted !== true,
    ),
  }));
}

function resolveLegacyRuntimeBaseUrlForKind(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): string {
  const rawEndpoint =
    defaultKind === "anthropic" ? endpoints.anthropic?.trim() : endpoints.openai?.trim();
  if (rawEndpoint) {
    return normalizeModelProviderBaseUrlForKind(rawEndpoint, defaultKind);
  }
  const fallbackEndpoint = endpoints.anthropic?.trim() || endpoints.openai?.trim() || "";
  return fallbackEndpoint
    ? normalizeModelProviderBaseUrlForKind(fallbackEndpoint, defaultKind)
    : "";
}

function resolveRuntimeBaseUrlForStore(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): string {
  const runtimeBaseURL = resolveModelProviderRuntimeBaseUrl(
    {
      apiFormat: resolveModelProviderKindApiFormat(defaultKind),
      defaultKind,
      endpoints,
    },
    defaultKind,
  );
  if (runtimeBaseURL) {
    return runtimeBaseURL;
  }

  const baseURL = endpoints.baseURL?.trim();
  if (baseURL) {
    return normalizeModelProviderBaseUrlForKind(baseURL, defaultKind);
  }

  // The old store may still only have endpoints.anthropic/openai.
  // OpenCode runtime config can only save the baseURL of the current kind. Here, press defaultKind to get an old entry.
  return resolveLegacyRuntimeBaseUrlForKind(endpoints, defaultKind);
}

function normalizeEndpoints(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): ModelProviderEndpoints {
  const runtimeBaseURL = resolveRuntimeBaseUrlForStore(endpoints, defaultKind);
  if (!runtimeBaseURL) {
    return {};
  }
  return {
    baseURL: runtimeBaseURL,
    paths: {
      [defaultKind]: getDefaultModelProviderEndpointPathForKind(defaultKind),
    },
  };
}
