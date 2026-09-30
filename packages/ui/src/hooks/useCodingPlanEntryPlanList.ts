import { useCallback, useEffect, useState } from "react";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type EnterpriseCodingPlanPricingProduct } from "@zcode/shared";
import { buildOwnedEntryPlanList } from "@/lib/codingPlanOwnedEntryPlans.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { logger } from "@/logger.js";

export interface CodingPlanEntryInventory {
  entryPlanList: string;
  status: "loading" | "error" | "ready";
  retry: () => void;
}

export function useCodingPlanEntryPlanList(): CodingPlanEntryInventory {
  const { state, reload } = useProviderSettingsView();
  const providerSettingsView = state.status === "ready" ? state.view : null;
  const loading = state.status === "loading";
  const { credentialService, codingPlanSubscriptionService } = useServices();
  const user = useZCodeStore((state) => state.user);
  // The currently selected team context is not passed, and the four Start/Personal connections use existing equity caches respectively.
  const { entitlements, refresh } = useCodingPlanEntitlements({
    providerSettingsView,
    suppressProviderFingerprintAutoRefresh: true,
  });
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => {
    if (state.status === "error") reload();
    setGeneration((value) => value + 1);
  }, [state.status, reload]);
  const [teams, setTeams] = useState<{
    user: typeof user;
    view: typeof providerSettingsView;
    sources: { token: string | null; products: EnterpriseCodingPlanPricingProduct[] | null }[];
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!providerSettingsView) return;
    let cancelled = false;
    // Team subscriptions follow authenticated pricing; never infer purchased plans from the static product catalog.
    void Promise.all([
      refresh({ force: true, silent: true }),
      Promise.all(
        (["bigmodel", "zai"] as const).map(async (family) => {
          let token: string | null = null;
          try {
            token = (await credentialService.load(`oauth:${family}:access_token`))?.trim() || null;
            if (!token) return { token, products: [] };
            const result = await codingPlanSubscriptionService.getEnterprisePricing({
              authenticated: true,
              family,
            });
            return { token, products: result.productList };
          } catch (error) {
            logger.warn("[purchaseTelemetry] failed to read team plans", { family, error });
            return { token, products: null };
          }
        }),
      ),
    ]).then(([, sources]) => {
      if (!cancelled)
        setTeams((previous) => ({
          user,
          view: providerSettingsView,
          generation,
          sources: sources.map((source, index) => {
            // Refresh failure does not mean no purchase; the successful result will only be reused when the account, family and credentials are consistent.
            const cached = previous?.sources[index];
            return source.products === null &&
              source.token &&
              previous?.user === user &&
              cached?.token === source.token
              ? { ...source, products: cached.products }
              : source;
          }),
        }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    credentialService,
    codingPlanSubscriptionService,
    user,
    providerSettingsView,
    generation,
    loading,
    refresh,
  ]);
  const sameIdentity = teams?.user === user && teams.view === providerSettingsView;
  const current = sameIdentity && teams.generation === generation;
  const usableTeams = sameIdentity && teams.sources.every((source) => source.products !== null);
  const planIds: readonly string[] = [
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  ];
  // The account model has no Personal API Key; reuse the entitlement hook's read-only Access check, and do not filter out unselected/disabled plans.
  const required = planIds
    .filter((providerId) =>
      resolveAccountProviderInspectionAccess(providerSettingsView, providerId),
    )
    .map((providerId) => entitlements[providerId]);
  // The error describes this refresh only; it must not invalidate a still-usable historical snapshot (including a successful confirmation that no plan exists).
  const missing = required.filter((item) => {
    const snapshot = item?.snapshot;
    return (
      !snapshot ||
      (snapshot.unavailableReason !== "no_plan" &&
        (!snapshot.authenticated || snapshot.unavailableReason))
    );
  });
  const pending = loading || !current || missing.some((item) => item?.loading);
  const failed = !usableTeams || missing.length > 0;
  const status =
    state.status === "error" ? "error" : pending ? "loading" : failed ? "error" : "ready";
  useEffect(() => {
    logger.debug("[purchaseTelemetry] plan entry query status", {
      status,
      configuredSources: required.length,
      generation,
    });
  }, [status, required.length, generation]);
  return {
    status,
    retry,
    entryPlanList:
      status === "ready"
        ? buildOwnedEntryPlanList({
            snapshots: required.map((item) => item?.snapshot),
            teamProducts: teams?.sources.flatMap((source) => source.products ?? []) ?? [],
          })
        : "",
  };
}
