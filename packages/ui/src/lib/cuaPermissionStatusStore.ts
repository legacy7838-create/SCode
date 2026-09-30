/**
 * In-process shared cache of the Computer Use Helper permission state.
 *
 * Why it is needed: permission state has two consumers — the "Computer Use" section of the settings
 * page and the always-present entry button in the composer. Each used to hold its own
 * useCuaPermissionStatus instance, polling separately and maintaining its own sticky probe
 * snapshot, so the same TCC grant on the same machine could render as different states in the two
 * places while doubling the request volume. This collapses "last result + in-flight dedupe + sticky
 * probe" into a single source of truth slotted per workspace.
 *
 * Refresh is event-driven rather than a timed poll (entering the page / the app regaining focus /
 * an explicit refresh), triggered by useCuaPermissionStatus. The cache survives component unmounts:
 * re-entering the settings page first renders the last known grant state instead of flashing
 * "unknown" from null and then jumping to granted.
 */
import { isCuaPermissionStatusAvailable } from "@zcode/services";
import type {
  CuaPermissionStatus,
  CuaPermissionStatusQueryOptions,
  CuaPermissionStatusResult,
  ICuaPermissionService,
} from "@zcode/services";

import {
  persistCuaPermissionStatus,
  readCachedCuaPermissionStatus,
} from "./cuaPermissionStatusCache.js";

interface CuaPermissionStatusSnapshot {
  /**
   * Result of the last successful query; null = no state has been obtained for this workspace yet.
   */
  status: CuaPermissionStatusResult | null;
  /**
   * Whether status may be used for decisions. False while a query is in flight or when the most
   * recent query failed — display may keep using lastKnown, but actions like "Open System Settings"
   * must wait for a new result.
   */
  fresh: boolean;
  /**
   * Whether there is settled content to display. It holds as soon as the cold-start cache is hit,
   * and after a real result has been obtained it only goes up, never down.
   *
   * Division of labour with fresh: fresh expresses "was the current value just confirmed" and falls
   * back to false at the start of every query; if the display followed it, the grant button would
   * flip back and forth between "Open System Settings" and "Verifying…" and its width would jump
   * around. settled exists purely for display, to avoid that jitter.
   */
  settled: boolean;
}

/**
 * Snapshot returned when no slot is hit. useSyncExternalStore requires getSnapshot to return a
 * reference-stable value, and allocating a new object every time would cause an infinite render
 * loop, so it is built lazily once and then reused.
 *
 * The first value comes from the cross-process cache: the in-process slot is empty after a restart,
 * so if the first frame were still null the two permission rows in the settings page would first
 * render the grant button and then disappear wholesale once the first query returns (collapsing the
 * row height). The TCC grant belongs to the Helper bundle rather than to a workspace, so this cache
 * is the best current guess for any workspace; "not confirmed yet" is expressed by fresh=false.
 */
let initialSnapshotCache: CuaPermissionStatusSnapshot | null = null;

function initialSnapshot(): CuaPermissionStatusSnapshot {
  if (!initialSnapshotCache) {
    const cached = readCachedCuaPermissionStatus();
    initialSnapshotCache = { status: cached, fresh: false, settled: cached !== null };
  }
  return initialSnapshotCache;
}

interface Slot {
  snapshot: CuaPermissionStatusSnapshot;
  inFlight: boolean;
  /**
   * A new refresh request arrives while a query is in flight: coalesce it into one follow-up query
   * instead of issuing them concurrently.
   */
  rerunRequested: boolean;
  /**
   * An active screen capture is explicit user intent, so it is only OR-merged; it resets
   * immediately once consumed and runs at most once per round.
   */
  pendingFunctionalProbe: boolean;
  /** Backoff retry timer for transient unavailability; always undefined in steady state. */
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Number of retries already consumed; indexes TRANSIENT_RETRY_DELAYS_MS. */
  retryAttempt: number;
  /**
   * Ready snapshot: once fully-ready has been observed (both TCC entries granted + both functional
   * probes ok), later read-only refreshes keep the already-confirmed ok probe results as long as
   * both TCC entries are still granted. A read-only query never runs the screen capture probe in
   * the first place (upstream shouldRunCuaScreenCaptureProbe requires an explicit
   * includeFunctionalProbes), so pushing false down faithfully would erase the readiness conclusion
   * measured earlier. A genuine degradation (TCC revoked / Helper unavailable) takes the else
   * branch, clears the sticky value, and is published faithfully.
   */
  stickyReady: CuaPermissionStatus | null;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();

/**
 * Mirrors the settings page helperContextKey: the permission belongs to the (workspace path,
 * workspace identity) pair. NUL is used as the separator so that spaces in a path cannot push two
 * different workspaces into the same slot.
 */
export function cuaPermissionStatusKey(workspacePath: string, workspaceIdentity?: string): string {
  return [workspacePath, workspaceIdentity?.trim() ?? ""].join("\u0000");
}

export function subscribeCuaPermissionStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCuaPermissionStatusSnapshot(key: string | null): CuaPermissionStatusSnapshot {
  if (!key) return initialSnapshot();
  return slots.get(key)?.snapshot ?? initialSnapshot();
}

function ensureSlot(key: string): Slot {
  const existing = slots.get(key);
  if (existing) return existing;
  const created: Slot = {
    snapshot: initialSnapshot(),
    inFlight: false,
    rerunRequested: false,
    pendingFunctionalProbe: false,
    retryTimer: undefined,
    retryAttempt: 0,
    stickyReady: null,
  };
  slots.set(key, created);
  return created;
}

function clearTransientRetry(slot: Slot): void {
  if (slot.retryTimer) clearTimeout(slot.retryTimer);
  slot.retryTimer = undefined;
}

function publish(slot: Slot, snapshot: CuaPermissionStatusSnapshot): void {
  if (
    slot.snapshot.status === snapshot.status &&
    slot.snapshot.fresh === snapshot.fresh &&
    slot.snapshot.settled === snapshot.settled
  )
    return;
  slot.snapshot = snapshot;
  for (const listener of listeners) listener();
}

/**
 * Display-state readiness: both TCC entries granted. The settings page permission rows and the
 * composer entry button share this definition, so the same grant renders consistently in both
 * places.
 *
 * Why display state ignores the functional probes: by the upstream contract a read-only refresh
 * never runs the screen capture probe (shouldRunCuaScreenCaptureProbe requires an explicit
 * includeFunctionalProbes — an active screen capture must be user intent), so screenCaptureProbeOk
 * is always false, and judging the display by it would permanently classify granted users as still
 * pending. Genuine unavailability (TCC records a grant but WindowServer refuses the pixels, and so
 * on) is surfaced to the model as an ordinary MCP error from the tool call; the Renderer never
 * guesses permissions from a resident query or from error text.
 */
export function isCuaPermissionTccGranted(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  );
}

/**
 * End-to-end runtime readiness: both TCC entries granted **and** both functional probes verified to
 * pass. This can only hold right after an explicit active probe (returning from the grant dialog /
 * verifying after a Helper restart), so it is used solely as the condition for recording the sticky
 * snapshot below, not as the display definition.
 */
function isFunctionallyReady(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.accessibilityProbeOk === true &&
    result.screenRecording === "granted" &&
    result.screenCaptureProbeOk === true
  );
}

/** Applies the sticky probes and returns the result that is actually published. */
function withStickyProbes(
  slot: Slot,
  result: CuaPermissionStatusResult,
): CuaPermissionStatusResult {
  if (!("accessibility" in result)) {
    slot.stickyReady = null;
    return result;
  }
  if (isFunctionallyReady(result)) {
    slot.stickyReady = result;
    return result;
  }
  if (
    slot.stickyReady &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  ) {
    return {
      ...result,
      accessibilityProbeOk: slot.stickyReady.accessibilityProbeOk,
      screenCaptureProbeOk: slot.stickyReady.screenCaptureProbeOk,
    };
  }
  slot.stickyReady = null;
  return result;
}

/**
 * Backoff retry interval (milliseconds) for transient unavailability.
 *
 * Why it is needed: on the main side getStatus faithfully returns unavailable while the Helper host
 * is not yet running (see packages/services/src/node.ts). A cold Helper start / the recreate right
 * after enabling the plugin both land in this window — measured locally at about 3 seconds from
 * installed to ready. Event-driven refresh only samples on mount / focus / an explicit refresh, so
 * treating such a sample as a final state would put a red dot plus "Error" on the composer entry
 * and leave it unclickable, and a user who stays inside the app has no self-healing path. The old
 * polling implementation relied on the next sample to cover this; bounded backoff replaces it:
 * roughly 7 seconds accumulated is enough to cover the cold-start window, after which the error is
 * reported faithfully, and in steady state no timer is created at all.
 */
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Schedules one backoff retry; returns false when the allowance is exhausted, and the caller
 * publishes the result faithfully. The retry carries no options: an active screen capture probe is
 * explicit user intent and must not be amplified by an automatic retry.
 */
function scheduleTransientRetry(slot: Slot, params: FetchCuaPermissionStatusParams): boolean {
  const delay = TRANSIENT_RETRY_DELAYS_MS[slot.retryAttempt];
  if (delay === undefined) {
    // Reset to allow the next real event (focus / refresh / remount) to regain the full retry quota.
    slot.retryAttempt = 0;
    return false;
  }
  slot.retryAttempt += 1;
  clearTransientRetry(slot);
  slot.retryTimer = setTimeout(() => {
    slot.retryTimer = undefined;
    const { service, workspacePath, workspaceIdentity } = params;
    fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity, mode: "retry" });
  }, delay);
  return true;
}

interface FetchCuaPermissionStatusParams {
  service: ICuaPermissionService;
  workspacePath: string;
  workspaceIdentity?: string;
  options?: CuaPermissionStatusQueryOptions;
  /**
   * "refresh" (the default) = external state may have just changed (focus returned, Helper
   * restarted, plugin toggled), so a query already in flight may be reading the old world and one
   * more must be run; "ensure" = only requires "a fresh result exists" (component mount); when a
   * query is already in flight it rides along, otherwise the settings page and the composer entry
   * mounting one after the other would each queue up and waste one extra host RPC; "retry" = a
   * backoff retry scheduled by the store itself, which does **not reset the retry counter** —
   * otherwise every retry would get a full allowance back and the bounded backoff would degenerate
   * into unbounded polling at a fixed interval.
   */
  mode?: "refresh" | "ensure" | "retry";
}

/**
 * Fetches the permission state once and writes it into the shared cache. Concurrent calls for the
 * same workspace are coalesced: while one is in flight at most one follow-up query is recorded, so
 * that repeatedly switching between the native grant prompt and System Settings (each generating
 * focus) does not stack up a series of AX + screen capture probes.
 */
export function fetchCuaPermissionStatus(params: FetchCuaPermissionStatusParams): void {
  const { service, workspacePath, workspaceIdentity, options, mode = "refresh" } = params;
  const key = cuaPermissionStatusKey(workspacePath, workspaceIdentity);
  const slot = ensureSlot(key);
  slot.pendingFunctionalProbe ||= options?.includeFunctionalProbes === true;
  if (slot.inFlight) {
    if (mode === "refresh") slot.rerunRequested = true;
    return;
  }
  // Real events (mount/focus/explicit refresh) take over sampling: cancel the queued backoff retry and reset the quota to zero.
  // retry itself does not go here - otherwise the full quota will be returned every time it is retried, and the bounded backoff will become an infinite poll.
  if (mode !== "retry") {
    clearTransientRetry(slot);
    slot.retryAttempt = 0;
  }
  slot.inFlight = true;
  const includeFunctionalProbes = slot.pendingFunctionalProbe;
  slot.pendingFunctionalProbe = false;
  // Old results are not available for decision-making during the query: the user may have just changed the authorization in the system settings, or the Helper is being updated.
  publish(slot, { status: slot.snapshot.status, fresh: false, settled: slot.snapshot.settled });

  let completed: CuaPermissionStatusResult | null = null;
  void Promise.resolve()
    .then(() => service.getStatus(workspacePath, workspaceIdentity, { includeFunctionalProbes }))
    .then((result) => {
      completed = result;
    })
    .catch(() => {
      // Keep lastKnown displayed; retry convergence with backoff below.
    })
    .finally(() => {
      slot.inFlight = false;
      if (slot.rerunRequested) {
        // Refresh occurs during the query process: the old results may come from the Helper before restarting, and are not published. Only a new query is added.
        slot.rerunRequested = false;
        fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity });
        return;
      }
      // Query failure/Helper is not running yet are environmental transient states, not the final authorization state. Keep the previous status when there is still a retry quota
      // (fresh=false means unconfirmed), allowing backoff and retry to converge.
      //
      // After the quota is exhausted, the fate of the two branches is different. Here is a truthful explanation:
      // - The result is unavailable (Helper really cannot get up) → Drop it to the bottom and publish it as it is, and the UI will display an error state;
      // - Query reject (RPC channel failure) → fall to `if (!completed)`, only keep lastKnown + fresh=false,
      //   **Does not produce an error final state**. When cold starting and there is no cache, the entrance will stop at starting and the settings page will stop at "Verifying".
      //   Resampling until the next real event (focus / remount / explicit refresh). This is deliberate: channel failure
      //   Explain "We don't know the permission status" instead of "There is a permission problem". Rendering it as a red error will mislead the user.
      //   Reauthorize. The trade-off is that there is no visible error message for this failure, it only appears when RPC continues to fail.
      const transient = !completed || !isCuaPermissionStatusAvailable(completed);
      if (transient && scheduleTransientRetry(slot, params)) {
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      if (!completed) {
        // reject and the retry quota has been exhausted: keep lastKnown + fresh=false and wait for the next real event (see above).
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      slot.retryAttempt = 0;
      const published = withStickyProbes(slot, completed);
      publish(slot, { status: published, fresh: true, settled: true });
      // For use on the first screen of the next cold start. unavailable is ignored internally by persist: Helper is in environment state when it is not started.
      // Keeping this in mind will only make your next cold start above the fold longer.
      persistCuaPermissionStatus(published);
    });
}
