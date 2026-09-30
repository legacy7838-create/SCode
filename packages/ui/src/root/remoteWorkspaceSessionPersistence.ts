import type { AppSettings, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { resolveStartupLocalWorkspaceSessionIndex } from "@zcode/shared";
import {
  buildPersistedWorkspaceSessionEntries,
  buildRemoteWorkspaceSessionEntryMap,
  buildWorkspaceSessionKey,
  readPersistedWorkspaceSessionEntries,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  isWorkspaceTab,
  type RestorableWorkspaceTab,
  type TabStore,
  type TabStoreState,
} from "@/store/tabStore.js";

function getRestorableWorkspaceKey(tab: string | RestorableWorkspaceTab): string {
  if (typeof tab === "string") {
    return tab;
  }
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

export function buildRemoteWorkspacePersistPatch(
  state: TabStoreState,
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
): Partial<AppSettings> {
  const remoteSessionMap = buildRemoteWorkspaceSessionEntryMap(remoteSessions);
  const serializedWorkspaceSessions = buildPersistedWorkspaceSessionEntries(
    state.tabs,
    remoteSessionMap,
  );
  const serializedRemoteWorkspaceKeys = new Set(
    serializedWorkspaceSessions.flatMap((entry) =>
      entry.kind === "remote" ? [buildWorkspaceSessionKey(entry)] : [],
    ),
  );
  const pendingRemoteSessions = remoteSessions.filter(
    (entry) => !serializedRemoteWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const workspaceTabs = state.tabs.filter((tab) => tab.kind === "workspace");
  const activeIndex = state.activeWorkspacePath
    ? workspaceTabs.findIndex((tab) => tab.workspacePath === state.activeWorkspacePath)
    : 0;

  return {
    // When the SSH entry is hidden, remote tab recovery will be skipped, and only local items will remain in the tabs.
    // If only the current tabs are serialized here, the next time you write setting.json, the entire remote session snapshot will be erased.
    // Here, "currently serialized items + remote snapshots that do not appear in tabs" are merged to ensure that the entry can still be reconnected after restoration.
    lastWorkspaceSession: [...serializedWorkspaceSessions, ...pendingRemoteSessions],
    lastActiveTabIndex: Math.max(activeIndex, 0),
  };
}

export function restorePersistedRemoteWorkspaceSessions({
  settings,
  tabStoreApi,
  allowRemoteWorkspaceRestore = true,
  unavailableWorkspacePath,
  conversationWorkspacePath,
  restoreMode = "all",
}: {
  settings: AppSettings;
  tabStoreApi: TabStore;
  allowRemoteWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  conversationWorkspacePath?: string;
  restoreMode?: "all" | "active-first";
}): { deferredRestore?: () => void } | undefined {
  const persistedSessions = readPersistedWorkspaceSessionEntries(settings);

  if (persistedSessions.length === 0 && !conversationWorkspacePath) {
    return;
  }

  const restoredTabs: Array<string | RestorableWorkspaceTab> = [];
  const seenLocalWorkspacePaths = new Set<string>();
  const seenRemoteWorkspaceKeys = new Set<string>();
  const activeSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
    persistedSessions,
    settings.lastActiveTabIndex,
  );
  let restoredActiveIndex = 0;
  let canonicalConversationRestoredIndex: number | null = null;
  let shouldActivateCanonicalConversation = false;

  for (const [index, persistedEntry] of persistedSessions.entries()) {
    if (persistedEntry.kind === "local") {
      const isStaleConversationWorkspace = Boolean(
        conversationWorkspacePath &&
        persistedEntry.workspacePurpose === "conversation" &&
        persistedEntry.workspacePath !== conversationWorkspacePath,
      );
      if (isStaleConversationWorkspace) {
        // The test data root directory or the old data root may put multiple conversation backing paths
        // Persisted; they are the same logical "projectless session" and must be given as service when restored
        // The canonical path shall prevail, otherwise there will be multiple defaults in the sidebar and scheduled task selector.
        logger.warn("[Root] skipping restore of non-canonical conversation workspace", {
          workspacePath: persistedEntry.workspacePath,
          conversationWorkspacePath,
        });
        if (index === activeSessionIndex) {
          shouldActivateCanonicalConversation = true;
          if (canonicalConversationRestoredIndex !== null) {
            restoredActiveIndex = canonicalConversationRestoredIndex;
          }
        }
        continue;
      }

      if (seenLocalWorkspacePaths.has(persistedEntry.workspacePath)) {
        logger.warn("[Root] skipping duplicate local workspace restore", {
          workspacePath: persistedEntry.workspacePath,
        });
        continue;
      }

      const isConversationWorkspace = persistedEntry.workspacePath === conversationWorkspacePath;
      const workspacePurpose = isConversationWorkspace
        ? "conversation"
        : persistedEntry.workspacePurpose;
      const availability =
        !isConversationWorkspace && persistedEntry.workspacePath === unavailableWorkspacePath
          ? "unavailable-local-directory"
          : undefined;
      restoredTabs.push(
        workspacePurpose || availability
          ? {
              workspacePath: persistedEntry.workspacePath,
              workspacePurpose,
              availability,
            }
          : persistedEntry.workspacePath,
      );
      seenLocalWorkspacePaths.add(persistedEntry.workspacePath);
      const restoredIndex = restoredTabs.length - 1;
      if (isConversationWorkspace) {
        canonicalConversationRestoredIndex = restoredIndex;
      }
      if (
        index === activeSessionIndex ||
        (isConversationWorkspace && shouldActivateCanonicalConversation)
      ) {
        restoredActiveIndex = restoredIndex;
      }
      continue;
    }

    const workspaceIdentity = resolveRemoteWorkspaceSessionIdentity(persistedEntry);
    const workspaceKey = workspaceIdentity?.trim() || persistedEntry.workspacePath;
    if (seenRemoteWorkspaceKeys.has(workspaceKey)) {
      logger.warn("[Root] skipping restore of remote workspace with conflicting identity", {
        workspacePath: persistedEntry.workspacePath,
        workspaceIdentity,
      });
      continue;
    }

    if (!allowRemoteWorkspaceRestore) {
      // When the remote connection entrance is hidden by policy, startup recovery cannot quietly open the remote workspace tab.
      // Otherwise, the user cannot see the entrance but still retains the "disconnected remote item", which will cause inconsistency between display and capabilities.
      continue;
    }

    // The startup only restores the "disconnected remote tab" and does not automatically reconnect.
    // In this way, lastConnectionStatus in setting.json can truly reflect the last result.
    // Remote tabs closed by the user will not be pulled back in the background the next time they are started.
    restoredTabs.push({
      workspacePath: persistedEntry.workspacePath,
      remoteTarget: persistedEntry.target,
      workspaceIdentity,
    });
    seenRemoteWorkspaceKeys.add(workspaceKey);
  }

  if (conversationWorkspacePath && !seenLocalWorkspacePaths.has(conversationWorkspacePath)) {
    // conversation backing workspace is app-owned cwd, when it was missing from the old setup,
    // The sidebar will not subscribe to the scope; if purpose is missing, it will be treated as a project. The recovery phase starts with service
    // The parsed canonical path is authoritative, inactive supplementation and mandatory conversation marking.
    restoredTabs.push({
      workspacePath: conversationWorkspacePath,
      workspacePurpose: "conversation",
    });
    canonicalConversationRestoredIndex = restoredTabs.length - 1;
    if (shouldActivateCanonicalConversation) {
      restoredActiveIndex = canonicalConversationRestoredIndex;
    }
  }

  if (restoredTabs.length > 0) {
    if (restoreMode === "active-first" && restoredTabs.length > 1) {
      const activeTab = restoredTabs[restoredActiveIndex];
      if (activeTab) {
        const activeWorkspaceKey = getRestorableWorkspaceKey(activeTab);
        logger.info("[Root] restoring active workspace first", {
          deferredCount: restoredTabs.length - 1,
        });
        tabStoreApi.getState().restoreTabs([activeTab], 0);
        return {
          deferredRestore: () => {
            const startupActiveStillOpen = tabStoreApi
              .getState()
              .tabs.filter(isWorkspaceTab)
              .some(
                (tab) =>
                  (tab.workspaceIdentity?.trim() || tab.workspacePath) === activeWorkspaceKey,
              );
            // active-first saves the old settings snapshot; if the user closes the active tab before idle callback,
            // Directly completing will resurrect it from the old snapshot. Close the new intent belonging to this window, and the identity must be excluded when completing.
            const tabsToComplete = startupActiveStillOpen
              ? restoredTabs
              : restoredTabs.filter(
                  (restoredTab) => getRestorableWorkspaceKey(restoredTab) !== activeWorkspaceKey,
                );
            logger.info("[Root] filling in inactive workspaces after first frame", {
              count: tabsToComplete.length - (startupActiveStillOpen ? 1 : 0),
            });
            tabStoreApi.getState().completeTabRestore(tabsToComplete);
          },
        };
      }
    }
    logger.info("[Root] restoring combined workspace session", {
      count: restoredTabs.length,
      activeIndex: restoredActiveIndex,
    });
    tabStoreApi.getState().restoreTabs(restoredTabs, restoredActiveIndex);
  }
  return undefined;
}
