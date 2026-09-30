import { PlatformChannels } from "@zcode/shared";
import { DesktopBrowserScreenshotActivityController } from "./browserScreenshotActivityController.js";
import { DesktopBrowserScreenshotSurfaceCoordinator } from "./browserScreenshotSurfaceCoordinator.js";

interface BrowserWindowForScreenshotSurface {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
    send(channel: string, payload: unknown): void;
  };
}

interface GuestWebContentsForScreenshotActivity {
  id: number;
  isDestroyed(): boolean;
  readonly hostWebContents: { id: number } | null;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

/** Binds the screenshot surface coordinator to the owning BrowserWindow; the coordinator itself has no dependency on Electron globals, which keeps it testable. */
export function createDesktopBrowserScreenshotSurfaceCoordinator(options: {
  fromId(windowId: number): BrowserWindowForScreenshotSurface | null;
  fromWebContentsId(webContentsId: number): GuestWebContentsForScreenshotActivity | null;
  log?(message: string): void;
  warn?(message: string): void;
  timeoutMs?: number;
  activityTimeoutMs?: number;
  allowTransparentWindowBootstrap?: boolean;
  hideTaskbarDuringTransparentWindowBootstrap?: boolean;
}): DesktopBrowserScreenshotSurfaceCoordinator {
  const activityController = new DesktopBrowserScreenshotActivityController({
    fromId: options.fromId,
    fromWebContentsId: options.fromWebContentsId,
    allowTransparentWindowBootstrap:
      options.allowTransparentWindowBootstrap ??
      (process.platform === "darwin" || process.platform === "win32"),
    hideTaskbarDuringTransparentWindowBootstrap:
      options.hideTaskbarDuringTransparentWindowBootstrap ?? process.platform === "win32",
    log: options.log,
  });
  return new DesktopBrowserScreenshotSurfaceCoordinator({
    timeoutMs: options.timeoutMs,
    activityTimeoutMs: options.activityTimeoutMs,
    acquireActivity: (windowId, payload) =>
      activityController.acquire({
        windowId,
        webContentsId: payload.webContentsId,
        requestId: payload.requestId,
        reason: "browser-screenshot",
      }),
    sendPrepare: (windowId, payload) => {
      const win = options.fromId(windowId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        options.log?.("[browser-screenshot-surface] prepare skipped for destroyed owner window");
        return false;
      }
      try {
        win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfacePrepare, payload);
        return true;
      } catch {
        // Send may throw an error synchronously during the closing of the Electron window; prepare must be converted into a controlled failure and cannot be leaked to the main process.
        options.log?.("[browser-screenshot-surface] prepare send failed");
        return false;
      }
    },
    sendRelease: (windowId, payload) => {
      const win = options.fromId(windowId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        options.log?.("[browser-screenshot-surface] release skipped for destroyed owner window");
        return;
      }
      try {
        win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfaceRelease, payload);
      } catch {
        // release runs in timeout/dispose/lease finally, and must not be thrown in reverse to interrupt the main process cleanup.
        options.log?.("[browser-screenshot-surface] release send failed");
      }
    },
    log: options.log,
    warn: options.warn,
  });
}
