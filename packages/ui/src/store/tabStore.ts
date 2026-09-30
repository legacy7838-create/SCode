/* oxlint-disable eslint(max-lines) */
/**
 * Tab Store —— multi-tab state management
 *
 * Every window owns an independent tab store (not broadcast across windows). Tab state is persisted
 * through settingService (see useTabPersistence).
 */
import { create } from "zustand";
import {
  createUuid,
  type RemoteTarget,
  type TabId,
  type TabState,
  type WorkspacePurpose,
} from "@zcode/shared";
import {
  persistWorkspaceExpandedPreference,
  readWorkspaceExpansionState,
  resolveExpandedWorkspacePaths,
  type WorkspaceExpansionState,
} from "@/lib/workspaceExpansionPreference.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

export const SETTINGS_TAB_ID = "__settings__" satisfies TabId;

export type WorkspaceAvailability = "available" | "unavailable-local-directory";

export interface SettingsTabState {
  id: typeof SETTINGS_TAB_ID;
  kind: "settings";
  label: "settings";
}

export interface WorkspaceTabState extends TabState {
  kind: "workspace";
  /** The one-shot startup validation result; not persisted, and not re-checked while running. */
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface WorkspaceTabOptions {
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface RestorableWorkspaceTab {
  workspacePath: string;
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export type WindowTabState = WorkspaceTabState | SettingsTabState;

export function isWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return tab.kind === "workspace";
}

export function isWorkspaceTabReadOnly(tab: WindowTabState): tab is WorkspaceTabState & {
  availability: "unavailable-local-directory";
} {
  return isWorkspaceTab(tab) && tab.availability === "unavailable-local-directory";
}

export function isWorkspaceReadOnly(
  state: Pick<TabStoreState, "tabs">,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return state.tabs.some(
    (tab) =>
      isWorkspaceTabReadOnly(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
  );
}

export function isSettingsTab(tab: WindowTabState): tab is SettingsTabState {
  return tab.kind === "settings";
}

// ============================================================================
// State definition
// ============================================================================

export interface TabStoreState {
  /** All tabs currently open in this window (ordered) */
  tabs: WindowTabState[];
  /** The currently active tab ID; null means no active tab */
  activeTabId: TabId | null;
  /** The currently or most recently active workspace path */
  activeWorkspacePath: string | null;
  /**
   * The currently or most recently active workspace identity (isolates identical paths on remotes)
   */
  activeWorkspaceIdentity: string | null;
  /** The set of workspace paths expanded in the left sidebar */
  expandedWorkspacePaths: Set<string>;
  /** Add a tab, returning the new tab's ID */
  addTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /**
   * Ensure the workspace appears in the task area's data source, without stealing the current focus
   */
  ensureWorkspaceTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** Close a tab */
  closeTab: (tabId: TabId) => void;
  /** Activate the given tab */
  activateTab: (tabId: TabId) => void;
  /** Drag-and-drop ordering: move the tab at fromIndex to toIndex */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  /**
   * Reorder only the workspace subsequence, preserving the position slots of non-workspace tabs
   * such as the settings page
   */
  reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => void;
  /** Open the settings tab (unique within the window) */
  openSettingsTab: () => void;
  /** Activate a tab by workspace path (used for cross-window focus); returns whether one was found */
  activateTabByPath: (path: string, options?: { workspaceIdentity?: string }) => boolean;
  /** Toggle a workspace's expanded/collapsed state */
  toggleWorkspaceExpanded: (path: string) => void;
  /** Expand every workspace in the current task area */
  expandAllWorkspaceTabs: (paths: string[]) => void;
  /** Collapse every workspace in the current task area */
  collapseAllWorkspaceTabs: (paths: string[]) => void;
  /** Restore tabs in bulk (used at startup to restore them from persisted data) */
  restoreTabs: (tabs: Array<string | RestorableWorkspaceTab>, activeIndex: number) => void;
  /**
   * Fill in the persisted tabs after the first startup frame; keeps the current active identity and
   * any tabs the user added in the meantime.
   */
  completeTabRestore: (tabs: Array<string | RestorableWorkspaceTab>) => void;
}

// ============================================================================
// Utility function
// ============================================================================

/** Take the folder name from the path as the tab's display name */
function labelFromPath(path: string): string {
  // Compatible with Windows backslashes and Unix forward slashes
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function createWorkspaceTab(
  workspacePath: string,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    id: createUuid(),
    kind: "workspace",
    workspacePath,
    label: labelFromPath(workspacePath),
    availability: options?.availability,
    remoteSessionId: options?.remoteSessionId,
    remoteTarget: options?.remoteTarget,
    workspaceIdentity: options?.workspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose,
  };
}

function mergeWorkspaceTabOptions(
  tab: WorkspaceTabState,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    ...tab,
    availability: options?.availability ?? tab.availability,
    remoteSessionId: options?.remoteSessionId ?? tab.remoteSessionId,
    remoteTarget: options?.remoteTarget ?? tab.remoteTarget,
    remoteHistoryId: options?.remoteHistoryId ?? tab.remoteHistoryId,
    workspaceIdentity: options?.workspaceIdentity ?? tab.workspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath ?? tab.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose ?? tab.workspacePurpose,
  };
}

function normalizeRestorableWorkspaceTab(
  tab: string | RestorableWorkspaceTab,
): RestorableWorkspaceTab {
  if (typeof tab === "string") {
    return {
      workspacePath: tab,
    };
  }

  return tab;
}

function createSettingsTab(): SettingsTabState {
  return {
    id: SETTINGS_TAB_ID,
    kind: "settings",
    label: "settings",
  };
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return nextItems;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function ensureWorkspaceExpanded(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.add(workspacePath);
  return next;
}

function pruneExpandedWorkspace(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (!expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.delete(workspacePath);
  return next;
}

// ============================================================================
// Store creation
// ============================================================================

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createTabStore(storage: StorageLike | null | undefined = undefined) {
  return create<TabStoreState>()((set, get) => ({
    tabs: [],
    activeTabId: null,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: new Set<string>(),

    addTab: (workspacePath: string, options) => {
      // Previously, reusing tabs was only judged by the workspacePath + history/session fragment.
      // Different remote ends with the same path (for example, 10.0.0.1:/home/dev and 10.0.0.2:/home/dev) will be treated as one tab.
      // Here, priority is given to matching by workspaceIdentity (authority + canonicalPath), and the path is only used as a final guide.
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(existing.workspacePath, true, storage);
        set((state) => ({
          // After the remote workspace is manually reconnected successfully, addTab will be used again.
          // But here, the existing tab hit before is only activated, and the new remoteSessionId and other metadata are not written back to the old tab.
          // As a result, the UI still reads the old status of "remoteSessionId has not been updated yet".
          // The reconnect button will always be displayed, as if it is not connected yet. Here, the remote session fields are synchronously overwritten when reusing tabs.
          tabs: state.tabs.map((tab) =>
            tab.id !== existing.id || !isWorkspaceTab(tab)
              ? tab
              : mergeWorkspaceTabOptions(tab, options),
          ),
          activeTabId: existing.id,
          activeWorkspacePath: existing.workspacePath,
          // Plug-in management on the Settings page should continue to hit the same remote end according to the identity of the "recently activated workspace".
          // Previously, only the path was saved here. After switching to the settings tab, the identity will be lost, causing the remote isolation of the same path to fail.
          activeWorkspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity ?? null,
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            existing.workspacePath,
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(workspacePath, true, storage);
      set((state) => ({
        // The workspace list on the left now supports manual sorting, but newly opened projects are still appended to the bottom by default.
        // When opening new projects continuously, you always have to scroll to the bottom to find the latest workspace, which is inconsistent with the "latest context first" browsing method in the sidebar.
        // Here, the new workspace is inserted at the front, so that the newly opened project appears directly at the top of the list.
        tabs: [tab, ...state.tabs],
        activeTabId: tab.id,
        activeWorkspacePath: workspacePath,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          workspacePath,
        ),
      }));
      return tab.id;
    },

    ensureWorkspaceTab: (workspacePath: string, options) => {
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(existing.workspacePath, true, storage);
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id !== existing.id || !isWorkspaceTab(tab)
              ? tab
              : mergeWorkspaceTabOptions(tab, options),
          ),
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            existing.workspacePath,
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(workspacePath, true, storage);
      set((state) => ({
        // Claude history import may write tasks to a workspace where the current window has never been opened.
        // The task area only traverses workspace tabs; if it only bumps the task list version without padding tabs,
        // Although the new task has been successfully persisted, there is still no corresponding group to render in the sidebar. Here is an entrance that only ensures visibility.
        // It allows the target workspace to enter the task area data source without interrupting the tab / settings context that the user is currently looking at.
        tabs: [tab, ...state.tabs],
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          workspacePath,
        ),
      }));
      return tab.id;
    },

    closeTab: (tabId: TabId) => {
      const stateBefore = get();
      const { tabs, activeTabId } = stateBefore;
      const index = tabs.findIndex((t) => t.id === tabId);
      if (index === -1) {
        return;
      }

      const closingTab = tabs[index] ?? null;
      const newTabs = tabs.filter((t) => t.id !== tabId);

      // If you close the currently active tab, you need to switch to the adjacent tab.
      let newActiveTabId = activeTabId;
      if (activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActiveTabId = null;
        } else {
          // First activate the right tab, if it is the last one, activate the left one
          const newIndex = Math.min(index, newTabs.length - 1);
          newActiveTabId = newTabs[newIndex]!.id;
        }
      }

      const nextWorkspaceTab = newTabs.find((tab) => tab.id === newActiveTabId);
      const fallbackWorkspacePath = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspacePath;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspacePath ?? null;
        }

        return stateBefore.activeWorkspacePath;
      })();
      const fallbackWorkspaceIdentity = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspaceIdentity ?? null;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspaceIdentity ?? null;
        }

        return stateBefore.activeWorkspaceIdentity;
      })();

      const nextState = {
        tabs: newTabs,
        activeTabId: newActiveTabId,
        activeWorkspacePath: fallbackWorkspacePath,
        activeWorkspaceIdentity: fallbackWorkspaceIdentity,
        expandedWorkspacePaths: (() => {
          const prunedExpandedWorkspacePaths =
            closingTab && isWorkspaceTab(closingTab)
              ? pruneExpandedWorkspace(stateBefore.expandedWorkspacePaths, closingTab.workspacePath)
              : stateBefore.expandedWorkspacePaths;

          // After closing the current workspace, the main content will automatically switch to the adjacent tab.
          // Previously, when the sidebar placed the expanded state in the local state of the component, the replacement item would be expanded smoothly after the workspacePath changed;
          // Now that it is hosted by the store, this backend must also be moved over, otherwise "close the current tab" will leave an activated but collapsed workspace.
          return fallbackWorkspacePath
            ? ensureWorkspaceExpanded(prunedExpandedWorkspacePaths, fallbackWorkspacePath)
            : prunedExpandedWorkspacePaths;
        })(),
      };

      if (fallbackWorkspacePath) {
        persistWorkspaceExpandedPreference(fallbackWorkspacePath, true, storage);
      }

      set(nextState);
    },

    activateTab: (tabId: TabId) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((t) => t.id === tabId);
      if (!tab) {
        return;
      }

      const nextState = {
        activeTabId: tabId,
        activeWorkspacePath: isWorkspaceTab(tab)
          ? tab.workspacePath
          : stateBefore.activeWorkspacePath,
        activeWorkspaceIdentity: isWorkspaceTab(tab)
          ? (tab.workspaceIdentity ?? null)
          : stateBefore.activeWorkspaceIdentity,
        expandedWorkspacePaths: isWorkspaceTab(tab)
          ? ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, tab.workspacePath)
          : stateBefore.expandedWorkspacePaths,
      };

      if (isWorkspaceTab(tab)) {
        persistWorkspaceExpandedPreference(tab.workspacePath, true, storage);
      }

      set(nextState);
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= state.tabs.length ||
          toIndex >= state.tabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const newTabs = moveItem(state.tabs, fromIndex, toIndex);
        return { tabs: newTabs };
      });
    },

    reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        const workspaceTabs = state.tabs.filter(isWorkspaceTab);
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= workspaceTabs.length ||
          toIndex >= workspaceTabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const reorderedWorkspaceTabs = moveItem(workspaceTabs, fromIndex, toIndex);
        let workspaceIndex = 0;
        const newTabs = state.tabs.map((tab) => {
          if (!isWorkspaceTab(tab)) {
            return tab;
          }

          return reorderedWorkspaceTabs[workspaceIndex++] ?? tab;
        });

        return { tabs: newTabs };
      });
    },

    openSettingsTab: () => {
      const existing = get().tabs.find(isSettingsTab);
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }

      const settingsTab = createSettingsTab();
      set((state) => ({
        tabs: [...state.tabs, settingsTab],
        activeTabId: settingsTab.id,
      }));
    },

    toggleWorkspaceExpanded: (path: string) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        const nextExpanded = !expandedWorkspacePaths.has(path);
        if (expandedWorkspacePaths.has(path)) {
          expandedWorkspacePaths.delete(path);
        } else {
          expandedWorkspacePaths.add(path);
        }

        persistWorkspaceExpandedPreference(path, nextExpanded, storage);

        return { expandedWorkspacePaths };
      });
    },

    expandAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.add(path);
          persistWorkspaceExpandedPreference(path, true, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    collapseAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.delete(path);
          persistWorkspaceExpandedPreference(path, false, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    activateTabByPath: (path: string, options) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((currentTab): currentTab is WorkspaceTabState => {
        if (!isWorkspaceTab(currentTab) || currentTab.workspacePath !== path) {
          return false;
        }

        if (options?.workspaceIdentity) {
          return currentTab.workspaceIdentity === options.workspaceIdentity;
        }

        return true;
      });
      if (!tab) {
        return false;
      }

      const nextState = {
        activeTabId: tab.id,
        activeWorkspacePath: path,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, path),
      };

      persistWorkspaceExpandedPreference(path, true, storage);

      set(nextState);
      return true;
    },

    restoreTabs: (tabsInput, activeIndex: number) => {
      if (tabsInput.length === 0) return;
      const tabs = tabsInput.map((tab) => {
        const normalized = normalizeRestorableWorkspaceTab(tab);
        return createWorkspaceTab(normalized.workspacePath, {
          remoteSessionId: normalized.remoteSessionId,
          remoteTarget: normalized.remoteTarget,
          workspaceIdentity: normalized.workspaceIdentity,
          workspacePurpose: normalized.workspacePurpose,
          availability: normalized.availability,
        });
      });
      const safeIndex = Math.min(Math.max(activeIndex, 0), tabs.length - 1);
      const activeWorkspaceTab = tabs[safeIndex];
      if (!activeWorkspaceTab || !isWorkspaceTab(activeWorkspaceTab)) {
        return;
      }
      const expansionState: WorkspaceExpansionState = readWorkspaceExpansionState(storage);
      set({
        tabs,
        activeTabId: activeWorkspaceTab.id,
        activeWorkspacePath: activeWorkspaceTab.workspacePath,
        activeWorkspaceIdentity: activeWorkspaceTab.workspaceIdentity ?? null,
        expandedWorkspacePaths: resolveExpandedWorkspacePaths(
          tabs.map((tab) => tab.workspacePath),
          expansionState,
        ),
      });
    },

    completeTabRestore: (tabsInput) => {
      if (tabsInput.length === 0) return;
      set((state) => {
        const consumedTabIds = new Set<TabId>();
        const completedTabs = tabsInput.map((tabInput) => {
          const normalized = normalizeRestorableWorkspaceTab(tabInput);
          const options: WorkspaceTabOptions = {
            remoteSessionId: normalized.remoteSessionId,
            remoteTarget: normalized.remoteTarget,
            workspaceIdentity: normalized.workspaceIdentity,
            localWorkspacePath: normalized.localWorkspacePath,
            workspacePurpose: normalized.workspacePurpose,
            availability: normalized.availability,
          };
          const existing = state.tabs.find(
            (tab): tab is WorkspaceTabState =>
              isWorkspaceTab(tab) &&
              !consumedTabIds.has(tab.id) &&
              isSameWorkspaceTab(tab, normalized.workspacePath, options),
          );
          if (existing) {
            consumedTabIds.add(existing.id);
            return mergeWorkspaceTabOptions(existing, options);
          }
          return createWorkspaceTab(normalized.workspacePath, options);
        });
        const extraWorkspaceTabs = state.tabs.filter(
          (tab): tab is WorkspaceTabState => isWorkspaceTab(tab) && !consumedTabIds.has(tab.id),
        );
        const nonWorkspaceTabs = state.tabs.filter((tab) => !isWorkspaceTab(tab));
        const tabs = [...extraWorkspaceTabs, ...completedTabs, ...nonWorkspaceTabs];
        const expansionState = readWorkspaceExpansionState(storage);

        // If restoreTabs is called again in the second phase of active-first, the active tab id will be rebuilt.
        // Let the mounted session view lose its identity; new tabs opened by the user after the first frame will also be overwritten.
        // The completion phase only merges missing tabs, explicitly retaining the current focus and active workspace projection.
        return {
          tabs,
          activeTabId: state.activeTabId,
          activeWorkspacePath: state.activeWorkspacePath,
          activeWorkspaceIdentity: state.activeWorkspaceIdentity,
          expandedWorkspacePaths: resolveExpandedWorkspacePaths(
            tabs.filter(isWorkspaceTab).map((tab) => tab.workspacePath),
            expansionState,
          ),
        };
      });
    },
  }));
}

export type TabStore = ReturnType<typeof createTabStore>;
