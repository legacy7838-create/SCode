// zustand assembly for split screen Layout/Focus layer.
// The model and pure state machine are in paneLayoutTree.ts, and persistence is in paneLayoutPersistence.ts——
// This document only does store assembly + persistent subscription, and re-exports both (single entry point for consumption).
import { create } from "zustand";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { persistPaneLayout, readPersistedPaneLayout } from "@/v4/paneLayoutPersistence.js";
import {
  bindPaneSession,
  closePane,
  confirmRestoredPaneSession,
  focusPane,
  INITIAL_PANE_LAYOUT,
  openSessionInNewPane,
  replacePaneBinding,
  setSplitNodeRatio,
  splitPaneAt,
  splitPaneAtSide,
  type PaneBinding,
  type PaneLayoutSnapshot,
  type PaneSplitSide,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

const persistedPaneLayoutAtModuleLoad = readPersistedPaneLayout();
const restoredPaneLayoutAtModuleLoad = isRendererReloadNavigation()
  ? persistedPaneLayoutAtModuleLoad
  : null;

/**
 * Used at the cold-start entry point: identify and clean up layouts left behind by the previous
 * renderer that should not be restored this time.
 */
export function hadPersistedPaneLayoutAtModuleLoad(): boolean {
  return persistedPaneLayoutAtModuleLoad !== null;
}

export * from "@/v4/paneLayoutTree.js";
export * from "@/v4/paneLayoutPersistence.js";

interface PaneLayoutStore extends PaneLayoutSnapshot {
  /**
   * Splits off a draft pane at the anchor pane (scope-bound; it binds in place after the first
   * createSession).
   */
  splitPane: (anchorPaneId: string, direction: SplitDirection, scope: PaneWorkspaceScope) => void;
  /**
   * Splits off panes bound to an existing session around the anchor pane (draft drop / non-group
   * drag entry point).
   */
  splitPaneWithBinding: (anchorPaneId: string, side: PaneSplitSide, binding: PaneBinding) => void;
  /**
   * Sidebar / drill-down entry point: already open → focus it; otherwise split the focused pane to
   * the right and bind the session.
   */
  openSessionInNewPane: (scope: PaneWorkspaceScope, sessionId: string) => void;
  /**
   * Draft temporary layout: an ordinary sidebar click only replaces the focused secondary, it does
   * not overwrite the primary draft.
   */
  replacePaneBinding: (paneId: string, binding: PaneBinding) => void;
  closePane: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  bindPaneSession: (paneId: string, sessionId: string) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  confirmRestoredPaneSession: (paneId: string) => void;
  /** Creating a new task/draft exits split view and returns to a single primary panel. */
  resetToPrimaryPane: () => void;
}

/**
 * One per window; the action references are stable and can be passed straight down to memoized
 * components.
 */
export const usePaneLayoutStore = create<PaneLayoutStore>()((set) => ({
  // Only the same renderer reload restores the layout from localStorage; app cold start starts from a single primary draft.
  ...(restoredPaneLayoutAtModuleLoad ?? INITIAL_PANE_LAYOUT),

  splitPane: (anchorPaneId, direction, scope) => {
    set((state) =>
      splitPaneAt(state, anchorPaneId, direction, {
        workspaceScope: scope,
        sessionId: null,
      }),
    );
  },

  splitPaneWithBinding: (anchorPaneId, side, binding) => {
    set((state) => splitPaneAtSide(state, anchorPaneId, side, binding));
  },

  openSessionInNewPane: (scope, sessionId) => {
    set((state) => openSessionInNewPane(state, scope, sessionId));
  },

  replacePaneBinding: (paneId, binding) => {
    set((state) => replacePaneBinding(state, paneId, binding));
  },

  closePane: (paneId) => {
    set((state) => closePane(state, paneId));
  },

  focusPane: (paneId) => {
    set((state) => focusPane(state, paneId));
  },

  bindPaneSession: (paneId, sessionId) => {
    set((state) => bindPaneSession(state, paneId, sessionId));
  },

  setSplitRatio: (splitId, ratio) => {
    set((state) => setSplitNodeRatio(state, splitId, ratio));
  },

  confirmRestoredPaneSession: (paneId) => {
    set((state) => confirmRestoredPaneSession(state, paneId));
  },

  resetToPrimaryPane: () => {
    set(INITIAL_PANE_LAYOUT);
  },
}));

// Layout changes are persistent (zustand does not notify when the transfer function no-op preserves the original reference, and there is no redundant writing).
usePaneLayoutStore.subscribe((state) => {
  persistPaneLayout(state);
});
