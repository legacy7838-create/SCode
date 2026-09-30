export interface BrowserWindowForTransparentBootstrap {
  isDestroyed(): boolean;
  isVisible?(): boolean;
  isMinimized?(): boolean;
  isFocused?(): boolean;
  getOpacity?(): number;
  setOpacity?(opacity: number): void;
  showInactive?(): void;
  hide?(): void;
  setSkipTaskbar?(skip: boolean): void;
  on?(event: "focus", listener: () => void): void;
  removeListener?(event: "focus", listener: () => void): void;
}

export interface TransparentWindowBootstrap {
  release(): void;
}

/**
 * Bounded presentation grace between `showInactive` and the Viz surface becoming available: reading
 * it back in the same turn throws UnknownVizError (SIGSEGV under concurrency). Every "capture right
 * after showInactive" path (activity pump, full capture) must honour this same constant.
 */
export const TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS = 100;

/**
 * Gives the macOS guest — created only after hide-close — one window-level presentation that is
 * invisible to the user.
 *
 * Returning undefined means no bootstrap is needed; false means this window cannot be bootstrapped
 * safely.
 */
export function startBrowserScreenshotTransparentWindowBootstrap(options: {
  win: BrowserWindowForTransparentBootstrap;
  enabled: boolean;
  windowId: number;
  webContentsId: number;
  requestId: string;
  hideTaskbarDuringBootstrap?: boolean;
  log?(message: string): void;
}): TransparentWindowBootstrap | false | undefined {
  const { win } = options;
  if (!options.enabled || win.isVisible?.() !== false || win.isMinimized?.() === true) {
    return undefined;
  }
  if (
    !win.isFocused ||
    !win.getOpacity ||
    !win.setOpacity ||
    !win.showInactive ||
    !win.hide ||
    !win.on ||
    !win.removeListener ||
    (options.hideTaskbarDuringBootstrap && !win.setSkipTaskbar)
  ) {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap unavailable windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  let originalOpacity: number;
  try {
    originalOpacity = win.getOpacity();
  } catch {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap opacity read failed windowId=${options.windowId}`,
    );
    return false;
  }

  let released = false;
  let taskbarHidden = false;
  const release = (preserveVisibility: boolean) => {
    if (released) return;
    released = true;
    try {
      win.removeListener?.("focus", handleFocus);
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap listener cleanup failed windowId=${options.windowId}`,
      );
    }
    if (win.isDestroyed()) return;

    try {
      if (!preserveVisibility && !win.isFocused?.()) {
        win.hide?.();
      }
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap hide failed windowId=${options.windowId}`,
      );
    } finally {
      if (!win.isDestroyed()) {
        try {
          win.setOpacity?.(originalOpacity);
        } catch {
          options.log?.(
            `[browser-screenshot-activity] transparent bootstrap opacity restore failed windowId=${options.windowId}`,
          );
        }
        if (taskbarHidden) {
          try {
            win.setSkipTaskbar?.(false);
          } catch {
            options.log?.(
              `[browser-screenshot-activity] transparent bootstrap taskbar restore failed windowId=${options.windowId}`,
            );
          }
        }
      }
    }
  };
  const handleFocus = () => {
    // Transparent bootstrap may compete with user-initiated recovery of windows from the Dock/second-instance.
    // focus indicates that the window ownership has been returned to the user; here only the transparency is restored, and subsequent Ready/release prohibits hiding again.
    release(true);
  };

  try {
    // The guest attached after owner hidden never gets the first frame of compositor; capturer count
    // Only existing surfaces can be maintained. It must be transparent first and then showInactive to give the guest an invisible presentation.
    // opportunity, and restore the original window state when Ready/release.
    if (options.hideTaskbarDuringBootstrap) {
      win.setSkipTaskbar?.(true);
      taskbarHidden = true;
    }
    win.setOpacity(0);
    win.on("focus", handleFocus);
    win.showInactive();
  } catch {
    release(true);
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap failed windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  return { release: () => release(false) };
}
