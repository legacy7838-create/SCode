import type { IServiceAccessor } from "@zcode/services";
import {
  type ProviderFamilyDomain,
  resolveModelProviderFamilyIdByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";

function inferProviderFamilyDomainFromSelection(
  providers: readonly { readonly providerId: string }[],
): ProviderFamilyDomain | null {
  const usableDomains = new Set<ProviderFamilyDomain>();

  for (const provider of providers) {
    const domain = resolveModelProviderFamilyIdByProviderId(provider.providerId);
    if (!domain) continue;
    usableDomains.add(domain);
  }

  if (usableDomains.size !== 1) {
    return null;
  }
  return [...usableDomains][0] ?? null;
}

export async function ensureProviderFamilyDomainMigration(
  services: Pick<IServiceAccessor, "settingService" | "oauthService" | "modelSelectionService">,
): Promise<void> {
  const settings = await services.settingService.get();
  if (settings.providerFamilyDomain || settings.providerFamilyDomainMigrated) {
    return;
  }

  let inferredDomain = resolveProviderFamilyDomainFromOAuthProvider(
    await services.oauthService.getActiveProvider(),
  );
  let selectableProviders: readonly { readonly providerId: string }[] | null = null;

  if (!inferredDomain) {
    try {
      selectableProviders = (await services.modelSelectionService.getView()).providers;
      inferredDomain = inferProviderFamilyDomainFromSelection(selectableProviders);
    } catch (error) {
      logger.warn("[providerFamilyDomainMigration] failed to read model selection view", {
        error,
      });
    }
  }

  if (!inferredDomain && selectableProviders?.length === 0) {
    // The OAuth active provider and Registry may not have been restored after early startup.
    // At this time, if the "empty result" is marked as migrated, subsequent draft preheating will have the old Start Plan preference when the selectedKey is empty.
    logger.info(
      "[providerFamilyDomainMigration] provider family domain migration waiting for model selection view",
    );
    return;
  }

  await services.settingService.update({
    ...(inferredDomain ? { providerFamilyDomain: inferredDomain } : {}),
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
  });

  logger.info("[providerFamilyDomainMigration] provider family domain migration complete", {
    inferredDomain,
  });
}
