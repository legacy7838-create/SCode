/**
 * `IPlatformService` implementation for the Tauri renderer.
 *
 * The real `@zcode/ui` `<Root>` needs two things: an `IServiceAccessor` (the
 * business-service RPC channel — files, agent streaming, tasks, automations,
 * MCP, …) and an `IPlatformService` (host-only operations — native dialogs,
 * window lifecycle, notifications).
 *
 * The service channel is delivered exactly as the Web client delivers it: over a
 * WebSocket to `@zcode/server` (see `main.tsx`). This file supplies the second
 * half — the platform surface — and is modelled on `packages/web/src/main.tsx`'s
 * `createWebPlatform()`:
 *
 *  - Members backed by a real Tauri command (file pickers, save-as, open
 *    external, reveal-in-file-manager, notifications, window sync, workspace
 *    activation, renderer-ready) call `invoke(...)`.
 *  - Everything else uses the same web-shaped fallback the Web build ships, so
 *    the shared UI type contract is fully satisfied and no member is left
 *    `undefined`.
 *
 * When the bundle runs outside Tauri (`vite dev` in a plain browser), the Tauri
 * globals are absent; native members then fall back to the web behaviour instead
 * of throwing, so the UI still renders during pure front-end work.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

import {
  DesktopCommandIds,
  type DesktopCommandId,
  type DesktopWindowChromeState,
  type IPlatformService,
  type RemoteTarget,
  type SaveFileRequest,
  type SaveFileResult,
  type TaskNotificationPayload,
} from "@zcode/shared";

import { ZC_EVENTS, type ZcEventName } from "./events.js";

/** True when the Tauri IPC bridge is present (i.e. running inside the app, not a bare browser tab). */
function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** `invoke` that resolves to `fallback` when the Tauri bridge is unavailable. */
async function safeInvoke<T>(command: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  if (!hasTauri()) return fallback;
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    console.warn(`[tauri-platform] ${command} failed`, cause);
    return fallback;
  }
}

/** Subscribe to a Rust-emitted event; no-op disposer when the bridge is absent. */
function onTauriEvent<T>(event: ZcEventName, handler: (payload: T) => void): () => void {
  if (!hasTauri()) return () => {};
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Standard base64 for the `save_file` command — Tauri's JSON transport cannot carry an `ArrayBuffer`. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** A stable-per-machine device id, matching the Web fallback's physical fingerprint. */function computeDeviceFingerprint(): string {
  const nav = globalThis.navigator as Navigator & { platform?: string };
  const parts = [
    nav?.platform ?? "",
    globalThis.screen?.width !== undefined ? String(globalThis.screen.width) : "",
    globalThis.screen?.height !== undefined ? String(globalThis.screen.height) : "",
    globalThis.screen?.colorDepth !== undefined ? String(globalThis.screen.colorDepth) : "",
  ];
  return parts.filter(Boolean).join("|") || "zcode-tauri";
}

/**
 * Nudge the page zoom by `delta`, reading the last value back from the Rust
 * side so repeated presses accumulate against the real state, not a local copy.
 */
async function adjustZoom(delta: number): Promise<void> {
  const current = await invoke<number>("get_desktop_zoom").catch(() => 1);
  const next = Math.max(0.3, Math.min(3, current + delta));
  await invoke("set_desktop_zoom", { factor: next }).catch(() => {});
}

export interface CreateTauriPlatformOptions {
  isLocalDevelopmentRuntime?: boolean;
}

export function createTauriPlatform(options: CreateTauriPlatformOptions = {}): IPlatformService {
  const deviceId = computeDeviceFingerprint();

  return {
    // Tauri's native file pickers return absolute host paths the agent can read.
    canSelectFilePath: true,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime ?? false,

    // --- Native dialogs / opener ---------------------------------------------
    selectDirectory: () => safeInvoke<string | null>("pick_directory", {}, null),
    selectFile: () => safeInvoke<string | null>("pick_file", { extensions: null }, null),
    selectFiles: async () => {
      const one = await safeInvoke<string | null>("pick_file", { extensions: null }, null);
      return one ? [one] : [];
    },
    async saveFile(payload: SaveFileRequest): Promise<SaveFileResult> {
      if (!hasTauri()) return { success: false, error: "Save is only available in the desktop app" };
      try {
        if ("sourceUrl" in payload && payload.sourceUrl) {
          const response = await fetch(payload.sourceUrl);
          const buffer = await response.arrayBuffer();
          const path = await invoke<string | null>("save_file", {
            suggestedName: payload.suggestedName,
            contentsBase64: arrayBufferToBase64(buffer),
          });
          return path ? { success: true, path } : { success: false, canceled: true };
        }
        const path = await invoke<string | null>("save_file", {
          suggestedName: payload.suggestedName,
          contentsBase64: arrayBufferToBase64(payload.data as ArrayBuffer),
        });
        return path ? { success: true, path } : { success: false, canceled: true };
      } catch (cause) {
        return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    getPathForFile: () => null,

    openExternal: (url: string) => {
      if (hasTauri()) void invoke("open_external", { url }).catch(() => {});
      else window.open(url, "_blank", "noopener,noreferrer");
    },
    openInFileManager: (path: string) =>
      safeInvoke<{ success: boolean; error?: string }>("open_in_file_manager", { path }, {
        success: false,
        error: "Not supported outside the desktop app",
      }),
    openExternalFile: (path: string) =>
      safeInvoke<{ success: boolean; error?: string }>("open_in_file_manager", { path }, {
        success: false,
        error: "Not supported outside the desktop app",
      }),

    createTempTextAttachment: async (payload) => {
      const localPath = await safeInvoke<string>(
        "create_temp_text_attachment",
        { contents: payload.text, suggestedName: payload.filename ?? null },
        "",
      );
      if (!localPath) throw new Error("Temporary text attachments require the desktop host");
      const sizeBytes = new TextEncoder().encode(payload.text).length;
      return {
        filename: payload.filename ?? "attachment.txt",
        localPath,
        mimeType: "text/plain" as const,
        sizeBytes,
      };
    },

    // --- Workspace / window sync ---------------------------------------------
    activateOrSetWorkspace: (path: string) =>
      safeInvoke<{ activated: boolean }>("activate_or_set_workspace", { path }, { activated: false }),
    syncWindowTabs: (paths: string[]) => {
      if (hasTauri()) void invoke("sync_window_tabs", { paths }).catch(() => {});
    },
    syncWindowUnreadCount: (count: number) => {
      if (hasTauri()) void invoke("sync_window_unread_count", { count }).catch(() => {});
    },
    syncActiveTaskSession: (sessionId: string | null) => {
      if (hasTauri()) void invoke("sync_active_task_session", { sessionId }).catch(() => {});
    },
    notifyRendererReady: () => {
      if (hasTauri()) void invoke("notify_renderer_ready").catch(() => {});
    },

    // --- Notifications --------------------------------------------------------
    showTaskNotification: (payload: TaskNotificationPayload) => {
      if (hasTauri()) {
        void invoke("show_notification", {
          title: payload.title,
          body: payload.body,
          tag: payload.taskId,
        }).catch(() => {});
      }
    },

    // --- Remote (not wired for the local Tauri workspace yet) -----------------
    connectRemote: (options: RemoteTarget) =>
      Promise.resolve({
        success: false,
        error: `Remote connect is not supported in the Tauri app yet: ${options.kind}`,
      }),
    cancelPendingRemoteConnection: () => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    listWSLDistros: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},

    // --- MCP native directory (no Rust command yet) ---------------------------
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({ success: false, error: "MCP native directory management is not wired yet" }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({ servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 }),

    // --- Feedback / community -------------------------------------------------
    openFeedback: () => Promise.resolve(),
    openCommunity: () => Promise.resolve(),
    canOpenCommunity: () => Promise.resolve(false),

    // --- OAuth / deep links (Rust emits these events) -------------------------
    registerOAuthState: () => {},
    onOAuthCallback: (callback) => onTauriEvent<string>(ZC_EVENTS.OAUTH_CALLBACK, callback),
    onPaymentCallback: (callback) => onTauriEvent<string>(ZC_EVENTS.PAYMENT_CALLBACK, callback),
    onShareImport: () => () => {},

    // --- Telemetry (fire-and-forget no-ops) -----------------------------------
    reportTelemetryEvent: () => Promise.resolve(),
    reportArmsCustomEvent: () => Promise.resolve(),

    // --- Menu / tab / window events (Rust emits these) ------------------------
    onFocusTab: (handler) => onTauriEvent<string>(ZC_EVENTS.FOCUS_TAB, handler),
    onNewTab: (handler) => onTauriEvent<void>(ZC_EVENTS.NEW_TAB, () => handler()),
    onCloseActiveContextRequest: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onTaskNotificationClick: () => () => {},

    // --- Logs / screenshot ----------------------------------------------------
    exportLogs: () => Promise.resolve({ success: false, error: "Not wired in the Tauri app yet" }),
    captureWindowScreenshot: () => Promise.resolve(null),

    // --- Embedded browser data (no embedded browser in Tauri yet) -------------
    importChromeBrowserData: () =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in the Tauri app" }),

    // --- Auto-update (server manifest format change required first) -----------
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: false }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),

    // --- Desktop window surface ----------------------------------------------
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not wired in the Tauri app yet" }),

    // The frameless window draws its own titlebar + controls (see
    // DesktopWindowControls), so these must drive the real OS window via
    // Tauri's window API — otherwise the minimize/maximize/close buttons no-op.
    executeDesktopCommand: async (command: DesktopCommandId) => {
      if (!hasTauri()) return undefined;
      const win = getCurrentWindow();
      try {
        switch (command) {
          case DesktopCommandIds.MinimizeWindow:
            await win.minimize();
            return undefined;
          case DesktopCommandIds.ToggleMaximizeWindow:
            await win.toggleMaximize();
            return undefined;
          case DesktopCommandIds.CloseWindow:
            await win.close();
            return undefined;
          case DesktopCommandIds.ToggleFullScreen:
            await win.setFullscreen(!(await win.isFullscreen()));
            return undefined;
          case DesktopCommandIds.ResetWindowSize:
            await win.setSize(new LogicalSize(1280, 820));
            await win.center();
            return undefined;
          case DesktopCommandIds.ZoomIn:
            await adjustZoom(0.1);
            return undefined;
          case DesktopCommandIds.ZoomOut:
            await adjustZoom(-0.1);
            return undefined;
          case DesktopCommandIds.ResetZoom:
            await invoke("set_desktop_zoom", { factor: 1 }).catch(() => {});
            return undefined;
          default:
            // No native equivalent (About/Changelog/Updates/…); safe no-op.
            return undefined;
        }
      } catch (cause) {
        console.warn(`[tauri-platform] executeDesktopCommand(${command}) failed`, cause);
        return undefined;
      }
    },
    getDesktopWindowChromeState: async (): Promise<DesktopWindowChromeState> => {
      if (!hasTauri()) {
        return { isMaximized: false, macOSMajorVersion: null, supportsNativeRoundedCorners: false };
      }
      const isMaximized = await getCurrentWindow()
        .isMaximized()
        .catch(() => false);
      return { isMaximized, macOSMajorVersion: null, supportsNativeRoundedCorners: false };
    },
    onDesktopWindowChromeStateChanged: (handler) => {
      if (!hasTauri()) return () => {};
      const win = getCurrentWindow();
      let disposed = false;
      let unlisten: (() => void) | null = null;
      const emit = () => {
        void win
          .isMaximized()
          .then((isMaximized) => {
            if (!disposed) {
              handler({ isMaximized, macOSMajorVersion: null, supportsNativeRoundedCorners: false });
            }
          })
          .catch(() => {});
      };
      // A maximize/restore/move all surface as a resize on the OS window.
      void win.onResized(emit).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onWindowFullscreenChanged: (handler) => {
      if (!hasTauri()) return () => {};
      const win = getCurrentWindow();
      let disposed = false;
      let unlisten: (() => void) | null = null;
      let last: boolean | null = null;
      const emit = () => {
        void win
          .isFullscreen()
          .then((isFullscreen) => {
            if (!disposed && isFullscreen !== last) {
              last = isFullscreen;
              handler(isFullscreen);
            }
          })
          .catch(() => {});
      };
      void win.onResized(emit).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    setTitleBarTheme: () => Promise.resolve(),

    getDeviceId: () => deviceId,
  };
}

/**
 * The window this renderer belongs to. Its label is the key every Rust-side
 * registry is indexed by; the command layer derives the caller from an injected
 * `WebviewWindow`, never from a payload field.
 */
export const currentWindowLabel = (): string =>
  hasTauri() ? getCurrentWebviewWindow().label : "main";

export { ZC_EVENTS };
