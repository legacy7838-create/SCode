import { useEffect, useMemo } from "react";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import {
  useDynamicWorkflowAvailabilityStore,
  type DynamicWorkflowAvailabilitySnapshot,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

/**
 * Read the dynamic-workflow rollout snapshot. Read-only, and never triggers a request: fetching is
 * solely the loader's responsibility inside Root. Consumers (the automation page, the run panel)
 * may live inside a workspace-scoped ServiceProvider (the remote Host's accessor), and letting each
 * of them fetch would overwrite the app-level copy.
 */
export function useDynamicWorkflowAvailability(): DynamicWorkflowAvailabilitySnapshot {
  // Subscribe field by field: a selector returning an object literal is a new reference every time, and useSyncExternalStore would treat it as a change.
  const status = useDynamicWorkflowAvailabilityStore((state) => state.status);
  const enabled = useDynamicWorkflowAvailabilityStore((state) => state.enabled);
  const config = useDynamicWorkflowAvailabilityStore((state) => state.config);
  return useMemo(() => ({ status, enabled, config }), [config, enabled, status]);
}

/**
 * App-session-level fetching, mounted once in Root. It retries when the service changes (mobile
 * `/remote` completing the workspace bridge); for the fetching and failure-retry rules see
 * dynamicWorkflowAvailabilityStore.
 */
export function useDynamicWorkflowAvailabilityLoader(
  service: ICodingPlanSubscriptionService,
): void {
  const ensureLoaded = useDynamicWorkflowAvailabilityStore((state) => state.ensureLoaded);
  useEffect(() => {
    void ensureLoaded(service);
  }, [ensureLoaded, service]);
}
