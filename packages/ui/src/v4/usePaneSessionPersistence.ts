// Local persistence of pane ↔ session binding (pane binding belongs to the local UI state of the Layout layer).
// Motivation: The old link relies on useTaskRestore (deleted)
// Restore the selected task; after the renderer is refreshed under v4, the zustand selection state is reset to zero. If it is not persisted, the refresh will cause the user to
// Kick back the draft pane and the output session "disappears". The CLI/host process continues to run when the renderer refreshes,
// After restoring the selection state, pane resubscribes to get the snapshot+continuation.
// Only the first workspace of the same renderer reload will be restored; app cold start and workspace-only
// The entry remains in draft and does not consume session bindings left over from the previous run.
import { useEffect, useRef } from "react";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";

const STORAGE_PREFIX = "zcode-v4-last-session:v1:";

function storageKey(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

function readPersistedPaneSession(workspaceKey: string): string | null {
  try {
    return localStorage.getItem(storageKey(workspaceKey));
  } catch {
    return null;
  }
}

function persistPaneSession(workspaceKey: string, sessionId: string | null): void {
  try {
    if (sessionId) {
      localStorage.setItem(storageKey(workspaceKey), sessionId);
    } else {
      localStorage.removeItem(storageKey(workspaceKey));
    }
  } catch {
    // No storage environment (test/stealth) silent downgrade: refresh recovery is not available, but does not affect normal sessions.
  }
}

interface UsePaneSessionPersistenceParams {
  workspaceKey: string;
  activeSessionId: string | null;
  /**
   * The explicit user-intent generation of startDraft; when it is greater than 0, null means a
   * draft, not something pending restoration.
   */
  draftFocusVersion: number;
  /** Phone /remote does not consume the desktop pane's local restore state. */
  enabled?: boolean;
  /**
   * The restore entry point: the same selection path as when the user clicks the task list, which
   * keeps the side effects (read-state cleanup and the like) consistent.
   */
  selectSession: (sessionId: string) => void;
}

function shouldRestorePersistedPaneSession(params: {
  activeSessionId: string | null;
  draftFocusVersion: number;
  enabled: boolean;
  rendererReload: boolean;
}): boolean {
  return (
    params.enabled &&
    params.rendererReload &&
    params.activeSessionId === null &&
    params.draftFocusVersion === 0
  );
}

/**
 * Restores the last bound session on mount; from then on it is written and cleared along with the
 * selection state. It restores only once, on the first mount for each workspaceKey — the user
 * explicitly returning to a draft (a new task) counts as a selection change and clears the
 * persistence key, so the old session is not pulled back over and over.
 */
export function usePaneSessionPersistence({
  workspaceKey,
  activeSessionId,
  draftFocusVersion,
  enabled = true,
  selectSession,
}: UsePaneSessionPersistenceParams): void {
  const restoredKeysRef = useRef<Set<string>>(new Set());
  // Only the first workspace after reload can consume the pane binding before the refresh; then open other
  // The workspace is still a workspace-only entry, you must enter the draft, and you cannot restore old sessions one by one.
  const rendererReloadRestoreAvailableRef = useRef(isRendererReloadNavigation());
  const pendingRestoreRef = useRef<{
    workspaceKey: string;
    sessionId: string;
  } | null>(null);
  const selectSessionRef = useRef(selectSession);
  selectSessionRef.current = selectSession;

  useEffect(() => {
    if (!enabled) return;
    if (restoredKeysRef.current.has(workspaceKey)) return;
    restoredKeysRef.current.add(workspaceKey);
    const rendererReload = rendererReloadRestoreAvailableRef.current;
    rendererReloadRestoreAvailableRef.current = false;
    if (
      !shouldRestorePersistedPaneSession({
        activeSessionId,
        draftFocusVersion,
        enabled,
        rendererReload,
      })
    ) {
      // Both cold start and workspace-only entries must be drafts. old last-session
      // Even if it comes from the last time the app was run, the activeTaskId cannot be overwritten in this mount.
      if (activeSessionId === null) {
        persistPaneSession(workspaceKey, null);
      }
      return;
    }
    const stored = readPersistedPaneSession(workspaceKey);
    if (stored) {
      pendingRestoreRef.current = { workspaceKey, sessionId: stored };
      selectSessionRef.current(stored);
    }
    // activeSessionId/draftFocusVersion deliberately does not enter dependencies: recovery only looks at the moment when workspace is first mounted.
    // Subsequent explicit new creation and selection changes have the following persistence effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    // Do not write the initial null before the recovery is completed (the value to be restored will be overwritten).
    if (!restoredKeysRef.current.has(workspaceKey)) return;
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore?.workspaceKey === workspaceKey) {
      if (activeSessionId === null) {
        return;
      }
      // The recovery effect and the persistent effect belong to the same commit, and the closure of the latter is still possible
      // Read null before recovery. Wait until the selection state is truly backfilled before allowing writing to avoid deleting the reload recovery key first.
      pendingRestoreRef.current = null;
    }
    persistPaneSession(workspaceKey, activeSessionId);
  }, [activeSessionId, enabled, workspaceKey]);
}
