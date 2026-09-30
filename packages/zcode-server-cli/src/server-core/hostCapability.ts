import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "@zcode/shared";

// Single-use short-lived ticket semantics consistent with packages/server/src/hostCapability.ts.
// Dependency boundaries prohibit importing implementations from @zcode/server entries, so an equivalent copy is kept in the new package
// Pure memory implementation, the behavior is based on the compatibility contract of the old server (TTL, one-time consumption, expiration cleanup).
export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

export interface HostCapabilityStore {
  issue(): ServerRemoteHostCapability;
  consume(capability: string | undefined): boolean;
}

/** A short-lived, single-use desktop host capability; it only exists in the Server Core process memory. */
export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const expiresByCapability = new Map<string, number>();

  const purgeExpired = (at: number): void => {
    for (const [capability, expiresAt] of expiresByCapability) {
      if (expiresAt <= at) expiresByCapability.delete(capability);
    }
  };

  return {
    issue() {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      expiresByCapability.set(capability, expiresAt);
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return false;
      const consumedAt = now();
      const expiresAt = expiresByCapability.get(capability);
      // Regardless of whether the ticket is successful, expired or replayed, it will be deleted first. Only the first consumption within TTL can be obtained.
      // trusted-host role to avoid replayable long-term privilege escalation claims.
      expiresByCapability.delete(capability);
      purgeExpired(consumedAt);
      return expiresAt !== undefined && expiresAt > consumedAt;
    },
  };
}
