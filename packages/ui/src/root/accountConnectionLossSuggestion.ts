import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import type { ProviderFamilyConnectionSelection } from "@zcode/shared";
import type { AccountConnectionLoss } from "@/root/accountConnectionRefreshObserver.js";
import {
  resolveFirstSubscribedTeamPlanConnectionWithContext,
  resolveModelProviderFamilyConnectionProviderId,
} from "@/lib/modelProviderFamilyConnectionSelection.js";
import { hasActiveUsageEntitlementSnapshot } from "@/lib/codingPlanProvider.js";
import { getEnterprisePricingProducts } from "@/root/oauthTeamPricing.js";
import { logger } from "@/logger.js";

/**
 * Only computes the suggestion; it does not save on the user's behalf. The closure pins the target
 * shown on the button, which is re-validated at click time.
 */
export async function prepareAccountConnectionSwitch(
  services: IServiceAccessor,
  event: AccountConnectionLoss,
) {
  const settings = await services.settingService.get();
  const family = settings.providerFamilyDomain;
  const original = family && settings.providerFamilyConnectionSelections?.[family];
  if (!family || !original || original.kind === "start-plan" || !event.isCurrent()) return null;
  if (
    resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection: original,
    }) !== event.providerId
  )
    return null;
  const expected = {
    providerFamilyDomain: family,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections,
  };
  const isOriginal = (view: ProviderSettingsView) => {
    const state = view.providers.find((p) => p.providerId === event.providerId)?.accountState;
    return (
      event.isCurrent() &&
      state?.current === true &&
      state.connectionKey === event.connectionKey &&
      state.availability === "unavailable"
    );
  };
  const view = await services.providerSettingsService.getView();
  if (!isOriginal(view)) return null;
  const isAvailable = async (
    selection: ProviderFamilyConnectionSelection,
    snapshot: ProviderSettingsView,
  ) => {
    const providerId = resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection,
    });
    if (selection.kind !== "team-coding-plan")
      return (
        snapshot.providers.find((p) => p.providerId === providerId)?.accountState?.availability ===
        "available"
      );
    // An unselected Team has no reusable current fact. Press button for specific organization/project inquiries,
    // Team roster existence or another Team's equity cannot be made available as a target.
    const { kind: planKind, ...identity } = selection;
    const entitlement = await services.usageStatsService.getEntitlementSnapshot({
      preferredProviderId: providerId,
      includeSubscription: true,
      accountAccess: { type: "zhipu-account", family, planKind, ...identity },
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    return hasActiveUsageEntitlementSnapshot(entitlement, providerId);
  };
  let selection: ProviderFamilyConnectionSelection | undefined;
  let label: string | undefined;
  if (await isAvailable({ kind: "individual-coding-plan" }, view))
    selection = { kind: "individual-coding-plan" };
  if (!selection) {
    const pricing = await getEnterprisePricingProducts(services, family);
    if (pricing.status === "success") {
      for (const product of pricing.productList) {
        const contexts = product.teamProjects?.length ? product.teamProjects : [product];
        for (const context of contexts) {
          const candidate = resolveFirstSubscribedTeamPlanConnectionWithContext({
            teamProducts: [{ ...product, teamProjects: [], ...context }],
          });
          if (!candidate || JSON.stringify(candidate) === JSON.stringify(original)) continue;
          if (await isAvailable(candidate, view)) {
            selection = candidate;
            label =
              context.organizationName?.trim() ||
              context.projectName?.trim() ||
              candidate.organizationId;
            break;
          }
        }
        if (selection) break;
      }
    }
  }
  if (!selection || !event.isCurrent()) return null;
  const target = selection;
  let running = false;
  let applied = false;
  return {
    selection: target,
    label,
    async apply(): Promise<"switched" | "stale"> {
      if (running || applied || !event.isCurrent()) return "stale";
      running = true;
      try {
        const latest = await services.providerSettingsService.refresh(
          "account-connection-switch-confirm",
        );
        if (!isOriginal(latest) || !(await isAvailable(target, latest)) || !event.isCurrent())
          return "stale";
        await services.settingService.update(
          {
            providerFamilyConnectionSelections: {
              ...settings.providerFamilyConnectionSelections,
              [family]: target,
            },
          },
          expected,
        );
        applied = true;
        try {
          await services.providerSettingsService.refresh("account-connection-switched");
        } catch (error) {
          // The writing has been completed. If the refresh fails, the result cannot be disguised as unsaved; subsequent normal refreshes will continue to converge.
          logger.lifecycle.warn("[AccountConnection] connection saved, refresh still pending", {
            error,
          });
        }
        return "switched";
      } finally {
        running = false;
      }
    },
  };
}
