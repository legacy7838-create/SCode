/* eslint-disable max-lines -- The published legacy Provider store is modeled only at the one-way importer boundary. */
import { z } from "zod";

export interface ClaudeModelMapping {
  haiku: string;
  sonnet: string;
  opus: string;
  reasoning: string;
}

/**
 * Model slot mappings per ZCode Agent Provider (distinguished by provider).
 * Only claude is implemented for now; add fields here when other providers are added later.
 */
export interface ProviderModelMappings {
  [provider: string]: unknown;
  /** @deprecated The claude slot is no longer written to the v2 provider store; it is only used to migrate and clean up after reading legacy configuration. */
  claude?: ClaudeModelMapping;
}

export interface ModelProviderEndpoints {
  /** @deprecated Only used to read legacy provider configuration; the new store uses baseURL + paths. */
  anthropic?: string;
  /** @deprecated Only used to read legacy provider configuration; the new store uses baseURL + paths. */
  openai?: string;
  /** @deprecated Gemini custom providers have been unified onto endpoints.openai + compat; this field only remains for reading legacy data. */
  gemini?: string;
  /** v2 catalog endpoint base URL; the old field is kept for migration-period UI/connectivity code to read. */
  baseURL?: string;
  /** v2 catalog endpoint paths, keyed by the public runtime kind. */
  paths?: Partial<Record<ModelProviderKind, string>>;
}

export type ModelProviderSupportedFormat = "anthropic" | "openai" | "responses" | "gemini";

export type ModelProviderApiFormat =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export type ModelProviderCatalogSourceId = "china-llm-zcode-dev";

export type ModelProviderKind = "anthropic" | "openai" | "openai-compatible";

export type ModelProviderModality = "text" | "image" | "video" | "audio" | "pdf";

export interface ProviderOptionsPatch {
  set?: Array<{ path: string[]; value: unknown }>;
  unset?: Array<{ path: string[] }>;
}

export interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<string, Partial<Record<ModelProviderKind, ProviderOptionsPatch>>>;
}

export function stripModelProviderReasoningPatches(
  reasoning: ModelProviderReasoningSpec,
): ModelProviderReasoningSpec {
  return {
    ...(reasoning.defaultLevel ? { defaultLevel: reasoning.defaultLevel } : {}),
    levels: Object.fromEntries(Object.keys(reasoning.levels).map((level) => [level, {}])),
  };
}

export interface ModelProviderCatalogModel {
  id: string;
  name?: string;
  kinds: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  modalities: {
    input: ModelProviderModality[];
    output: ModelProviderModality[];
  };
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
}

export interface ModelProviderModelConfig extends ModelProviderCatalogModel {
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}

export type ModelProviderModelEntry = string | ModelProviderModelConfig;

export type ModelProviderSource = "builtin" | "models-dev" | "custom" | "workspace";

export type ModelProviderSystemDisabledReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled"
  | "oauth_provider_inactive";

export interface ModelProviderConfig {
  id: string;
  name: string;
  /** Absent means enabled; when false the provider is only hidden from the chat box model list, its configuration is not deleted. */
  enabled?: boolean;
  /**
   * Why the system turned the provider off automatically. When enabled=false and this field is
   * empty the user turned it off manually, and a later successful entitlement check must not
   * turn it back on automatically.
   */
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKey: string;
  apiKeyUrl?: string;
  models: ModelProviderModelEntry[];
  defaultKind?: ModelProviderKind;
  /** @deprecated The legacy model display-name map is only used for v1 automatic migration. */
  modelDisplayNames?: Record<string, string>;
  /** @deprecated The legacy model format map is only used for v1 automatic migration. */
  modelSupportedFormats?: Record<string, ModelProviderSupportedFormat[]>;
  providerMappings?: ProviderModelMappings;
  createdAt: number;
  updatedAt: number;
}

const claudeModelMappingSchema = z.object({
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
  reasoning: z.string(),
});

const providerModelMappingsSchema = z
  .object({
    claude: claudeModelMappingSchema.optional(),
  })
  .catchall(z.unknown());

const modelSupportedFormatSchema = z.enum(["anthropic", "openai", "responses", "gemini"]);

export const modelProviderApiFormatSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);

export const modelProviderKindSchema = z.enum(["anthropic", "openai", "openai-compatible"]);

export const modelProviderCatalogSourceIdSchema = z.enum(["china-llm-zcode-dev"]);

const modelProviderModalitySchema = z.enum(["text", "image", "video", "audio", "pdf"]);

const providerOptionsPatchOperationSchema = z.object({
  path: z.array(z.string().min(1)).min(1),
});

const providerOptionsPatchSchema = z.object({
  set: z.array(providerOptionsPatchOperationSchema.extend({ value: z.unknown() })).optional(),
  unset: z.array(providerOptionsPatchOperationSchema).optional(),
});

export const modelProviderReasoningSpecSchema = z.object({
  defaultLevel: z.string().min(1).optional(),
  levels: z.record(
    z.string().min(1),
    z.partialRecord(modelProviderKindSchema, providerOptionsPatchSchema),
  ),
});

const modelProviderEndpointPathsSchema = z.partialRecord(modelProviderKindSchema, z.string());

const modelProviderCatalogEndpointSchema = z.object({
  baseURL: z.string(),
  paths: modelProviderEndpointPathsSchema,
});

const modelProviderCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  kinds: z.array(modelProviderKindSchema),
  defaultKind: modelProviderKindSchema.optional(),
  modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
  modalities: z.object({
    input: z.array(modelProviderModalitySchema),
    output: z.array(modelProviderModalitySchema),
  }),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: modelProviderReasoningSpecSchema.optional(),
  priority: z.number().finite().optional(),
});

const modelProviderCatalogProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoints: modelProviderCatalogEndpointSchema,
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderCatalogModelSchema),
});

export const modelProviderCatalogFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v1"),
  providers: z.array(modelProviderCatalogProviderSchema),
});

const modelProviderModelConfigSchema = modelProviderCatalogModelSchema.extend({
  disabledReason: z.string().optional(),
  supportsTools: z.boolean().optional(),
  supportsStructuredOutput: z.boolean().optional(),
  modified: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export const modelProviderSourceSchema = z.enum(["builtin", "models-dev", "custom", "workspace"]);

export const modelProviderSystemDisabledReasonSchema = z.enum([
  "coding_plan_not_authenticated",
  "coding_plan_not_connected",
  "coding_plan_auth_failed",
  "coding_plan_not_entitled",
  "oauth_provider_inactive",
]);

const legacyModelProviderEndpointsSchema = z.object({
  anthropic: z.string().default(""),
  openai: z.string().default(""),
  gemini: z.string().default(""),
});

export const modelProviderEndpointsSchema = legacyModelProviderEndpointsSchema.extend({
  anthropic: z.string().optional(),
  openai: z.string().optional(),
  gemini: z.string().optional(),
  baseURL: z.string().optional(),
  paths: modelProviderEndpointPathsSchema.optional(),
});

const legacyModelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: legacyModelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  models: z.array(z.string()).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const legacyModelProviderListSchema = z.array(legacyModelProviderConfigSchema);

const modelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: modelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
  catalogProviderId: z.string().optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderModelConfigSchema).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const modelProviderListSchema = z.array(modelProviderConfigSchema);

export const modelProviderStoreFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v2"),
  providers: modelProviderListSchema,
});

export const modelProviderDisplayOrderStateSchema = z.object({
  providerIds: z.array(z.string().min(1)),
  updatedAt: z.number().int().nonnegative(),
});

export function stripLegacyClaudeProviderMappings(
  providerMappings: ProviderModelMappings | undefined,
): ProviderModelMappings | undefined {
  if (!providerMappings) {
    return undefined;
  }
  const { claude: _legacyClaudeMapping, ...remainingMappings } = providerMappings;
  // The v2 store no longer persists the old Claude slot, but providerMappings themselves are reserved for
  // Subsequent slot configuration of ZCode CLI and other providers; only the historical subfields are deleted here, and unknown subsequent keys are retained as they are.
  return remainingMappings;
}

export const MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW = 200_000;
// When old configuration and models lacking metadata do not have reliable catalog facts, new models should be added to the settings page.
// Use the same conservative default value to avoid 128k/200k divergence between agent registry and new UI models.
const LEGACY_MODEL_CONTEXT_WINDOW = MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW;

export function resolveModelProviderContextWindow(contextWindow: number | undefined): number {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
    return LEGACY_MODEL_CONTEXT_WINDOW;
  }

  const normalized = Math.floor(contextWindow);
  return normalized > 0 ? normalized : LEGACY_MODEL_CONTEXT_WINDOW;
}

export function isModelProviderModelConfig(
  model: ModelProviderModelEntry,
): model is ModelProviderModelConfig {
  return typeof model === "object" && model !== null;
}

export function getModelProviderModelIds(
  provider: Pick<ModelProviderConfig, "models"> | null | undefined,
): string[] {
  if (!provider) {
    return [];
  }

  return (
    provider.models
      // Model deletions are now persisted as tombstones in provider.models for persistence and remote merging;
      // All optional/delivered model directories must treat tombstone as if it does not exist, to prevent the chat box and CLI from continuing to see deleted models.
      .filter((model) => !isModelProviderModelConfig(model) || model.deleted !== true)
      .map((model) => (isModelProviderModelConfig(model) ? model.id.trim() : model.trim()))
      .filter((modelId) => modelId.length > 0)
  );
}

function uniqueModelProviderKinds(kinds: readonly ModelProviderKind[]): ModelProviderKind[] {
  return [...new Set(kinds)];
}

export function mapModelProviderSupportedFormatToKind(
  format: ModelProviderSupportedFormat,
): ModelProviderKind | null {
  switch (format) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai-compatible";
    case "responses":
      return "openai";
    case "gemini":
      return null;
  }
}

export function createModelProviderModelConfig(params: {
  id: string;
  name?: string;
  kinds?: readonly ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: {
    input?: readonly ModelProviderModality[];
    output?: readonly ModelProviderModality[];
  };
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}): ModelProviderModelConfig {
  const inputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.input ?? (["text"] satisfies ModelProviderModality[])),
  ];
  const outputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.output ?? (["text"] satisfies ModelProviderModality[])),
  ];
  return {
    id: params.id.trim(),
    name: params.name?.trim() || undefined,
    kinds: uniqueModelProviderKinds([...(params.kinds ?? [])]),
    ...(params.defaultKind ? { defaultKind: params.defaultKind } : {}),
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
    contextWindow: resolveModelProviderContextWindow(params.contextWindow),
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.priority !== undefined && Number.isFinite(params.priority)
      ? { priority: params.priority }
      : {}),
    ...(params.disabledReason ? { disabledReason: params.disabledReason } : {}),
    ...(params.supportsTools !== undefined ? { supportsTools: params.supportsTools } : {}),
    ...(params.supportsStructuredOutput !== undefined
      ? { supportsStructuredOutput: params.supportsStructuredOutput }
      : {}),
    ...(params.modified !== undefined ? { modified: params.modified } : {}),
    ...(params.deleted !== undefined ? { deleted: params.deleted } : {}),
  };
}

export function resolveModelProviderDefaultKind(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
): ModelProviderKind {
  if (provider.defaultKind) {
    return provider.defaultKind;
  }

  const paths = provider.endpoints.paths;
  if (paths?.["openai-compatible"] !== undefined) {
    return "openai-compatible";
  }
  if (paths?.openai !== undefined) {
    return "openai";
  }
  if (paths?.anthropic !== undefined) {
    return "anthropic";
  }

  const apiFormat = resolveModelProviderApiFormat(provider);
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

export function resolveModelProviderKindApiFormat(kind: ModelProviderKind): ModelProviderApiFormat {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
      return "openai-chat-completions";
  }
}

function mapModelProviderApiFormatToKind(apiFormat: ModelProviderApiFormat): ModelProviderKind {
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

export function getDefaultModelProviderEndpointPathForKind(kind: ModelProviderKind): string {
  switch (kind) {
    case "anthropic":
      return "/v1/messages";
    case "openai":
      return "/responses";
    case "openai-compatible":
      return "/chat/completions";
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function collapseDuplicatedAbsoluteRuntimeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return normalized;
    }
    const marker = `${parsed.protocol}//${parsed.host}`;
    const secondMarkerIndex = normalized.indexOf(marker, marker.length);
    if (secondMarkerIndex < 0) {
      return normalized;
    }

    const firstUrl = normalized.slice(0, secondMarkerIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(secondMarkerIndex).replace(/\/+$/, "");
    if (firstUrl === secondUrl) {
      // When saving the old settings page, you may spell the runtime baseURL as path again.
      // Form https://host/path/https://host/path; only completely duplicate safe forms are collapsed here.
      return firstUrl;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

function joinBaseUrlAndPath(baseURL: string, path: string): string {
  const trimmedBase = baseURL.trim();
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return trimmedBase;
  }
  if (isAbsoluteHttpUrl(trimmedPath)) {
    // Old endpoints.paths may have been saved as the full runtime baseURL.
    // In this case, endpoints.baseURL cannot be superimposed, otherwise a duplicate URL will be written back.
    return trimmedPath;
  }
  if (!trimmedBase) {
    return trimmedPath;
  }
  if (trimmedBase.endsWith("/") && trimmedPath.startsWith("/")) {
    return `${trimmedBase.slice(0, -1)}${trimmedPath}`;
  }
  if (!trimmedBase.endsWith("/") && !trimmedPath.startsWith("/")) {
    return `${trimmedBase}/${trimmedPath}`;
  }
  return `${trimmedBase}${trimmedPath}`;
}

export function normalizeModelProviderBaseUrlForKind(
  baseURL: string,
  kind: ModelProviderKind,
): string {
  const suffixes: Record<ModelProviderKind, string[]> = {
    anthropic: ["/v1/messages", "/messages"],
    // The SDK baseURL for OpenAI Responses usually contains /v1, and only /responses will be appended at runtime.
    // The entire /v1/responses cannot be stripped off, otherwise the user’s https://host/v1 will be displayed/replaced as https://host.
    openai: ["/responses"],
    "openai-compatible": ["/chat/completions"],
  };
  let normalized = normalizeModelProviderConfiguredBaseUrl(baseURL);
  for (const suffix of suffixes[kind]) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized.replace(/\/+$/, "");
}

export function normalizeModelProviderConfiguredBaseUrl(baseURL: string): string {
  // The Base URL of the settings page and config.json is an explicit configuration value by the user and cannot be in API format.
  // Automatically delete path segments such as /v1, /responses or /chat/completions; only safe duplicate URL folding and closing cleanup are done here.
  return collapseDuplicatedAbsoluteRuntimeBaseUrl(baseURL).replace(/\/+$/, "");
}

export function resolveModelProviderRuntimeBaseUrl(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
  kind = mapModelProviderApiFormatToKind(resolveModelProviderApiFormat(provider)),
): string {
  const baseURL = provider.endpoints.baseURL?.trim() ?? "";
  const paths = provider.endpoints.paths ?? {};
  if (!provider.endpoints.baseURL?.trim() && !provider.endpoints.paths) {
    return "";
  }
  // baseURL is just a public prefix, only paths of explicitly declared kind represent available protocols.
  // Otherwise the OpenAI-only provider will be incorrectly detected/synchronized to be available for Anthropic.
  if (paths[kind] === undefined) {
    return "";
  }
  // catalog's baseURL + path represents the complete request address, while OpenAI/Anthropic
  // The runtime SDK receives the API base URL and appends /chat/completions, /responses or /messages on its own.
  // If the complete request address is directly transmitted, the actual transmission will be spelled .../chat/completions/chat/completions.
  return normalizeModelProviderBaseUrlForKind(joinBaseUrlAndPath(baseURL, paths[kind] ?? ""), kind);
}

function pathFromModelProviderEndpointUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${path}${url.search}`;
}

function buildEndpointsFromLegacyRuntimeBaseUrls(
  entries: Array<[ModelProviderKind, string]>,
): ModelProviderEndpoints {
  const normalizedEntries = entries.flatMap(([kind, rawUrl]) => {
    const url = normalizeModelProviderBaseUrlForKind(rawUrl, kind);
    return url ? [{ kind, url }] : [];
  });
  if (normalizedEntries.length === 0) {
    return {};
  }

  const parsedEntries = normalizedEntries.map((entry) => {
    try {
      return { ...entry, parsed: new URL(entry.url) };
    } catch {
      return { ...entry, parsed: null };
    }
  });
  const firstParsed = parsedEntries[0]?.parsed;
  const canShareOrigin =
    firstParsed && parsedEntries.every((entry) => entry.parsed?.origin === firstParsed.origin);

  return {
    ...(canShareOrigin ? { baseURL: firstParsed.origin } : {}),
    paths: Object.fromEntries(
      parsedEntries.map((entry) => [
        entry.kind,
        canShareOrigin && entry.parsed ? pathFromModelProviderEndpointUrl(entry.parsed) : entry.url,
      ]),
    ) as Partial<Record<ModelProviderKind, string>>,
  };
}

function resolveLegacyModelProviderDefaultKind(
  provider: Pick<z.infer<typeof legacyModelProviderConfigSchema>, "apiFormat" | "endpoints">,
): ModelProviderKind {
  switch (provider.apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
    case undefined:
      break;
  }

  if (provider.endpoints.anthropic?.trim()) {
    return "anthropic";
  }
  if (provider.endpoints.openai?.trim()) {
    return "openai-compatible";
  }
  return "anthropic";
}

function getDefaultModelSupportedFormatsFromLegacyEndpoints(
  endpoints: Pick<ModelProviderEndpoints, "anthropic" | "openai">,
): ModelProviderSupportedFormat[] {
  const formats: ModelProviderSupportedFormat[] = [];
  if (endpoints.anthropic?.trim()) {
    formats.push("anthropic");
  }
  if (endpoints.openai?.trim()) {
    formats.push("openai");
  }
  return formats;
}

export function migrateLegacyModelProviderConfig(
  provider: z.infer<typeof legacyModelProviderConfigSchema>,
): ModelProviderConfig {
  const defaultKind = resolveLegacyModelProviderDefaultKind(provider);
  // The old provider may be configured with Anthropic and OpenAI at the same time. During the migration phase, the historical path will be retained first.
  // Subsequent service layer storage boundaries will converge to a single kind according to the OpenCode runtime config.
  const legacyEntries: Array<[ModelProviderKind, string]> = [];
  const anthropicEndpoint = provider.endpoints.anthropic?.trim();
  if (anthropicEndpoint) {
    legacyEntries.push(["anthropic", anthropicEndpoint]);
  }
  const openaiEndpoint = provider.endpoints.openai?.trim();
  if (openaiEndpoint) {
    legacyEntries.push([defaultKind === "openai" ? "openai" : "openai-compatible", openaiEndpoint]);
  }
  const endpoints = buildEndpointsFromLegacyRuntimeBaseUrls(legacyEntries);
  const migratedModels = provider.models.map((modelId) => {
    const formats =
      provider.modelSupportedFormats?.[modelId] ??
      (provider.apiFormat
        ? getDefaultModelSupportedFormatsFromApiFormat(provider.apiFormat)
        : getDefaultModelSupportedFormatsFromLegacyEndpoints(provider.endpoints));
    const kinds = uniqueModelProviderKinds(
      formats.flatMap((format) => {
        const kind = mapModelProviderSupportedFormatToKind(format);
        return kind ? [kind] : [];
      }),
    );
    const disabledReason =
      kinds.length === 0 && formats.includes("gemini")
        ? "legacy gemini format is not supported by zcode.model-providers.v2"
        : undefined;

    return createModelProviderModelConfig({
      id: modelId,
      name: provider.modelDisplayNames?.[modelId],
      kinds,
      defaultKind: kinds.includes(defaultKind) ? defaultKind : kinds[0],
      disabledReason,
    });
  });

  return {
    id: provider.id,
    name: provider.name,
    ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
    ...(provider.systemDisabledReason
      ? { systemDisabledReason: provider.systemDisabledReason }
      : {}),
    endpoints,
    apiFormat: provider.apiFormat,
    source: provider.source,
    modelsDevProviderId: provider.modelsDevProviderId,
    apiKeyRequired: provider.apiKeyRequired,
    headers: provider.headers,
    logoUrl: provider.logoUrl,
    apiKey: provider.apiKey,
    apiKeyUrl: provider.apiKeyUrl,
    defaultKind,
    models: migratedModels,
    providerMappings: stripLegacyClaudeProviderMappings(provider.providerMappings),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export function getDefaultModelSupportedFormatsFromEndpoints(
  endpoints: Partial<
    Pick<ModelProviderEndpoints, "anthropic" | "openai" | "gemini" | "baseURL" | "paths">
  >,
): ModelProviderSupportedFormat[] {
  const formats: ModelProviderSupportedFormat[] = [];
  const paths = endpoints.paths;
  if (endpoints.baseURL?.trim() || paths) {
    if (paths?.anthropic !== undefined) {
      formats.push("anthropic");
    }
    if (paths?.["openai-compatible"] !== undefined) {
      formats.push("openai");
    }
    if (paths?.openai !== undefined) {
      formats.push("responses");
    }
    return formats;
  }
  return [];
}

export function getDefaultModelSupportedFormatsFromApiFormat(
  apiFormat: ModelProviderApiFormat,
): ModelProviderSupportedFormat[] {
  switch (apiFormat) {
    case "anthropic-messages":
      return ["anthropic"];
    case "openai-responses":
      return ["responses"];
    case "openai-chat-completions":
      return ["openai"];
  }
}

export function resolveModelProviderApiFormat(
  provider: Pick<ModelProviderConfig, "apiFormat" | "endpoints"> &
    Partial<Pick<ModelProviderConfig, "defaultKind">>,
): ModelProviderApiFormat {
  if (
    provider.apiFormat === "anthropic-messages" ||
    provider.apiFormat === "openai-chat-completions" ||
    provider.apiFormat === "openai-responses"
  ) {
    return provider.apiFormat;
  }

  if (provider.defaultKind) {
    return resolveModelProviderKindApiFormat(provider.defaultKind);
  }

  // Old migration data may declare multiple protocols at the same time without explicit defaultKind/apiFormat
  // Still prioritize the Anthropic-compatible main link to avoid the Claude semantic provider from being mistakenly switched to OpenAI.
  if (provider.endpoints.paths?.anthropic !== undefined) {
    return "anthropic-messages";
  }

  if (provider.endpoints.paths?.openai !== undefined) {
    return "openai-responses";
  }

  if (provider.endpoints.paths?.["openai-compatible"] !== undefined) {
    return "openai-chat-completions";
  }

  return "anthropic-messages";
}

/** Connectivity test error classification */
