import type { BrowserWindow } from "electron";
import {
  type ExternalWorkspaceOpenDialogCopy,
  confirmExternalWorkspaceOpen,
  isNetworkWorkspacePath,
  isValidLocalWorkspaceDirectory,
} from "./desktopOAuthDeepLink.js";
import {
  createOpenWorkspaceStartupBootstrap,
  type StartupWindowBootstrap,
} from "./startupWorkspace.js";

export type ExplicitStartupWorkspaceSource = "open-workspace-arg" | "deep-link";

export interface ExplicitStartupWorkspaceRequest {
  path: string;
  source: ExplicitStartupWorkspaceSource;
}

interface StartupDeepLinkConsumptionGate {
  markStartupRequestConsumed: (request: ExplicitStartupWorkspaceRequest) => void;
  shouldHandleReadyProtocolUrl: (protocolUrl: string | null) => boolean;
}

interface ResolveExplicitStartupWorkspaceBootstrapDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  parentWindow?: BrowserWindow | null;
}

export function createStartupDeepLinkConsumptionGate(
  startupProtocolUrl: string | null,
): StartupDeepLinkConsumptionGate {
  let startupDeepLinkConsumed = false;

  return {
    markStartupRequestConsumed: (request) => {
      if (request.source !== "deep-link") {
        return;
      }

      // Cold start argv deep link Regardless of confirmation, cancellation or verification failure in startup bootstrap,
      // All must form a one-time consumption to avoid app.whenReady from replaying the same external URL from process.argv.
      startupDeepLinkConsumed = true;
    },
    shouldHandleReadyProtocolUrl: (protocolUrl) => {
      if (!protocolUrl) {
        return false;
      }

      return !(startupDeepLinkConsumed && protocolUrl === startupProtocolUrl);
    },
  };
}

export function resolveExplicitStartupWorkspaceBootstrap(
  request: ExplicitStartupWorkspaceRequest,
  deps: ResolveExplicitStartupWorkspaceBootstrapDeps,
): StartupWindowBootstrap | null {
  if (request.source === "deep-link") {
    if (isNetworkWorkspacePath(request.path)) {
      // Cold-starting deep links cannot bypass UNC early rejection of running deep links;
      // The network path must be stopped before any statSync and other filesystem probes.
      deps.logger.warn("[deep-link] network workspace path rejected", { path: request.path });
      return null;
    }

    // The first window bootstrap occurs before renderer ready and cannot go through the subsequent IPC gate;
    // The deep link source must still be confirmed by the user first, and will fall back to default activation after cancellation.
    if (
      !confirmExternalWorkspaceOpen(
        request.path,
        deps.logger,
        deps.parentWindow ?? null,
        deps.confirmationCopy,
      )
    ) {
      return null;
    }
  }

  if (!isValidLocalWorkspaceDirectory(request.path)) {
    deps.logger.warn("[startup-workspace] open-workspace argv invalid, falling back", {
      path: request.path,
    });
    return null;
  }

  deps.logger.info("[startup-workspace] using explicit open workspace:", request.path);
  return createOpenWorkspaceStartupBootstrap(request.path);
}
