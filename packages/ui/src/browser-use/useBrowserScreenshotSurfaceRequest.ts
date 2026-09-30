import { useEffect, useRef, useState } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { BrowserUseSidePaneTab, WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";

function matchesTab(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.browserId === payload.browserId &&
    tab.browserGeneration === payload.browserGeneration &&
    tab.tabId === payload.tabId
  );
}

/**
 * For a browser tab restored across processes (the `browser:` prefix), the browserId /
 * browserGeneration in the renderer registry are the values of the old process in the persistent
 * shell; once the tab has been taken over by a new scope round, the main-side owner is already
 * updated, but the renderer has no reliable sync channel (a residency transition only carries the
 * new values when the state changes). If prepare/release insisted on strict seven-tuple matching,
 * the screenshot surface of a restored tab would never match: prepare would be silently ignored →
 * the screenshot would always hit the 3s timeout; release would never hit → the pane would stick on
 * a nearly transparent fixed layer (which the user perceives as a transparent overlay hang). So
 * matching degrades to workspaceKey + sessionId + tabId — tabId is a globally unique uuid, and the
 * first two prevent cross-workspace / cross-session crosstalk; stale protection is carried by the
 * main-side coordinator using the generation inside the request.
 */
function matchesTabLoose(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.tabId === payload.tabId
  );
}

function matchesRequest(
  request: BrowserViewScreenshotSurfacePreparePayload,
  payload: BrowserViewScreenshotSurfaceReleasePayload,
): boolean {
  return (
    request.requestId === payload.requestId &&
    request.workspaceKey === payload.workspaceKey &&
    request.sessionId === payload.sessionId &&
    request.tabId === payload.tabId &&
    request.webContentsId === payload.webContentsId
  );
}

function findScreenshotSurfaceTab(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && matchesTab(tab, payload),
  );
}

/**
 * Once prepare has been received by the current renderer, browserGeneration may keep updating as
 * attach/restore proceeds. The same transient request still has to be delivered to the original
 * tab; main uses the generation inside the request for the final stale protection.
 */
export function findScreenshotSurfaceTabForRender(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return (
    findScreenshotSurfaceTab(tabs, payload) ??
    tabs.find(
      (tab): tab is BrowserUseSidePaneTab =>
        tab.type === "browser-use" && matchesTabLoose(tab, payload),
    )
  );
}

/**
 * prepare receive matching: an exact scope hit wins first; a tab restored across processes keeps
 * its registry scope metadata at the old process's values (see the matchesTabLoose comment), so it
 * can only receive prepare through the degraded match.
 */
function findScreenshotSurfaceTabForPrepare(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return findScreenshotSurfaceTabForRender(tabs, payload);
}

/**
 * Only transient prepare requests already matched to the current renderer tab registry are stored.
 * Requests do not enter the workspace store, so desktop composition sync does not spread into
 * remote/replayable task state.
 */
export function useBrowserScreenshotSurfaceRequest(
  tabs: readonly WorkspaceSidePaneTab[],
): BrowserViewScreenshotSurfacePreparePayload | null {
  const platform = usePlatform();
  const [request, setRequest] = useState<BrowserViewScreenshotSurfacePreparePayload | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const disposePrepare = platform.onBrowserViewScreenshotSurfacePrepare?.((payload) => {
      // The browser-use operation will update the tab registry; the old effect depends on tabs.
      // When command and React effect cleanup occur at the same time, the IPC listener will be temporarily removed, and the prepare message will therefore
      // Lose permanently and wait 30 seconds for background screenshot. The listener is only registered with the platform life cycle and reads the latest tabs when matched.
      if (!findScreenshotSurfaceTabForPrepare(tabsRef.current, payload)) {
        logger.debug(
          "[browser-use] ignoring screenshot surface prepare for non-current renderer tab",
          {
            requestId: payload.requestId,
            tabId: payload.tabId,
          },
        );
        return;
      }
      logger.debug("[browser-use] received screenshot surface prepare", {
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
      });
      setRequest((current) => {
        if (current && current.requestId !== payload.requestId) {
          logger.debug("[browser-use] keeping screenshot surface request that is still preparing", {
            requestId: current.requestId,
            tabId: current.tabId,
          });
          return current;
        }
        return payload;
      });
    });
    const disposeRelease = platform.onBrowserViewScreenshotSurfaceRelease?.((payload) => {
      setRequest((current) => {
        if (!current || !matchesRequest(current, payload)) {
          return current;
        }
        return null;
      });
    });
    return () => {
      disposePrepare?.();
      disposeRelease?.();
    };
  }, [platform]);

  return request;
}
