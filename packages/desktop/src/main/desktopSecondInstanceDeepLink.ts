import type { BrowserWindow } from "electron";
import type { ExternalWorkspaceOpenDialogCopy } from "./desktopOAuthDeepLink.js";
import {
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  extractOpenWorkspacePathFromArgs,
  extractOpenWorkspacePathFromSingleInstanceData,
} from "./desktopDeepLinkUrl.js";

interface SecondInstanceWorkspaceDeps {
  additionalData: unknown;
  argv: readonly string[];
  forceUpdateBlocked: boolean;
  focusForceUpdateGateWindow: () => void;
  handleDeepLink: (
    url: string,
    options: {
      canOpenWorkspace: () => boolean;
      confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
      onWorkspaceOpenBlocked: () => void;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  handleOpenWorkspacePath: (
    path: string,
    options?: {
      allowWithoutReadyWindow?: boolean;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  logger: { warn: (...args: unknown[]) => void };
  workspaceConfirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export function handleSecondInstanceWorkspaceRequest(deps: SecondInstanceWorkspaceDeps): boolean {
  const url =
    // The Linux second-instance argv may be rearranged or appended by the desktop environment.
    // Electron officially recommends additionalData for accurate parameters. Here, priority is given to reading the deep link pre-parsed by the second instance.
    extractDeepLinkUrlFromSingleInstanceData(deps.additionalData) ??
    extractDeepLinkUrlFromArgs(deps.argv);
  if (
    url &&
    deps.handleDeepLink(url, {
      canOpenWorkspace: () => !deps.forceUpdateBlocked,
      confirmationCopy: deps.workspaceConfirmationCopy,
      resolveApplicationWindow: deps.resolveApplicationWindow,
      onWorkspaceOpenBlocked: () => {
        deps.logger.warn(
          "[force-update] ignored a second-instance workspace deep link request during the force update",
        );
        deps.focusForceUpdateGateWindow();
      },
    })
  ) {
    return true;
  }

  const openWorkspacePath =
    extractOpenWorkspacePathFromSingleInstanceData(deps.additionalData) ??
    extractOpenWorkspacePathFromArgs(deps.argv);
  if (openWorkspacePath && deps.forceUpdateBlocked) {
    deps.logger.warn(
      "[force-update] ignored a second-instance workspace request during the force update",
    );
    deps.focusForceUpdateGateWindow();
    return true;
  }
  return Boolean(
    openWorkspacePath &&
    deps.handleOpenWorkspacePath(openWorkspacePath, {
      resolveApplicationWindow: deps.resolveApplicationWindow,
    }),
  );
}
