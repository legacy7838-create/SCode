import type { OAuthProviderId } from "@zcode/shared";
import { createBigModelProviderRuntimeConfig } from "./providers/bigmodelProviderConfig.js";
import { createZaiProviderRuntimeConfig } from "./providers/zaiProviderConfig.js";

/** Provider runtime configuration (visible only in the host process) */
export interface OAuthProviderRuntimeConfig {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  appId: string;
  redirectUri: string;
  businessLoginUrl?: string;
  appSecret?: string;
}

/** Global OAuth runtime configuration */
export interface OAuthRuntimeConfig {
  providers: OAuthProviderRuntimeConfig[];
}

/**
 * Builds the OAuth configuration from the runtime environment variables.
 *
 * Note: this may only be used in the host process, to avoid exposing sensitive configuration to the renderer.
 */
export function createOAuthRuntimeConfig(env: NodeJS.ProcessEnv = process.env): OAuthRuntimeConfig {
  return {
    providers: [createBigModelProviderRuntimeConfig(env), createZaiProviderRuntimeConfig(env)],
  };
}
