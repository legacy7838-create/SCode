/**
 * A local cache for CUA permission status.
 *
 * Why it is needed: on a cold start `useCuaPermissionStatus`'s status is null, while the detail
 * buttons on the two permission rows of the settings page are hidden only when it `=== "granted"`.
 * So while it is null both rows render their "Open Accessibility / Open Screen Recording" buttons,
 * and once the first query (whose real result is already granted) returns, those buttons all
 * disappear again and the row height collapses — users see this jitter on every visit to the
 * settings page. The always-present entry next to the input field behaves the same way: on a cold
 * start it goes through starting before jumping to ready.
 *
 * The cache carries the last real result over to the next launch as the optimistic initial value
 * for the first screen, so on the common path (the authorization state has not changed) the first
 * screen is already the final state and no longer jumps.
 *
 * Boundary (important): the value cached here is **only used for rendering** and never takes part
 * in any authorization decision.
 * - Display follows `settled` (true as soon as there is something displayable), so on a cache hit
 *   the settings page's "Open System Settings" button is **immediately clickable** instead of
 *   waiting for the real result to return — a deliberate trade-off, because otherwise the button
 *   label would jitter between "Verifying…" and the final state. Security does not rest on that
 *   button's disabled state but on the click edge: `openPermissionSettings` re-runs `getStatus` and
 *   validates it precisely with `requiredCuaPermissionsForFreshStatus`, so a stale value cannot
 *   open the wrong system panel — it only toasts a notice and triggers a refresh.
 * - `fresh` still only flips to true once the real result arrives, for decision-making checks.
 * - The real functional gate lives in the Helper/producer; failures reach the model as an ordinary
 *   MCP tool error, are unrelated to this cache, and the Renderer never triggers permission side
 *   effects on its own. Therefore the worst case of the cache is showing a state of unknown
 *   correctness for an instant on the first screen, immediately overwritten by the next
 *   event-driven query.
 */
import {
  isCuaPermissionStatusAvailable,
  type CuaPermissionState,
  type CuaPermissionStatus,
  type CuaPermissionStatusResult,
} from "@zcode/services";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * TCC authorization is App-level (Helper bundle) rather than workspace-level, so it uses a single
 * global key instead of being partitioned per workspace.
 */
const CUA_PERMISSION_STATUS_CACHE_KEY = "zcode-cua-permission-status";

/**
 * Cache validity period. The user can change the authorization state in system settings while ZCode
 * is not running, so the older the cache the less trustworthy it is; once it expires, falling back
 * to the cold-start state (null) is preferable to rendering the first screen with a granted value
 * that may already have been revoked.
 */
const CUA_PERMISSION_STATUS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PERMISSION_STATES: readonly CuaPermissionState[] = ["granted", "stale", "denied", "unknown"];

interface CachedEnvelope {
  savedAt: number;
  status: CuaPermissionStatus;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPermissionState(value: unknown): value is CuaPermissionState {
  return PERMISSION_STATES.includes(value as CuaPermissionState);
}

/**
 * All-field validation. The cache outlives individual versions, so as soon as a field drifts
 * (renamed or retyped) it could feed undefined into the rendering branches, producing problems
 * harder to diagnose than the jitter; here it is better to declare the cache invalid and return to
 * null.
 */
function parseCachedStatus(value: unknown): CuaPermissionStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.grantOwner !== "string" ||
    !isPermissionState(candidate.accessibility) ||
    !isPermissionState(candidate.screenRecording) ||
    typeof candidate.accessibilityProbeOk !== "boolean" ||
    typeof candidate.screenCaptureProbeOk !== "boolean"
  ) {
    return null;
  }
  if (
    candidate.grantOwnerDisplayName !== undefined &&
    typeof candidate.grantOwnerDisplayName !== "string"
  ) {
    return null;
  }

  const parsed: CuaPermissionStatus = {
    grantOwner: candidate.grantOwner,
    accessibility: candidate.accessibility,
    accessibilityProbeOk: candidate.accessibilityProbeOk,
    screenRecording: candidate.screenRecording,
    screenCaptureProbeOk: candidate.screenCaptureProbeOk,
  };
  if (typeof candidate.grantOwnerDisplayName === "string") {
    parsed.grantOwnerDisplayName = candidate.grantOwnerDisplayName;
  }
  return parsed;
}

export function readCachedCuaPermissionStatus(
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): CuaPermissionStatus | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(CUA_PERMISSION_STATUS_CACHE_KEY) ?? null;
  } catch {
    // Privacy mode/storage disabled: equivalent to no caching.
    return null;
  }
  if (!raw) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;

  const { savedAt, status } = envelope as Partial<CachedEnvelope>;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  // savedAt in the future = the clock is set back or tampered with, the freshness cannot be judged and will not be accepted.
  const age = now - savedAt;
  if (age < 0 || age > CUA_PERMISSION_STATUS_CACHE_TTL_MS) return null;

  return parseCachedStatus(status);
}

export function persistCuaPermissionStatus(
  status: CuaPermissionStatusResult,
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): void {
  // unavailable means that the Helper is not up / non-macOS / non-product mode, which is the environment state rather than the authorization state.
  // Remember that it will only cause a wrong first screen to appear on the next cold boot, so no writing will be done (nor will existing valid caches be cleared).
  if (!isCuaPermissionStatusAvailable(status)) return;

  const envelope: CachedEnvelope = { savedAt: now, status };
  try {
    storage?.setItem(CUA_PERMISSION_STATUS_CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota is full/Privacy mode: The cache is only for first-screen optimization. Failure to write will not affect the function.
  }
}
