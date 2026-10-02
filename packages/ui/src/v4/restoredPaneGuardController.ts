// Settlement logic for a restored (restoredUnvalidated) workbench pane.
//
// The guard subscribes to the pane scope's sessions-index store. Because every subscribe uses
// runtimePolicy "existing-only" (see docs/specs/sessions-index-restore-guard.md), a workspace
// without a running agent runtime parks the store in "dormant" with workspaceId === null and never
// emits again. A guard that keyed only on workspaceId would stall forever, so the not-ready status
// is treated as terminal-but-unconfirmed: after a bounded grace window the pane is kept (the
// verification flag is cleared) and is never closed on the timeout path.
import type { SessionsIndexStore, SessionsIndexStoreStatus } from "@/v4/sessionsIndexStore.js";

/** How long a not-ready store may hold a restored pane before the guard settles it as kept. */
export const RESTORE_GUARD_GRACE_MS = 4_000;

/** Statuses that mean the store cannot produce a snapshot for this workspace right now. */
function isTerminalNotReady(status: SessionsIndexStoreStatus): boolean {
  return status === "dormant" || status === "error";
}

export interface RestoredPaneGuardControllerOptions {
  store: Pick<SessionsIndexStore, "getState" | "getStatus" | "getSessions">;
  sessionId: string;
  onConfirmed: (sessionId: string) => void;
  onMissing: (sessionId: string) => void;
  graceMs?: number;
  /** Injectable for tests; defaults to the global timer functions. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface RestoredPaneGuardController {
  /** Re-evaluate the store; safe to call on every emit and once synchronously after subscribe. */
  evaluate(): void;
  /** Cancel any pending grace timer and stop settling forever. */
  dispose(): void;
}

export function createRestoredPaneGuardController(
  options: RestoredPaneGuardControllerOptions,
): RestoredPaneGuardController {
  const {
    store,
    sessionId,
    onConfirmed,
    onMissing,
    graceMs = RESTORE_GUARD_GRACE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let disposed = false;
  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGrace = () => {
    if (graceTimer !== null) {
      clearTimeoutFn(graceTimer);
      graceTimer = null;
    }
  };

  const settle = (exists: boolean) => {
    if (disposed || settled) return;
    settled = true;
    clearGrace();
    if (exists) onConfirmed(sessionId);
    else onMissing(sessionId);
  };

  // Bounded wait for a not-ready store. On fire the pane is KEPT (confirmed), never closed: the
  // primary pane cannot be closed, and a workspace may simply have no runtime this session.
  const startGrace = () => {
    if (graceTimer !== null) return;
    graceTimer = setTimeoutFn(() => {
      graceTimer = null;
      settle(true);
    }, graceMs);
  };

  const evaluate = () => {
    if (disposed || settled) return;
    const state = store.getState();
    if (state.workspaceId !== null) {
      // A real snapshot is authoritative: confirm or collapse based on actual membership.
      const exists = store.getSessions().some((summary) => summary.sessionId === sessionId);
      settle(exists);
      return;
    }
    // No snapshot yet. Only a terminal not-ready status starts the grace window; "idle" and
    // "connecting" stay patient so an in-flight subscribe is never cut short.
    if (isTerminalNotReady(store.getStatus())) {
      startGrace();
    }
  };

  const dispose = () => {
    disposed = true;
    clearGrace();
  };

  return { evaluate, dispose };
}
