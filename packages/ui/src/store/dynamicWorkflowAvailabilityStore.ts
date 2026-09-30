import { create } from "zustand";
import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import { logger } from "@/logger.js";

// ============================================================
// The only copy of the dynamic workflow grayscale snapshot in the renderer
// ============================================================
//
// Host is the only decision-maker, and only the copy of `{ mode, enabled, source }` given by it is cached:
//   - Only fetched once per app session. The request is made by the loader (the only owner) in Root.
//     The automation page and run panel are read-only and will not be sent again respectively;
//   - Without forceRefresh. The Host uses the same 1h snapshot to deduce the tool policy sent to the CLI.
//     A separate force of renderer will make it possible to have differences such as "the interface has an entrance / the model has no tools";
//     To force refresh() to be retrieved;
//   - Request failure is handled as disabled (fail-closed, the same decision as resolveDynamicWorkflowClientConfig),
//     But **Do not remember failure**: Change a service instance and try again. What the phone `/remote` got before bridging the workspace was
//     An unsupported proxy will inevitably throw an error. After the bridge is completed, the accessor will be replaced, and it must be corrected that time.

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** The loading period is always false: if it is unknown, it will not be provided. The entrance would rather appear half a beat later than flash and then close it. */
  readonly enabled: boolean;
  /** It is null when it is not ready or fails to retrieve the data; `source` is only used for observation to distinguish between "server port" and "local coverage". */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** The first time the number is retrieved; after the same service has produced results, it is no-op, and concurrent calls share the same request. */
  ensureLoaded(service: ICodingPlanSubscriptionService): Promise<void>;
  /** Bypassing latch and Host's 1h snapshot cache refetch (forceRefresh). */
  refresh(service: ICodingPlanSubscriptionService): Promise<void>;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

let inFlight: Promise<void> | null = null;
/** A service instance that has already produced a result (success or failure); the same instance will not be requested again. */
let settledService: ICodingPlanSubscriptionService | null = null;

type PublishSnapshot = (snapshot: DynamicWorkflowAvailabilitySnapshot) => void;

async function loadDynamicWorkflowConfig(
  service: ICodingPlanSubscriptionService,
  options: { forceRefresh?: boolean },
  publish: PublishSnapshot,
): Promise<void> {
  try {
    const config = await service.getDynamicWorkflowClientConfig(options);
    publish({ status: "ready", enabled: config.enabled === true, config });
  } catch (error) {
    logger.warn(
      "[dynamic-workflow] failed to read rollout snapshot, treating as not matched",
      error instanceof Error ? error.message : String(error),
    );
    publish({ status: "ready", enabled: false, config: null });
  } finally {
    settledService = service;
  }
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set, get) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(service): Promise<void> {
      if (settledService === service) return Promise.resolve();
      if (inFlight) {
        // The one on the way may be another service (the accessor will change during the mobile `/remote` bridging process): it will be judged again after it is queued.
        // If this is the one in transit, settledService is already equal to it, and the recursion will immediately hit the no-op above.
        return inFlight.then(() => get().ensureLoaded(service));
      }
      const run = loadDynamicWorkflowConfig(service, {}, set).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },

    refresh(service): Promise<void> {
      return loadDynamicWorkflowConfig(service, { forceRefresh: true }, set);
    },
  }),
);
