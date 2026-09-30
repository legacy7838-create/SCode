// Accessibility verification after restarting Helper: absorb tccd propagation lag + decide whether to upgrade to "restart ZCode".
//
// Background: After macOS Accessibility authorization, the AXIsProcessTrusted of the running Helper is cached at the process level, and the Helper must be restarted.
// You can only eat it if you create a new process. When restartHelper returns, the broker socket of the new Helper is healthy, but the AX status may still read stale
// (tccd propagation has a few seconds lag). If you only refresh once, it is likely to read stale again, making the user think that the restart is invalid.
//
// This helper polls accessibility after restart: leaving stale(granted/denied/unknown) is regarded as "Resolved" and returns false;
// It will not return true until the timeout is still stale (or it is unavailable/throws an error), triggering the UI upgrade to "restart ZCode".
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";

interface WaitForAccessibilityNotStaleOptions {
  /**
   * Overall timeout (default 6s): covers tccd propagation lag, the first round is usually granted
   * immediately.
   */
  timeoutMs?: number;
  /** Polling interval (default 500ms). */
  intervalMs?: number;
}

type GetCuaPermissionStatusFn = () => Promise<CuaPermissionStatusResult>;

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls accessibility after restarting the Helper to decide whether it has left `stale`.
 *
 * @returns `false` — accessibility left `stale` within the timeout (granted/denied/unknown), no
 * escalation needed. `true` — still `stale` at the timeout (or persistently unavailable/throwing),
 * escalate to the "restart ZCode" fallback.
 *
 * Semantics:
 * - `granted` → the restart picked up the grant, resolved.
 * - `denied`/`unknown` → a real permission gap (the user did not grant), not a "restart failure",
 *   so no escalation (the permission onboarding takes it).
 * - `stale` persisting → the tccd cache never refreshed / the restart mechanism is stuck →
 *   escalate.
 * - unavailable / throwing → a transient state in the middle of the restart, keep polling; if it
 *   has still not recovered at the timeout → escalate.
 */
export async function waitForAccessibilityNotStale(
  getStatus: GetCuaPermissionStatusFn,
  options: WaitForAccessibilityNotStaleOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await getStatus();
      if (isCuaPermissionStatusAvailable(result) && result.accessibility !== "stale") {
        return false;
      }
    } catch {
      // getStatus may fail momentarily during restart (socket switching/Helper startup). Consider it unresolved and continue polling.
    }
    if (Date.now() >= deadline) return true;
    await sleep(intervalMs);
  }
}
