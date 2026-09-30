import { type UsageEntitlementSnapshot } from "@zcode/shared";
import { type ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export function pickCodingPlanEntitlementProvider(
  codingPlanProvider: ProviderSettingsFormProvider | null | undefined,
): ProviderSettingsFormProvider | null {
  // Coding Plan and ordinary API Key are two independent entrances.
  // The rights and model entries only follow the Coding Plan provider's own key to prevent common provider keys from mistakenly lighting up the subscription status.
  return codingPlanProvider ?? null;
}

export function hasActiveUsageEntitlementSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): boolean {
  return resolveUsageEntitlementOutcome(snapshot, providerId) === "active";
}

type UsageEntitlementOutcome = "active" | "inactive" | "unknown";

/**
 * Only an authoritative no_plan is read as invalid; network failures, auth failures, and incomplete
 * snapshots all stay unknown.
 */
export function resolveUsageEntitlementOutcome(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): UsageEntitlementOutcome {
  if (!snapshot) return "unknown";
  if (providerId && snapshot.provider?.id && snapshot.provider.id !== providerId) {
    return "unknown";
  }
  if (snapshot.unavailableReason === "no_plan") return "inactive";
  // The quota or remaining quota does not represent a subscription; individuals/teams are certified by the subscription summary returned by the service.
  return snapshot.subscription?.details.length ? "active" : "unknown";
}
