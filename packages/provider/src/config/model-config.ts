/* oxlint-disable eslint(max-lines) -- Model Config, the nested Overlay and the ordered rules together define one domain type; not splitting them apart for the line count for now. */
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeEnumOptionSpecDataSchema,
  completeLimitOptionSpecDataSchema,
  completeModelInputFormatDataSchema,
  completeModelOutputFormatDataSchema,
  completeModelPropertiesDataSchema,
  completeModelOptionSpecsDataSchema,
  completeModelConfigDataSchema,
  type enumOptionSpecDataSchema,
  type limitOptionSpecDataSchema,
  type modelInputFormatDataSchema,
  type modelOutputFormatDataSchema,
  type modelPropertiesDataSchema,
  type modelOptionSpecsDataSchema,
  type modelConfigDataSchema,
} from "@zcode/shared/model-config";
import { validateConfigSchema } from "./schema-validation.js";
import { clearManualModelConfig } from "./manual-model-config.js";
import {
  providerModelConfigRuleSchema,
  manualProviderModelConfigRuleSchema,
  personalModelConfigRulesSchema,
  builtinModelConfigRulesSchema,
  type ProviderModelConfigRuleData,
  type ManualProviderModelConfigRuleData,
  type TemplateModelConfigRuleData,
  type ModelMatchConfigRuleData,
  type ModelApiMatchConfigRuleData,
  type ProviderSiteMatchConfigRuleData,
  type BuiltinModelConfigRulesData,
  type PersonalModelConfigRulesData,
} from "./rule-data-schema.js";

export type EnumOptionSpec = Readonly<z.infer<typeof completeEnumOptionSpecDataSchema>>;

export type LimitOptionSpec = Readonly<z.infer<typeof completeLimitOptionSpecDataSchema>>;

export type EnumOptionSpecConfigInput = Readonly<z.infer<typeof enumOptionSpecDataSchema>>;

export class EnumOptionSpecConfig extends ConfigOverlay<EnumOptionSpecConfig> {
  readonly values?: EnumOptionSpecConfigInput["values"];
  readonly map?: EnumOptionSpecConfigInput["map"];

  constructor(input: EnumOptionSpecConfigInput = {}) {
    super();
    this.values =
      input.values === undefined
        ? undefined
        : input.values === null
          ? null
          : Object.freeze([...input.values]);
    this.map = input.map;
    Object.freeze(this);
  }

  overlay(next: EnumOptionSpecConfig): EnumOptionSpecConfig {
    return new EnumOptionSpecConfig({
      values: this.overlayValue(this.values, next.values),
      map: this.overlayValue(this.map, next.map),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeEnumOptionSpecDataSchema, this.toJSON(), path, true);
  }

  toJSON(): EnumOptionSpecConfigInput {
    return objectWithoutUndefined({
      values: this.values,
      map: this.map,
    });
  }
}

export type LimitOptionSpecConfigInput = Readonly<z.infer<typeof limitOptionSpecDataSchema>>;

export class LimitOptionSpecConfig extends ConfigOverlay<LimitOptionSpecConfig> {
  readonly max?: LimitOptionSpecConfigInput["max"];
  readonly map?: LimitOptionSpecConfigInput["map"];

  constructor(input: LimitOptionSpecConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: LimitOptionSpecConfig): LimitOptionSpecConfig {
    return new LimitOptionSpecConfig({
      max: this.overlayValue(this.max, next.max),
      map: this.overlayValue(this.map, next.map),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeLimitOptionSpecDataSchema, this.toJSON(), path, true);
  }

  toJSON(): LimitOptionSpecConfigInput {
    return objectWithoutUndefined({
      max: this.max,
      map: this.map,
    });
  }
}

export type ModelPropertiesConfigInput = Readonly<z.infer<typeof modelPropertiesDataSchema>>;

export type ModelInputFormatConfigInput = Readonly<z.infer<typeof modelInputFormatDataSchema>>;

export class ModelInputFormatConfig extends ConfigOverlay<ModelInputFormatConfig> {
  readonly supportsText?: ModelInputFormatConfigInput["supportsText"];
  readonly supportsImage?: ModelInputFormatConfigInput["supportsImage"];
  readonly supportsVideo?: ModelInputFormatConfigInput["supportsVideo"];
  readonly supportsAudio?: ModelInputFormatConfigInput["supportsAudio"];
  readonly supportsPdf?: ModelInputFormatConfigInput["supportsPdf"];

  constructor(input: ModelInputFormatConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: ModelInputFormatConfig): ModelInputFormatConfig {
    return new ModelInputFormatConfig({
      supportsText: this.overlayValue(this.supportsText, next.supportsText),
      supportsImage: this.overlayValue(this.supportsImage, next.supportsImage),
      supportsVideo: this.overlayValue(this.supportsVideo, next.supportsVideo),
      supportsAudio: this.overlayValue(this.supportsAudio, next.supportsAudio),
      supportsPdf: this.overlayValue(this.supportsPdf, next.supportsPdf),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelInputFormatDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelInputFormatConfigInput {
    return objectWithoutUndefined({
      supportsText: this.supportsText,
      supportsImage: this.supportsImage,
      supportsVideo: this.supportsVideo,
      supportsAudio: this.supportsAudio,
      supportsPdf: this.supportsPdf,
    });
  }
}

export type ModelOutputFormatConfigInput = Readonly<z.infer<typeof modelOutputFormatDataSchema>>;

export class ModelOutputFormatConfig extends ConfigOverlay<ModelOutputFormatConfig> {
  readonly supportsText?: ModelOutputFormatConfigInput["supportsText"];

  constructor(input: ModelOutputFormatConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: ModelOutputFormatConfig): ModelOutputFormatConfig {
    return new ModelOutputFormatConfig({
      supportsText: this.overlayValue(this.supportsText, next.supportsText),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelOutputFormatDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelOutputFormatConfigInput {
    return objectWithoutUndefined({ supportsText: this.supportsText });
  }
}

export class ModelPropertiesConfig extends ConfigOverlay<ModelPropertiesConfig> {
  readonly requiresMfjsToolSchema?: ModelPropertiesConfigInput["requiresMfjsToolSchema"];
  readonly contextWindow?: ModelPropertiesConfigInput["contextWindow"];
  readonly inputFormat?: ModelInputFormatConfig | null;
  readonly outputFormat?: ModelOutputFormatConfig | null;
  readonly supportsToolCall?: ModelPropertiesConfigInput["supportsToolCall"];
  readonly supportsJsonSchemaOutput?: ModelPropertiesConfigInput["supportsJsonSchemaOutput"];
  readonly supportsNativeWebSearch?: ModelPropertiesConfigInput["supportsNativeWebSearch"];
  readonly supportsMidConversationSystem?: ModelPropertiesConfigInput["supportsMidConversationSystem"];

  constructor(input: ModelPropertiesConfigInput = {}) {
    super();
    Object.assign(this, {
      ...input,
      inputFormat:
        input.inputFormat instanceof ModelInputFormatConfig || input.inputFormat == null
          ? input.inputFormat
          : new ModelInputFormatConfig(input.inputFormat),
      outputFormat:
        input.outputFormat instanceof ModelOutputFormatConfig || input.outputFormat == null
          ? input.outputFormat
          : new ModelOutputFormatConfig(input.outputFormat),
    });
    Object.freeze(this);
  }

  overlay(next: ModelPropertiesConfig): ModelPropertiesConfig {
    return new ModelPropertiesConfig({
      requiresMfjsToolSchema: this.overlayValue(
        this.requiresMfjsToolSchema,
        next.requiresMfjsToolSchema,
      ),
      contextWindow: this.overlayValue(this.contextWindow, next.contextWindow),
      inputFormat: this.overlayConfig(this.inputFormat, next.inputFormat),
      outputFormat: this.overlayConfig(this.outputFormat, next.outputFormat),
      supportsToolCall: this.overlayValue(this.supportsToolCall, next.supportsToolCall),
      supportsJsonSchemaOutput: this.overlayValue(
        this.supportsJsonSchemaOutput,
        next.supportsJsonSchemaOutput,
      ),
      supportsNativeWebSearch: this.overlayValue(
        this.supportsNativeWebSearch,
        next.supportsNativeWebSearch,
      ),
      supportsMidConversationSystem: this.overlayValue(
        this.supportsMidConversationSystem,
        next.supportsMidConversationSystem,
      ),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelPropertiesDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelPropertiesConfigInput {
    return objectWithoutUndefined({
      requiresMfjsToolSchema: this.requiresMfjsToolSchema,
      contextWindow: this.contextWindow,
      inputFormat: this.inputFormat?.toJSON() ?? this.inputFormat,
      outputFormat: this.outputFormat?.toJSON() ?? this.outputFormat,
      supportsToolCall: this.supportsToolCall,
      supportsJsonSchemaOutput: this.supportsJsonSchemaOutput,
      supportsNativeWebSearch: this.supportsNativeWebSearch,
      supportsMidConversationSystem: this.supportsMidConversationSystem,
    });
  }
}

export type ModelOptionSpecsConfigInput = Readonly<z.infer<typeof modelOptionSpecsDataSchema>>;

export class ModelOptionSpecsConfig extends ConfigOverlay<ModelOptionSpecsConfig> {
  readonly reasoningLevel?: EnumOptionSpecConfig | null;
  readonly maxOutputTokens?: LimitOptionSpecConfig | null;

  constructor(input: ModelOptionSpecsConfigInput = {}) {
    super();
    this.reasoningLevel = toEnumOptionSpecConfig(input.reasoningLevel);
    this.maxOutputTokens = toLimitOptionSpecConfig(input.maxOutputTokens);
    Object.freeze(this);
  }

  overlay(next: ModelOptionSpecsConfig): ModelOptionSpecsConfig {
    return new ModelOptionSpecsConfig({
      reasoningLevel: this.overlayConfig(this.reasoningLevel, next.reasoningLevel),
      maxOutputTokens: this.overlayConfig(this.maxOutputTokens, next.maxOutputTokens),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelOptionSpecsDataSchema, this.toJSON(), path, true);
  }

  toJSON(): ModelOptionSpecsConfigInput {
    return objectWithoutUndefined({
      reasoningLevel: this.reasoningLevel?.toJSON() ?? this.reasoningLevel,
      maxOutputTokens: this.maxOutputTokens?.toJSON() ?? this.maxOutputTokens,
    });
  }
}

export type ModelConfigInput = Omit<ModelConfigObject, "properties" | "optionSpecs"> & {
  readonly properties?: ModelPropertiesConfig | null;
  readonly optionSpecs?: ModelOptionSpecsConfig | null;
};

export type ModelConfigObject = Readonly<z.infer<typeof modelConfigDataSchema>>;

export class ModelConfig extends ConfigOverlay<ModelConfig> {
  readonly enabled?: ModelConfigObject["enabled"];
  readonly properties?: ModelPropertiesConfig | null;
  readonly optionSpecs?: ModelOptionSpecsConfig | null;

  constructor(input: ModelConfigInput = {}) {
    super();
    this.enabled = input.enabled;
    this.properties = input.properties;
    this.optionSpecs = input.optionSpecs;
    Object.freeze(this);
  }

  static empty(): ModelConfig {
    return new ModelConfig();
  }

  static fromData(config: ModelConfigObject): ModelConfig {
    return new ModelConfig({
      enabled: config.enabled,
      properties:
        config.properties == null
          ? config.properties
          : new ModelPropertiesConfig(config.properties),
      optionSpecs:
        config.optionSpecs == null
          ? config.optionSpecs
          : new ModelOptionSpecsConfig(config.optionSpecs),
    });
  }

  overlay(next: ModelConfig): ModelConfig {
    return new ModelConfig({
      enabled: this.overlayValue(this.enabled, next.enabled),
      properties: this.overlayConfig(this.properties, next.properties),
      optionSpecs: this.overlayConfig(this.optionSpecs, next.optionSpecs),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelConfigDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelConfigObject {
    return objectWithoutUndefined({
      enabled: this.enabled,
      properties: this.properties?.toJSON() ?? this.properties,
      optionSpecs: this.optionSpecs?.toJSON() ?? this.optionSpecs,
    });
  }
}

type RuleWithConfig<T> = Readonly<Omit<T, "config"> & { config: ModelConfig }>;
export type ProviderModelConfigRule = RuleWithConfig<ProviderModelConfigRuleData>;
export type ManualProviderModelConfigRule = RuleWithConfig<ManualProviderModelConfigRuleData>;
export type TemplateModelConfigRule = RuleWithConfig<TemplateModelConfigRuleData>;
export type ModelMatchConfigRule = RuleWithConfig<ModelMatchConfigRuleData>;
export type ModelApiMatchConfigRule = RuleWithConfig<ModelApiMatchConfigRuleData>;
export type ProviderSiteMatchConfigRule = RuleWithConfig<ProviderSiteMatchConfigRuleData>;

/** `type` only marks which layer an in-memory execution rule came from and is never written to the config file; grouping must no longer guess from which fields are present. */
export type ModelConfigRule =
  | (ProviderModelConfigRule & { readonly type: "provider-model" })
  | (ManualProviderModelConfigRule & { readonly type: "manual-provider-model" })
  | (TemplateModelConfigRule & { readonly type: "template-model" })
  | (ModelMatchConfigRule & { readonly type: "model" })
  | (ModelApiMatchConfigRule & { readonly type: "model-api" })
  | (ProviderSiteMatchConfigRule & { readonly type: "provider-site" });
type ExactModelConfigRule = Extract<
  ModelConfigRule,
  { type: "provider-model" | "manual-provider-model" }
>;

export interface ModelConfigRuleResolutionInput {
  readonly providerId: string;
  readonly templateId?: string | null;
  readonly modelId: string;
  readonly apiType?: string | null;
  readonly baseUrl?: string | null;
}

export class ModelConfigRules {
  readonly #rules: readonly ModelConfigRule[];

  constructor(rules: readonly ModelConfigRule[] = []) {
    this.#rules = Object.freeze(rules.map((rule) => Object.freeze({ ...rule })));
    Object.freeze(this);
  }

  static empty(): ModelConfigRules {
    return new ModelConfigRules();
  }

  /** Built-in keeps its original hierarchy and in-group order; Personal only contains plain/manual exact rules. */
  static composeEffective(builtin: ModelConfigRules, personal: ModelConfigRules): ModelConfigRules {
    return new ModelConfigRules([...builtin.rules(), ...personal.rules().filter(isExactModelRule)]);
  }

  rules(): readonly ModelConfigRule[] {
    return this.#rules;
  }

  resolve(input: ModelConfigRuleResolutionInput): ModelConfig {
    let result = ModelConfig.empty();
    const baseUrl = input.baseUrl == null ? undefined : normalizeBaseURLForRuleMatch(input.baseUrl);
    for (const rule of this.#rules) {
      if (isExactModelRule(rule)) {
        if (rule.providerId !== input.providerId || rule.modelId !== input.modelId) continue;
        // Manual rules require all editable leaves to be complete and therefore can be overridden directly; system leaves continue from the rules of the current identity.
        // Clearing the entire baseline will both lose the system mapping and force the UI to copy the old model's hidden configuration into the personal rules.
        result = (
          rule.type === "manual-provider-model"
            ? ModelConfig.fromData(clearManualModelConfig(result.toJSON()))
            : result
        ).overlay(rule.config);
        continue;
      }
      if (rule.type === "template-model") {
        if (rule.templateId === input.templateId && rule.modelId === input.modelId)
          result = result.overlay(rule.config);
        continue;
      }
      // Only the recommendation rule matching is relaxed, and the model ID in the actual request is not changed.
      if (!matchesRule(rule.modelMatch, input.modelId, true)) continue;
      if (
        (rule.type === "model-api" || rule.type === "provider-site") &&
        rule.apiTypeMatch !== undefined
      ) {
        if (input.apiType == null || !matchesRule(rule.apiTypeMatch, input.apiType)) continue;
      }
      if (
        rule.type === "provider-site" &&
        (baseUrl === undefined || !matchesRule(rule.baseUrlMatch, baseUrl))
      )
        continue;
      result = result.overlay(rule.config);
    }
    return result;
  }

  setExact(
    providerId: string,
    modelId: string,
    config: ModelConfig,
    useRecommendedConfig?: boolean,
  ): ModelConfigRules {
    const previous = this.getExactRule(providerId, modelId);
    const manual =
      useRecommendedConfig === undefined
        ? previous?.type === "manual-provider-model"
        : !useRecommendedConfig;
    // Save the entry to reuse the entire rule schema without writing another "complete but ignore enabled" check.
    const data = { providerId, modelId, config: config.toJSON() };
    (manual ? manualProviderModelConfigRuleSchema : providerModelConfigRuleSchema).parse(data);
    const replacement: ExactModelConfigRule = {
      type: manual ? "manual-provider-model" : "provider-model",
      providerId,
      modelId,
      config,
    };
    const result: ModelConfigRule[] = [];
    let replaced = false;
    for (const rule of this.#rules) {
      if (isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === modelId) {
        if (!replaced) result.push(replacement);
        replaced = true;
      } else {
        result.push(rule);
      }
    }
    if (!replaced) result.push(replacement);
    return new ModelConfigRules(result);
  }

  deleteExact(providerId: string, modelId: string): ModelConfigRules {
    return new ModelConfigRules(
      this.#rules.filter(
        (rule) =>
          !isExactModelRule(rule) || rule.providerId !== providerId || rule.modelId !== modelId,
      ),
    );
  }

  renameExactModel(
    providerId: string,
    currentModelId: string,
    nextModelId: string,
  ): ModelConfigRules {
    if (currentModelId === nextModelId) return this;
    return new ModelConfigRules(
      this.#rules.map((rule) =>
        isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === currentModelId
          ? { ...rule, modelId: nextModelId }
          : rule,
      ),
    );
  }

  deleteExactForProvider(providerId: string): ModelConfigRules {
    return new ModelConfigRules(
      this.#rules.filter((rule) => !isExactModelRule(rule) || rule.providerId !== providerId),
    );
  }

  getExact(providerId: string, modelId: string): ModelConfig | undefined {
    let result: ModelConfig | undefined;
    for (const rule of this.#rules) {
      if (!isExactModelRule(rule) || rule.providerId !== providerId || rule.modelId !== modelId)
        continue;
      result = result ? result.overlay(rule.config) : rule.config;
    }
    return result;
  }

  getExactRule(providerId: string, modelId: string): ExactModelConfigRule | undefined {
    for (let index = this.#rules.length - 1; index >= 0; index -= 1) {
      const rule = this.#rules[index]!;
      if (isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === modelId)
        return rule;
    }
    return undefined;
  }

  toZCodeBuiltinJSON(): BuiltinModelConfigRulesData {
    return builtinModelConfigRulesSchema.parse({
      modelRules: this.#collect("model"),
      modelApiRules: this.#collect("model-api"),
      providerSiteRules: this.#collect("provider-site"),
      templateModelRules: this.#collect("template-model"),
      builtinProviderModelRules: this.#collect("provider-model"),
    });
  }

  toPersonalJSON(): PersonalModelConfigRulesData {
    // Complete rules must be rechecked at encoding boundaries, and incomplete manual values ​​constructed directly cannot be written to the file.
    return personalModelConfigRulesSchema.parse({
      providerModelRules: this.#collect("provider-model"),
      manualProviderModelRules: this.#collect("manual-provider-model"),
    });
  }

  toJSON() {
    return {
      ...this.toZCodeBuiltinJSON(),
      manualProviderModelRules: this.#collect("manual-provider-model"),
    };
  }

  #collect<T extends ModelConfigRule["type"]>(type: T) {
    return this.#rules
      .filter((rule): rule is Extract<ModelConfigRule, { type: T }> => rule.type === type)
      .map(({ type: _type, config, ...identity }) => ({ ...identity, config: config.toJSON() }));
  }
}

function isExactModelRule(rule: ModelConfigRule): rule is ExactModelConfigRule {
  return rule.type === "provider-model" || rule.type === "manual-provider-model";
}

function matchesRule(pattern: string, value: string, ignoreCase = false): boolean {
  return new RegExp(`^(?:${pattern})$`, ignoreCase ? "i" : undefined).test(value);
}

function normalizeBaseURLForRuleMatch(value: string): string | undefined {
  try {
    // Host case, default port, and trailing slash should not change configuration hits; URL parser preserves path/query case.
    const parsed = new URL(value);
    const suffix = `${parsed.search}${parsed.hash}`;
    const serialized = parsed.toString();
    const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length);
    return `${endpoint.replace(/\/+$/, "")}${suffix}`;
  } catch {
    return undefined;
  }
}

function toEnumOptionSpecConfig(
  spec: EnumOptionSpecConfig | EnumOptionSpecConfigInput | null | undefined,
): EnumOptionSpecConfig | null | undefined {
  return spec instanceof EnumOptionSpecConfig || spec == null
    ? spec
    : new EnumOptionSpecConfig(spec);
}

function toLimitOptionSpecConfig(
  spec: LimitOptionSpecConfig | LimitOptionSpecConfigInput | null | undefined,
): LimitOptionSpecConfig | null | undefined {
  return spec instanceof LimitOptionSpecConfig || spec == null
    ? spec
    : new LimitOptionSpecConfig(spec);
}

function objectWithoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;
}
