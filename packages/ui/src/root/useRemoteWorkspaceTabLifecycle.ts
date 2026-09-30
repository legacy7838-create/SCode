import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  unbindRemoteWorkspaceIdentity,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

function remoteWorkspaceKey(tab: WorkspaceTabState): string | null {
  if (!tab.workspaceIdentity?.trim() && !tab.remoteSessionId && !tab.remoteTarget) {
    return null;
  }

  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

function collectClosedRemoteWorkspaceKeys(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
): string[] {
  const nextRemoteWorkspaceKeys = new Set(
    nextWorkspaceTabs.flatMap((tab) => {
      const workspaceKey = remoteWorkspaceKey(tab);
      return workspaceKey ? [workspaceKey] : [];
    }),
  );
  const closedRemoteWorkspaceKeys = new Set<string>();

  for (const previousTab of previousWorkspaceTabs) {
    const workspaceKey = remoteWorkspaceKey(previousTab);
    if (!workspaceKey || nextRemoteWorkspaceKeys.has(workspaceKey)) {
      continue;
    }
    closedRemoteWorkspaceKeys.add(workspaceKey);
  }

  return [...closedRemoteWorkspaceKeys];
}

function collectClosedRemoteWorkspaceSessionIds(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
  rememberedSessionIdsByWorkspaceKey: ReadonlyMap<string, string>,
): string[] {
  const previousLiveSessionIds = new Set(
    previousWorkspaceTabs
      .map((tab) => tab.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  return collectClosedRemoteWorkspaceKeys(previousWorkspaceTabs, nextWorkspaceTabs).flatMap(
    (workspaceKey) => {
      const sessionId = rememberedSessionIdsByWorkspaceKey.get(workspaceKey);
      // The tab that still has remoteSessionId will be released by the normal removal process below this hook.
      // Here we only release the session that "disconnects first and then clears the tab field" to avoid repeated dispose.
      return sessionId && !previousLiveSessionIds.has(sessionId) ? [sessionId] : [];
    },
  );
}

export function useRemoteWorkspaceTabLifecycle({
  tabs,
  activeWorkspaceTab,
  platform,
  onRemoteWorkspaceTabsClosed,
}: {
  tabs: WindowTabState[];
  activeWorkspaceTab: WorkspaceTabState | null;
  platform: IPlatformService;
  onRemoteWorkspaceTabsClosed?: (workspaceKeys: string[]) => void;
}) {
  const previousWorkspaceTabsRef = useRef<WindowTabState[]>([]);
  const rememberedSessionIdsByWorkspaceKeyRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const previousWorkspaceTabs = previousWorkspaceTabsRef.current.filter(isWorkspaceTab);
    const nextWorkspaceTabs = tabs.filter(isWorkspaceTab);
    const closedRemoteWorkspaceKeys = collectClosedRemoteWorkspaceKeys(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
    );
    const closedRemoteSessionIds = collectClosedRemoteWorkspaceSessionIds(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
      rememberedSessionIdsByWorkspaceKeyRef.current,
    );
    if (closedRemoteWorkspaceKeys.length > 0) {
      onRemoteWorkspaceTabsClosed?.(closedRemoteWorkspaceKeys);
      for (const workspaceKey of closedRemoteWorkspaceKeys) {
        rememberedSessionIdsByWorkspaceKeyRef.current.delete(workspaceKey);
      }
    }
    for (const tab of nextWorkspaceTabs) {
      const workspaceKey = remoteWorkspaceKey(tab);
      if (workspaceKey && tab.remoteSessionId) {
        rememberedSessionIdsByWorkspaceKeyRef.current.set(workspaceKey, tab.remoteSessionId);
      }
    }

    for (const sessionId of closedRemoteSessionIds) {
      void (async () => {
        try {
          // The disconnection event will first clear the remoteSessionId on the tab, resulting in the normal removal process below.
          // The session cannot be released. Here, the memorized sessionId is used to complete the cleanup path of "disconnect and then close the tab".
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] failed to dispose the disconnected remote session:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    const nextRemoteSessionIds = new Set(
      nextWorkspaceTabs
        .map((tab) => tab.remoteSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );

    for (const previousTab of previousWorkspaceTabs) {
      const stillExists = nextWorkspaceTabs.some((nextTab) => nextTab.id === previousTab.id);
      if (stillExists) {
        continue;
      }

      if (!previousTab.remoteSessionId) {
        continue;
      }

      const survivingRemoteTab = nextWorkspaceTabs.find((nextTab) => {
        if (!nextTab.remoteSessionId) {
          return false;
        }

        if (previousTab.workspaceIdentity && nextTab.workspaceIdentity) {
          return nextTab.workspaceIdentity === previousTab.workspaceIdentity;
        }

        return nextTab.workspacePath === previousTab.workspacePath;
      });

      if (survivingRemoteTab?.remoteSessionId) {
        // Previously, mapping was only maintained based on workspacePath. When closing a remote tab with the same path, the other remote tab would be "unbound" together.
        // Here, priority is given to reusing the bindings of surviving tabs, and refreshing the workspaceIdentity mapping synchronously to avoid subsequent RPC hitting wrong sessions.
        bindRemoteWorkspacePath(
          survivingRemoteTab.workspacePath,
          survivingRemoteTab.remoteSessionId,
        );
        if (survivingRemoteTab.workspaceIdentity) {
          bindRemoteWorkspaceIdentity(
            survivingRemoteTab.workspaceIdentity,
            survivingRemoteTab.remoteSessionId,
          );
        }
      } else {
        unbindRemoteWorkspacePath(previousTab.workspacePath);
        if (previousTab.workspaceIdentity) {
          unbindRemoteWorkspaceIdentity(previousTab.workspaceIdentity);
        }
      }
    }

    const disposedSessionIds = new Set<string>();
    for (const previousTab of previousWorkspaceTabs) {
      const sessionId = previousTab.remoteSessionId;
      if (!sessionId || nextRemoteSessionIds.has(sessionId) || disposedSessionIds.has(sessionId)) {
        continue;
      }

      disposedSessionIds.add(sessionId);
      const workspacePath = previousTab.workspacePath;
      void (async () => {
        try {
          logger.info("[Root] remote workspace tab removed, disposing the remote session", {
            workspacePath,
            workspaceIdentity: previousTab.workspaceIdentity,
            sessionId,
          });
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] failed to dispose the remote session:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    previousWorkspaceTabsRef.current = nextWorkspaceTabs;
  }, [onRemoteWorkspaceTabsClosed, platform, tabs]);

  useEffect(() => {
    if (!activeWorkspaceTab?.remoteSessionId) {
      return;
    }

    // When switching between multiple remote tabs on the same path, you cannot only bind the path mapping once when establishing a connection.
    // Otherwise, the mapping will still stay in the old tab after switching, and the hook of the workspacePath parsing service may still hit the old session.
    // Here, after switching the active tab, the path and workspaceIdentity mapping is refreshed to the current tab to ensure that the workspace-level RPC follows the current tab.
    bindRemoteWorkspacePath(activeWorkspaceTab.workspacePath, activeWorkspaceTab.remoteSessionId);
    if (activeWorkspaceTab.workspaceIdentity) {
      bindRemoteWorkspaceIdentity(
        activeWorkspaceTab.workspaceIdentity,
        activeWorkspaceTab.remoteSessionId,
      );
    }
  }, [
    activeWorkspaceTab?.remoteSessionId,
    activeWorkspaceTab?.workspaceIdentity,
    activeWorkspaceTab?.workspacePath,
  ]);
}
