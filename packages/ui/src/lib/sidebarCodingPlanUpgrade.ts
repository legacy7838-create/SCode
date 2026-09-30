import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

export function resolveSidebarCodingPlanUpgradeFallbackProviderId(
  providerFamilyDomain: ProviderFamilyDomain | null,
): SidebarUsageCodingPlanProviderId {
  // The API Key mode does not inject the package key into the Coding Plan provider, so the avatar upgrade entrance is
  // The provider cannot be deduced from the source of equity or usage; fall back to the entrance of the corresponding brand by the provider family domain name.
  return providerFamilyDomain === "bigmodel"
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
}

function normalizePlanLevel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasPlanLevelToken(value: string | null | undefined, token: string): boolean {
  return new RegExp(`(^|[\\s_-])${token}($|[\\s_-])`, "i").test(value?.trim() ?? "");
}

function isTerminalCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  // Determine whether the package level is in the final state that cannot be upgraded: enterprise/team is considered the final state.
  return normalized.includes("enterprise") || normalized.includes("team");
}

function isMaxCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  return normalized === "max" || hasPlanLevelToken(value, "max");
}

export function isTerminalCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isTerminalCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = normalizePlanLevel(detail.productId);
    const productName = normalizePlanLevel(detail.productName);
    return isTerminalCodingPlanLevel(productId) || isTerminalCodingPlanLevel(productName);
  });
}

export function isMaxCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isMaxCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = detail.productId;
    const productName = detail.productName;
    return isMaxCodingPlanLevel(productId) || isMaxCodingPlanLevel(productName);
  });
}
