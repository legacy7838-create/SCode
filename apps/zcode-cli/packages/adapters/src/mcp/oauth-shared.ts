import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

const MCP_OAUTH_DISCOVERY_STATE_KEY = "discovery_state";
const MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY = "discovery_state_fetched_at";

/** Lifetime of the cached discovery metadata. Rediscover once it expires, so a long-lived process never keeps using stale AS metadata whose endpoint has since changed. */
const MCP_OAUTH_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export interface McpOAuthAuthorizationContext {
  authorizationUrl: string;
  redirectUrl: string;
  serverName: string;
}

/**
 * The discovery record's timestamp lives in its own key instead of wrapping
 * `discovery_state` itself.
 *
 * The value shape of `discovery_state` must stay the bare `OAuthDiscoveryState`: the CLI and
 * the desktop upgrade independently while sharing one credential file, so replacing it with a
 * `{fetched_at, state}` wrapper would make a reader that has not upgraded read an object with
 * no `authorizationServerUrl` in it and silently lose the discovery cache. Appending one
 * optional key is the backward-compatible move.
 */
export async function saveDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  state: OAuthDiscoveryState,
  now = Date.now(),
): Promise<void> {
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY)]: JSON.stringify(state),
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY)]: String(now),
  });
}

/**
 * Read the discovery record if it has not expired.
 *
 * A missing timestamp (written by an older version) or an expired record both return
 * `undefined`, so the caller rediscovers once; the next save writes the timestamp back and
 * the store heals itself.
 */
export async function loadDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  options: { expectedIssuer?: string; now?: number; ttlMs?: number } = {},
): Promise<OAuthDiscoveryState | undefined> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MCP_OAUTH_DISCOVERY_TTL_MS;
  const stateKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY);
  const fetchedAtKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY);
  const values = await credentialStore.loadMany([stateKey, fetchedAtKey]);
  const raw = values[stateKey];
  if (!raw) return undefined;

  const fetchedAt = Number(values[fetchedAtKey]);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt >= ttlMs) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.authorizationServerUrl !== "string") return undefined;

  const state = parsed as unknown as OAuthDiscoveryState;
  if (options.expectedIssuer && !issuersMatch(state, options.expectedIssuer)) {
    // The issuer recorded by canonical is inconsistent with the cache: the authorization server has changed and the cache must be invalidated.
    return undefined;
  }
  return state;
}

function issuersMatch(state: OAuthDiscoveryState, expectedIssuer: string): boolean {
  const cachedIssuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
  if (!cachedIssuer) return false;
  return normalizeIssuer(cachedIssuer) === normalizeIssuer(expectedIssuer);
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
