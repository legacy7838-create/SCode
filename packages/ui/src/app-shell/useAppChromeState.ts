import { useEffect, useRef, useState } from "react";
import type { DesktopWindowChromeState, IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX = 136;

function readFinitePositivePx(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function resolveInitialWindowControlsPaddingPx({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
}) {
  const metrics = platform.getWindowControlsOverlayMetrics?.();
  const leftPaddingPx =
    isDesktop && isMacDesktop
      ? (readFinitePositivePx(metrics?.leftPaddingPx) ??
        MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX)
      : MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX;
  const rightPaddingPx =
    isDesktop && isWindowsDesktop
      ? (readFinitePositivePx(metrics?.rightPaddingPx) ??
        WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX)
      : WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX;

  return { leftPaddingPx, rightPaddingPx };
}

function resolveLegacyReadyVersionFromState(payload: UpdateStatePayload) {
  // The old UpdateReady event will only tell the renderer "a certain version is ready" and will not tell it the follow-up
  // Entering a staging error or other uninstallable state. Once the new state stream is not update-downloaded, the old ready must be cleared.
  return payload.kind === "update-downloaded" ? payload.version : null;
}

export function useAppChromeState({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
  workspaceAbsPath,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
  workspaceAbsPath: string;
}) {
  const initialWindowControlsPadding = resolveInitialWindowControlsPaddingPx({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
  });
  const [isMacFullscreen, setIsMacFullscreen] = useState(false);
  const [desktopWindowChromeState, setDesktopWindowChromeState] =
    useState<DesktopWindowChromeState | null>(null);
  const [macWindowControlsLeftPaddingPx, setMacWindowControlsLeftPaddingPx] = useState(
    () => initialWindowControlsPadding.leftPaddingPx,
  );
  const [windowsWindowControlsRightPaddingPx, setWindowsWindowControlsRightPaddingPx] = useState(
    () => initialWindowControlsPadding.rightPaddingPx,
  );
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const sidebarContainerRef = useRef<HTMLElement | null>(null);
  const hasShownUpdateToastRef = useRef(false);
  const updateStateEventRevisionRef = useRef(0);
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!isDesktop || !isMacDesktop) {
      setIsMacFullscreen(false);
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      return;
    }

    // After macOS goes full screen, the traffic lights will move closer to the upper left corner layout.
    // If the top floating layer continues to use window state pl-24, it will expand the left safe area too much, making it visually look like the three keys "disappear".
    // Subscribe here to the full-screen state of the desktop window, which only narrows the white space when macOS is full-screen and does not affect the normal window state.
    return platform.onWindowFullscreenChanged((fullscreen) => {
      setIsMacFullscreen(fullscreen);
    });
  }, [isDesktop, isMacDesktop, platform]);

  useEffect(() => {
    // Excluding macOS leaves the version unknown, and Tahoe incorrectly adopts Sequoia's 6px rounded corners.
    // All desktop platforms share window status query, retain event priority and uninstall cleanup; Web does not read native status.
    if (!isDesktop || !platform.getDesktopWindowChromeState) {
      setDesktopWindowChromeState(null);
      return;
    }

    let disposed = false;
    let eventRevision = 0;
    const dispose = platform.onDesktopWindowChromeStateChanged?.((state) => {
      eventRevision += 1;
      setDesktopWindowChromeState(state);
    });
    const requestRevision = eventRevision;

    // Only listening to maximize/unmaximize will miss the initial state of "the window is maximized when the application starts".
    // Subscribe before actively querying, and use revision to prevent slower query results from overwriting updated window events.
    void platform.getDesktopWindowChromeState().then(
      (state) => {
        if (!disposed && eventRevision === requestRevision) setDesktopWindowChromeState(state);
      },
      (error) => logger.warn("[app-chrome] failed to sync desktop window chrome state", { error }),
    );

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  useEffect(() => {
    const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
    const rootElement = document.documentElement;
    if (!rootElement) return;
    // The Linux shell is cropped by the renderer. If the rounded corners are retained after maximization, transparent gaps will be exposed at the four corners of the screen.
    // Reuse the window state of the main process as the only source to switch the Workspace and settings page at the same time.
    rootElement.classList.toggle(
      "window-maximized",
      isLinuxDesktop && (desktopWindowChromeState?.isMaximized ?? false),
    );
    return () => rootElement.classList.remove("window-maximized");
  }, [desktopWindowChromeState?.isMaximized, isDesktop, isMacDesktop, isWindowsDesktop]);

  useEffect(() => {
    if (
      !isDesktop ||
      (!isMacDesktop && !isWindowsDesktop) ||
      !platform.onWindowControlsOverlayChanged
    ) {
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      setWindowsWindowControlsRightPaddingPx(WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX);
      return;
    }

    // After the page is zoomed, the native window control area will not scale with the renderer zoom.
    // macOS synchronizes the left traffic light safe area, and Windows synchronizes the right title bar button safe area.
    return platform.onWindowControlsOverlayChanged((metrics) => {
      const leftPaddingPx = readFinitePositivePx(metrics.leftPaddingPx);
      const rightPaddingPx = readFinitePositivePx(metrics.rightPaddingPx);
      logger.debug("[app-chrome] native window controls geometry changed", {
        isMacDesktop,
        isWindowsDesktop,
        leftPaddingPx,
        rightPaddingPx,
      });
      if (isMacDesktop && leftPaddingPx !== null) {
        setMacWindowControlsLeftPaddingPx(leftPaddingPx);
      }
      if (isWindowsDesktop && rightPaddingPx !== null) {
        setWindowsWindowControlsRightPaddingPx(rightPaddingPx);
      }
    });
  }, [isDesktop, isMacDesktop, isWindowsDesktop, platform]);

  useEffect(() => {
    if (!platform.onUpdateReady) {
      return;
    }

    // The update ready state was previously scattered inside the button component, and each place could only repeatedly subscribe to platform events.
    // In this way, the WorkspaceHeader cannot know "whether there is currently an update", and it is easy for multiple entries to each maintain a forked state.
    // Here, the version is promoted to App unified management, and then distributed to Header / Overlay as needed.
    return platform.onUpdateReady((version) => {
      logger.info("[App] installable update received", {
        workspaceAbsPath,
        version,
      });
      setUpdateReadyVersion(version);

      // When the Windows desktop receives an update, a light prompt is displayed without blocking the main interface.
      if (isWindowsDesktop && !hasShownUpdateToastRef.current) {
        hasShownUpdateToastRef.current = true;
        toast(intl.formatMessage({ id: "update.toast.ready" }, { version }), {
          durationMs: 4000,
          position: "bottom-left",
          variant: "update",
        });
      }
    });
  }, [platform, workspaceAbsPath, isWindowsDesktop, intl]);

  useEffect(() => {
    let cancelled = false;

    if (platform.getUpdateState) {
      const requestRevision = updateStateEventRevisionRef.current;
      void platform.getUpdateState().then(
        (payload) => {
          if (!cancelled && updateStateEventRevisionRef.current === requestRevision) {
            setUpdateState(payload);
            setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
          }
        },
        (error) => {
          logger.warn("[App] failed to sync auto update state", { error });
        },
      );
    }

    if (!platform.onUpdateStateChanged) {
      return () => {
        cancelled = true;
      };
    }

    const dispose = platform.onUpdateStateChanged((payload) => {
      updateStateEventRevisionRef.current += 1;
      setUpdateState(payload);
      setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [platform]);

  return {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  };
}
