/* oxlint-disable eslint(max-lines) -- Deep Link routing must keep protocol validation and delivery atomic inside this one module. */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import { type OAuthProviderId, type OAuthStateRegistration, PlatformChannels } from "@zcode/shared";
import {
  extractWorkspaceOpenPath,
  extractShareImportCode,
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isWorkspaceOpenUrl,
  isShareImportUrl,
} from "./desktopDeepLinkUrl.js";
import { registerLinuxDeepLinkProtocol } from "./desktopLinuxDeepLinkRegistration.js";

interface DeepLinkWorkspaceGateOptions {
  canOpenWorkspace?: (workspacePath: string) => boolean;
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  onWorkspaceOpenBlocked?: (workspacePath: string) => void;
  /** Business window parser; Main auxiliary windows such as CUA indicator must be excluded. */
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export interface ExternalWorkspaceOpenDialogCopy {
  buttons: [string, string];
  title: string;
  message: string;
  detail: (path: string) => string;
}

interface OAuthRouteTarget {
  windowId: number;
  provider?: OAuthProviderId;
}

const oauthStateToWindow = new Map<string, OAuthRouteTarget>();
const rendererReadyWebContentsIds = new Set<number>();
let pendingDeepLinkUrl: string | null = null;
let pendingPaymentDeepLinkUrl: string | null = null;
let pendingOpenWorkspaceRequest: {
  path: string;
  targetWebContentsId?: number;
} | null = null;
const pendingShareImports: { shareCode: string; targetWebContentsId?: number }[] = [];
const MAX_PENDING_SHARE_IMPORTS = 8;

function enqueuePendingShareImport(
  payload: { shareCode: string },
  targetWebContentsId?: number,
): void {
  if (
    pendingShareImports.some(
      (item) =>
        item.shareCode === payload.shareCode && item.targetWebContentsId === targetWebContentsId,
    )
  ) {
    return;
  }
  pendingShareImports.push(
    targetWebContentsId === undefined ? { ...payload } : { ...payload, targetWebContentsId },
  );
  if (pendingShareImports.length > MAX_PENDING_SHARE_IMPORTS) {
    pendingShareImports.shift();
  }
}

export function parseOAuthStateRegistration(payload: unknown): OAuthStateRegistration | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    state?: unknown;
    provider?: unknown;
  };

  if (typeof candidate.state !== "string" || candidate.state.trim() === "") {
    return null;
  }

  if (candidate.provider != null && typeof candidate.provider !== "string") {
    return null;
  }

  return {
    state: candidate.state.trim(),
    ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
  };
}

function focusDeepLinkTargetWindow(targetWindow: BrowserWindow): void {
  // The open-url callback of macOS will only deliver the URL to the current instance and will not automatically bring the window back to the foreground.
  // Previously, only IPC forwarding was done here, and the user still stayed in the external application after completing OAuth or opening the directory from the system service.
  // Here, after successful routing, the target window is explicitly activated and focused to unify the multi-platform bounce experience.
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (process.platform === "darwin") {
    app.show();
  }

  targetWindow.focus();
}

function hasOAuthAuthorizationCode(parsedUrl: URL): boolean {
  return parsedUrl.searchParams.has("code") || parsedUrl.searchParams.has("authCode");
}

export function isValidLocalWorkspaceDirectory(path: string): boolean {
  if (!path || path.includes("\0") || isNetworkWorkspacePath(path) || !isAbsolute(path)) {
    return false;
  }

  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isNetworkWorkspacePath(path: string): boolean {
  // Only if the original path starts with // or \\, it will start with \\ after normalization;
  // Unix absolute paths with a single / are not misinterpreted as UNC network paths.
  const normalized = path.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\") || /^\\\\\?\\UNC\\/iu.test(normalized);
}

export const externalWorkspaceOpenDialogCopy: ExternalWorkspaceOpenDialogCopy = {
  buttons: ["Open folder", "Cancel"],
  title: "Open external ZCode link?",
  message: "Open this folder in ZCode?",
  detail: (path) =>
    `${path}\n\nOnly open folders from sources you trust. Project settings may affect the agent runtime.`,
};

export function confirmExternalWorkspaceOpen(
  path: string,
  logger: { warn: (...args: unknown[]) => void },
  parentWindow: BrowserWindow | null,
  copy: ExternalWorkspaceOpenDialogCopy = externalWorkspaceOpenDialogCopy,
): boolean {
  const options = {
    type: "warning" as const,
    buttons: copy.buttons,
    defaultId: 1,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail(path),
    noLink: true,
  };
  const response = parentWindow
    ? dialog.showMessageBoxSync(parentWindow, options)
    : dialog.showMessageBoxSync(options);
  const confirmed = response === 0;
  if (!confirmed) {
    logger.warn("[deep-link] the user cancelled opening the external linked workspace", { path });
  }
  return confirmed;
}

export function handleOpenWorkspacePath(
  path: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: {
    allowWithoutReadyWindow?: boolean;
    resolveApplicationWindow?: () => BrowserWindow | null;
  } = {},
): boolean {
  if (!isValidLocalWorkspaceDirectory(path)) {
    logger.warn("[deep-link] the workspace path to open is invalid, ignored", { path });
    return false;
  }

  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  if (targetWindow) {
    const targetWebContentsId = targetWindow.webContents.id;
    if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
      pendingOpenWorkspaceRequest = {
        path,
        targetWebContentsId,
      };
      focusDeepLinkTargetWindow(targetWindow);
      // Cold start argv deep link will be registered after the main window is created and the renderer is
      // onOpenWorkspacePath is reached before. At this time, direct webContents.send will lose IPC.
      // You must wait for the renderer to actively report ready before posting the directory path.
      logger.warn(
        "[deep-link] workspace open request hit a window that is not ready, cached it while waiting for the renderer",
        {
          windowId: targetWebContentsId,
          path,
        },
      );
      return true;
    }

    targetWindow.webContents.send(PlatformChannels.OpenWorkspacePath, path);
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] workspace open request routed successfully", {
      windowId: targetWebContentsId,
      path,
    });
    return true;
  }

  if (!options.allowWithoutReadyWindow) {
    logger.warn("[deep-link] workspace open request did not hit a window yet, ignored", { path });
    return false;
  }

  pendingOpenWorkspaceRequest = { path };
  logger.warn(
    "[deep-link] workspace open request did not hit a window yet, cached it while waiting for the renderer",
    { path },
  );
  return false;
}

export function handleDeepLink(
  url: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: DeepLinkWorkspaceGateOptions = {},
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn("[deep-link] failed to parse the URL:", url);
    return false;
  }

  if (isWorkspaceOpenUrl(parsedUrl)) {
    const workspacePath = extractWorkspaceOpenPath(parsedUrl);
    if (!workspacePath) {
      logger.warn("[deep-link] workspace open request is missing a path, ignored", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }

    if (isNetworkWorkspacePath(workspacePath)) {
      // Windows UNC paths trigger SMB authentication during the statSync verification phase.
      // Deep links are external inputs and network paths must be rejected before any file system probing.
      logger.warn("[deep-link] network workspace path rejected", { path: workspacePath });
      return false;
    }

    if (options.canOpenWorkspace && !options.canOpenWorkspace(workspacePath)) {
      // The forced upgrade is a process-level gate, and the workspace deep link cannot enter the cache/delivery path first.
      logger.warn("[deep-link] workspace open request was blocked by the current startup gate", {
        path: workspacePath,
      });
      options.onWorkspaceOpenBlocked?.(workspacePath);
      return true;
    }

    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    // zcode://workspace/open comes from external applications such as browsers/IM and cannot be equivalent to the user's
    // ZCode selects the directory internally; confirmation must occur before statSync to avoid the project configuration being silently trusted.
    if (
      !confirmExternalWorkspaceOpen(workspacePath, logger, targetWindow, options.confirmationCopy)
    ) {
      return true;
    }

    return handleOpenWorkspacePath(workspacePath, logger, {
      allowWithoutReadyWindow: true,
      resolveApplicationWindow: options.resolveApplicationWindow,
    });
  }

  if (isPaymentCallbackUrl(parsedUrl)) {
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      targetWindow.webContents.send(PlatformChannels.PaymentCallback, url);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] payment callback routed successfully", {
        windowId: targetWindow.webContents.id,
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return true;
    }

    pendingPaymentDeepLinkUrl = url;
    logger.warn(
      "[deep-link] payment callback did not hit a window yet, cached it while waiting for the renderer",
      {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      },
    );
    return false;
  }

  if (isShareImportUrl(parsedUrl)) {
    const shareCode = extractShareImportCode(parsedUrl);
    if (!shareCode) {
      logger.warn("[deep-link] the share import code is invalid, ignored", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }
    const payload = { shareCode };
    // The share branch must also go through resolveApplicationWindow - focus on the bottom line
    // getAllWindows()[0] will hit auxiliary windows such as CUA indicator; and the pending queue must be bound to the target window.
    // Otherwise, when there are multiple windows, the import will be delivered to the renderer that is ready first, and the .zcode-share of the wrong workspace will be written.
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      if (!rendererReadyWebContentsIds.has(targetWindow.webContents.id)) {
        enqueuePendingShareImport(payload, targetWindow.webContents.id);
        focusDeepLinkTargetWindow(targetWindow);
        logger.info("[deep-link] share import is waiting for the renderer to be ready", {
          windowId: targetWindow.webContents.id,
        });
        return true;
      }
      targetWindow.webContents.send(PlatformChannels.ShareImport, payload);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] share import routed successfully", {
        windowId: targetWindow.webContents.id,
      });
      return true;
    }
    enqueuePendingShareImport(payload);
    logger.info("[deep-link] share import is waiting for the main window");
    return false;
  }

  if (!isOAuthCallbackUrl(parsedUrl)) {
    return false;
  }

  const state = parsedUrl.searchParams.get("state");
  if (!state) {
    logger.warn("[deep-link] the OAuth callback is missing state, ignoring this callback", {
      protocol: parsedUrl.protocol,
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  const routeTarget = oauthStateToWindow.get(state);
  const targetWindow = routeTarget
    ? BrowserWindow.getAllWindows().find((window) => window.webContents.id === routeTarget.windowId)
    : null;
  const shouldCompleteOAuthRoute = hasOAuthAuthorizationCode(parsedUrl);

  if (targetWindow) {
    targetWindow.webContents.send(PlatformChannels.OAuthCallback, url);
    if (shouldCompleteOAuthRoute) {
      oauthStateToWindow.delete(state);
    }
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] OAuth callback routed successfully", {
      state,
      windowId: targetWindow.webContents.id,
      provider: routeTarget?.provider,
      completed: shouldCompleteOAuthRoute,
    });
    return true;
  }

  pendingDeepLinkUrl = url;
  logger.warn(
    "[deep-link] the OAuth callback did not hit the target window, cached it while waiting for the renderer",
    {
      state,
      hasRouteTarget: Boolean(routeTarget),
    },
  );
  return false;
}

export function registerDeepLinkProtocol(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: { iconPath?: string } = {},
) {
  const scheme = "zcode";

  if (process.defaultApp && process.argv.length >= 2) {
    const entry = resolve(process.argv[1]!);
    const ok = app.setAsDefaultProtocolClient(scheme, process.execPath, [entry]);
    if (!ok) {
      logger.warn("[deep-link] failed to register the protocol handler (defaultApp)", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    } else {
      logger.info("[deep-link] protocol handler registered successfully (defaultApp)", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    }
    return;
  }

  const ok = app.setAsDefaultProtocolClient(scheme);
  if (!ok) {
    logger.warn("[deep-link] failed to register the protocol handler", { scheme });
  } else {
    logger.info("[deep-link] protocol handler registered successfully", { scheme });
  }

  if (process.platform === "linux" && app.isPackaged) {
    registerLinuxDeepLinkProtocol({
      executablePath: process.execPath,
      homeDir: app.getPath("home"),
      productName: app.name,
      iconSourcePath: options.iconPath,
      env: process.env,
      argv: process.argv,
      logger,
    });
  }
}

export function registerOAuthState(windowId: number, registration: OAuthStateRegistration): void {
  oauthStateToWindow.set(registration.state, {
    windowId,
    provider: registration.provider,
  });

  setTimeout(() => oauthStateToWindow.delete(registration.state), 5 * 60 * 1000);
}

export function deliverPendingDeepLink(webContents: WebContents): boolean {
  rendererReadyWebContentsIds.add(webContents.id);

  const hasPendingOAuthCallback = pendingDeepLinkUrl != null;
  // After the pending share import is bound to the target window, it is only delivered to the target window (or the target is not bound during cold start).
  // entry); keep the entry when the non-target window is ready, otherwise the import will be written into the workspace of the error window.
  const undeliveredShareImports: typeof pendingShareImports = [];
  for (const pending of pendingShareImports.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.ShareImport, { shareCode: pending.shareCode });
    } else {
      undeliveredShareImports.push(pending);
    }
  }
  pendingShareImports.push(...undeliveredShareImports);
  if (hasPendingOAuthCallback) {
    webContents.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl);
    pendingDeepLinkUrl = null;
  }
  if (pendingPaymentDeepLinkUrl) {
    webContents.send(PlatformChannels.PaymentCallback, pendingPaymentDeepLinkUrl);
    pendingPaymentDeepLinkUrl = null;
  }
  if (
    pendingOpenWorkspaceRequest &&
    (pendingOpenWorkspaceRequest.targetWebContentsId == null ||
      pendingOpenWorkspaceRequest.targetWebContentsId === webContents.id)
  ) {
    webContents.send(PlatformChannels.OpenWorkspacePath, pendingOpenWorkspaceRequest.path);
    pendingOpenWorkspaceRequest = null;
  }
  return hasPendingOAuthCallback;
}

export function clearOAuthRoutesForWindow(windowId: number): void {
  rendererReadyWebContentsIds.delete(windowId);
  if (pendingOpenWorkspaceRequest?.targetWebContentsId === windowId) {
    pendingOpenWorkspaceRequest = null;
  }
  // After pending share import binds the target window, the target window must be cleaned up synchronously when it is closed.
  // Otherwise the queue entry never expires and may be delivered to other windows that are subsequently ready (wrong workspace).
  for (let index = pendingShareImports.length - 1; index >= 0; index -= 1) {
    if (pendingShareImports[index]!.targetWebContentsId === windowId) {
      pendingShareImports.splice(index, 1);
    }
  }

  for (const [state, routeTarget] of oauthStateToWindow) {
    if (routeTarget.windowId === windowId) {
      oauthStateToWindow.delete(state);
    }
  }
}
