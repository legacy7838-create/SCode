// Availability switch for the sidebar session item "Open in Split Screen/Drag Split Screen" entrance.
// session workbench groups support desktop and regular web apps; mobile and /remote web-remote
// Not enabled. Use context instead of layer-by-layer props: session item context menu and drag source are multiple
// The sidebar Section is shared, and the determination source converges at WorkspaceShellLayout.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { WorkbenchSessionTarget } from "@/v4/workbenchSessionPlacement.js";

export type V4SplitPaneSessionTarget = WorkbenchSessionTarget;

interface V4SplitPaneEntryContextValue {
  readonly enabled: boolean;
  readonly canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  readonly openSession: (target: V4SplitPaneSessionTarget) => void;
}

const DEFAULT_SPLIT_PANE_ENTRY_CONTEXT: V4SplitPaneEntryContextValue = {
  enabled: false,
  canOpenSession: () => false,
  openSession: () => {},
};

const V4SplitPaneEntryContext = createContext<V4SplitPaneEntryContextValue>(
  DEFAULT_SPLIT_PANE_ENTRY_CONTEXT,
);

export function V4SplitPaneEntryProvider({
  enabled,
  canOpenSession,
  onOpenSession,
  children,
}: {
  enabled: boolean;
  canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  onOpenSession: (target: V4SplitPaneSessionTarget) => void;
  children: ReactNode;
}) {
  const controllerRef = useRef({ canOpenSession, onOpenSession });
  controllerRef.current = { canOpenSession, onOpenSession };
  const value = useMemo<V4SplitPaneEntryContextValue>(
    () => ({
      enabled,
      canOpenSession: (target) => enabled && controllerRef.current.canOpenSession(target),
      openSession: (target) => {
        if (enabled) controllerRef.current.onOpenSession(target);
      },
    }),
    [enabled],
  );
  return (
    <V4SplitPaneEntryContext.Provider value={value}>{children}</V4SplitPaneEntryContext.Provider>
  );
}

/**
 * The context-menu entry point is arbitrated centrally by the shell, so a task row cannot bypass
 * the active group / draft pane owner.
 */
export function useV4SplitPaneEntry(): V4SplitPaneEntryContextValue {
  return useContext(V4SplitPaneEntryContext);
}
