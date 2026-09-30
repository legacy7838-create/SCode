import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { acquireFileLock } from "@zcode/shared/node";
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

const MCP_OAUTH_PENDING_AUTHORIZATION_KEY = "pending_authorization";

/**
 * Contention wait budget for the authorization lease.
 *
 * It cannot be 0: under contention `acquireFileLock` first checks `elapsed >= maxWaitMs` and only afterwards tries to
 * reclaim an abandoned lock. A zero wait times out immediately and never runs the owner-dead check, so once the
 * lock-holding process crashes the authorization feature stays permanently unavailable. A short budget is enough to
 * guarantee "at least one owner-dead reclaim before failing", while keeping the follower's extra latency at a
 * magnitude that is imperceptible inside a human-in-the-loop authorization flow.
 */
const AUTHORIZATION_LEASE_MAX_WAIT_MS = 250;
const AUTHORIZATION_LEASE_RETRY_DELAYS_MS = [25] as const;
const AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS = 100;

interface McpOAuthAuthorizationLease {
  attemptId: string;
  release(): Promise<void>;
}

/**
 * Path of the lease file.
 *
 * The basename may only hold the hash and hyphens: credential key prefixes look like `mcp:oauth:<hash>`, and colons
 * are illegal in Windows filenames, so splicing one straight into the path would make the whole flow fail on Windows.
 */
function resolveAuthorizationLeasePath(credentialsFilePath: string, keyPrefix: string): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.authz`);
}

export function sanitizeKeyPrefix(keyPrefix: string): string {
  return keyPrefix.replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Tries to become the authorization leader. Returns `undefined` when it cannot win (the caller turns into a follower); it never blocks waiting.
 *
 * In-process contention is guaranteed by `mkdir` mutual exclusion just the same: the second caller's `mkdir` receives EEXIST, and the
 * owner PID it then reads is this very process and is alive, so nothing is wrongly reclaimed and it correctly
 * degrades to follower. Hence no extra in-process registry is needed.
 */
export async function tryAcquireAuthorizationLease(input: {
  credentialsFilePath: string;
  keyPrefix: string;
}): Promise<McpOAuthAuthorizationLease | undefined> {
  const leasePath = resolveAuthorizationLeasePath(input.credentialsFilePath, input.keyPrefix);
  try {
    const release = await acquireFileLock(
      leasePath,
      AUTHORIZATION_LEASE_RETRY_DELAYS_MS,
      AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS,
      AUTHORIZATION_LEASE_MAX_WAIT_MS,
    );
    return {
      attemptId: randomBytes(16).toString("hex"),
      release,
    };
  } catch (error) {
    if (getErrorCode(error) === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE) return undefined;
    // EACCES/EPERM, etc. indicate that the credential directory is not writable, interactive authorization is unlikely to succeed in any case, and must be reported instead of silently downgraded.
    throw error;
  }
}

interface PendingAuthorizationRecord {
  attemptId: string;
  authorizationUrl: string;
  baselineGeneration?: string;
  expiresAt: number;
  state: string;
}

interface StoredPendingAuthorization {
  attempt_id: string;
  authorization_url: string;
  baseline_generation?: string;
  expires_at: number;
  state: string;
}

export async function publishPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  record: PendingAuthorizationRecord,
): Promise<void> {
  const stored: StoredPendingAuthorization = {
    attempt_id: record.attemptId,
    authorization_url: record.authorizationUrl,
    ...(record.baselineGeneration === undefined
      ? {}
      : { baseline_generation: record.baselineGeneration }),
    expires_at: record.expiresAt,
    state: record.state,
  };
  await credentialStore.save(pendingKey(keyPrefix), JSON.stringify(stored));
}

/** Reads the pending entry; an expired one counts as absent (the TTL only drives display decisions and carries no lock-ownership semantics). */
export async function loadPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  now = Date.now(),
): Promise<PendingAuthorizationRecord | undefined> {
  const raw = await credentialStore.load(pendingKey(keyPrefix));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.attempt_id !== "string" ||
    typeof parsed.authorization_url !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.expires_at !== "number"
  ) {
    return undefined;
  }
  if (parsed.expires_at <= now) return undefined;
  return {
    attemptId: parsed.attempt_id,
    authorizationUrl: parsed.authorization_url,
    ...(typeof parsed.baseline_generation === "string"
      ? { baselineGeneration: parsed.baseline_generation }
      : {}),
    expiresAt: parsed.expires_at,
    state: parsed.state,
  };
}

/**
 * Deletes only the pending entry published by this attempt.
 *
 * The delete must be a CAS on the attempt: an unconditional delete in an old leader's `finally` would wipe the
 * pending entry a new leader has just published, and the follower would immediately lose the authorization URL.
 * Read the current value first to confirm ownership, then compare-and-delete on the original value.
 */
export async function deletePendingAuthorizationIfOwned(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  attemptId: string,
): Promise<boolean> {
  const key = pendingKey(keyPrefix);
  const raw = await credentialStore.load(key);
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unresolvable residual values ​​are only cleaned up if they are indeed the current value.
    return await credentialStore.deleteIfValue(key, raw);
  }
  if (!isRecord(parsed) || parsed.attempt_id !== attemptId) return false;
  return await credentialStore.deleteIfValue(key, raw);
}

function pendingKey(keyPrefix: string): string {
  return mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_PENDING_AUTHORIZATION_KEY);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
