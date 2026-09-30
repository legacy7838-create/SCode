import { dirname, join } from "node:path";
import {
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  selectResourceURL,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type { Logger } from "@zcode/contracts";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  invalidateCanonicalCredentials,
  loadCredentialPair,
  publishCanonicalCredentials,
  type CredentialPairSnapshot,
} from "./oauth-credentials.js";
import {
  createInteractiveAuthorizationRequiredError,
  createTemporaryRefreshFailureError,
} from "./oauth-errors.js";
import { sanitizeKeyPrefix } from "./oauth-lease.js";
import { loadDiscoveryRecord, saveDiscoveryRecord } from "./oauth-shared.js";

/**
 * Acquisition budget for the refresh lock.
 *
 * Must cover the network budget inside the lock (one discovery + one token request), otherwise a waiter times
 * out before the winner has published its result. `withFileLock` defaults to only 8 seconds (privateFilePersistence.ts:9), which is not enough.
 */
const REFRESH_LOCK_MAX_WAIT_MS = 45_000;

interface RefreshMcpOAuthTokensInput {
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  /**
   * reactive = triggered by the 401's `onUnauthorized`.
   *
   * This is what decides the semantics on a network failure: proactive (refresh ahead of expiry) may fail-soft and return the current value,
   * because that token has not been rejected by the resource server yet; reactive may not — it has just been rejected, so returning
   * it guarantees a second 401 and a thrown `ClientHttpAuthentication`, and it also misreads a transient AS outage as a call for interactive authorization.
   */
  reactive: boolean;
  serverName: string;
  serverUrl: string;
  /** The statically configured clientId. When one exists, `invalid_client` cannot self-heal through interactive authorization. */
  staticClientId?: string;
}

interface ResolvedAsMetadata {
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  resource?: URL;
}

/**
 * Refresh the access token inside a cross-process single-flight lock, returning a usable access token.
 *
 * The concurrent-refresh problem: multiple CLI processes share one credentials file, and `withFileLock` covers only the credential reads/writes, not the
 * network token exchange. When the access token expires, every process refreshes with the same refresh token at once, trips
 * the authorization server's rotation reuse-detection, gets the whole token family revoked, and degrades into a fresh authorization in the end.
 */
export async function refreshMcpOAuthTokensUnderLock(
  input: RefreshMcpOAuthTokensInput,
): Promise<string> {
  const observedGeneration = (await loadCredentialPair(input.credentialStore, input.keyPrefix))
    ?.generation;
  const lockPath = resolveRefreshLockPath(input.credentialStore.filePath, input.keyPrefix);

  try {
    return await withFileLock(
      lockPath,
      async () => await refreshLocked(input, observedGeneration),
      {
        lockMaxWaitMs: REFRESH_LOCK_MAX_WAIT_MS,
      },
    );
  } catch (error) {
    if (!isZCodeFileLockTimeoutError(error)) throw error;
    // Waiting for the lock to time out does not mean that the refresh failed: the winner may have already published the results. Reread it first, confirm the replacement and use it directly if you have the token.
    const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);
    if (current?.tokens && current.generation !== observedGeneration) {
      return current.tokens.access_token;
    }
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
}

async function refreshLocked(
  input: RefreshMcpOAuthTokensInput,
  observedGeneration: string | undefined,
): Promise<string> {
  const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);

  // Merge: Wait for others to have refreshed during the lock period and then reuse it directly, eliminating two requests. This is the key to rotation reuse-detection.
  if (current?.tokens && current.generation !== observedGeneration) {
    return current.tokens.access_token;
  }
  if (!current?.tokens) {
    // The generation changed but the winner did not leave a token (for example, it received an invalid_grant): it cannot be regarded as "no credentials"
    // Return silently and must switch to interactive authorization.
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_credentials",
      serverName: input.serverName,
    });
  }
  const refreshToken = current.tokens.refresh_token;
  const clientInformation = current.clientInformation;
  if (!refreshToken || !clientInformation) {
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_refresh_token",
      serverName: input.serverName,
    });
  }

  let resolved: ResolvedAsMetadata;
  try {
    resolved = await resolveAsMetadata(input, current);
  } catch (error) {
    // Failure of discovery must not be treated as a failure of grant.
    return failSoft(input, current, error);
  }

  try {
    const next = await refreshAuthorization(resolved.authorizationServerUrl, {
      clientInformation,
      refreshToken,
      ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
      ...(resolved.resource ? { resource: resolved.resource } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    const published = await publishCanonicalCredentials(input.credentialStore, input.keyPrefix, {
      clientInformation,
      ...(current.issuer ? { issuer: current.issuer } : {}),
      publishedBy: `refresh:${input.keyPrefix}`,
      tokens: next,
    });
    input.logger?.info("MCP OAuth access token refreshed", {
      event: "mcp.oauth.refresh.completed",
      credentialKeyPrefix: input.keyPrefix,
      mcpServerName: input.serverName,
      processId: process.pid,
      publishedGeneration: published.generation.slice(0, 12),
      reactive: input.reactive,
      refreshTokenRotated: next.refresh_token !== refreshToken,
      status: "completed",
    });
    return next.access_token;
  } catch (error) {
    return await handleRefreshFailure(input, current, error);
  }
}

async function handleRefreshFailure(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): Promise<never | string> {
  const oauthErrorCode = error instanceof OAuthError ? error.code : undefined;
  input.logger?.warn("MCP OAuth access token refresh failed", {
    event: "mcp.oauth.refresh.failed",
    credentialKeyPrefix: input.keyPrefix,
    credentialSource: current.source,
    mcpServerName: input.serverName,
    oauthErrorCode,
    processId: process.pid,
    reactive: input.reactive,
    status: "failed",
  });

  if (oauthErrorCode === OAuthErrorCode.InvalidGrant) {
    // Deterministic invalidation: the refresh token has been revoked or expired. CAS clears tokens and retains the client as the re-authorization seed.
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "tokens",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_grant",
      serverName: input.serverName,
    });
  }

  if (
    oauthErrorCode === OAuthErrorCode.InvalidClient ||
    oauthErrorCode === OAuthErrorCode.UnauthorizedClient
  ) {
    if (input.staticClientId) {
      // The invalid_client of the statically configured client cannot be self-healed by interactive authorization: Phase 2 will still use the same client.
      // Delicensing only creates a cycle. Report configuration errors.
      throw new Error(
        `MCP server ${input.serverName} OAuth client was rejected by the authorization server (invalid_client). ` +
          `The configured clientId is not usable; fix the MCP oauth configuration.`,
        { cause: error },
      );
    }
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "all",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_client",
      serverName: input.serverName,
    });
  }

  return failSoft(input, current, error);
}

/**
 * Non-deterministic failures (network, 5xx, `server_error`).
 *
 * proactive returns the current value: the token has not been rejected yet, so let the request proceed and leave the final word
 * to the 401 path. reactive must throw a transient error: the current value has just been rejected, so returning it guarantees another 401.
 */
function failSoft(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): string {
  if (input.reactive || !current.tokens) {
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
  return current.tokens.access_token;
}

/**
 * Resolve the authorization server metadata and the validated resource.
 *
 * The discovery record carries a TTL and is shared with Phase 2; `resource` must be resolved and carried into the refresh request (RFC
 * 8707). The SDK's own refresh passes it, and since we bypass `auth()` we have to supply it ourselves, otherwise the audience binding is lost.
 */
async function resolveAsMetadata(
  input: Pick<
    RefreshMcpOAuthTokensInput,
    "credentialStore" | "fetchFn" | "keyPrefix" | "serverUrl"
  >,
  current: Pick<CredentialPairSnapshot, "issuer">,
): Promise<ResolvedAsMetadata> {
  const cached = await loadDiscoveryRecord(input.credentialStore, input.keyPrefix, {
    ...(current.issuer ? { expectedIssuer: current.issuer } : {}),
  });
  const discovered: OAuthDiscoveryState =
    cached ??
    (await discoverOAuthServerInfo(input.serverUrl, {
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    }));
  if (!cached) {
    await saveDiscoveryRecord(input.credentialStore, input.keyPrefix, discovered);
  }

  const resource = await selectResourceURL(
    input.serverUrl,
    // selectResourceURL reads only provider's validateResourceURL; there is no provider here, just pass an empty shell.
    {} as never,
    discovered.resourceMetadata,
  );
  return {
    authorizationServerUrl: discovered.authorizationServerUrl,
    ...(discovered.authorizationServerMetadata
      ? { metadata: discovered.authorizationServerMetadata }
      : {}),
    ...(resource ? { resource } : {}),
  };
}

/**
 * Path of the refresh lock file.
 *
 * Must be independent of the credentials file: the lock body calls `publishCanonicalCredentials`,
 * which locks credentials.json itself; the same path would reenter into a self-deadlock. The
 * basename holds only a hash and hyphens (Windows filenames do not allow colons).
 */
function resolveRefreshLockPath(credentialsFilePath: string, keyPrefix: string): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.refresh`);
}
