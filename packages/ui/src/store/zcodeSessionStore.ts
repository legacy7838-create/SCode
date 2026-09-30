/**
 * ZCode session UI state store
 *
 * One tab maps to one workspace, so chat-related state must also be stored bucketed by workspace.
 * That way, when switching tabs, the current task, the in-progress draft state, and the
 * initialization state do not bleed into each other.
 */
import { create } from "zustand";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { type ZCodeSessionStoreState } from "./zcodeSessionStoreTypes.js";
import { getWorkspaceState } from "./zcodeSessionStoreSelectors.js";
import { createNavigationSlice } from "./zcodeSessionStoreNavigation.js";
import { createTaskSlice } from "./zcodeSessionStoreTaskSlice.js";
import { createWorkspaceSlice } from "./zcodeSessionStoreWorkspaceSlice.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export const useZCodeSessionStore = create<ZCodeSessionStoreState>()((set, get) => ({
  workspaces: {},
  ...createNavigationSlice(set, get),
  ...createWorkspaceSlice(set),
  ...createTaskSlice(set),
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) =>
    getWorkspaceState(get(), workspacePath, workspaceIdentity),
}));

type ZCodeSessionStoreE2EBridge = typeof useZCodeSessionStore;

declare global {
  interface Window {
    __zcodeSessionStoreE2E?: ZCodeSessionStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // The E2E diagnostic entry must be opened explicitly by WDIO, and ZCODE_ENV=test cannot be reused to prevent the product test environment from exposing the variable global store.
  window.__zcodeSessionStoreE2E = useZCodeSessionStore;
}

// ────────────────────────────────────────────
// Re-exports: Keep external `from '@/store/zcodeSessionStore'` import paths continuing to work
// ────────────────────────────────────────────
export * from "./zcodeSessionStoreTypes.js";
export * from "./zcodeSessionStoreSelectors.js";
// Re-export navigation types used externally:
export type {
  TaskNavigationHistory,
  TaskNavEntry,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";

// Memory diagnostic counter: All workspace buckets have no deletion path, logs are dropped first.
uiMemoryDiagnosticsRegistry.register("sessionStore", () => ({
  workspaces: Object.keys(useZCodeSessionStore.getState().workspaces).length,
}));
