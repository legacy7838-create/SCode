import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderId,
} from "./config/index.js";
import type {
  AccountProviderResolveInput,
  AccountProviderResolver,
} from "./account-provider-service.js";
import type {
  AccountProviderState,
  AccountProviderUnavailableReason,
} from "./account-provider-state.js";

export type AccountProviderConnectionResult = {
  /** Reusing a previous snapshot is forbidden once the account/organization identity changes; used only for this round of resolution and never stored in config. */
  readonly resetPrevious?: boolean;
  readonly current?: boolean;
  readonly connectionKey?: string;
  readonly effectiveAt?: number;
} & (
  | {
      readonly providerId: ProviderId;
      readonly status: "available" | "pending";
      readonly models?: readonly ModelId[];
    }
  | {
      readonly providerId: ProviderId;
      readonly status: "unavailable" | "unknown";
      /** Only carried when status === "unavailable"; unknown means that the cause cannot be determined in this round. */
      readonly unavailableReason?: AccountProviderUnavailableReason;
    }
);

export interface ResolveAccountProviderConfigsInput {
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly connections: readonly AccountProviderConnectionResult[];
}

export type AccountProviderConnectionResolver = (
  input: Omit<AccountProviderResolveInput, "previousProviders">,
) => Promise<readonly AccountProviderConnectionResult[]>;

export function createAccountProviderConfigResolver(
  resolveConnections: AccountProviderConnectionResolver,
): AccountProviderResolver {
  return async (input) => {
    const connections = await resolveConnections({
      configRevision: input.configRevision,
      configuredProviders: input.configuredProviders,
      reasons: input.reasons ?? [],
    });
    const providers = resolveAccountProviderConfigs({
      configuredProviders: input.configuredProviders,
      previousProviders: input.previousProviders,
      connections,
    });
    const states: Record<string, AccountProviderState> = {};
    for (const connection of connections) {
      const previous = connection.resetPrevious
        ? undefined
        : input.previousStates?.[connection.providerId];
      const access = providers.get(connection.providerId)?.access;
      // unknown only retains the last displayed fact; current is always selected from this round and cannot resurrect old connections.
      // The reason field has the same rules as availability: unknown is used from the previous round to avoid a network jitter.
      // "Clearly no rights" downgraded to unknown reason.
      const unavailableReason =
        connection.status === "unknown" && previous
          ? previous.unavailableReason
          : connection.status === "unavailable"
            ? connection.unavailableReason
            : undefined;
      states[connection.providerId] = Object.freeze({
        ...(connection.status === "unknown" ? previous : {}),
        availability:
          connection.status === "unknown" && previous ? previous.availability : connection.status,
        entitled: access?.type === "zhipu-account" && access.entitled === true,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        ...(connection.current === undefined ? {} : { current: connection.current }),
        connectionKey: connection.connectionKey,
        ...(connection.effectiveAt === undefined ? {} : { effectiveAt: connection.effectiveAt }),
      });
    }
    return Object.freeze({ providers, states: Object.freeze(states) });
  };
}

/** Converts account connection results into the third-layer Account Provider Config used by the Registry. */
export function resolveAccountProviderConfigs(
  input: ResolveAccountProviderConfigsInput,
): ProviderConfigMap {
  const connectionByProviderId = indexConnections(input.configuredProviders, input.connections);
  const resolved: Array<readonly [ProviderId, ProviderConfig]> = [];
  for (const [providerId, configured] of input.configuredProviders.entries()) {
    const access = configured.access;
    if (access?.type !== "zhipu-account") continue;
    const connection = connectionByProviderId.get(providerId) ?? {
      providerId,
      status: "unknown" as const,
    };

    if (connection.status === "available" || connection.status === "pending") {
      if (access.mode === "start-plan") {
        const models = normalizeModelIds(connection.models);
        resolved.push([
          providerId,
          new ProviderConfig({
            // It is clear that the empty model is the authoritative result of this round, and the old whitelist that has expired cannot be retained.
            access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
            builtinModelIds: models,
          }),
        ]);
        continue;
      }
      resolved.push([
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
        }),
      ]);
      continue;
    }

    if (connection.status === "unavailable") {
      resolved.push([providerId, createEntitlementOverlay(false)]);
      continue;
    }

    const previous = connection.resetPrevious ? undefined : input.previousProviders.get(providerId);
    if (previous) {
      resolved.push([providerId, previous]);
    } else {
      resolved.push([providerId, createEntitlementOverlay(false)]);
    }
  }

  return new ProviderConfigMap(resolved);
}

function createEntitlementOverlay(entitled: boolean): ProviderConfig {
  return new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled }) });
}

function indexConnections(
  configuredProviders: ProviderConfigMap,
  connections: readonly AccountProviderConnectionResult[],
): ReadonlyMap<ProviderId, AccountProviderConnectionResult> {
  const result = new Map<ProviderId, AccountProviderConnectionResult>();
  for (const connection of connections) {
    if (result.has(connection.providerId)) {
      throw new Error(`Duplicate Account Provider connection result: ${connection.providerId}`);
    }
    const configured = configuredProviders.get(connection.providerId);
    if (!configured) {
      throw new Error(
        `Account connection points to unconfigured Provider: ${connection.providerId}`,
      );
    }
    if (!isAccountConstrainedProvider(configured)) {
      throw new Error(
        `Account connection points to non-Account Provider: ${connection.providerId}`,
      );
    }
    result.set(connection.providerId, connection);
  }
  return result;
}

function isAccountConstrainedProvider(config: ProviderConfig): boolean {
  return config.access?.type === "zhipu-account";
}

function normalizeModelIds(values: readonly ModelId[] | null | undefined): readonly ModelId[] {
  const result: ModelId[] = [];
  for (const value of values ?? []) {
    const modelId = value.trim();
    if (!modelId) continue;
    result.push(modelId);
  }
  return Object.freeze(result);
}
