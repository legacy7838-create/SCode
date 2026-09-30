import {
  projectModelSelectionProviderView,
  type ModelSelectionView,
  type ProviderRegistryView,
} from "@zcode/provider";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";

/** Off-Peak only projects its fixed hidden Providers; hidden candidates are never opened to the normal user selection surface. */
export function buildOffPeakModelSelectionView(registry: ProviderRegistryView): ModelSelectionView {
  const providerIds = new Set<string>(Object.values(OFF_PEAK_PROVIDER_IDS));
  const providers = registry.providers.filter(
    (candidate) =>
      providerIds.has(candidate.providerId) && candidate.config.visibility === "hidden",
  );
  return Object.freeze({
    revision: registry.revision,
    providers: Object.freeze(providers.map(projectModelSelectionProviderView)),
  });
}
