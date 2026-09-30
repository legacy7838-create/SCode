import { isApiKeyAccess, type ProviderApiType } from "@zcode/provider";
import {
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";

export interface ProviderDraftValues {
  nameValue: string;
  apiFormat: ProviderApiType;
  baseUrlValue: string;
  apiKeyValue: string;
}

function normalizeConfiguredBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return normalized;
    const marker = `${parsed.protocol}//${parsed.host}`;
    const duplicateIndex = normalized.indexOf(marker, marker.length);
    if (duplicateIndex < 0) return normalized;
    const firstUrl = normalized.slice(0, duplicateIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(duplicateIndex).replace(/\/+$/, "");
    // The old settings page used to concatenate the complete Base URL as a path; only two sections of the same security form were collapsed.
    return firstUrl === secondUrl ? firstUrl : normalized;
  } catch {
    return normalized;
  }
}

export function resolvePendingProviderDraftSave({
  provider,
  draft,
  readOnlyEndpoints,
  nameConfirmed = false,
}: {
  provider: ProviderSettingsFormProvider;
  draft: ProviderDraftValues;
  readOnlyEndpoints?: boolean;
  nameConfirmed?: boolean;
  now: () => number;
}): ProviderSettingsFormProvider | null {
  const label = draft.nameValue.trim();
  const baseURL = normalizeConfiguredBaseUrl(draft.baseUrlValue);
  // The ID and default protocol are only used for form display with empty configuration and are not overridden by users; dirty checking and form initialization must come from the same source.
  // Names are only confirmed on Enter/Out of Focus; connected idle saves, tests, and uninstalls cannot entrain unconfirmed names.
  const labelChanged = nameConfirmed && label !== getProviderFormLabel(provider);
  const typeChanged =
    !readOnlyEndpoints && draft.apiFormat !== (provider.config.api?.type ?? "anthropic-messages");
  const urlChanged = !readOnlyEndpoints && baseURL !== (provider.config.api?.baseUrl ?? "");
  const keyChanged =
    isApiKeyAccess(provider.config.access) &&
    draft.apiKeyValue !== (provider.config.access.apiKey ?? "");
  if (!labelChanged && !typeChanged && !urlChanged && !keyChanged) return null;

  // The form only has a name, connection type, address, and Key; rebuilding the entire API will remove hidden headers,
  // Saving the Effective object will materialize the inherited fields. Apply only the modified leaves to their respective baselines.
  const apiChanges = {
    ...(typeChanged || (urlChanged && !provider.config.api?.type) ? { type: draft.apiFormat } : {}),
    ...(urlChanged ? { baseUrl: baseURL || undefined } : {}),
  };
  const api =
    typeChanged || urlChanged ? { ...provider.config.api, ...apiChanges } : provider.config.api;
  const access =
    keyChanged && isApiKeyAccess(provider.config.access)
      ? { ...provider.config.access, apiKey: draft.apiKeyValue }
      : provider.config.access;
  const config = {
    ...provider.config,
    access,
    api,
  };

  const personalConfig = {
    ...provider.personalConfig,
    ...(keyChanged && isApiKeyAccess(provider.config.access)
      ? {
          access: {
            ...provider.personalConfig.access,
            type: provider.config.access.type,
            apiKey: draft.apiKeyValue,
          },
        }
      : {}),
    ...(typeChanged || urlChanged
      ? { api: { ...provider.personalConfig.api, ...apiChanges } }
      : {}),
  };

  if (!labelChanged && JSON.stringify(config) === JSON.stringify(provider.config)) {
    return null;
  }
  return {
    ...provider,
    ...(labelChanged ? { providerName: label || null, providerNameUpdate: label || null } : {}),
    config,
    personalConfig,
  };
}
