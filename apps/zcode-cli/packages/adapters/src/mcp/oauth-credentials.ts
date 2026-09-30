import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";

export const MCP_OAUTH_CANONICAL_CREDENTIALS_KEY = "authorization_credentials";
const MCP_OAUTH_LEGACY_CLIENT_KEY = "client_information";
const MCP_OAUTH_LEGACY_TOKENS_KEY = "tokens";
export const MCP_OAUTH_CREDENTIALS_VERSION = 2;
export const MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS = new Set([1, MCP_OAUTH_CREDENTIALS_VERSION]);

/**
 * Canonical credential pair.
 *
 * `generation`, `obtained_at`, `expires_at` and `issuer` are all **optional new fields**, and they do not bump the version:
 * appending optional fields stays backward compatible with old readers (an old reader simply ignores unknown fields),
 * whereas bumping the version would make un-upgraded CLI/desktop treat the new record as an unknown version, drop it
 * wholesale and fall back to the legacy mirror, losing the pair guarantee.
 */
export interface McpOAuthCanonicalCredentials {
  client_information: OAuthClientInformationMixed;
  /** Absolute expiry point (epoch ms) derived from `expires_in` and `obtained_at`. */
  expires_at?: number;
  /**
   * Random id, unique per publication.
   *
   * It must not reuse `published_by`: that is a transaction id derived from the OAuth state, and multiple refreshes
   * within the same transaction never change it, so it cannot carry the duties of letting a follower observe the
   * generational turnover and invalidate via CAS. A random id also eliminates ABA.
   */
  generation?: string;
  /** Authorization server issuer. This round only stores the field; it does not participate in credential keying. */
  issuer?: string;
  /** Token acquisition time (epoch ms). `OAuthTokens` only carries `expires_in`, and without this the real expiry point cannot be computed across processes. */
  obtained_at?: number;
  published_by: string;
  tokens: OAuthTokens;
  version: 1 | typeof MCP_OAUTH_CREDENTIALS_VERSION;
}

export interface CanonicalCredentialSnapshot {
  clientInformation: OAuthClientInformationMixed;
  expiresAt?: number;
  generation: string;
  issuer?: string;
  obtainedAt?: number;
  /** Raw JSON, used for compare-and-delete. */
  raw: string;
  tokens: OAuthTokens;
}

export function mcpOAuthCredentialKey(keyPrefix: string, name: string): string {
  return `${keyPrefix}:${name}`;
}

function createCredentialGeneration(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Migration-period baseline: old records have no `generation`, so a stable hash of the canonical raw content stands in for it.
 * A content change is a generation change, which is enough to support a follower's "did it turn over" decision.
 */
function resolveCredentialGeneration(canonical: McpOAuthCanonicalCredentials, raw: string): string {
  if (typeof canonical.generation === "string" && canonical.generation.length > 0) {
    return canonical.generation;
  }
  return `legacy-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

export function isCanonicalCredentials(value: unknown): value is McpOAuthCanonicalCredentials {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(value.version)
  ) {
    return false;
  }
  if (typeof value.published_by !== "string" || value.published_by.length === 0) return false;
  if (!isRecord(value.client_information) || !isRecord(value.tokens)) return false;
  return (
    typeof value.client_information.client_id === "string" &&
    typeof value.tokens.access_token === "string" &&
    typeof value.tokens.token_type === "string"
  );
}

/**
 * Reads only the canonical pair and performs no legacy compatibility derivation.
 *
 * Both the Phase 2 baseline generation and the Phase 1 refresh need only the canonical record; the interleaved
 * compatibility logic for the legacy mirror stays inside the provider.
 */
export async function loadCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CanonicalCredentialSnapshot | undefined> {
  const key = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const raw = await credentialStore.load(key);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isCanonicalCredentials(parsed)) return undefined;
  return {
    clientInformation: parsed.client_information,
    ...(parsed.expires_at === undefined ? {} : { expiresAt: parsed.expires_at }),
    generation: resolveCredentialGeneration(parsed, raw),
    ...(parsed.issuer === undefined ? {} : { issuer: parsed.issuer }),
    ...(parsed.obtained_at === undefined ? {} : { obtainedAt: parsed.obtained_at }),
    raw,
    tokens: parsed.tokens,
  };
}

interface PublishCanonicalCredentialsInput {
  clientInformation: OAuthClientInformationMixed;
  issuer?: string;
  obtainedAt?: number;
  publishedBy: string;
  tokens: OAuthTokens;
}

interface PublishedCanonicalCredentials {
  canonical: McpOAuthCanonicalCredentials;
  generation: string;
  legacyClientRaw: string;
  legacyTokensRaw: string;
  raw: string;
}

/**
 * Publishes the canonical pair and the legacy mirror atomically.
 *
 * The client and the refresh token must come from the same authorization, so all three keys must be written in one
 * cross-process read-modify-write critical section of the shared credential store; writing them separately would let
 * the last-written client and token come from different transactions. The legacy mirror keeps being maintained during
 * the compatibility window so that un-upgraded CLI/Desktop can still read.
 */
export async function publishCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  input: PublishCanonicalCredentialsInput,
): Promise<PublishedCanonicalCredentials> {
  const obtainedAt = input.obtainedAt ?? Date.now();
  const expiresAt =
    typeof input.tokens.expires_in === "number" && Number.isFinite(input.tokens.expires_in)
      ? obtainedAt + input.tokens.expires_in * 1000
      : undefined;
  const generation = createCredentialGeneration();
  const canonical: McpOAuthCanonicalCredentials = {
    client_information: input.clientInformation,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    generation,
    ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
    obtained_at: obtainedAt,
    published_by: input.publishedBy,
    tokens: input.tokens,
    version: MCP_OAUTH_CREDENTIALS_VERSION,
  };
  const raw = JSON.stringify(canonical);
  const legacyClientRaw = JSON.stringify(input.clientInformation);
  const legacyTokensRaw = JSON.stringify(input.tokens);
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]: raw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY)]: legacyClientRaw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY)]: legacyTokensRaw,
  });
  return { canonical, generation, legacyClientRaw, legacyTokensRaw, raw };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Safety margin used by the access token near-expiry decision. */
const MCP_OAUTH_EXPIRY_SKEW_MS = 30_000;

/**
 * Whether the token has to be refreshed before it is handed to a request header.
 *
 * Without `expires_at` (an old record, or a server that returned no `expires_in`) it counts as near expiry
 * unconditionally: `OAuthTokens` carries no acquisition time, so the real expiry point cannot be computed -- better to
 * take the lock and attempt one refresh than to send out a token that may already be expired.
 */
export function isCanonicalTokenNearExpiry(
  snapshot: Pick<CanonicalCredentialSnapshot, "expiresAt">,
  now = Date.now(),
  skewMs = MCP_OAUTH_EXPIRY_SKEW_MS,
): boolean {
  if (snapshot.expiresAt === undefined) return true;
  return now >= snapshot.expiresAt - skewMs;
}

type CanonicalInvalidationScope = "tokens" | "all";

/**
 * Conditional invalidation against the canonical snapshot.
 *
 * The delete only happens while the canonical current value still equals `expectedRaw`, so when another transaction
 * has already published a new pair this invalidation is abandoned as a whole and the winner is never removed by
 * mistake. `tokens` keeps the legacy client as the seed for a re-authorization; `all` is for `invalid_client`, where
 * the client and the token must be discarded as a whole pair.
 */
export async function invalidateCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  expectedRaw: string,
  scope: CanonicalInvalidationScope,
): Promise<boolean> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const keysToDelete = [
    canonicalKey,
    mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY),
  ];
  if (scope === "all") {
    keysToDelete.push(mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY));
  }
  return await credentialStore.deleteManyIfValue(canonicalKey, expectedRaw, keysToDelete);
}

export interface CredentialPairSnapshot {
  clientInformation?: OAuthClientInformationMixed;
  expiresAt?: number;
  /** The generation when the canonical record is available; derived from the content when only the legacy record exists, still usable for observing turnover. */
  generation?: string;
  issuer?: string;
  obtainedAt?: number;
  /** Canonical raw JSON; undefined when only the legacy record exists (no canonical CAS possible). */
  raw?: string;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

/**
 * Reads the canonical record and the legacy mirror and derives one usable pair according to the compatibility rules.
 */
export async function loadCredentialPair(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CredentialPairSnapshot | undefined> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const legacyClientKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY);
  const legacyTokensKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY);
  const values = await credentialStore.loadMany([canonicalKey, legacyClientKey, legacyTokensKey]);
  return deriveCredentialPair({
    canonicalRaw: values[canonicalKey] ?? undefined,
    legacyClientRaw: values[legacyClientKey] ?? undefined,
    legacyTokensRaw: values[legacyTokensKey] ?? undefined,
  });
}

/**
 * Pair derivation rules for the compatibility window (a pure function, no I/O).
 *
 * It is extracted into a pure function so that "callers that already hold the raw snapshot" (the provider, which
 * needs the raw value for compare-and-delete) reuse the very same rules instead of reading the credential file a
 * second time -- writing this interleaved compatibility branch twice in two places is guaranteed to diverge.
 *
 * Background of the rules: during the compatibility window the CLI and the desktop may be different versions, an old
 * process writes only the legacy key while a new process writes canonical + mirror. What is decided here is whether,
 * for the old generation-less format, a change in legacy can be *proven* to belong to the same authorization.
 */
export function deriveCredentialPair(input: {
  canonicalRaw?: string;
  legacyClientRaw?: string;
  legacyTokensRaw?: string;
}): CredentialPairSnapshot | undefined {
  const canonicalParsed = parseJson<unknown>(input.canonicalRaw);
  const canonical =
    canonicalParsed !== undefined && isCanonicalCredentials(canonicalParsed)
      ? canonicalParsed
      : undefined;
  const legacyClient = parseJson<OAuthClientInformationMixed>(input.legacyClientRaw);
  const legacyTokens = parseJson<OAuthTokens>(input.legacyTokensRaw);

  if (canonical && input.canonicalRaw) {
    const canonicalSnapshot: CredentialPairSnapshot = {
      clientInformation: canonical.client_information,
      ...(canonical.expires_at === undefined ? {} : { expiresAt: canonical.expires_at }),
      generation: resolveCredentialGeneration(canonical, input.canonicalRaw),
      ...(canonical.issuer === undefined ? {} : { issuer: canonical.issuer }),
      ...(canonical.obtained_at === undefined ? {} : { obtainedAt: canonical.obtained_at }),
      raw: input.canonicalRaw,
      source: "canonical",
      tokens: canonical.tokens,
    };
    if (canonical.version === 1) {
      const canAdoptLegacyTokens =
        legacyTokens !== undefined &&
        (!legacyClient || isDeepStrictEqual(legacyClient, canonical.client_information));
      if (canAdoptLegacyTokens) {
        return {
          clientInformation: legacyClient ?? canonical.client_information,
          source: "legacy",
          tokens: legacyTokens,
        };
      }
      // After v1 is released, the legacy image will be deleted, so no image is a normal stable state; if it is applied to v2
      // The image invalidation rule will discard the still valid canonical token and force all upgraded users to re-authorize.
      return canonicalSnapshot;
    }
    if (!legacyTokens) {
      // Old providers must remain invalid after invalidate tokens, and old tokens cannot be revived from canonical.
      return { clientInformation: legacyClient, source: "legacy" };
    }
    if (isDeepStrictEqual(legacyTokens, canonical.tokens)) {
      return legacyClient ? canonicalSnapshot : { source: "legacy", tokens: legacyTokens };
    }
    if (legacyClient && isDeepStrictEqual(legacyClient, canonical.client_information)) {
      // When the client has not changed, you can confirm that the legacy token is the refresh result of the old provider with the same identity.
      return { clientInformation: legacyClient, source: "legacy", tokens: legacyTokens };
    }
    // When both client and token change and there is no generation, it cannot be proven that they are from the same transaction: keep the client for re-authorization,
    // Never speculatively splice authentication assets.
    return { clientInformation: legacyClient, source: "legacy" };
  }

  if (!legacyClient && !legacyTokens) return undefined;
  return {
    clientInformation: legacyClient,
    source: "legacy",
    ...(legacyTokens ? { tokens: legacyTokens } : {}),
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
