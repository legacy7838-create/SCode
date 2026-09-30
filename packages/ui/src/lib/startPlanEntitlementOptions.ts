import type { ProviderSettingsView } from "@zcode/services";
import { resolveModelProviderFamilySpecByProviderId } from "@zcode/shared";
import type { UseUsageEntitlementOptions } from "@/hooks/useUsageEntitlement.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";

/**
 * Settings, the input box, and submission suggestions reuse the original entitlement cache; the
 * account identity is provided by the Account Source connection fingerprint.
 */
export function buildStartPlanEntitlementOptions(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): UseUsageEntitlementOptions {
  const inspection = resolveAccountProviderInspectionAccess(view, providerId);
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  const family = resolveModelProviderFamilySpecByProviderId(providerId);
  const fingerprint = inspection
    ? JSON.stringify([provider?.accountState?.connectionKey ?? view?.revision, inspection])
    : "";
  return {
    enabled: Boolean(inspection && family),
    preferredProviderId: providerId,
    accountAccess: family
      ? { type: "zhipu-account", family: family.id, planKind: "start-plan" }
      : undefined,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({ providerId, providerFingerprint: fingerprint }),
    refreshOnMount: false,
  };
}
