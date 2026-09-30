import { useCallback, useEffect, useReducer, useRef } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * Rebuild window cap. Measured agent start→ready is about 550-650ms and createSession takes a few
 * hundred ms more, so 5s has ample headroom. A timeout only releases the gate, it does not cancel
 * the rebuild — a late binding still updates effectiveSessionId normally and wakes the attachment
 * re-upload.
 */
const DRAFT_RUNTIME_REBUILD_TIMEOUT_MS = 5000;

interface DraftRuntimeRebuildGateState {
  rebuilding: boolean;
  /**
   * The warm-up session id at the moment the generation changed; a different non-empty id appearing
   * means the rebuild is complete.
   */
  pendingFrom: string | null;
  /**
   * Monotonically increasing, used only to make the timer effect restart when a generation change
   * happens during a rebuild.
   */
  epoch: number;
}

type DraftRuntimeRebuildGateEvent =
  | { type: "runtimeRestart"; prewarmSessionId: string | null }
  | { type: "prewarmSessionChanged"; prewarmSessionId: string | null }
  | { type: "rebuildTimeout" };

const DRAFT_RUNTIME_REBUILD_GATE_IDLE: DraftRuntimeRebuildGateState = {
  epoch: 0,
  pendingFrom: null,
  rebuilding: false,
};

function reduceDraftRuntimeRebuildGate(
  state: DraftRuntimeRebuildGateState,
  event: DraftRuntimeRebuildGateEvent,
): DraftRuntimeRebuildGateState {
  switch (event.type) {
    case "runtimeRestart":
      return {
        epoch: state.epoch + 1,
        pendingFrom: event.prewarmSessionId,
        rebuilding: true,
      };
    case "prewarmSessionChanged":
      if (!state.rebuilding) return state;
      // The binding is null between retire and the reconstruction is completed, and the access control cannot be released based on this.
      if (event.prewarmSessionId === null) return state;
      if (event.prewarmSessionId === state.pendingFrom) return state;
      return { epoch: state.epoch, pendingFrom: null, rebuilding: false };
    case "rebuildTimeout":
      if (!state.rebuilding) return state;
      return { ...state, rebuilding: false };
  }
}

interface DraftRuntimeRebuildGate {
  /**
   * The warm-up session is being rebuilt; sending must be forbidden while it is true, otherwise
   * attachments hang off a session that no longer exists.
   */
  rebuilding: boolean;
}

/**
 * CUA Helper readiness, liveness recovery, and similar causes reclaim the agent runtime
 * (workspace-dispose), flushing away the warm-up session whose draft state is not persisted yet.
 * This hook increments draftRuntimeInvalidationVersion when the runtime generation changes to
 * trigger a rebuild, and reports rebuilding=true within the rebuild window for the send gate to
 * use.
 *
 * The generation-change signal prefers onRuntimeLifecycle's unavailable: it arrives at the moment
 * of dispose. onRuntimeRestart only fires when a new agent process spawns, and the agent spawns
 * lazily — no request, no spawn — so the generation-change notification never arrives, the warm-up
 * session is never rebuilt, and attachments stay stuck in waitingSession until the user manually
 * clicks send once and kicks it alive (production measurements show the gap from helper ready to
 * rebuild at 2.3s/6.0s/26.3s, all of them exactly at the moment of the user's click).
 *
 * Not enabled for the real session state (sessionId !== null): that path is handled by the CLI's
 * cold-session-resume.
 */
export function useDraftRuntimeRebuildGate(params: {
  /** Enabled only in draft state (sessionId === null). */
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  /** The current warm-up session id; a new non-empty value means the rebuild is complete. */
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** Preferred over onRuntimeRestart when the hosting transport exposes runtime liveness. */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  timeoutMs?: number;
}): DraftRuntimeRebuildGate {
  const {
    enabled,
    onRuntimeLifecycle,
    onRuntimeRestart,
    prewarmSessionId,
    timeoutMs = DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
    workspaceIdentity,
    workspacePath,
  } = params;
  const [state, dispatch] = useReducer(
    reduceDraftRuntimeRebuildGate,
    DRAFT_RUNTIME_REBUILD_GATE_IDLE,
  );

  // enabled / prewarmSessionId go ref: If handleRuntimeRestart depends on them, every time the session id changes
  // Will unsubscribe and then resubscribe, and the transport will dispose upstream when the listeners are cleared - in that window
  // Arriving generation events will be discarded.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const prewarmSessionIdRef = useRef(prewarmSessionId);
  prewarmSessionIdRef.current = prewarmSessionId;

  const handleRuntimeRestart = useCallback(() => {
    if (!enabledRef.current) return;
    dispatch({ prewarmSessionId: prewarmSessionIdRef.current, type: "runtimeRestart" });
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [workspaceIdentity, workspacePath]);

  useEffect(() => {
    // Choose one of the two subscriptions: Subscribing to both channels will cause the same update to be processed twice. It is useless to create a warm-up session and upload the attachment one more time.
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        // available No need to process: reconstruction has been initiated by unavailable, access control release is handed over to prewarmSessionChanged.
        if (state === "unavailable") handleRuntimeRestart();
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(handleRuntimeRestart);
  }, [handleRuntimeRestart, onRuntimeLifecycle, onRuntimeRestart]);

  useEffect(() => {
    dispatch({ prewarmSessionId, type: "prewarmSessionChanged" });
  }, [prewarmSessionId]);

  // Rely on epoch rather than rebuilding: rebuilding remains true when another generation is replaced during reconstruction.
  // Only epoch changes can restart the timer.
  useEffect(() => {
    if (!state.rebuilding) return;
    const timer = setTimeout(() => dispatch({ type: "rebuildTimeout" }), timeoutMs);
    return () => clearTimeout(timer);
  }, [state.epoch, state.rebuilding, timeoutMs]);

  return { rebuilding: state.rebuilding };
}
