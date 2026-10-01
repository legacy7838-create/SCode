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

import {
  type EditorInfo,
  type IPlatformService,
  type LoadCliMcpFromUserDirectoryRequest,
  type LoadCliMcpFromUserDirectoryResult,
  type MigrateLegacyCommonMcpRequest,
  type MigrateLegacyCommonMcpResult,
  type BotRemoteWorkspaceReconnectedEvent,
  type OpenInEditorOptions,
  type RemoteConnectionRuntimeLog,
  type RemoteSessionClosedEvent,
  type RemoteTarget,
  type SaveCliMcpToUserDirectoryRequest,
  type SaveFileRequest,
  type SaveFileResult,
  type TaskNotificationPayload,
} from "@zcode/shared";
import type { SSHConfigAliasOption } from "@zcode/shared";

import { ZC_EVENTS, type ZcEventName } from "./events.js";
import { type ConnectRemoteOutcome } from "./session.js";
import {
  executeDesktopCommand,
  getDesktopWindowChromeState,
  onDesktopWindowChromeStateChanged,
  onWindowFullscreenChanged,
} from "./window.js";

export { currentWindowLabel } from "./window.js";

export {
  beginRendererSession,
  detachRendererSession,
  rendererSession,
  watchRendererTeardown,
  type ConnectRemoteOutcome,
  type RendererSession,
  type RendererSessionHandshake,
} from "./session.js";

/**
 * `NO_NATIVE_EQUIV` — the machine-readable marker the Rust side uses for a
 * capability Tauri genuinely cannot provide (`commands/session.rs`,
 * `NO_NATIVE_EQUIV`).
 *
 * It is a marker rather than a sentinel value like `0` or `[]` on purpose. A
 * sentinel is indistinguishable from a real answer — this file's
 * `getDesktopSessionActivity` used to return `{ runningAgentSessionCount: 0 }`,
 * which is a plausible *false* answer the UI then renders. Carrying the code
 * lets the caller tell "the host cannot know this" apart from "it is zero".
 */
const NO_NATIVE_EQUIV = "NO_NATIVE_EQUIV";

/** True when the Tauri IPC bridge is present (i.e. running inside the app, not a bare browser tab). */
function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** A refusal the UI can render, for a host operation Tauri cannot perform. */
function noNativeEquiv(reason: string): { success: false; error: string } {
  return { success: false, error: `${NO_NATIVE_EQUIV}: ${reason}` };
}

/**
 * Turn a command rejection into the `{ success, error }` envelope the renderer
 * branches on.
 *
 * Rust errors are a tagged `CommandError` (`commands/mod.rs`), so the reason
 * survives the boundary as data rather than as a flattened message. This is the
 * one place that knows the shape, so every member that reports failure reports
 * it the same way.
 */
function toEnvelope(cause: unknown): { success: false; error: string } {
  const record = cause as { kind?: unknown; message?: unknown } | null;
  const kind = typeof record?.kind === "string" ? record.kind : "platform";
  const message =
    typeof record?.message === "string" ? record.message : String(cause ?? "unknown error");
  return { success: false, error: `${kind}: ${message}` };
}

/**
 * `invoke` that **propagates** a failure instead of substituting a fallback.
 *
 * `safeInvoke` is right for a member whose fallback is a harmless degradation — a file picker
 * that returns `null` when the bridge is gone. It is wrong for a member whose fallback is a
 * *plausible wrong answer*: `loadMcpFromUserDirectory` falling back to `{ servers: [] }` tells
 * the user they have no MCP servers when in fact the read failed, and they will act on that.
 *
 * Inside Tauri the bridge is always present, so a failure here is a real fault and must surface
 * as one. Outside Tauri — a bare browser tab running the web client — there is no command to
 * call and the web implementation is the correct answer, so that case still degrades.
 */
async function strictInvoke<T>(command: string, args: Record<string, unknown>, outsideTauri: T): Promise<T> {
  if (!hasTauri()) return outsideTauri;
  // No catch: the error is the answer.
  return invoke<T>(command, args);
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

// ---------------------------------------------------------------------------
// Renderer session handshake
// ---------------------------------------------------------------------------
// `beginRendererSession`, `detachRendererSession`, `rendererSession` and the wire
// shapes live in `./session.js`. They used to sit in this file, which pushed it
// past the 400-line rule and — more importantly — left `watchRendererTeardown`
// defined but never called, so `detach_renderer_session` had no caller at all.

/**
 * `TaskNotificationPayload.status` → the kebab-case variant names the Rust
 * `TaskStatus` enum uses, matching the `HostMessage`/`HostEvent` discipline
 * (`PORT_STATUS.md:117-122`). The adapter is the single translation point, so
 * the wire vocabulary is translated once rather than forked across two.
 */
const TASK_STATUS_TO_WIRE: Record<TaskNotificationPayload["status"], string> = {
  completed: "completed",
  failed: "failed",
  permission_request: "permission-request",
  elicitation_request: "elicitation-request",
  feedback_update: "feedback-update",
};

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
          // Rust downloads and base64s it (`save_download_file`), which also
          // validates the URL and the suggested name *before* opening a dialog.
          // Doing the fetch here meant a malformed name still cost the user a
          // dialog before the rejection arrived.
          const path = await invoke<string | null>("save_download_file", {
            url: payload.sourceUrl,
            suggestedName: payload.suggestedName,
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
    // NO_NATIVE_EQUIV, stated rather than returning a bare `null`. Electron implemented this with
    // `webUtils.getPathForFile` (`preload/index.ts:299-304`), which is a **preload-only** API:
    // Tauri v2 exposes no equivalent, so there is nothing for a Rust command to wrap. The `null`
    // is therefore the honest answer rather than a missing implementation — but it has to say so,
    // because a silent `null` reads as "the file had no path" and sends the caller down the
    // web/inline attachment path for a reason that is not the user's.
    getPathForFile: () => null,

    openExternal: (url: string) => {
      if (hasTauri()) void invoke("open_external", { url }).catch(() => {});
      else window.open(url, "_blank", "noopener,noreferrer");
    },
    // `reveal_in_file_manager`, not `open_in_file_manager`. The latter takes the caller's path
    // verbatim; the former resolves it against `AllowedRoots` first, which is the same
    // containment `zcode-fs` enforces. A renderer-supplied path must go through the
    // allowlist, so the confined command is the only correct target here.
    openInFileManager: (path: string) =>
      safeInvoke<{ success: boolean; error?: string }>(
        "reveal_in_file_manager",
        { path },
        {
          success: false,
          error: `${NO_NATIVE_EQUIV}: openInFileManager needs the desktop host`,
        },
      ),
    openExternalFile: (path: string) =>
      safeInvoke<{ success: boolean; error?: string }>("open_external_file", { path }, {
        success: false,
        error: `${NO_NATIVE_EQUIV}: openExternalFile needs the desktop host`,
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
    // Routed through `show_task_notification`, not the raw `show_notification`,
    // so the Rust side owns the 3 s duplicate-suppression window
    // (`TASK_NOTIFICATION_DEDUPE_WINDOW_MS`) and can report *why* a
    // notification was skipped. Firing the raw command from here bypassed both.
    async showTaskNotification(payload: TaskNotificationPayload): Promise<void> {
      if (!hasTauri()) return;
      await invoke("show_task_notification", {
        payload: {
          taskId: payload.taskId,
          status: TASK_STATUS_TO_WIRE[payload.status],
          requestId: payload.requestId ?? null,
          title: payload.title,
          body: payload.body,
        },
      });
    },

    // --- Remote ---------------------------------------------------------------
    // Every one of these reaches Rust. `connect_remote` currently answers with
    // a typed `NoNativeEquiv` outcome (commands/session.rs) rather than pretending
    // to connect, and that refusal is surfaced verbatim: the renderer used to
    // synthesise its own refusal string here, which meant the reason lived in
    // TypeScript while the decision lived in Rust.
    async connectRemote(
      options: RemoteTarget,
      requestId?: string,
      context?: {
        workspacePath: string;
        workspaceIdentity?: string;
        connectTrigger?: string;
      },
    ): Promise<{ success: boolean; error?: string; sessionId?: string }> {
      if (!hasTauri()) return noNativeEquiv("remote workspaces need the desktop host");
      try {
        const outcome = await invoke<ConnectRemoteOutcome>("connect_remote", {
          request: {
            target: options,
            requestId: requestId ?? null,
            workspacePath: context?.workspacePath ?? null,
            workspaceIdentity: context?.workspaceIdentity ?? null,
            connectTrigger: context?.connectTrigger ?? null,
          },
        });
        // Exhaustive over the tagged union: adding a Rust variant becomes a
        // type error here instead of a silently-dropped case at runtime.
        switch (outcome.status) {
          case "connected":
            return { success: true, sessionId: outcome.sessionId };
          case "no-native-equiv":
            return {
              success: false,
              error: `${NO_NATIVE_EQUIV}: ${outcome.reason}`,
            };
          case "invalid-payload":
            return { success: false, error: outcome.error };
        }
      } catch (cause) {
        return toEnvelope(cause);
      }
    },

    async cancelPendingRemoteConnection(requestId?: string): Promise<void> {
      if (!hasTauri()) return;
      await invoke("cancel_pending_remote_connection", { requestId: requestId ?? null });
    },

    async disposeRemoteSession(sessionId: string): Promise<void> {
      if (!hasTauri()) return;
      await invoke("dispose_remote_session", { sessionId });
    },

    // Real host read. `list_wsl_distros` went with the WSL backend
    // (docs/specs/remove-wsl.md); SSH aliases are what remains here.
    listSSHConfigAliases: (): Promise<SSHConfigAliasOption[]> =>
      hasTauri() ? invoke<SSHConfigAliasOption[]>("list_ssh_config_aliases") : Promise.resolve([]),
    onRemoteConnectionLog: (handler) =>
      onTauriEvent<RemoteConnectionRuntimeLog>(ZC_EVENTS.REMOTE_CONNECTION_LOG, handler),
    onRemoteSessionClosed: (handler) =>
      onTauriEvent<RemoteSessionClosedEvent>(ZC_EVENTS.REMOTE_SESSION_CLOSED, handler),
    onBotRemoteWorkspaceReconnected: (handler) =>
      onTauriEvent<BotRemoteWorkspaceReconnectedEvent>(
        ZC_EVENTS.BOT_REMOTE_WORKSPACE_RECONNECTED,
        handler,
      ),

    // --- MCP native directory -------------------------------------------------
    // Backed by `zcode-mcp-config` (docs/specs/rust-native-mcp-config.md). The previous
    // entries here were web-shaped fallbacks that silently returned an empty server list and
    // a "not wired yet" failure, which is a wrong answer rather than a degraded one.
    async loadMcpFromUserDirectory(
      request?: LoadCliMcpFromUserDirectoryRequest,
    ): Promise<LoadCliMcpFromUserDirectoryResult> {
      // Strict: an empty list here would read as "no servers configured" rather than
      // "the read failed" (docs/specs/rust-native-mcp-config.md invariant 1).
      return strictInvoke<LoadCliMcpFromUserDirectoryResult>(
        "load_mcp_from_user_directory",
        { request: request ?? null },
        { servers: [] },
      );
    },
    async saveMcpToUserDirectory(
      payload: SaveCliMcpToUserDirectoryRequest,
    ): Promise<{ success: boolean; error?: string }> {
      // The Rust side returns the same `{ success, error }` envelope the Electron handler
      // returned, because the renderer branches on `success`.
      // Strict for the same reason: a swallowed error would report a save as failed for an
      // unrelated reason, and the renderer shows that message to the user.
      return strictInvoke<{ success: boolean; error?: string }>(
        "save_mcp_to_user_directory",
        { payload },
        { success: false, error: "MCP user-directory save is only available in the desktop app" },
      );
    },
    async migrateLegacyCommonMcp(
      request?: MigrateLegacyCommonMcpRequest,
    ): Promise<MigrateLegacyCommonMcpResult> {
      // Strict: "nothing to migrate" and "the migration failed" must not look identical.
      return strictInvoke<MigrateLegacyCommonMcpResult>(
        "migrate_legacy_common_mcp",
        { request: request ?? null },
        { servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 },
      );
    },

    // --- Feedback / community -------------------------------------------------
    // Not implemented, and the blocker is *not* the URL opener — `open_external`
    // exists and would work. `packages/web/src/main.tsx` resolves these from
    // remote app config (`resolveFeedbackUrl`, `resolveWebCommunityUrl`), which
    // the Tauri host does not serve yet. Hardcoding a URL here would fork the
    // remote-config contract, so the members stay inert until the config
    // channel exists; `canOpenCommunity` answering `false` is the honest
    // "no community link is available" rather than a claim that one exists.
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
    // These four were `() => () => {}` no-ops while `src-tauri/src/events.rs`
    // already declared the matching names. Rust emits them; the renderer was
    // simply not listening, so menu actions and notification clicks silently did
    // nothing. The names are asserted equal at startup by `main.tsx`, so a
    // rename cannot drift — but an unhooked event still fails silently.
    onCloseActiveContextRequest: (handler) =>
      onTauriEvent<void>(ZC_EVENTS.CLOSE_ACTIVE_CONTEXT_REQUEST, () => handler()),
    onNewTask: (handler) => onTauriEvent<void>(ZC_EVENTS.NEW_TASK, () => handler()),
    onOpenWorkspace: (handler) => onTauriEvent<void>(ZC_EVENTS.OPEN_WORKSPACE, () => handler()),
    onTaskNotificationClick: (handler) =>
      onTauriEvent<string>(ZC_EVENTS.TASK_NOTIFICATION_CLICK, handler),

    // --- Logs / screenshot ----------------------------------------------------
    // NO_NATIVE_EQUIV, and the refusal says so instead of returning a generic
    // string: Tauri v2 exposes no window-capture API at all
    // (`PORT_STATUS.md`, observability classification). `exportLogs` is a real
    // gap, not a platform gap — `zcode-logredact` has to land first
    // (docs/specs/rust-native-observability-classification.md), and until it does
    // a user on this build cannot get their logs out at all.
    exportLogs: () =>
      // Not ported, and deliberately so: log export exists to send a bundle to someone else,
      // and the product decision is that it is not used for that (docs/specs/rust-native-config.md
      // §7). The exporter still redacts credentials before writing a file, because a log bundle
      // pasted into a bug report carries the reporter's own tokens.
      Promise.resolve(
        noNativeEquiv(
          "log export is not available in this build; the redaction and archive halves are both " +
            "TypeScript-only today (docs/specs/rust-native-observability-classification.md)",
        ),
      ),
    captureWindowScreenshot: () =>
      // `null` is the contract's own "no screenshot" value and the doc comment
      // for this member allows it. There is no window-capture API in Tauri v2 at
      // all, so there is nothing to return and no envelope shape to carry a
      // reason — returning an object here would break the declared return type.
      Promise.resolve(null),

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
    // Blocked, not unimplemented: CUTOVER_SPEC §4 requires the server to emit a
    // JSON manifest before any Tauri client can ship one, plus the `X-Device-Mid`
    // header fix and the deb/rpm self-update route. The refusals below carry the
    // reason so the UI can render "updates unavailable in this build" instead of
    // an inert control with no explanation.
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () =>
      // `UpdateStatePayload` is a closed union with no `unavailable` variant, so
      // `idle` + `enabled: false` is the only honest value expressible. The
      // events that would have explained *why* are the ones this build never
      // emits; the reason is recorded here instead.
      Promise.resolve({ kind: "idle", enabled: false }),
    downloadUpdate: () =>
      Promise.reject(
        new Error(`${NO_NATIVE_EQUIV}: auto-update is blocked on the server manifest format change`),
      ),
    cancelUpdateDownload: () => Promise.resolve(),
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () =>
      Promise.reject(
        new Error(`${NO_NATIVE_EQUIV}: auto-update is blocked on the server manifest format change`),
      ),
    quitAndInstallUpdate: () =>
      Promise.reject(
        new Error(`${NO_NATIVE_EQUIV}: auto-update is blocked on the server manifest format change`),
      ),

    // --- Host state reads ----------------------------------------------------
    // Honest refusal, not a fabricated zero. The running agent session count is
    // owned by the Host process, which under Tauri is `@zcode/server` and not
    // this one (CUTOVER_SPEC R2). `get_desktop_session_activity` returns that
    // refusal in Rust so the reason is rendered from the owner instead of being
    // invented here; the old `{ runningAgentSessionCount: 0 }` was a plausible
    // false answer.
    getDesktopSessionActivity: async (): Promise<{ runningAgentSessionCount: number }> => {
      if (!hasTauri()) return { runningAgentSessionCount: 0 };
      return invoke<{ runningAgentSessionCount: number }>("get_desktop_session_activity");
    },

    // Read from the Rust registry rather than a local copy, so the number the UI
    // shows is the one `sync_window_unread_count` actually stored.
    getDesktopZoomLevel: () =>
      hasTauri()
        ? invoke<number>("get_desktop_zoom").then((zoomLevel) => ({ zoomLevel }))
        : Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},

    getInstalledEditors: (): Promise<EditorInfo[]> =>
      hasTauri() ? invoke<EditorInfo[]>("get_installed_editors") : Promise.resolve([]),
    async openInEditor(editorId: string, path: string, options?: OpenInEditorOptions) {
      if (!hasTauri()) return noNativeEquiv("open-in-editor needs the desktop host");
      try {
        return await invoke<{ success: boolean; error?: string }>("open_in_editor", {
          editorId,
          path,
          options: options ?? null,
        });
      } catch (cause) {
        return toEnvelope(cause);
      }
    },

    // --- Desktop window surface ----------------------------------------------
    // Implemented in `./window.js`: these members drive the real OS window, and
    // keeping them in one module is what makes "the buttons actually work"
    // reviewable instead of spread across a 600-line adapter.
    executeDesktopCommand,
    getDesktopWindowChromeState,
    onDesktopWindowChromeStateChanged,
    onWindowFullscreenChanged,
    setTitleBarTheme: () => Promise.resolve(),

    getDeviceId: () => deviceId,
  };
}

