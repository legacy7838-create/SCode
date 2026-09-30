import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
} from "@zcode/shared";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** The Host and the managed Worker share the same identity classification; resolution itself is still the job of the pure Provider Facade. */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    (providerId) => {
      // Start is resolved based on the real ID; it cannot participate in the uniqueness judgment of paid connections or be mapped to paid quotas.
      if (isStartPlanModelProviderId(providerId)) return "ordinary";
      if (isBuiltinModelProviderId(providerId)) return "account-plan";
      if (Object.values(OFF_PEAK_PROVIDER_IDS).some((id) => id === providerId))
        return "account-offpeak";
      return "ordinary";
    },
    resolveLegacyReasoningLevel,
  );
}
