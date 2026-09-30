import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, type ApiClient } from "@zcode/shared";
import type { OAuthRuntimeConfig } from "../runtimeConfig.js";
import { BigModelProviderAdapter } from "./bigmodelProviderAdapter.js";
import type { OAuthProviderAdapter } from "./providerAdapter.js";
import { ZaiProviderAdapter } from "./zaiProviderAdapter.js";

/** Creates the usable provider adapters from the runtime configuration */
export function createOAuthProviderAdapters(
  config: OAuthRuntimeConfig,
  options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
  const adapters: OAuthProviderAdapter[] = [];
  const apiClient = options.apiClient;
  if (!apiClient) {
    throw new Error(
      "ApiClient is not injected: OAuth provider adapters must receive an apiClient through Providers",
    );
  }

  for (const providerConfig of config.providers) {
    switch (providerConfig.id) {
      case BIGMODEL_PROVIDER_ID:
        adapters.push(new BigModelProviderAdapter(providerConfig, apiClient));
        break;
      case ZAI_PROVIDER_ID:
        adapters.push(new ZaiProviderAdapter(providerConfig, apiClient));
        break;
      default:
        // Unknown providers are ignored directly to prevent a single configuration error from bringing down all login capabilities.
        break;
    }
  }

  return adapters;
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";
