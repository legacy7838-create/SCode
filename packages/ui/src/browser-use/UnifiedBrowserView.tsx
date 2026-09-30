/* oxlint-disable eslint(max-lines) -- UnifiedBrowserView keeps navigation, events and the guest
 * lifecycle of the stable webview in one place; the horizontal scroll chain has been pushed down
 * into a separate hook.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWebElementPicker } from "@/hooks/useWebElementPicker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";
import { BrowserViewportSurface } from "@/browser-use/BrowserViewportSurface.js";
import { BrowserViewportToolbar } from "@/browser-use/BrowserViewportToolbar.js";
import { useBrowserResizeOperationWarning } from "@/browser-use/useBrowserResizeOperationWarning.js";
import { useBrowserScreenshotSurfaceReady } from "@/browser-use/useBrowserScreenshotSurfaceReady.js";
import { useEmbeddedBrowserWheelChain } from "@/browser-use/useEmbeddedBrowserWheelChain.js";
import { useDesktopZoomFactor } from "@/browser-use/useDesktopZoomFactor.js";
import { useResponsiveBrowserViewportControl } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import {
  DEFAULT_BROWSER_URL,
  INITIAL_BROWSER_STATE,
  displayBrowserUrl,
  isDefaultBrowserOpenableUrl,
  isRecoverableBrowserGuestExitReason,
  normalizeBrowserUrl,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

type PendingGuestNavigationCompletion = {
  resolve: () => void;
  url: string;
};

/**
 * UnifiedBrowserView — the unified browser view (a `<webview>` + CDP-on-guest architecture).
 *
 * Web pixels are rendered directly by the `<webview>` guest inside the renderer (composited in the
 * DOM, coverable by DOM overlays, which fully solves the problem of the WebContentsView native
 * layer occluding menus). human navigation / back-forward / reload / element picking call webview
 * methods directly (low latency, no handshake dependency); chrome state is driven by webview
 * events.
 *
 * At did-attach it also reports the guest's webContentsId to main (browserViewAttachGuest), so main
 * can attach a CDP (webContents.debugger) to that guest and let the agent drive this tab over the
 * protocol.
 *
 * The chrome reuses the BrowserToolbar of EmbeddedBrowserPaneParts; URL normalization and the
 * not-mounted fallback reuse embeddedBrowserHelpers.
 */
export function UnifiedBrowserView({
  browserKey,
  isResidencyRestore = false,
  isVisible,
  isSelected = isVisible,
  isCurrentTask = isSelected,
  initialUrl,
  faviconUrl,
  navigationRequest,
  onUrlChange,
  onPageMetadataChange,
  onNavigationRequestHandled,
  workspacePath,
  workspaceIdentity,
  workspaceKey,
  remoteSessionId,
  sessionId,
  residencyGeneration,
  browserUseOperationUntil,
  browserResizeBaselineVersion,
  screenshotSurfaceRequest,
  deferEmptyGuest = false,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
}: {
  /** The controlled view key (= tab.id / sessionId, used by the agent to locate that tab). */
  browserKey: string;
  /**
   * When restoring under budget, the bootstrap src is revoked as soon as the guest is created; the
   * first effective navigation is owned by main alone.
   */
  isResidencyRestore?: boolean;
  /**
   * Whether the pane is visible (active + expanded). While hidden it is only removed from the
   * layout, not unmounted, which preserves the page and its history.
   */
  isVisible: boolean;
  /**
   * The tab strip selection state is orthogonal to the panel display state; selected is kept even
   * while collapsed.
   */
  isSelected?: boolean;
  /** The tab of the current task, used for main's eviction tier. */
  isCurrentTask?: boolean;
  /** The initial / restore URL navigated to on mount (the human tab restore state). */
  initialUrl?: string | null;
  /** The current favicon of the tab shell; persisted along with the residency report. */
  faviconUrl?: string | null;
  /**
   * An external request asks to navigate that tab to a URL ({id,url}); onNavigationRequestHandled
   * is the receipt once it has been consumed.
   */
  navigationRequest?: { id: string; url: string } | null;
  /** Reports the current URL changing (persisting the human tab URL). */
  onUrlChange?: (url: string) => void;
  /** Reports page title / favicon changes (driving the tab label). */
  onPageMetadataChange?: (metadata: { title?: string; faviconUrl?: string | null }) => void;
  /** The receipt that the navigationRequest has been consumed. */
  onNavigationRequestHandled?: (requestId: string) => void;
  /**
   * The workspace path needed to add an element selection to chat (passed by the human branch; the
   * agent branch may omit it).
   */
  workspacePath?: string;
  /** The workspace identity that owns the element selection context (passed by the human branch). */
  workspaceIdentity?: string;
  /**
   * The identity scope frozen when a browser-use tab is created; when present it takes priority
   * over the current workspace ambient props.
   */
  workspaceKey?: string;
  remoteSessionId?: string;
  /**
   * The conversation ownership frozen when the tab is created; it must not be backfilled from the
   * active task at dom-ready time.
   */
  sessionId?: string;
  residencyGeneration?: number;
  /** The operation deadline shared with the tab mouse indicator; passed only for browser-use tabs. */
  browserUseOperationUntil?: number;
  browserResizeBaselineVersion?: number;
  /**
   * Temporarily keeps the real layout of a background guest before a screenshot; it does not change
   * any active/focus semantics.
   */
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  /**
   * Blank human tabs create their guest lazily; agent/browser-use must keep the attach during the
   * creation window.
   */
  deferEmptyGuest?: boolean;
  /** Passed only by the human Browser surface; Agent Browser Use must keep it undefined. */
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  /** Accepts only changes the human UI makes deliberately; Agent viewport events must not call it. */
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
}): React.JSX.Element {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const desktopZoomFactor = useDesktopZoomFactor();

  const [addressValue, setAddressValue] = useState("");
  const [browserState, setBrowserState] = useState<BrowserState>(INITIAL_BROWSER_STATE);
  const hasInitialNavigation = Boolean(initialUrl && initialUrl !== DEFAULT_BROWSER_URL);
  const [hasNavigated, setHasNavigated] = useState(hasInitialNavigation);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [webview, setWebview] = useState<ElectronWebviewTag | null>(null);
  const [guestAttachRetryNonce, setGuestAttachRetryNonce] = useState(0);
  useBrowserScreenshotSurfaceReady({
    request: screenshotSurfaceRequest ?? null,
    webview,
  });
  const shouldComposeSurface = Boolean(screenshotSurfaceRequest);
  const setGuestZoomFactor = useCallback((target: ElectronWebviewTag, targetZoomFactor: number) => {
    if (typeof target.setZoomFactor !== "function") return;
    safeWebviewCall(
      () => target.setZoomFactor(targetZoomFactor),
      undefined,
      (error) => {
        logger.debug("[browser-use] skipping zoom sync on unready webview", {
          error: error instanceof Error ? error.message : String(error),
          targetZoomFactor,
        });
      },
    );
  }, []);
  const normalizeResponsiveGuestZoom = useCallback(() => {
    if (webview) setGuestZoomFactor(webview, 1);
  }, [setGuestZoomFactor, webview]);
  const {
    browserRegionRef,
    notifyBrowserViewportResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  } = useBrowserResizeOperationWarning({
    browserKey,
    isVisible,
    operationUntil: browserUseOperationUntil,
    resizeBaselineVersion: browserResizeBaselineVersion,
  });
  const {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  } = useResponsiveBrowserViewportControl({
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange: prepareForAgentViewportChange,
    onViewportSynchronized: normalizeResponsiveGuestZoom,
    onViewportResize: notifyBrowserViewportResize,
    initialHumanViewportPreference,
    onHumanViewportPreferenceChange,
    sessionId,
  });
  // What MediaRecorder records is the WebView surface actually synthesized in the renderer. If the user's Fit/50% is used
  // Preview, subsequent canvas can only enlarge the low-resolution source to the target size. Recording a lease thus derives a 100% surface,
  // Does not modify the user's free size, zoom selection, or persistent state; React will naturally restore the original preview after the request is released.
  const forceUnscaledSurface = screenshotSurfaceRequest?.surfaceScaleMode === "unscaled";
  // The fallback viewport of a normal background tab may be larger than the window; passing only Fit will not enable the layout.
  // The webview will never be ready after shrinking with the ready layer. The responsive layout of the requested size is uniformly derived during screenshots,
  // After release, the user mode and size are restored, preferences are not written, and guest is not rebuilt.
  const effectiveIsResponsiveMode = isResponsiveMode || Boolean(screenshotSurfaceRequest);
  const effectiveViewportSize = screenshotSurfaceRequest?.viewport ?? responsiveViewportSize;
  // Ordinary screenshots only temporarily change the layout; guest zoom of fallback metrics is managed by main.
  // If the temporary Fit is used as a user mode switch, the release will restore desktop zoom by mistake, destroying subsequent CDP coordinates.
  const shouldNormalizeGuestZoom = isResponsiveMode || forceUnscaledSurface;
  // Fixed 100%/200% preview not shrinking with screenshot canvas, Windows high DPI guest raster
  // May still be clipped by host visibility range. Ordinary screenshots are temporarily fit and the user scale is restored after release; recording remains unscaled.
  const effectiveViewportZoom = forceUnscaledSurface
    ? "100"
    : screenshotSurfaceRequest
      ? "fit"
      : responsiveViewportZoom;
  useEmbeddedBrowserWheelChain({
    browserRegionRef,
    isResponsiveMode: effectiveIsResponsiveMode,
    webview,
  });

  // The navigation URL queued before dom-ready; the loadURL is unified after the webview is ready (the src of <webview> only takes effect in the first load).
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef<string | null>(null);
  // Consumed initialUrl/navigationRequest to avoid repeated navigation.
  const lastAppliedInitialUrlRef = useRef<string | null>(null);
  const lastHandledNavigationRequestIdRef = useRef<string | null>(null);
  const lastRestorableUrlRef = useRef<string | null>(
    initialUrl && initialUrl !== DEFAULT_BROWSER_URL ? initialUrl : null,
  );
  const guestRecoveryInProgressRef = useRef(false);
  // When a failed guest receives external navigation, the acknowledgment must wait until the replacement guest actually takes over the loadURL.
  const pendingGuestNavigationCompletionRef = useRef<PendingGuestNavigationCompletion | null>(null);
  // GuestId reporting and deduplication: did-attach and dom-ready will be triggered continuously; only guest or active status changes will be re-reported.
  const lastReportedGuestRef = useRef<{
    active: boolean;
    webContentsId: number;
    scopeFingerprint: string;
  } | null>(null);
  const wasResponsiveModeRef = useRef(false);
  // Guest destruction attribution management: online main process UAF (EXC_BAD_ACCESS at
  // 0x10, DevToolsSession is notified in transit that the access has been destructed (client) before it occurs, the main log can only be seen
  // "cdp still attached on destroyed guest", it is impossible to distinguish who uninstalled the webview node:
  // residency suspends shell change/parent tree uninstallation/shouldMountWebview conditional flip/generation replacement.
  // ref(null) is the first site for React to uninstall the <webview> node; it cooperates with the component uninstallation management and suspends the shell ack log.
  // Can crucify the destroyer and timing. It will only be called after the webview actually exists, and the magnitude is consistent with the tab life cycle.
  const webviewTeardownProbeRef = useRef({
    browserKey: "",
    generation: 0,
    hasNavigated: hasInitialNavigation,
    hadWebview: false,
  });
  webviewTeardownProbeRef.current.browserKey = browserKey;
  webviewTeardownProbeRef.current.generation = webviewGeneration;
  webviewTeardownProbeRef.current.hasNavigated = hasNavigated;
  const logWebviewTeardown = useCallback((trigger: string) => {
    const probe = webviewTeardownProbeRef.current;
    logger.info("[browser-use] webview node left the DOM (guest will be destroyed)", {
      browserKey: probe.browserKey,
      generation: probe.generation,
      guestReported: lastReportedGuestRef.current,
      hasNavigated: probe.hasNavigated,
      trigger,
    });
  }, []);
  const onPageMetadataChangeRef = useRef(onPageMetadataChange);
  onPageMetadataChangeRef.current = onPageMetadataChange;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  const completePendingGuestNavigation = useCallback(
    (completion?: PendingGuestNavigationCompletion | null) => {
      const pendingCompletion =
        completion === undefined ? pendingGuestNavigationCompletionRef.current : completion;
      if (!pendingCompletion || pendingGuestNavigationCompletionRef.current !== pendingCompletion) {
        return;
      }
      pendingGuestNavigationCompletionRef.current = null;
      pendingCompletion.resolve();
    },
    [],
  );

  const waitForGuestNavigationTakeover = useCallback((url: string) => {
    // The same view only retains one external navigation intent at the same time; if future entries allow concurrency, the new request will explicitly replace the old request.
    // End the old receipt first to prevent the overwritten Promise from hanging permanently.
    const replacedCompletion = pendingGuestNavigationCompletionRef.current;
    pendingGuestNavigationCompletionRef.current = null;
    replacedCompletion?.resolve();
    return new Promise<void>((resolve) => {
      pendingGuestNavigationCompletionRef.current = { resolve, url };
    });
  }, []);

  useEffect(
    () => () => {
      // When the view is closed, it is explicitly canceled and the upper navigationRequest cannot be left to wait forever.
      completePendingGuestNavigation();
    },
    [completePendingGuestNavigation],
  );

  useEffect(
    () => () => {
      // Uninstalling the component means that <webview> must leave the DOM: Residency suspends shell change / parent panel closes /
      // Session switch whole tree rehang. The time difference with ref-null can be used to distinguish "replacement and reconstruction" from "true uninstallation".
      if (webviewTeardownProbeRef.current.hadWebview || lastReportedGuestRef.current) {
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("component-unmount");
      }
    },
    [logWebviewTeardown],
  );

  const reportBrowserGuest = useCallback(
    (active: boolean) => {
      if (!webview) return;
      if (typeof webview.getWebContentsId !== "function") return;
      const webContentsId = safeWebviewCall(() => webview.getWebContentsId(), 0);
      if (webContentsId <= 0) return;
      const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
      const scopeFingerprint = JSON.stringify({
        active,
        webContentsId,
        workspaceKey: effectiveWorkspaceKey ?? "",
        remoteSessionId: remoteSessionId ?? "",
        sessionId: sessionId ?? "",
        residencyGeneration: residencyGeneration ?? null,
      });
      const lastReported = lastReportedGuestRef.current;
      if (lastReported?.scopeFingerprint === scopeFingerprint) {
        return;
      }
      lastReportedGuestRef.current = { active, webContentsId, scopeFingerprint };
      const attachRequest = platform.browserViewAttachGuest?.({
        key: browserKey,
        webContentsId,
        active,
        ...(effectiveWorkspaceKey ? { workspaceKey: effectiveWorkspaceKey } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
      });
      if (!attachRequest) return;
      void attachRequest
        .then((result) => {
          // The old preload may still just return undefined; the compatible semantics of a successful attach remain unchanged.
          if (!result || result.ok) {
            synchronizeInitialHumanViewport();
            return;
          }
          logger.warn(
            "[browser-use] main rejected guest attach, waiting to rebind by owner scope",
            {
              browserKey,
              reason: result.reason,
              recoveryRequested: result.recoveryRequested,
            },
          );
          // main will replay BrowserViewReady; clear the deduplication mark to ensure that the same webContentsId can be re-reported.
          if (result.recoveryRequested) {
            lastReportedGuestRef.current = null;
            setGuestAttachRetryNonce((current) => current + 1);
          }
        })
        .catch((error) => {
          logger.debug("[browser-use] failed to report guest webContentsId", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      browserKey,
      platform,
      remoteSessionId,
      residencyGeneration,
      sessionId,
      synchronizeInitialHumanViewport,
      webview,
      workspaceKey,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const detachBrowserGuestBeforeReplacement = useCallback(async (): Promise<boolean> => {
    const lastReported = lastReportedGuestRef.current;
    // When the guest has not been reported to main, there is no native CDP session, and the web side will not expose the desktop capabilities.
    if (!lastReported || !platform.browserViewDetachGuest) return true;
    try {
      const detached = await platform.browserViewDetachGuest({
        key: browserKey,
        webContentsId: lastReported.webContentsId,
      });
      if (!detached) {
        logger.warn(
          "[browser-use] main did not confirm old guest CDP detach, cancelling webview rebuild",
          {
            browserKey,
            webContentsId: lastReported.webContentsId,
          },
        );
      }
      return detached;
    } catch (error) {
      logger.warn(
        "[browser-use] request to main to detach old guest CDP failed, cancelling webview rebuild",
        {
          browserKey,
          error: error instanceof Error ? error.message : String(error),
          webContentsId: lastReported.webContentsId,
        },
      );
      return false;
    }
  }, [browserKey, platform]);

  const {
    cancelPicking: cancelWebElementPicking,
    isPicking: isWebElementPicking,
    togglePicking: toggleWebElementPicking,
  } = useWebElementPicker({
    // Transport-independent exit: go when webview is ready <webview>.executeJavaScript(script, true);
    // If it is still null, return canceled (a legal selection result) and keep no-op.
    executeJs: (script) =>
      webview ? webview.executeJavaScript(script, true) : Promise.resolve({ status: "cancelled" }),
    workspacePath: workspacePath ?? "",
    workspaceIdentity: workspaceKey ?? workspaceIdentity,
  });

  // ---- Synchronize chrome status from webview (url/forward/back/title)----
  const syncBrowserState = useCallback((target: ElectronWebviewTag) => {
    // If the guest is not attached before dom-ready / navigation churn / reattach process, the synchronization method will throw
    // "Must be attached to the DOM", use safeWebviewCall to avoid bubbling up to window.onerror.
    const onDetached = (error: unknown) => {
      logger.debug("[browser-use] skipping state sync on unready webview", {
        error: error instanceof Error ? error.message : String(error),
      });
    };
    const currentUrl =
      safeWebviewCall(() => target.getURL(), "", onDetached) || DEFAULT_BROWSER_URL;
    const canGoBack = safeWebviewCall(() => target.canGoBack(), false, onDetached);
    const canGoForward = safeWebviewCall(() => target.canGoForward(), false, onDetached);
    const title = safeWebviewCall(() => target.getTitle(), "", onDetached);
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      lastRestorableUrlRef.current = currentUrl;
    }
    setAddressValue(displayBrowserUrl(currentUrl));
    setBrowserState((prev) => ({
      ...prev,
      canGoBack,
      canGoForward,
      currentUrl,
      isReady: true,
      title,
    }));
    onPageMetadataChangeRef.current?.({ title: title || undefined });
    // The page URL is not trustworthy: it is only used for display and tab persistence, and does not participate in any execution path.
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      onUrlChangeRef.current?.(currentUrl);
    }
  }, []);

  // ---- webview event wiring + did-attach reporting guestId ----
  useEffect(() => {
    if (!webview) return;

    const handleDidAttach = () => {
      // navigationHistory.restore can only be used with new guests that have never loaded a page. If you wait
      // dom-ready is reported. By default, about:blank has been submitted and can only be degraded to URL reloading; it is reported immediately after attaching.
      // Give main a chance to restore the full Chromium pageState before the first navigation commit.
      if (isResidencyRestore) {
        // `<webview>` must have src before the guest will be created, but the retained attributes will be submitted again after attaching
        // about:blank and interrupt main's history restore. Delete the bootstrap src immediately after the guest already exists.
        webview.removeAttribute("src");
      }
      reportBrowserGuest(isSelected);
    };

    const handleDomReady = () => {
      // Electron/Chromium will continue to propagate the main window page zoom to the guest; only the outer layer will be compensated
      // When transforming, guest innerWidth/DPR will still change. Free size must have guest zoom fixed to 1,
      // The normal mode still leaves it to Electron to propagate naturally to avoid actively rewriting the web page zoom.
      if (isResponsiveMode) setGuestZoomFactor(webview, 1);
      // did-attach is the earliest opportunity for complete history recovery; dom-ready is reserved for Electron version compatibility.
      reportBrowserGuest(isSelected);

      // The src attribute of <webview> only takes effect in the first navigation. Subsequent navigation uses the imperative loadURL: consumption queue URL.
      const pending = pendingUrlRef.current;
      if (pending) {
        const pendingCompletion = pendingGuestNavigationCompletionRef.current;
        pendingUrlRef.current = null;
        setBrowserState((prev) => ({ ...prev, isReady: true }));
        void (async () => {
          try {
            await webview.loadURL(pending);
          } catch (loadError: unknown) {
            const message = loadError instanceof Error ? loadError.message : String(loadError);
            if (!message.includes("ERR_ABORTED")) {
              setBrowserState((prev) => ({
                ...prev,
                errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
                isLoading: false,
              }));
            }
          } finally {
            // Simply writing the external request to pendingUrl and then acknowledging it is not enough: the failed guest will never consume it.
            // Only when the guest reaches dom-ready and completes a loadURL attempt can the navigation intention be truly taken over.
            completePendingGuestNavigation(pendingCompletion);
          }
        })();
        return;
      }
      guestRecoveryInProgressRef.current = false;
      syncBrowserState(webview);
    };

    const handleDidStartLoading = () => {
      void cancelWebElementPicking();
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: null,
        loadErrorCode: null,
        isLoading: true,
      }));
    };

    const handleDidStopLoading = () => {
      guestRecoveryInProgressRef.current = false;
      setBrowserState((prev) => ({ ...prev, isLoading: false }));
      syncBrowserState(webview);
    };

    const handleNavigation = () => {
      syncBrowserState(webview);
    };

    const handleTitleUpdated = (event: ElectronWebviewTitleEvent) => {
      setBrowserState((prev) => ({ ...prev, title: event.title }));
      onPageMetadataChangeRef.current?.({ title: event.title || undefined });
    };

    const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
      // Ignore subframe failures with -3 (ERR_ABORTED, interrupted by subsequent navigation).
      if (!event.isMainFrame || event.errorCode === -3) return;
      logger.warn("[browser-use] page load failed", {
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        url: event.validatedURL,
      });
      setBrowserState((prev) => ({
        ...prev,
        currentUrl: event.validatedURL || prev.currentUrl,
        errorMessage: intl.formatMessage(
          { id: "browser.loadFailed" },
          { message: event.errorDescription },
        ),
        loadErrorCode: event.errorCode,
        isLoading: false,
      }));
      setAddressValue(
        displayBrowserUrl(
          event.validatedURL || safeWebviewCall(() => webview.getURL(), "") || DEFAULT_BROWSER_URL,
        ),
      );
      guestRecoveryInProgressRef.current = false;
    };

    const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
      const { exitCode, reason } = event.details;
      if (!isRecoverableBrowserGuestExitReason(reason)) {
        logger.warn(
          "[browser-use] guest renderer exited unexpectedly and cannot recover automatically",
          {
            browserKey,
            exitCode,
            reason,
          },
        );
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message: `renderer ${reason} (${exitCode})` },
          ),
          // After the renderer exits, the entire guest needs to be rebuilt and cannot be restored by simply re-navigating.
          // guestFailure allows the interface to prioritize the reconstruction entry instead of the retry entry for ordinary page loading errors.
          guestFailure: { exitCode, reason },
          isLoading: false,
          isReady: false,
        }));
        // If the replacement guest fails to start again, a clear failure result has been formed; the wait is ended, so that the upper layer no longer permanently suspends the request.
        completePendingGuestNavigation();
        return;
      }
      if (guestRecoveryInProgressRef.current) return;

      guestRecoveryInProgressRef.current = true;
      const recoveryUrl = lastRestorableUrlRef.current;
      void cancelWebElementPicking();

      logger.warn(
        "[browser-use] guest renderer exited unexpectedly, rebuilding in place and restoring last URL",
        {
          browserKey,
          exitCode,
          reason,
          recoveryUrl,
        },
      );
      void (async () => {
        const detached = await detachBrowserGuestBeforeReplacement();
        if (!detached) {
          guestRecoveryInProgressRef.current = false;
          setBrowserState((prev) => ({
            ...prev,
            errorMessage: null,
            loadErrorCode: null,
            guestFailure: { exitCode, reason },
            isLoading: false,
            isReady: false,
          }));
          completePendingGuestNavigation();
          return;
        }

        pendingUrlRef.current = recoveryUrl;
        lastRequestedUrlRef.current = null;
        lastAppliedInitialUrlRef.current = null;
        lastReportedGuestRef.current = null;
        setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
        setHasNavigated(Boolean(recoveryUrl));
        setBrowserState((prev) => ({
          ...prev,
          canGoBack: false,
          canGoForward: false,
          currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
          errorMessage: null,
          loadErrorCode: null,
          guestFailure: null,
          isLoading: Boolean(recoveryUrl),
          isReady: false,
        }));
        // renderer observed the guest exit, but main's render-process-gone listener was not
        // Arrive first every time. You must wait for the above CDP detach ACK before incrementing the key; otherwise React will uninstall the old
        // `<webview>` will cause the Electron DevToolsSession to access the destructed client in an in-flight notification.
        setWebviewGeneration((current) => current + 1);
      })();
    };

    webview.addEventListener("did-attach", handleDidAttach);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    return () => {
      webview.removeEventListener("did-attach", handleDidAttach);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
    };
  }, [
    browserKey,
    cancelWebElementPicking,
    completePendingGuestNavigation,
    detachBrowserGuestBeforeReplacement,
    intl,
    isResidencyRestore,
    isSelected,
    platform,
    reportBrowserGuest,
    setGuestZoomFactor,
    syncBrowserState,
    webview,
  ]);

  useEffect(() => {
    if (!webview) return;
    const wasResponsiveMode = wasResponsiveModeRef.current;
    wasResponsiveModeRef.current = shouldNormalizeGuestZoom;

    if (shouldNormalizeGuestZoom) {
      setGuestZoomFactor(webview, 1);
    } else if (wasResponsiveMode) {
      // Only restore the current application zoom when exiting free size; continue to use Electron's native propagation during normal browsing.
      setGuestZoomFactor(webview, desktopZoomFactor);
    }
  }, [desktopZoomFactor, shouldNormalizeGuestZoom, setGuestZoomFactor, webview]);

  useEffect(() => {
    reportBrowserGuest(isSelected);
  }, [guestAttachRetryNonce, isSelected, reportBrowserGuest]);

  useEffect(() => {
    const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
    if (!effectiveWorkspaceKey || !sessionId) return;
    const restoreUrl =
      browserState.currentUrl && browserState.currentUrl !== DEFAULT_BROWSER_URL
        ? browserState.currentUrl
        : (lastRestorableUrlRef.current ?? null);
    void platform
      .browserViewReportResidency?.({
        tabId: browserKey,
        workspaceKey: effectiveWorkspaceKey,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId,
        selected: isSelected,
        visible: isVisible,
        currentTask: isCurrentTask,
        loading: browserState.isLoading,
        restoreUrl,
        title: browserState.title || null,
        // The favicon cannot just stay in the renderer tab state: after the residency is reported missing,
        // The shell obtained from suspend and cold boot recovery will inevitably return the earth icon.
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
      })
      .catch((error) => {
        logger.debug("[browser-use] failed to report tab residency", {
          error: error instanceof Error ? error.message : String(error),
          tabId: browserKey,
        });
      });
  }, [
    browserKey,
    browserState.currentUrl,
    browserState.isLoading,
    browserState.title,
    faviconUrl,
    isCurrentTask,
    isSelected,
    isVisible,
    platform,
    remoteSessionId,
    sessionId,
    workspaceKey,
    workspaceIdentity,
    workspacePath,
  ]);

  const rebuildBrowserGuest = useCallback(
    async (
      recoveryUrl: string | null,
      trigger: "address-navigation" | "external-navigation" | "manual-retry",
    ): Promise<boolean> => {
      guestRecoveryInProgressRef.current = true;
      void cancelWebElementPicking();

      const detached = await detachBrowserGuestBeforeReplacement();
      if (!detached) {
        guestRecoveryInProgressRef.current = false;
        return false;
      }

      pendingUrlRef.current = recoveryUrl;
      lastRequestedUrlRef.current = null;
      lastAppliedInitialUrlRef.current = null;
      lastReportedGuestRef.current = null;

      logger.warn("[browser-use] rebuilding failed guest renderer on explicit navigation", {
        browserKey,
        recoveryUrl,
        trigger,
      });
      setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
      setHasNavigated(Boolean(recoveryUrl));
      setBrowserState((prev) => ({
        ...prev,
        canGoBack: false,
        canGoForward: false,
        currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
        errorMessage: null,
        loadErrorCode: null,
        guestFailure: null,
        isLoading: Boolean(recoveryUrl),
        isReady: false,
      }));
      setWebviewGeneration((current) => current + 1);
      return true;
    },
    [browserKey, cancelWebElementPicking, detachBrowserGuestBeforeReplacement],
  );

  // ----Navigation (human directly drives webview.loadURL; if not ready, queue it to dom-ready for consumption)----
  const openUrl = useCallback(
    async (input: string, source: "toolbar" | "restore" | "request" = "toolbar") => {
      const nextUrl = normalizeBrowserUrl(input);
      if (!nextUrl) {
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.invalidUrl" }),
          // The illegal address has nothing to do with the last network failure; not clearing it will cause the error state to continue to hang the old certificate guidance.
          loadErrorCode: null,
        }));
        return;
      }

      // If external requests can only be queued to guests who are not yet ready, they must wait until dom-ready actually takes over the loadURL before receiving a receipt;
      // The address bar/resume navigation does not have upstream consumption confirmation and does not need to wait for this life cycle signal.
      const navigationTakenOver =
        source === "request" && (!webview || !browserState.isReady)
          ? waitForGuestNavigationTakeover(nextUrl)
          : null;

      // After launch-failed isReady=false, just writing the address bar URL into pendingUrl is not enough:
      // The failed guest will never trigger dom-ready again, and the failed state and queued navigation will be permanently stuck.
      if (browserState.guestFailure && (source === "toolbar" || source === "request")) {
        lastRestorableUrlRef.current = nextUrl;
        onUrlChange?.(nextUrl);
        const rebuilt = await rebuildBrowserGuest(
          nextUrl,
          source === "request" ? "external-navigation" : "address-navigation",
        );
        if (!rebuilt) completePendingGuestNavigation();
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      // Deduplication: External request and restore may give the same URL at the same time, and consecutive loadURLs will trigger ERR_ABORTED(-3).
      if (
        nextUrl === lastRequestedUrlRef.current &&
        (pendingUrlRef.current === nextUrl || browserState.isLoading)
      ) {
        setAddressValue(displayBrowserUrl(nextUrl));
        setHasNavigated(true);
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      setAddressValue(displayBrowserUrl(nextUrl));
      setHasNavigated(true);
      lastRestorableUrlRef.current = nextUrl;
      onUrlChange?.(nextUrl);
      setBrowserState((prev) => ({ ...prev, errorMessage: null, loadErrorCode: null }));
      lastRequestedUrlRef.current = nextUrl;

      if (!webview || !browserState.isReady) {
        pendingUrlRef.current = nextUrl;
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      try {
        await webview.loadURL(nextUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ERR_ABORTED")) return;
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
          isLoading: false,
        }));
      }
    },
    [
      browserState.guestFailure,
      browserState.isLoading,
      browserState.isReady,
      completePendingGuestNavigation,
      intl,
      onUrlChange,
      rebuildBrowserGuest,
      waitForGuestNavigationTakeover,
      webview,
    ],
  );

  // ---- Navigate to the initial/recovery URL when mounting (human tab recovery state)----
  useEffect(() => {
    if (!initialUrl || initialUrl === DEFAULT_BROWSER_URL) return;
    lastRestorableUrlRef.current = initialUrl;
    if (lastAppliedInitialUrlRef.current === initialUrl) return;
    if (browserState.currentUrl === initialUrl) {
      lastAppliedInitialUrlRef.current = initialUrl;
      setHasNavigated(true);
      setAddressValue(displayBrowserUrl(initialUrl));
      return;
    }
    lastAppliedInitialUrlRef.current = initialUrl;
    void openUrl(initialUrl, "restore");
  }, [browserState.currentUrl, initialUrl, openUrl]);

  // ---- External navigation request ({id,url}): Navigation and receipt ----
  useEffect(() => {
    if (!navigationRequest) return;
    if (lastHandledNavigationRequestIdRef.current === navigationRequest.id) return;
    lastHandledNavigationRequestIdRef.current = navigationRequest.id;
    void openUrl(navigationRequest.url, "request").finally(() => {
      onNavigationRequestHandled?.(navigationRequest.id);
    });
  }, [navigationRequest, onNavigationRequestHandled, openUrl]);

  // ----Tools/Navigation Buttons (isReady gate control + safeWebviewCall click to instantly detach the race)----
  const runWebviewAction = useCallback((action: () => void) => {
    safeWebviewCall(
      () => {
        action();
        return undefined;
      },
      undefined,
      (error) => {
        logger.debug("[browser-use] skipping action on unready webview", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void openUrl(addressValue);
    },
    [addressValue, openUrl],
  );

  const handleGoBack = useCallback(() => {
    if (!webview || !browserState.canGoBack) return;
    runWebviewAction(() => webview.goBack());
  }, [browserState.canGoBack, runWebviewAction, webview]);

  const handleGoForward = useCallback(() => {
    if (!webview || !browserState.canGoForward) return;
    runWebviewAction(() => webview.goForward());
  }, [browserState.canGoForward, runWebviewAction, webview]);

  const handleReload = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.reload());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenDevTools = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.openDevTools());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenExternal = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => {
      const currentUrl = webview.getURL();
      // Security boundary: The system's default browser entry only allows Web URLs and file URLs, and inline protocols such as about/data are still prohibited.
      if (!isDefaultBrowserOpenableUrl(currentUrl)) return;
      platform.openExternal(currentUrl);
    });
  }, [browserState.isReady, platform, runWebviewAction, webview]);

  const handleTogglePicker = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    void toggleWebElementPicking().catch((error: unknown) => {
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: intl.formatMessage(
          { id: "browser.elementPickerFailed" },
          { message: error instanceof Error ? error.message : String(error) },
        ),
      }));
    });
  }, [browserState.isReady, intl, toggleWebElementPicking, webview]);

  const handleToggleResponsiveMode = useCallback(() => {
    toggleResponsiveMode();
  }, [toggleResponsiveMode]);

  const handleResponsiveViewportSizeChange = updateResponsiveViewportSize;

  const handleResponsiveViewportInput = useCallback(
    (viewportSize: typeof responsiveViewportSize) => {
      notifyBrowserViewportResize();
      updateResponsiveViewportSize(viewportSize);
    },
    [notifyBrowserViewportResize, updateResponsiveViewportSize],
  );

  const faviconListenerRef = useRef<{
    node: ElectronWebviewTag;
    listener: (event: ElectronWebviewFaviconEvent) => void;
  } | null>(null);
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      const current = faviconListenerRef.current;
      if (current?.node === node) return;
      if (current) {
        current.node.removeEventListener("page-favicon-updated", current.listener);
        faviconListenerRef.current = null;
      }
      if (node) {
        const listener = (event: ElectronWebviewFaviconEvent) => {
          onPageMetadataChangeRef.current?.({
            faviconUrl: event.favicons[0] ?? null,
          });
        };
        // favicon is a guest event that may only be triggered once; when useEffect is wired,
        // It may have been emitted between the webview ref submission and the effect execution. Synchronous listening in the ref stage can seal the window.
        node.addEventListener("page-favicon-updated", listener);
        faviconListenerRef.current = { node, listener };
      } else if (webviewTeardownProbeRef.current.hadWebview) {
        // Generation replacement (controlled reconstruction) and parent uninstallation will go here first; if there is a new node ref immediately after
        // The callback is generation replacement, otherwise it is whole tree/conditional unloading. See the webviewTeardownProbeRef annotation for destruction of attribution management.
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("ref-null");
      }
      if (node) webviewTeardownProbeRef.current.hadWebview = true;
      setWebview(node);
    },
    [logWebviewTeardown],
  );

  const handleRetryGuest = useCallback(() => {
    void rebuildBrowserGuest(lastRestorableUrlRef.current, "manual-retry");
  }, [rebuildBrowserGuest]);

  // The loading failure is just that the navigation is rejected this time, and the guest itself is still alive: just re-enter the openUrl without rebuilding the guest.
  const handleRetryLoad = useCallback(() => {
    const retryUrl = lastRestorableUrlRef.current ?? browserState.currentUrl;
    if (!retryUrl) return;
    void openUrl(retryUrl, "toolbar");
  }, [browserState.currentUrl, openUrl]);

  // After the addressValue draft is included in the vacant state judgment, as long as the user starts typing and has not yet entered,
  // The vacant state will be hidden in advance and the webview will be exposed. Empty states are determined only by confirmed navigation and loading/error states.
  const isEmptyBrowserState =
    !hasNavigated && !browserState.isLoading && !browserState.errorMessage;
  const shouldMountWebview =
    !deferEmptyGuest || isResidencyRestore || hasNavigated || hasInitialNavigation;
  const prevShouldMountWebviewRef = useRef(shouldMountWebview);
  useEffect(() => {
    const previous = prevShouldMountWebviewRef.current;
    prevShouldMountWebviewRef.current = shouldMountWebview;
    if (previous && !shouldMountWebview && webviewTeardownProbeRef.current.hadWebview) {
      logWebviewTeardown("should-mount-flip");
    }
  }, [logWebviewTeardown, shouldMountWebview]);

  // The display:none of inactive will cause Electron to retain the old compositor surface, and the background screenshot will be tiled according to the old surface.
  // flex during prepare is only used for compositing; outer inert, pointer-events-none, and aria-hidden isolate interactions with a11y.
  return (
    <div
      aria-hidden={!isVisible}
      data-browser-screenshot-webview-state={
        screenshotSurfaceRequest ? (webview ? "ready" : "missing") : undefined
      }
      className={cn(
        isVisible || shouldComposeSurface ? "flex" : "hidden",
        "h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
      )}
    >
      <BrowserToolbar
        addressValue={addressValue}
        browserState={browserState}
        formatMessage={intl.formatMessage}
        onAddressChange={setAddressValue}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenExternal={handleOpenExternal}
        onOpenDevTools={handleOpenDevTools}
        onPickElement={handleTogglePicker}
        onReload={handleReload}
        onToggleResponsiveMode={handleToggleResponsiveMode}
        onSubmit={handleSubmit}
        isElementPickerActive={isWebElementPicking}
        isResponsiveMode={isResponsiveMode}
      />
      {isResponsiveMode ? (
        <BrowserViewportToolbar
          isVisible={isVisible}
          onViewportSizeChange={handleResponsiveViewportInput}
          onZoomChange={setResponsiveViewportZoom}
          viewportSize={responsiveViewportSize}
          zoom={responsiveViewportZoom}
        />
      ) : null}
      <BrowserViewportSurface
        browserRegionRef={browserRegionRef}
        browserState={browserState}
        desktopZoomFactor={desktopZoomFactor}
        isResidencyRestore={isResidencyRestore}
        formatMessage={intl.formatMessage}
        isEmptyBrowserState={isEmptyBrowserState}
        isComposed={isVisible || shouldComposeSurface}
        isResponsiveMode={effectiveIsResponsiveMode}
        isViewportEmulated={
          effectiveIsResponsiveMode && screenshotSurfaceRequest?.viewportMode !== "natural"
        }
        onRetryGuest={handleRetryGuest}
        onRetryLoad={handleRetryLoad}
        onViewportResize={notifyBrowserViewportResize}
        onViewportSizeChange={handleResponsiveViewportSizeChange}
        onWebviewRef={handleWebviewRef}
        shouldMountWebview={shouldMountWebview}
        showResizeWarning={showResizeWarning}
        webviewGeneration={webviewGeneration}
        viewportSize={effectiveViewportSize}
        viewportZoom={effectiveViewportZoom}
      />
    </div>
  );
}
