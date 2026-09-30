/* eslint-disable max-lines -- Desktop window chrome, webview security policy, and popup routing share the same BrowserWindow lifecycle context. */
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, shell } from "electron";
import { join } from "node:path";
import type {
  ContextMenuParams,
  Input,
  MenuItemConstructorOptions,
  WebContents,
  WindowOpenHandlerResponse,
} from "electron";
import type { DesktopTitleBarTheme, Locale } from "@zcode/shared";
import {
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isTrustedCodingPlanWebviewOrigin,
  resolveZaiBusinessBaseUrl,
  PlatformChannels,
} from "@zcode/shared";
import { loadWindow, type WindowBootstrapOptions } from "./desktopHostProcess.js";
import {
  buildWindowsTitleBarOverlayForZoomLevel,
  hasCustomWindowsControls,
  registerCustomWindowsControls,
  MACOS_TRAFFIC_LIGHT_BASE_POSITION,
  syncWindowControlsOverlayForZoomLevel,
} from "./desktopWindowButtonPosition.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import {
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  resolveDesktopWindowSize,
  type DesktopWindowSize,
} from "./desktopWindowSize.js";
// CDP-on-guest pivot: The built-in browser is changed back to `<webview>` rendering, and the host BrowserWindow needs to reopen the webviewTag.
// And do guest hardening + URL whitelisting + popup routing back to the internal tab in will/did-attach-webview.
const ALLOWED_EMBEDDED_BROWSER_PROTOCOLS = new Set([
  "about:",
  "data:",
  "http:",
  "https:",
  "zcode-browser-restore:",
]);
const ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_BROWSER_DISPOSITIONS = new Set(["background-tab"]);

const embeddedBrowserJavaScriptDialogPreloadPath = join(
  import.meta.dirname,
  "../preload/embeddedBrowserJavaScriptDialog.cjs",
);
// Coding Plan official webpage dedicated preload: hang window.zcodeBridge for the official website to return the purchase completion signal.
const codingPlanWebviewPreloadPath = join(import.meta.dirname, "../preload/codingPlanWebview.cjs");

/**
 * Determine whether the webview loads the Coding Plan official website purchase page (/coding-plan?...&embedded=app).
 * Used to switch the preload of this kind of webview to codingPlanWebviewPreloadPath in will-attach-webview.
 * The rest of the webview (such as the built-in browser) still uses embeddedBrowserJavaScriptDialogPreloadPath.
 */
function isCodingPlanEmbeddedWebviewSrc(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (url.pathname !== "/coding-plan") return false;
    const embedded = url.searchParams.get("embedded");
    return embedded === "app";
  } catch {
    return false;
  }
}

/**
 * Loosely determine whether the current URL of webview belongs to the coding-plan purchase page.
 *
 * When the setWindowOpenHandler callback is triggered, the webview may have locale redirection.
 * (/coding-plan → /cn/coding-plan), so pathname is matched with includes.
 * embedded=app is still a hard condition to avoid misjudgment of external links of the built-in browser.
 */
function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isLinuxDesktopWindow() {
  return process.platform === "linux";
}

function buildDesktopWindowVisualOptions() {
  if (process.platform === "darwin") {
    return {
      backgroundColor: "#00000000",
      titleBarStyle: "hidden" as const,
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_BASE_POSITION,
      vibrancy: "under-window" as const,
      visualEffectState: "active" as const,
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundColor: "#00000000",
      // Windows window operations are drawn by the renderer, disabling the native title bar to avoid two sets of buttons.
      frame: false,
      backgroundMaterial: "acrylic" as const,
    };
  }

  return {
    // The opaque BrowserWindow will refill the renderer's rounded corners with a right-angled black background.
    // The Linux shell cannot form concentric arcs with the inner 12px panel. The transparent bottom is only responsible for exposing the four corners.
    // The renderer root surface still uses opaque tokens to prevent the desktop background color from mixing into the sidebar.
    backgroundColor: "#00000000",
    transparent: true,
    // The Linux native title bar will overlap with the renderer's self-drawn top menu. After hiding the frame, it will be controlled by a custom window.
    frame: false,
    // Some Linux window managers will draw additional outer shadows/strokes for frameless windows.
    // What the user sees is a black line on the outer edge of the window. Disable system shadows on Linux only to avoid affecting native textures on macOS/Windows.
    hasShadow: false,
  };
}

export function applyAppIcon(iconPath: string) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  // TypeScript will not automatically narrow app.dock because process.platform === "darwin".
  // The type of app.dock may still be undefined by definition, and calling it directly will continue to report ts(18048).
  // Here, the platform judgment and the null value judgment are combined, which not only conforms to the runtime semantics, but also allows the type system to clearly know that the Dock must exist.
  const dockIcon = nativeImage.createFromPath(iconPath);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function syncWindowFullscreenState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send(
    PlatformChannels.WindowFullscreenChanged,
    targetWindow.isFullScreen(),
  );
}

function syncDesktopWindowChromeState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) return;

  targetWindow.webContents.send(
    PlatformChannels.DesktopWindowChromeStateChanged,
    resolveDesktopWindowChromeState(targetWindow.isMaximized()),
  );
}

export function getWindowOverlayTheme(): Exclude<DesktopTitleBarTheme, "system"> {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function applyWindowsTitleBarTheme(
  targetWindow: BrowserWindow,
  theme: DesktopTitleBarTheme,
) {
  if (
    process.platform !== "win32" ||
    targetWindow.isDestroyed() ||
    hasCustomWindowsControls(targetWindow)
  ) {
    return;
  }

  const resolvedTheme = theme === "system" ? getWindowOverlayTheme() : theme;
  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  targetWindow.setTitleBarOverlay(
    buildWindowsTitleBarOverlayForZoomLevel(zoomLevel, resolvedTheme),
  );
}

function attachWindowsWindowRepaint(targetWindow: BrowserWindow) {
  if (process.platform !== "win32") {
    return;
  }

  let pendingRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  const repaint = () => {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
      return;
    }

    targetWindow.webContents.invalidate();
  };

  const scheduleRepaint = () => {
    repaint();
    if (pendingRepaintTimer !== null) {
      clearTimeout(pendingRepaintTimer);
    }
    pendingRepaintTimer = setTimeout(() => {
      pendingRepaintTimer = null;
      repaint();
    }, 32);
  };

  targetWindow.on("resized", () => {
    // After manual stretching of Windows ends, Electron/Chromium only updates the window bounds occasionally.
    // However, the last frame of the renderer is not completely repainted, and the host background color will be left in the new expanded area. resized is a low-frequency end event,
    // Here is a complete window redraw to ensure that the content layer is re-spread according to the final viewport size.
    scheduleRepaint();
  });
  targetWindow.on("show", () => {
    // When the Windows Acrylic window is hidden to the tray and then shown again, the invalid synthetic surface may continue to be reused.
    // The renderer and host are still alive but the window only has the host background color; bounded double frame redraw using resize without reloading the renderer or session.
    scheduleRepaint();
  });
}

function isAllowedEmbeddedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isAllowedEmbeddedBrowserNewWindowUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    // The PayPal approveUrl issued by the backend may first point to the Z.AI payment API transfer address.
    // 302 from this address to PayPal. The transfer URL must also remain in the current webview, otherwise it will be taken over by the system browser.
    return (
      ["https://api.z.ai", resolveZaiBusinessBaseUrl()].includes(parsed.origin) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function hasExternalBrowserModifier(input: Input): boolean {
  const modifiers = new Set(input.modifiers ?? []);
  return (
    input.meta === true ||
    input.control === true ||
    modifiers.has("meta") ||
    modifiers.has("command") ||
    modifiers.has("cmd") ||
    modifiers.has("control") ||
    modifiers.has("ctrl")
  );
}

function isExternalBrowserModifierKey(input: Input): boolean {
  const key = input.key.toLowerCase();
  const code = input.code.toLowerCase();
  return (
    key === "meta" ||
    key === "control" ||
    code === "metaleft" ||
    code === "metaright" ||
    code === "controlleft" ||
    code === "controlright"
  );
}

function shouldOpenEmbeddedBrowserRequestExternally(input: {
  disposition: string;
  externalBrowserModifierActive: boolean;
}): boolean {
  return (
    input.externalBrowserModifierActive || EXTERNAL_BROWSER_DISPOSITIONS.has(input.disposition)
  );
}

function attachEmbeddedBrowserWindowOpenHandler(options: {
  hostWebContents: WebContents;
  guestWebContents: WebContents;
  isCodingPlanGuest: boolean;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
  logger: { warn: (...args: unknown[]) => void };
}) {
  let externalBrowserModifierActive = false;

  options.guestWebContents.on("before-input-event", (_event, input) => {
    // KeyUp on some platforms may still be marked with modifier, and the latest modifiers will be recorded directly.
    // This will cause the "Open with system browser" state to stick, causing subsequent ordinary clicks to be opened externally.
    if (input.type === "keyUp" && isExternalBrowserModifierKey(input)) {
      externalBrowserModifierActive = false;
      return;
    }

    externalBrowserModifierActive = hasExternalBrowserModifier(input);
  });

  options.guestWebContents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const { url, disposition } = details;
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview popup url: ${url}`);
      return { action: "deny" };
    }

    // The external links of Coding Plan webview (terms/management, etc. target=_blank) directly launch the system default browser.
    // Does not route to internal Browser tab (aligns with native purchase panel behavior). When the callback fires the webview URL has
    // Loading is complete, it may become /cn/coding-plan due to locale redirection, use loose judgment.
    // The payment link uses location.href (setWindowOpenHandler is not triggered) and is not affected.
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldRouteCodingPlanPopup =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (shouldRouteCodingPlanPopup) {
      if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
        // PayPal authorization/callback is part of the Coding Plan purchase process and cannot be accessed through the system browser.
        // Otherwise the authorization bounce will break away from the current webview and lose the purchase context. The popup form is changed to the current guest navigation.
        void options.guestWebContents.loadURL(url).catch((error: unknown) => {
          options.logger.warn(
            "[browser-pane] failed to load coding-plan embedded popup in webview",
            {
              error: error instanceof Error ? error.message : String(error),
              url,
            },
          );
        });
        return { action: "deny" };
      }
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open coding-plan popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    if (
      shouldOpenEmbeddedBrowserRequestExternally({
        disposition,
        externalBrowserModifierActive,
      })
    ) {
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open webview popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    const owner = options.resolveBrowserViewOwner?.(options.guestWebContents.id);
    options.hostWebContents.send(PlatformChannels.OpenBrowserUrl, {
      disposition,
      url,
      ...(owner
        ? {
            workspaceKey: owner.workspaceKey,
            ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
            sessionId: owner.sessionId,
            browserId: owner.browserId,
            browserGeneration: owner.browserGeneration,
            sourceTabId: owner.tabId,
          }
        : {}),
    });
    return { action: "deny" };
  });

  options.guestWebContents.on("will-navigate", (event, url) => {
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldGuardCodingPlanNavigation =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (!shouldGuardCodingPlanNavigation || isCodingPlanWebviewUrl(url)) {
      return;
    }
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported coding-plan navigation url: ${url}`);
      event.preventDefault();
      return;
    }
    if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
      // When the official website uses location.href to initiate PayPal authorization, the main frame navigation will be triggered.
      // PayPal/transfer/trusted official website bounce needs to stay in the current webview, and subsequent callbacks can continue to subscribe.
      return;
    }

    // Coding Plan-specific preload will continue to exist in subsequent main frame navigation.
    // When leaving the trusted purchase page, guest navigation must be blocked and handed over to the system browser to prevent third-party pages from inheriting zcodeBridge.
    event.preventDefault();
    void shell.openExternal(url).catch((error: unknown) => {
      options.logger.warn("[browser-pane] failed to open coding-plan navigation externally", {
        error: error instanceof Error ? error.message : String(error),
        url,
      });
    });
  });
}

function buildTextContextMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
      getDesktopMenuMessage(id);

    return [
      {
        label: getLabel(desktopMenuMessageIds.editUndo),
        role: "undo",
        enabled: params.editFlags.canUndo,
      },
      {
        label: getLabel(desktopMenuMessageIds.editRedo),
        role: "redo",
        enabled: params.editFlags.canRedo,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editCut),
        role: "cut",
        enabled: params.editFlags.canCut,
      },
      {
        label: getLabel(desktopMenuMessageIds.editCopy),
        role: "copy",
        enabled: params.editFlags.canCopy,
      },
      {
        label: getLabel(desktopMenuMessageIds.editPaste),
        role: "paste",
        enabled: params.editFlags.canPaste,
      },
      {
        label: getLabel(desktopMenuMessageIds.editDelete),
        role: "delete",
        enabled: params.editFlags.canDelete,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editSelectAll),
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      },
    ];
  }

  if (params.selectionText.trim().length > 0) {
    return [{ role: "copy", enabled: params.editFlags.canCopy }];
  }

  return [];
}

export function createBrowserWindow(options: {
  iconPath: string;
  preloadPath: string;
  title?: string;
  bootstrap?: WindowBootstrapOptions;
  logger: { warn: (...args: unknown[]) => void };
  /** Desktop device identifier (a SHA-256 over the userData path), read synchronously by the renderer */
  deviceMid?: string;
  /** Persisted desktop page zoom level; applied first when the window is created so the first paint does not fall back to the default size. */
  initialDesktopZoomLevel?: number;
  /** The most recent normal window size and maximized state, as read by the main-process settings service. */
  initialWindowSize?: DesktopWindowSize;
  /** Read every time a native menu pops up, so switching the app language never requires rebuilding the window. */
  currentApplicationLocale?: () => Locale;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
}): BrowserWindow {
  const initialDesktopZoomLevel = clampDesktopZoomLevel(options.initialDesktopZoomLevel ?? 0);
  const initialDesktopZoomFactor = resolveDesktopZoomFactorForLevel(initialDesktopZoomLevel);
  const initialWindowSize = resolveDesktopWindowSize(
    options.initialWindowSize,
    screen.getPrimaryDisplay().workAreaSize,
  );
  const win = new BrowserWindow({
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    minWidth: MIN_DESKTOP_WINDOW_WIDTH,
    // The available height for a 1280x720 desktop environment is typically less than 768, and a minimum height that is too high prevents the user from continuing to shrink the window.
    minHeight: MIN_DESKTOP_WINDOW_HEIGHT,
    title: options.title,
    icon: options.iconPath,
    // After Linux becomes frameless, some desktop environments may still display the Electron native menu bar, which is automatically hidden to avoid two sets of menus at the top.
    autoHideMenuBar: isLinuxDesktopWindow(),
    ...buildDesktopWindowVisualOptions(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // CDP-on-guest pivot: The built-in browser is changed back to `<webview>` rendering, and the host needs to enable webviewTag.
      webviewTag: true,
      // Permanent backgroundThrottling=false will wake up the entire window renderer and all webview guests
      // and GPU. The window maintains the default throttling; only the owner renderer and the current target guest are temporarily awakened during the screenshot period.
      zoomFactor: initialDesktopZoomFactor,
      // Transparently pass deviceMid to preload for renderer to read synchronously before React rendering.
      additionalArguments: [`--device-id=${options.deviceMid ?? ""}`],
    },
  });

  // The zoom command originally only changed the current running window and was not restored after restarting.
  // When creating a window, the main process first applies the desktop zoom level in setting.json, and at the same time overrides the per-host zoom that Chromium may have left.
  win.webContents.setZoomFactor(initialDesktopZoomFactor);
  if (process.platform === "win32") registerCustomWindowsControls(win);
  syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);

  if (initialWindowSize.maximized) {
    win.maximize();
  }

  win.on("enter-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("leave-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("maximize", () => syncDesktopWindowChromeState(win));
  win.on("unmaximize", () => syncDesktopWindowChromeState(win));
  attachWindowsWindowRepaint(win);
  const pendingWebviewCodingPlanGuestFlags: boolean[] = [];

  win.webContents.once("did-finish-load", () => {
    // When a production package is navigated using loadFile(file://...) Chromium may replay after the page has finished loading
    // The origin-level zoom state overwrites the persistent zoom set during the window creation phase back to the default value.
    // After did-finish-load, press the setting.json setting to play it again to ensure that the production package and development state localhost behave consistently.
    win.webContents.setZoomFactor(initialDesktopZoomFactor);
    syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);
    syncWindowFullscreenState(win);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // CDP target metadata may still retain the original file:// URL when navigation fails, and the renderer
      // The actual document has entered chrome-error://; only by recording the failure of the main frame can the real navigation root cause be located.
      options.logger.warn("[desktop-window] renderer did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        webContentsId: win.webContents.id,
      });
    },
  );

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    // CDP replaces the UI after the native Dialog has been created, macOS may still display queued
    // Chromium NSAlert. Fixed preload intercepting each frame before calling the native API, and the isolated world only
    // Exposed alert/confirm sync bridge; web main world still doesn't have Node or any IPC capabilities.
    //
    // An exception is the Coding Plan official website: it requires window.zcodeBridge to return the purchase completion signal.
    // Use a dedicated preload (codingPlanWebview.ts) instead, and keep the native Dialog bridge for the rest of the webview.
    const targetUrl = params.src ?? "about:blank";
    const isCodingPlanWebview = isCodingPlanEmbeddedWebviewSrc(targetUrl);
    webPreferences.preload = isCodingPlanWebview
      ? codingPlanWebviewPreloadPath
      : embeddedBrowserJavaScriptDialogPreloadPath;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = true;

    delete params.preload;
    delete params.nodeintegration;
    // nodeIntegrationInSubFrames is the guest creation-time preference; derived WebPreferences is the same as the original attach
    // The parameters are all fixed to true, ensuring that the sub-frame where real navigation occurs loads the same preload before the web page script.
    // An inherited empty frame without src does not trigger preload, and the same-origin frame observer in preload takes over.
    params.nodeintegrationinsubframes = "true";
    delete params.disablewebsecurity;
    delete params.allowpopups;

    // If target=_blank/window.open in webview is completely disabled, the click will appear unresponsive;
    // If you let Electron handle it by default, a BrowserWindow separated from ZCode will be created. Reopened here by the host
    // allowpopups, and use setWindowOpenHandler in did-attach-webview to deny default window creation.
    // Then route the legal URL to the internal Browser tab or system browser.
    params.allowpopups = "true";

    if (!isAllowedEmbeddedBrowserUrl(targetUrl)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview url: ${targetUrl}`);
      event.preventDefault();
      return;
    }

    pendingWebviewCodingPlanGuestFlags.push(isCodingPlanWebview);
  });

  win.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    attachEmbeddedBrowserWindowOpenHandler({
      guestWebContents,
      hostWebContents: win.webContents,
      resolveBrowserViewOwner: options.resolveBrowserViewOwner,
      // PayPal/relay's 30x redirects are not guaranteed to trigger will-navigate on a hop-by-hop basis.
      // The Coding Plan guest identity must be stuck by the initial src and cannot be unprotected by the current URL.
      isCodingPlanGuest: pendingWebviewCodingPlanGuestFlags.shift() ?? false,
      logger: options.logger,
    });
  });

  win.webContents.on("context-menu", (_event, params) => {
    // When only Electron role is set, the menu copy follows the system/Electron language and may be inconsistent with the in-app copy;
    // The label is explicitly set here to ensure that the right-click menus at the three ends have the same set of copywriting.
    const template = buildTextContextMenuTemplate(params);

    if (!app.isPackaged) {
      if (template.length > 0) {
        template.push({ type: "separator" });
      }
      template.push({
        label: "Inspect Element",
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (template.length === 0) {
      return;
    }

    // Previously, in order to avoid double pop-up of the DOM right-click menu with terminals, the Electron native menu was not pop-up at all in the production environment;
    // However, ordinary text selections and input boxes do not have DOM menus, causing the right-click copy/paste image to be disabled. This only adds native menus under text editing semantics.
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  void Promise.resolve(loadWindow(win, "index", options.bootstrap)).catch((error: unknown) => {
    // The navigation Promise returned by loadFile/loadURL was discarded in the past, and the navigation in long-distance running failed.
    // It will only appear as a chrome-error page, and the main process log has no original exception to track.
    options.logger.warn("[desktop-window] renderer navigation rejected", error);
  });
  return win;
}
