import type { IServiceAccessor } from "@zcode/services";
import type { AccountProviderState } from "@zcode/provider";
import type {
  OAuthProviderId,
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  getModelProviderFamilySpec,
  resolveProviderFamilyDomainFromOAuthProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import {
  type ModelProviderFamilyConnectionSelection,
  resolveAutomaticModelProviderFamilyConnectionSelection,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

import { getEnterprisePricingProductsOrEmpty } from "@/root/oauthTeamPricing.js";

function resolveModelProviderFamilySpecFromOAuth(
  provider: OAuthProviderId | string,
): ReturnType<typeof getModelProviderFamilySpec> | null {
  const family = resolveProviderFamilyDomainFromOAuthProvider(provider);
  return family ? getModelProviderFamilySpec(family) : null;
}

async function getUsageEntitlementSnapshotOrNull(params: {
  services: IServiceAccessor;
  providerId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}): Promise<UsageEntitlementSnapshot | null> {
  try {
    return await params.services.usageStatsService.getEntitlementSnapshot({
      includeSubscription: true,
      preferredProviderId: params.providerId,
      accountAccess: params.accountAccess,
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
  } catch (error) {
    logger.warn("[Root] failed to refresh entitlement snapshot after login", {
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

async function refreshAccountProviderAccesses(params: {
  services: IServiceAccessor;
  providerIds: readonly string[];
  reason: string;
}): Promise<{
  accesses: ReadonlyMap<string, ZCodeProviderAccountAccess | ZCodeAccountAccess>;
  states: ReadonlyMap<string, AccountProviderState>;
  refreshed: boolean;
  error?: unknown;
}> {
  const providerSettingsService = params.services.providerSettingsService;

  try {
    const view = await providerSettingsService.refresh(params.reason);
    const accesses = new Map(
      params.providerIds.flatMap((providerId) => {
        const resolved = resolveAccountProviderInspectionAccess(view, providerId);
        if (!resolved) return [];
        const access = resolved.access;
        // The login/startup check is a package read-only query. Static mode will be resolved by current during execution.
        // Treat the unselected or pending Start as the current Coding query; the package itself must be explicitly queried here.
        const query: ZCodeProviderAccountAccess | ZCodeAccountAccess =
          access.mode === "start-plan" || access.mode === "individual-coding-plan"
            ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
            : access;
        return [[providerId, query] as const];
      }),
    );
    return {
      refreshed: true,
      accesses,
      states: new Map(
        view.providers.flatMap((provider) =>
          provider.accountState ? [[provider.providerId, provider.accountState] as const] : [],
        ),
      ),
    };
  } catch (error) {
    logger.warn("[Root] failed to refresh Account Provider access identities", {
      providerIds: params.providerIds,
      error,
    });
    return { refreshed: false, accesses: new Map(), states: new Map(), error };
  }
}

export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.provider);
  if (!domain) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecFromOAuth(params.provider);
  if (!familySpec) return null;
  // Login queries also have network waiting, and condition writing must be based on the intention before the query, not the selection after the packet is returned.
  const currentSettings = await params.services.settingService.get();
  const expectedAccountSettings = {
    providerFamilyDomain: currentSettings.providerFamilyDomain,
    providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
  };
  const codingPlanProviderId = familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = familySpec.startPlanProviderId;
  const codingPlanProviderIds = [
    familySpec.individualCodingPlanProviderId,
    familySpec.startPlanProviderId,
    familySpec.teamCodingPlanProviderId,
  ];
  const { accesses, states, refreshed } = await refreshAccountProviderAccesses({
    services: params.services,
    providerIds: codingPlanProviderIds,
    reason: "oauth-login-entitlement",
  });
  if (!refreshed) return null;
  // It's also possible that a post-login refresh is still waiting for the old Team to reorganize; unknown is not a first-time connection that can be sorted and reselected.
  if (
    !currentSettings.providerFamilyConnectionSelections?.[domain] &&
    codingPlanProviderIds.every((id) => states.get(id)?.availability === "unknown")
  )
    return null;

  const [codingPlanEntitlement, startPlanEntitlement, teamProducts] = await Promise.all([
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: codingPlanProviderId,
      accountAccess: accesses.get(codingPlanProviderId),
    }),
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: startPlanProviderId,
      accountAccess: accesses.get(startPlanProviderId),
    }),
    getEnterprisePricingProductsOrEmpty(params.services, domain),
  ]);
  // The old Start connection is only retained for reading and will not be deleted or automatically replaced with a paid connection due to expiry of rights.
  const savedSelection = currentSettings.providerFamilyConnectionSelections?.[domain];
  if (savedSelection?.kind === "start-plan") return savedSelection;
  const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
    providerFamilyDomain: domain,
    codingPlanEntitlement,
    startPlanEntitlement,
    teamProducts,
    codingPlanAvailable: states.has(codingPlanProviderId)
      ? states.get(codingPlanProviderId)!.availability === "available"
      : undefined,
    startPlanAvailable: states.has(startPlanProviderId)
      ? states.get(startPlanProviderId)!.availability === "available"
      : undefined,
  });
  if (!selection) {
    return null;
  }

  await params.services.settingService.update(
    {
      providerFamilyConnectionSelections: {
        ...currentSettings.providerFamilyConnectionSelections,
        [domain]: selection,
      },
    },
    expectedAccountSettings,
  );
  return selection;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.activeProvider);
  if (!domain) return null;
  const settings = await params.services.settingService.get();
  if (settings.providerFamilyDomain && settings.providerFamilyDomain !== domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    // Reason: The unavailability at startup is not a failure that occurred during this run, and the saved connection cannot be replaced for the user.
    // Refreshing the account will still be performed as usual; only the click action of the subsequent real invalidation prompt allows the selection of an alternative package.
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] startup account refresh failed, keeping existing connection", { error });
    }
    return saved;
  }
  try {
    // The first initialization is only used if there is really no choice; this entry retains unknown protection and conditional writing of old connections pending migration.
    const selection = await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: params.activeProvider,
      services: params.services,
    });
    if (selection) await params.refreshAppSettings?.();
    return selection;
  } catch (error) {
    logger.warn("[Root] failed to initialize connection at startup", { error });
    return null;
  }
}
