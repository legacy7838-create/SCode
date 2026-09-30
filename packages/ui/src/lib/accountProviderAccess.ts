import type { ProviderSettingsView } from "@zcode/services";
import { type ZCodeProviderAccountAccess, zcodeProviderAccountAccessSchema } from "@zcode/shared";

interface EntitledAccountProviderAccess {
  readonly providerId: string;
  readonly access: ZCodeProviderAccountAccess;
  readonly label?: string;
}

export function resolveEntitledAccountProviderAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (provider?.effectiveConfig.access?.type !== "zhipu-account") {
    return null;
  }

  // Registry Access is a static accountType/mode constraint; the dynamic planKind and Team scope
  // can only be resolved by the account service at request time. The old Schema would misjudge every real Registry Provider as empty.
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.entitled !== true) return null;
  const label = provider.providerName?.trim();
  return {
    providerId,
    access: parsed.data,
    ...(label ? { label } : {}),
  };
}

export function resolveEntitledAccountProviderAccessFingerprint(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): string {
  const access = resolveEntitledAccountProviderAccess(view, providerId);
  return access ? JSON.stringify([view?.revision, access.providerId, access.access]) : "";
}

/**
 * A read-only plan lookup is not the same as the execution model. Pending / unselected accounts
 * still have to show their entitlements, so this must not require current. This function is for
 * balance / subscription lookups only and must not be used for model requests or ModelSelection
 * completion.
 */
export function resolveAccountProviderInspectionAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (!provider) return null;
  // Even with no Start entitlement, a read-only lookup of the expiry reason is still needed; execution permission stays gated by entitled.
  if (
    provider.accountState?.availability === "unavailable" &&
    !(
      provider.effectiveConfig.access?.type === "zhipu-account" &&
      provider.effectiveConfig.access.mode === "start-plan" &&
      provider.accountState.unavailableReason === "not-entitled"
    )
  )
    return null;
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.mode === "off-peak") return null;
  if (!provider.accountState && parsed.data.entitled !== true) return null;
  return { providerId, access: parsed.data };
}
