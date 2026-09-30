/**
 * TabStoreProvider —— initializes the Tab Zustand store and provides it through React Context
 *
 * Each window mounts its own instance; tab state is not broadcast across windows.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { createTabStore, type TabStore, type TabStoreState } from "./tabStore.js";

declare global {
  interface Window {
    __zcodeTabStoreE2E?: TabStore;
  }
}

const TabStoreContext = createContext<TabStore | null>(null);
const fallbackTabStore = createTabStore(null);

export function TabStoreProvider({ children }: { children: ReactNode }) {
  // Only create the store during the first rendering to avoid repeated creation of HMR
  const storeRef = useRef<TabStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTabStore();
  }

  useEffect(() => {
    if (!shouldExposeE2EStoreBridge() || !storeRef.current) {
      return;
    }

    const store = storeRef.current;
    // V4 draft does not have taskId. If E2E presses activeTaskId=null to check the workspace,
    // Multiple workspaces will hit any draft bucket. Only in E2E builds expose the current window navigation store for helper
    // Read the current draft exactly by workspaceIdentity?.trim() || workspacePath.
    window.__zcodeTabStoreE2E = store;
    return () => {
      if (window.__zcodeTabStoreE2E === store) {
        delete window.__zcodeTabStoreE2E;
      }
    };
  }, []);

  return <TabStoreContext.Provider value={storeRef.current}>{children}</TabStoreContext.Provider>;
}

/**
 * Hook that consumes the Tab store
 *
 * Usage: const tabs = useTabStore(s => s.tabs); const addTab = useTabStore(s => s.addTab);
 */
export function useTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStore must be used within TabStoreProvider");
  }
  return useStore(store, selector);
}

/**
 * For display components that render independently; falls back to empty tab state when there is no
 * Root provider.
 */
export function useOptionalTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  return useStore(store ?? fallbackTabStore, selector);
}

/**
 * Get the raw reference to the tab store (for non-React contexts, e.g. a subscription in useEffect)
 */
export function useTabStoreApi(): TabStore {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStoreApi must be used within TabStoreProvider");
  }
  return store;
}
