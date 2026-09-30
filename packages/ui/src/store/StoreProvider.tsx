/**
 * StoreProvider —— initializes the Zustand store and provides it through React Context
 *
 * Mounted at the application root, wiring broadcastService to implement cross-window state sync.
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { IBroadcastService } from "@zcode/services";
import { createZCodeStore, type ZCodeStore, type ZCodeState } from "./index.js";

// Export a Context for tests to directly inject into the constructed store instance (such as cross-window broadcast suppression use cases).
const StoreContext = createContext<ZCodeStore | null>(null);

export function StoreProvider({
  broadcastService,
  initialIsRestoringOAuthSession = false,
  children,
}: {
  broadcastService: IBroadcastService;
  initialIsRestoringOAuthSession?: boolean;
  children: ReactNode;
}) {
  // Only create the store on the first render to avoid repeated HMR subscriptions
  const storeRef = useRef<ZCodeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createZCodeStore(broadcastService, {
      initialIsRestoringOAuthSession,
    });
  }

  return <StoreContext.Provider value={storeRef.current}>{children}</StoreContext.Provider>;
}

/**
 * A hook for consuming the Zustand store
 *
 * Usage: const theme = useZCodeStore(s => s.theme); const setTheme = useZCodeStore(s =>
 * s.setTheme);
 */
export function useZCodeStore<T>(selector: (state: ZCodeState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useZCodeStore must be used within StoreProvider");
  }
  return useStore(store, selector);
}

/**
 * A fault-tolerant useZCodeStore with a default value (part of decoupling the store).
 *
 * Use case: host components (PermissionDialog / the various markdown dialogs, etc.) read theme /
 * codePreviewSettings from the store and inject them into purely presentational components through
 * props. In unit tests these hosts are often rendered directly with renderToStaticMarkup and no
 * Provider, in which case this returns defaultValue instead of throwing, which keeps the
 * "presentational components do not touch the store" constraint intact; the real application root
 * always mounts StoreProvider, so real values are used there.
 *
 * Note: both the selector's return value and defaultValue must be referentially stable, otherwise
 * you get an infinite render loop.
 */
export function useZCodeStoreWithDefault<T>(
  selector: (state: ZCodeState) => T,
  defaultValue: T,
): T {
  const store = useContext(StoreContext);
  const subscribe = useCallback(
    (onStoreChange: () => void) => (store ? store.subscribe(onStoreChange) : () => {}),
    [store],
  );
  const getSnapshot = () => (store ? selector(store.getState()) : defaultValue);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
