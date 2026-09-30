import { useEffect } from "react";
import type { AppSettings } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";

/**
 * The two off-peak entry points share the initialization / connection / Registry notification
 * boundary, and no eligibility state is kept separately in the component.
 */
export function useOffPeakEligibility(
  settings: AppSettings | null | undefined,
  registryRevision: number | undefined,
): void {
  const { offPeakTaskService, codingPlanSubscriptionService } = useServices();
  const initialize = useOffPeakTaskStore((state) => state.initialize);
  const refresh = useOffPeakTaskStore((state) => state.refreshCodingPlanSupport);
  const family = settings?.providerFamilyDomain;
  const connection = family ? settings?.providerFamilyConnectionSelections?.[family] : undefined;
  const freshnessKey = settings
    ? JSON.stringify([registryRevision, family, connection])
    : undefined;

  useEffect(() => {
    void initialize({ offPeakTaskService, codingPlanSubscriptionService });
  }, [initialize, offPeakTaskService, codingPlanSubscriptionService]);

  useEffect(() => {
    if (freshnessKey === undefined) return;
    // A Settings change is only an invalidation signal; the ProviderSettings View revision comes from an already-completed Registry publication.
    // Even if the selection is unchanged, the account becoming ready later triggers a re-query; duplicate notifications with the same key from both entry points are deduped by the Store.
    void refresh(offPeakTaskService, freshnessKey);
  }, [freshnessKey, offPeakTaskService, refresh]);
}
