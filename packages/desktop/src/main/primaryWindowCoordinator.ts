import type { StartupWindowBootstrap } from "./startupWorkspace.js";

interface WindowLike {
  destroy?(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized?(): boolean;
  isRendererCrashed?(): boolean;
  webContents?: {
    isCrashed?: () => boolean;
  };
  restore?(): void;
  show(): void;
  focus?(): void;
}

interface PrimaryWindowCoordinatorDeps {
  listWindows(): WindowLike[];
  resolveStartupWindowBootstrap(): Promise<StartupWindowBootstrap>;
  createWindow(startupBootstrap: StartupWindowBootstrap): void;
  canCreateWindow?: (reason: string) => boolean;
  logger: {
    info(message: string): void;
  };
}

export function createPrimaryWindowCoordinator(deps: PrimaryWindowCoordinatorDeps) {
  let pendingEnsurePromise: Promise<void> | null = null;

  function isRendererCrashed(window: WindowLike): boolean {
    return Boolean(window.isRendererCrashed?.() || window.webContents?.isCrashed?.());
  }

  function revealExistingWindow(): boolean {
    for (const existingWindow of deps.listWindows()) {
      if (existingWindow.isDestroyed()) {
        continue;
      }

      if (isRendererCrashed(existingWindow)) {
        // BrowserWindow may still survive after renderer native crash; continuing to reuse it will only display a white screen when macOS is activated.
        existingWindow.destroy?.();
        deps.logger.info("[primary-window] discarded crashed renderer window");
        continue;
      }

      if (existingWindow.isMinimized?.()) {
        existingWindow.restore?.();
      }
      if (!existingWindow.isVisible()) {
        existingWindow.show();
      }
      existingWindow.focus?.();
      return true;
    }

    return false;
  }

  async function ensurePrimaryWindow(reason: string) {
    if (deps.canCreateWindow && !deps.canCreateWindow(reason)) {
      // Forced upgrade is a process-level gate, and entries such as activate/dock/tray/open-url must also share the same blocking boundary.
      deps.logger.info(`[primary-window] window creation blocked (${reason})`);
      return;
    }

    if (revealExistingWindow()) {
      deps.logger.info(`[primary-window] reused existing window (${reason})`);
      return;
    }

    if (pendingEnsurePromise) {
      deps.logger.info(`[primary-window] window creation already pending (${reason})`);
      return pendingEnsurePromise;
    }

    // When an application is cold-started on macOS, app.activate may arrive asynchronously and concurrently with the startup phase.
    // If ready and activate both resolveStartupWindowBootstrap and createWindow directly,
    // The latest version may create two main windows concurrently when starting for the first time. Here, using solo promise converges into one creation.
    deps.logger.info(`[primary-window] creating main window (${reason})`);
    pendingEnsurePromise = deps
      .resolveStartupWindowBootstrap()
      .then((startupBootstrap) => {
        if (revealExistingWindow()) {
          deps.logger.info(`[primary-window] window became available before create (${reason})`);
          return;
        }

        deps.createWindow(startupBootstrap);
      })
      .finally(() => {
        pendingEnsurePromise = null;
      });

    return pendingEnsurePromise;
  }

  return {
    ensurePrimaryWindow,
  };
}
