/* oxlint-disable eslint(max-lines) -- the atomic config lifecycle of Provider/Model shares a single Repository update boundary; splitting it would duplicate ordering and normalization logic. */
import type {
  ModelConfigRules,
  ModelId,
  ProviderConfig,
  ProviderId,
  ProviderTemplateId,
  ProviderConfigRule,
  ProviderTemplateLocale,
} from "./config/index.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ProviderConfigMap,
  ProviderConfig as ProviderConfigValue,
  ProviderTemplateMap,
  resolveProviderTemplateName,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderConfigSnapshot, ProviderSource } from "./sources.js";

export interface ProviderConfigLayerSnapshot {
  readonly revision: string;
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface ProviderConfigLayerUpdate {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface PersonalProviderConfigRepository extends ProviderSource<ProviderConfigLayerSnapshot> {
  update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot>;
}

export interface ProviderConfigServiceDependencies {
  readonly zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly personalRepository: PersonalProviderConfigRepository;
}

export interface PersonalProviderCreation {
  readonly providerId: ProviderId;
}

export interface CreatePersonalProviderInput {
  readonly templateId?: ProviderTemplateId;
  readonly providerName?: string;
  readonly locale?: ProviderTemplateLocale;
  readonly initialConfig?: ProviderConfig;
}

/** Host-internal membership facts surfaced by the Facade; a renderer-supplied model list must never be accepted. */
export interface ProviderModelMembership {
  readonly providerId: ProviderId;
  readonly inheritedModelIds: readonly ModelId[];
  readonly personalRevision: string;
  /** Checks inside the Personal transaction that the published snapshot is not stale; triggers no network request. */
  readonly assertCurrent: () => void;
}

function assertMembershipCurrent(
  membership: ProviderModelMembership | undefined,
  providerId: ProviderId,
  current: ProviderConfigLayerSnapshot,
): void {
  if (!membership) return;
  membership.assertCurrent();
  if (membership.providerId !== providerId || membership.personalRevision !== current.revision) {
    throw new Error("Provider Settings membership revision conflict");
  }
}

/** The Personal root record is only an overlay, not a basis for the Provider's existence; simply inherit from the Provider to create overrides as needed. */
function writableProviderOverlay(
  builtin: ProviderConfigLayerSnapshot,
  current: ProviderConfigLayerSnapshot,
  providerId: ProviderId,
): ProviderConfig {
  const provider = current.providers.get(providerId);
  if (provider) return provider;
  if (builtin.providers.has(providerId)) return new ProviderConfigValue({});
  // A deleted custom/template instance does not inherit the Provider identity, and late operations cannot revive it.
  throw new Error(`Provider does not exist: ${providerId}`);
}

export class ProviderConfigService implements ProviderSource<ProviderConfigSnapshot> {
  readonly #zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly #personalRepository: PersonalProviderConfigRepository;
  readonly #listeners = new Set<(reason: string) => void>();
  readonly #sourceDisposers: Array<() => void>;
  #disposed = false;

  constructor(dependencies: ProviderConfigServiceDependencies) {
    this.#zcodeBuiltinSource = dependencies.zcodeBuiltinSource;
    this.#personalRepository = dependencies.personalRepository;
    this.#sourceDisposers = [
      this.#zcodeBuiltinSource.onDidChange((reason) => this.#emit(`zcodeBuiltin:${reason}`)),
      this.#personalRepository.onDidChange((reason) => this.#emit(`personal:${reason}`)),
    ];
  }

  async read(): Promise<ProviderConfigSnapshot> {
    this.#assertNotDisposed();
    const [zcodeBuiltin, personal] = await Promise.all([
      this.#zcodeBuiltinSource.read(),
      this.#personalRepository.read(),
    ]);
    return Object.freeze({
      revision: JSON.stringify([zcodeBuiltin.revision, personal.revision]),
      zcodeBuiltinRevision: zcodeBuiltin.revision,
      personalRevision: personal.revision,
      zcodeBuiltinProviders: zcodeBuiltin.providers,
      zcodeBuiltinProviderTemplates: zcodeBuiltin.providerTemplates ?? ProviderTemplateMap.empty(),
      personalProviders: personal.providers,
      zcodeBuiltinModelRules: zcodeBuiltin.models,
      personalModels: personal.models,
      personalProviderOrder: personal.providerOrder ?? [],
    });
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Atomically replaces the complete Personal Overlay; for version migrations or a source-of-truth cutover only. */
  replacePersonalConfig(config: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    // Full import/distribution is different from field editing; if the new envelope does not have a default selection, it must be cleared and the old value on the receiving end cannot be inherited.
    return this.#personalRepository.update(() => config);
  }

  async savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      const builtin = zcodeBuiltin.providers.get(providerId);
      const currentPersonal = current.providers.get(providerId);
      const currentEffectiveProviders = zcodeBuiltin.providers.overlay(current.providers);
      // The total account ban has been revoked; new operations are rejected at the public write boundary to prevent invalid status from being written after hiding the UI.
      if (builtin?.access?.type === "zhipu-account" && metadata?.enabled === false) {
        throw new Error(`Account Providers cannot be disabled: ${providerId}`);
      }
      if (builtin?.access?.type === "zhipu-account" && config.access !== undefined) {
        // The universal save entry only parses ProviderConfig and has bypassed Personal Source Schema.
        // Access to the fixed Account Provider is allowed to be written to the disk, and will not be completely denied until the next read.
        throw new Error(
          `Access for a pinned Account Provider can only be declared by the ZCode Built-in Config: ${providerId}`,
        );
      }
      // Ordinary saves once also assumed creation semantics, and late saves after deletion can resurrect Overlay out of thin air.
      // Creation is already a clear domain operation, ordinary saving only updates the existing configuration, and rejects it if it does not exist.
      if (!currentPersonal && !builtin) {
        throw new Error(`Personal Provider has not been created yet: ${providerId}`);
      }
      let normalized = config;
      if (builtin) {
        if (normalized.group != null && normalized.group !== builtin.group) {
          throw new Error(
            `Personal Overlay cannot rewrite the Built-in Provider group: ${providerId}`,
          );
        }
        normalized = normalized.withoutGroup();
      } else {
        const group = normalized.group ?? currentPersonal?.group;
        if (group !== "standard-personal") {
          throw new Error(
            `Personal-only Providers must use the standard-personal group: ${providerId}`,
          );
        }
        normalized = normalized.overlay(new ProviderConfigValue({ group }));
      }
      const membershipBaseline =
        builtin ?? resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      const next = normalized.withModelMembershipFrom(
        // Ordinary providers also retain the dynamic member order when saving; when the name cannot be changed, the saved order is deleted according to the static list.
        normalizePersonalProviderMembership(
          currentPersonal,
          membershipBaseline,
          membership?.inheritedModelIds,
        ),
      );
      const currentRule = current.providers.getRule(providerId);
      const providers = current.providers.setRule({
        ...currentRule,
        providerId,
        ...(metadata?.templateId === undefined ? {} : { templateId: metadata.templateId }),
        ...(metadata?.enabled === undefined ? {} : { enabled: metadata.enabled }),
        ...(metadata?.providerName === undefined
          ? {}
          : { providerName: metadata.providerName?.trim() || null }),
        config: next,
      });
      const nextEffectiveProviders = zcodeBuiltin.providers.overlay(providers);
      // Old versions may have left providers with the same name. Full verification will block these historical problems
      // There is no need to save any irrelevant Provider; here only the name change is prohibited from introducing duplicate names.
      assertProviderLabelMutationIsUnique(
        providerId,
        currentEffectiveProviders,
        nextEffectiveProviders,
      );
      return {
        providers,
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  async createPersonalProvider(
    input: CreatePersonalProviderInput = {},
  ): Promise<PersonalProviderCreation> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    const templateId = input.templateId?.trim();
    const template = templateId ? zcodeBuiltin.providerTemplates?.get(templateId) : undefined;
    if (templateId && !template) throw new Error(`Provider Template does not exist: ${templateId}`);
    if (input.initialConfig?.group !== undefined) {
      throw new Error("initialConfig must not contain group");
    }
    if (input.initialConfig?.builtinModelIds !== undefined) {
      throw new Error("initialConfig must not contain builtinModelIds");
    }
    let createdProviderId: ProviderId | undefined;
    await this.#updatePersonal((current) => {
      const occupied = new Set([...zcodeBuiltin.providers.keys(), ...current.providers.keys()]);
      const providerId = nextPersonalProviderId(occupied, templateId);
      createdProviderId = providerId;
      const effectiveProviders = resolvePersonalProviderBaselines(zcodeBuiltin, current.providers);
      const label = nextPersonalProviderLabel(
        input.providerName ??
          (template && templateId
            ? resolveProviderTemplateName(templateId, template, input.locale ?? "en-US")
            : "new-provider"),
        effectiveProviders,
      );
      const initial = input.initialConfig ?? new ProviderConfigValue();
      const providers = current.providers.setRule({
        providerId,
        ...(templateId ? { templateId } : {}),
        providerName: label,
        config: new ProviderConfigValue({
          group: "standard-personal",
          access: templateId ? undefined : new ApiKeyAccessConfig(),
          personalModelIds: [],
          modelOrder: [],
        }).overlay(initial),
      });
      return {
        providers,
        models: current.models,
        providerOrder: appendCurrentProviderOrder(
          zcodeBuiltin.providers,
          providers,
          current.providerOrder,
          providerId,
        ),
      };
    });
    if (!createdProviderId) throw new Error("Failed to create the Personal Provider");
    return Object.freeze({ providerId: createdProviderId });
  }

  deletePersonalProvider(providerId: ProviderId): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    return this.#updatePersonal((current) => ({
      providers: current.providers.delete(providerId),
      models: current.models.deleteExactForProvider(providerId),
      providerOrder: current.providerOrder?.filter((candidate) => candidate !== providerId),
    }));
  }

  async reorderPersonalProviders(
    providerIds: readonly ProviderId[],
  ): Promise<ProviderConfigLayerSnapshot> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => ({
      providers: current.providers,
      models: current.models,
      providerOrder: normalizeProviderOrder(zcodeBuiltin.providers, current.providers, providerIds),
    }));
  }

  async reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      const builtinProvider =
        zcodeBuiltin.providers.get(providerId) ??
        resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      const provider = writableProviderOverlay(zcodeBuiltin, current, providerId);
      const modelOrder = normalizeModelOrder(
        membership?.inheritedModelIds ?? builtinProvider?.builtinModelIds ?? [],
        provider.personalModelIds ?? [],
        modelIds,
      );
      return {
        providers: current.providers.set(providerId, provider.withModelOrder(modelOrder)),
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  async addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = writableProviderOverlay(zcodeBuiltin, current, normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      if (builtinModelIds.includes(normalizedModelId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${normalizedModelId}`);
      }
      const currentModelIds = provider.personalModelIds ?? [];
      if (currentModelIds.includes(normalizedModelId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${normalizedModelId}`);
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider.withPersonalModelIds([...currentModelIds, normalizedModelId]).withModelOrder(
            // Adding cannot re-sort the member list, otherwise the order saved by the user will be lost.
            normalizeModelOrder(
              builtinModelIds,
              [...currentModelIds, normalizedModelId],
              provider.modelOrder ?? [],
            ),
          ),
        ),
        models: current.models.setExact(
          normalizedProviderId,
          normalizedModelId,
          config.overlay(new ModelConfig({ enabled: true })),
          useRecommendedConfig,
        ),
        providerOrder: current.providerOrder,
      };
    });
  }

  async renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const currentId = normalizeId("modelId", currentModelId);
    const nextId = normalizeId("modelId", nextModelId);
    if (currentId === nextId) return this.#personalRepository.read();
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      // Inheritance ownership protection applies to Facade and underlying direct calls and cannot be checked only when there is a dynamic context.
      if (builtinModelIds.includes(currentId))
        throw new Error(`Built-in Models cannot be renamed: ${normalizedProviderId}/${currentId}`);
      if (!provider?.personalModelIds?.includes(currentId)) {
        throw new Error(`Personal Model does not exist: ${normalizedProviderId}/${currentId}`);
      }
      if (provider.personalModelIds.includes(nextId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }
      if (builtinModelIds.includes(nextId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }
      const modelIds = provider.personalModelIds.map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        ),
        models: current.models.renameExactModel(normalizedProviderId, currentId, nextId),
        providerOrder: current.providerOrder,
      };
    });
  }

  async setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const id = normalizeId("providerId", providerId);
    const model = normalizeId("modelId", modelId);
    if (typeof enabled !== "boolean") throw new Error("Model enabled must be a boolean");
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, id, current);
      const provider = current.providers.get(id);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, id);
      if (!inherited.includes(model) && !provider?.personalModelIds?.includes(model)) {
        throw new Error(`Model does not exist: ${id}/${model}`);
      }
      // Start and stop reuse of full draft saves may overwrite other edits or be blocked by fixed configuration integrity.
      // Only the latest enabled is modified within the transaction; schema, members, and other model fields are not changed.
      const config = (current.models.getExact(id, model) ?? new ModelConfig({})).overlay(
        new ModelConfig({ enabled }),
      );
      return {
        providers: current.providers,
        models: current.models.setExact(id, model, config),
        providerOrder: current.providerOrder,
      };
    });
  }

  /** The only write boundary of the Model edit dialog: membership, ordering, and exact Rules are committed in a single Repository update. */
  async savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const originalId = normalizeId("modelId", originalModelId);
    const nextId = normalizeId("modelId", nextModelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      if (current.revision !== expectedPersonalRevision) {
        throw new Error(
          `Personal Provider Config revision conflict: expected ${expectedPersonalRevision}, current ${current.revision}`,
        );
      }
      const recommended =
        useRecommendedConfig ??
        current.models.getExactRule(normalizedProviderId, originalId)?.type !==
          "manual-provider-model";
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      const builtinSet = new Set(builtinModelIds);
      if (originalId !== nextId && builtinSet.has(originalId)) {
        throw new Error(`Built-in Models cannot be renamed: ${normalizedProviderId}/${originalId}`);
      }
      if (originalId !== nextId && builtinSet.has(nextId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }
      const personalModelIds = provider?.personalModelIds ?? [];
      const originalExists = builtinSet.has(originalId) || personalModelIds.includes(originalId);
      if (!originalExists) {
        throw new Error(`Model does not exist: ${normalizedProviderId}/${originalId}`);
      }
      if (originalId !== nextId && (personalModelIds.includes(nextId) || builtinSet.has(nextId))) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }

      let providers = current.providers;
      let models = current.models;
      if (originalId !== nextId) {
        if (!provider?.personalModelIds?.includes(originalId)) {
          throw new Error(`Personal Model does not exist: ${normalizedProviderId}/${originalId}`);
        }
        const modelIds = provider.personalModelIds.map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        providers = providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        );
        models = models.renameExactModel(normalizedProviderId, originalId, nextId);
      }
      models =
        recommended && isStructurallyEmpty(config.toJSON())
          ? models.deleteExact(normalizedProviderId, nextId)
          : models.setExact(normalizedProviderId, nextId, config, recommended);
      return { providers, models, providerOrder: current.providerOrder };
    });
  }

  async deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, normalizedProviderId);
      if (inherited.includes(normalizedModelId))
        throw new Error(
          `Built-in Models cannot be deleted: ${normalizedProviderId}/${normalizedModelId}`,
        );
      if (!provider?.personalModelIds?.includes(normalizedModelId)) {
        throw new Error(
          `Personal Model does not exist: ${normalizedProviderId}/${normalizedModelId}`,
        );
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(
              provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
            )
            .withModelOrder(
              normalizeModelOrder(
                inherited,
                provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
                provider.modelOrder ?? [],
              ),
            ),
        ),
        models: current.models.deleteExact(normalizedProviderId, normalizedModelId),
        providerOrder: current.providerOrder,
      };
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#sourceDisposers.splice(0)) dispose();
    this.#listeners.clear();
  }

  #updatePersonal(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    return this.#personalRepository.update((current) => ({
      // Provider/Model/Sort only modifies its own members and cannot clear the default selection due to shared files.
      defaultModelSelection: current.defaultModelSelection,
      ...transform(current),
    }));
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason || "changed");
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("ProviderConfigService has been disposed");
  }
}

function isStructurallyEmpty(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length === 0;
  return Object.values(value).every(isStructurallyEmpty);
}

function assertProviderLabelMutationIsUnique(
  providerId: ProviderId,
  currentProviders: ProviderConfigMap,
  nextProviders: ProviderConfigMap,
): void {
  const currentLabel = currentProviders.getRule(providerId)?.providerName?.trim();
  const nextLabel = nextProviders.getRule(providerId)?.providerName?.trim();
  const currentKey = currentLabel?.toLocaleLowerCase();
  const nextKey = nextLabel?.toLocaleLowerCase();
  if (!nextKey || nextKey === currentKey) return;
  for (const candidate of nextProviders.rules()) {
    const candidateId = candidate.providerId;
    if (candidateId === providerId) continue;
    if (candidate.providerName?.trim().toLocaleLowerCase() === nextKey) {
      throw new Error(`Provider name already exists: ${nextLabel}`);
    }
  }
}

function normalizePersonalProviderMembership(
  personal: ProviderConfig | undefined,
  builtin: ProviderConfig | undefined,
  inheritedModelIds?: readonly ModelId[],
): ProviderConfig | undefined {
  if (!personal) return undefined;
  const builtinModelIds = uniqueInOrder(inheritedModelIds ?? builtin?.builtinModelIds ?? []);
  const builtinSet = new Set(builtinModelIds);
  const personalModelIds = uniqueInOrder(personal.personalModelIds ?? []).filter(
    (modelId) => !builtinSet.has(modelId),
  );
  let normalized = personal.withPersonalModelIds(personalModelIds);
  if (personal.modelOrder !== undefined && personal.modelOrder !== null) {
    normalized = normalized.withModelOrder(
      normalizeModelOrder(builtinModelIds, personalModelIds, personal.modelOrder),
    );
  }
  return normalized;
}

function assertNonEmptyId(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function normalizeId(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

function normalizeProviderOrder(
  _zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  requested: readonly ProviderId[],
): ProviderId[] {
  const personalIds = personalProviders
    .entries()
    .filter(([, config]) => config.group === "standard-personal")
    .map(([providerId]) => providerId);
  return [...resolveOwnedOrder([], personalIds, requested)];
}

function appendCurrentProviderOrder(
  zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  currentOrder: readonly ProviderId[] | undefined,
  addedProviderId: ProviderId,
): ProviderId[] {
  const current = normalizeProviderOrder(
    zcodeBuiltinProviders,
    personalProviders,
    currentOrder ?? [],
  );
  return normalizeProviderOrder(zcodeBuiltinProviders, personalProviders, [
    ...current.filter((providerId) => providerId !== addedProviderId),
    addedProviderId,
  ]);
}

function normalizeModelOrder(
  builtinModelIds: readonly ModelId[],
  personalModelIds: readonly ModelId[],
  requested: readonly ModelId[],
): ModelId[] {
  return [...resolveOwnedOrder(builtinModelIds, personalModelIds, requested)];
}

function nextPersonalProviderId(
  occupied: ReadonlySet<ProviderId>,
  templateId?: ProviderTemplateId,
): ProviderId {
  const base = templateId ? normalizeProviderIdSeed(templateId) : "new-provider";
  if (!occupied.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function normalizeProviderIdSeed(value: string): string {
  return (
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "new-provider"
  );
}

function resolvePersonalProviderBaselines(
  zcodeBuiltin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
): ProviderConfigMap {
  const personal = personalProviders.mapConfigs((config, _id, rule) => {
    const template = rule.templateId
      ? zcodeBuiltin.providerTemplates?.get(rule.templateId)
      : undefined;
    return template ? template.config.overlay(config) : config;
  });
  return zcodeBuiltin.providers.overlay(personal);
}

function resolveTemplateBaseline(
  builtin: ProviderConfigLayerSnapshot,
  providers: ProviderConfigMap,
  providerId: ProviderId,
): ProviderConfig | undefined {
  const templateId = providers.getRule(providerId)?.templateId;
  return templateId ? builtin.providerTemplates?.get(templateId)?.config : undefined;
}

function resolveProviderBuiltinModelIds(
  builtin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
  providerId: ProviderId,
): readonly ModelId[] {
  return (
    builtin.providers.get(providerId)?.builtinModelIds ??
    resolveTemplateBaseline(builtin, personalProviders, providerId)?.builtinModelIds ??
    []
  );
}

function nextPersonalProviderLabel(seed: string, providers: ProviderConfigMap): string {
  const base = seed.trim() || "new-provider";
  const labels = new Set(
    providers
      .rules()
      .map((provider) => provider.providerName?.trim().toLocaleLowerCase())
      .filter((label): label is string => Boolean(label)),
  );
  if (!labels.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!labels.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
