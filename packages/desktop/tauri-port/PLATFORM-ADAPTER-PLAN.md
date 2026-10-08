# PLATFORM-ADAPTER-PLAN.md — `createTauriPlatform(): IPlatformService`

> READ-ONLY blueprint for the Electron→Tauri port. Companion to `INVENTORY.md`,
> `PORTING.md`, `BRIDGE.md`, `SIDECAR-TRANSPORT.md`. No source edited.
>
> Scope: reimplement the platform seam behind `IPlatformService`
> (`packages/shared/src/platform.ts:504-919`) over Tauri `invoke()` + events, so the
> renderer (`packages/ui`) is unchanged. Per `INVENTORY.md` §2 the UI has **zero** real
> `window.zcode.*` calls; the adapter (`desktopPlatform.ts`) is the only consumer, so
> **the adapter is the port seam, not the UI**.
>
> Ground rule (PORTING.md #2): Electron stays fully intact. Every row below that is not
> marked DONE must be additive and flag-gated.

> **STATUS — Part 1 landed** (`src/renderer/src/tauriPlatform.ts`): `createTauriPlatformSubset(deps?)`
> returns a `Pick<IPlatformService, …>` — NOT the full interface — implementing only 10 fully-backed
> methods (`selectDirectory`, `selectFile`, `selectFiles`, `openExternal`, `openInFileManager`,
> `openExternalFile`, `getDesktopZoomLevel`, `onDesktopZoomLevelChanged`, `setTitleBarTheme`,
> `getSystemLocale`), each delegating to a
> verified `tauriBridge` wrapper with
> real transformation (single-path unwrap, reveal→`{success,error?}` result object, `"system"`→clear
> override, level→`{zoomLevel}` wrap, fire-and-forget). It is **additive and not wired into the
> Electron factory** (Electron stays intact). The sync-return
> `getDeviceId` is deliberately excluded (PORTING.md sync-IPC trap → needs a prewarm cache). Conformance
> is asserted headless by `tauri-port/test/layer-b/b1-adapter.test.ts` (injectable deps). Expand the
> `Pick` keys + `createTauriPlatformSubset` body as gated rows land; wire the factory once the seam is
> complete.
>
> **Delegation audit (slice 35).** Each of the 10 adapter methods was checked against its Electron IPC
> handler in `desktopMainIpcPlatform.ts` — not assumed. Found + fixed ONE defect: `openInFileManager`
> was mapped to `showItemInFolder` (reveal) but Electron's `openPathInFileManager` calls
> `shell.openPath` (opens) → corrected to the `openPath` command. Confirmed faithful: `selectFile`
> (→`filePaths[0]`), `selectFiles` (→`filePaths`/`[]`), `selectDirectory` (→`filePaths[0]`) all match the
> adapter's `?.[0] ?? null` / `?? []` unwrapping; `openExternalFile`→`openPath`
> (`openPathInDefaultApp`); `getDesktopZoomLevel`→`{zoomLevel}` wrap; `setTitleBarTheme`→`set_theme`
> (Electron `nativeTheme.themeSource`+`applyWindowsTitleBarTheme` ⇔ Tauri per-window theme of webview +
> decorations); `getSystemLocale` reuses Electron's exact `startsWith("zh")` narrowing rule.

## Legend

- **Category**: `prop` `window` `dialog` `fs` `shell` `oauth` `update` `notify` `device`
  `remote` `storage/mcp` `browser-view` `event` `misc`.
- **Mechanism**: target Tauri mechanism — `command:<snake>` = `#[tauri::command]`,
  `event:<name>` = `listen()` push, `plugin:<x>`, `ws` = sidecar localhost-WS RPC
  (`SIDECAR-TRANSPORT.md`), `sync-cache` = prewarmed getter, `no-op`, `BLOCKED`.
- **Risk**: copied/aligned from `INVENTORY.md` §1/§2 (LOW / MED / HIGH / CRITICAL).
- **Phase**: build slice from §5 below (`P0..P8`, `OUT` = out-of-adapter-scope until a
  `INVENTORY.md` top blocker spike resolves).
- **DONE** marker (updated to source, slices 1–26) = a backing `#[tauri::command]` already exists in
  `commands.rs` AND a typed wrapper in `tauriBridge.ts`. As of this write there are **78 commands**
  (extracted from `commands.rs`, not hand-maintained); `a5-contract.test.ts` statically enforces 1:1
  command↔wrapper parity + camelCase arg keys, so the count below cannot silently drift. Grouped by
  capability (full list is the source of truth in `commands.rs`):
  - *app info / dirs*: `get_app_version` `get_app_name` `get_platform_info` `get_system_locale`
    `get_device_id` `get_download_directory` `get_documents_directory` `get_home_dir` `get_temp_dir`
    `get_app_data_dir` `get_app_config_dir` `get_exe_path`
  - *lifecycle*: `relaunch_app` `exit_app` `spawn_sidecar_echo` `kill_sidecar`
  - *window state/getters*: `get_window_size` `get_window_outer_size` `get_window_position`
    `get_window_inner_position` `get_window_scale_factor` `get_window_theme` `get_desktop_zoom_level`
    `get_cursor_position` `get_window_current_monitor` `get_primary_monitor` `get_available_monitors`
    `window_is_maximized` `is_window_minimized` `is_window_visible` `is_window_focused`
    `is_window_always_on_top` `is_window_resizable` `is_window_enabled` `is_fullscreen`
  - *window mutations*: `window_minimize` `window_maximize` `window_unmaximize` `window_unminimize`
    `window_toggle_fullscreen` `window_close` `window_set_focus` `set_window_title` `set_window_size`
    `set_window_position` `center_window` `set_fullscreen` `set_window_theme` `set_window_always_on_top`
    `set_window_resizable` `set_window_enabled` `show_window` `hide_window` `set_window_skip_taskbar`
    `set_window_focusable` `set_window_content_protected` `set_window_decorations`
    `set_window_ignore_cursor_events` `set_window_visible_on_all_workspaces` `set_window_cursor_grab`
    `set_window_cursor_visible` `set_window_min_size` `set_window_max_size` `clear_window_min_size`
    `clear_window_max_size` `set_window_background_color` `clear_window_background_color`
    `set_desktop_zoom_level`
  - *dialogs / fs pickers*: `show_open_dialog` `select_directory` `show_save_dialog`
    `show_message_dialog`
  - *shell / open*: `open_url` `open_path` `reveal_in_folder`
  - *notify / clipboard*: `show_notification` `read_clipboard_text` `write_clipboard_text`

  Several are *infra* not surfaced as their own `IPlatformService` method (app version/name/platform
  info/dir getters); they back rows but do not by themselves retire an interface method. Rows in §1
  whose `mechanism` is a `command:<snake>` now listed above are therefore **infra-ready** — the adapter
  (§5 P-slices) still has to map the method to them; the command existing ≠ the method being wired.

Signatures are quoted from `platform.ts` (line refs in parentheses). `ASSUMPTION` marks a
mechanism not yet confirmed against source/Rust.

---

## 1. Full method inventory (104 methods + 2 boolean props)

### 1a. Properties (2)

| member | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `canSelectFilePath?` | `boolean?` (platform.ts:506) | prop | static `true` in Tauri (native dialog returns abs paths) | LOW | P2 |
| `isLocalDevelopmentRuntime?` | `boolean?` (platform.ts:872) | prop | from `import.meta.env.DEV` / injected global, mirror `main.tsx:109-111` | LOW | P0 |

### 1b. Window / chrome / zoom / overlay

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `activateOrSetWorkspace` | `(path) => Promise<{activated:boolean}>` (:555) | window | `command:activate_or_set_workspace` (Rust window registry) | MED | P1 |
| `getDesktopWindowChromeState?` | `() => Promise<DesktopWindowChromeState>` (:755) | window | `command:get_window_chrome_state` (isMaximized + decorations) | MED | P1 |
| `onDesktopWindowChromeStateChanged?` | `(state) => () => void` (:758) | window event | `event:window-chrome-changed` | MED | P1 |
| `getWindowControlsOverlayMetrics?` | `() => WindowControlsOverlayMetrics \| null` — **SYNC** (:763) | window | `sync-cache` prewarm (no sync `invoke`; PORTING.md trap) | MED | P1 |
| `onWindowControlsOverlayChanged?` | `(metrics) => () => void` (:766) | window event | `event:overlay-metrics-changed` | MED | P1 |
| `getDesktopZoomLevel?` | `() => Promise<DesktopZoomState>` (:771) | window | `command:get_zoom_level` (webview `set_zoom` state) | LOW-MED | P1 |
| `onDesktopZoomLevelChanged?` | `(state) => () => void` (:774) | window event | `event:zoom-changed` | LOW-MED | P1 |
| `onWindowFullscreenChanged` | `(isFullscreen) => () => void` (:752) | window event | `event:window-fullscreen-changed` | LOW | P1 |
| `setTitleBarTheme` | `(theme) => Promise<void>` (:910) | window | `command:set_titlebar_theme` (window effects) | HIGH (chrome parity, INVENTORY §1 custom-frameless) | P1 |
| `onOpenWorkspace` | `() => () => void` (:746) | window event | `event:menu-open-workspace` | LOW | P1 |
| `onOpenWorkspacePath?` | `(path) => () => void` (:749) | window event | `event:deep-link-open-workspace` (+ replay cache) | MED | P5 |
| `onNewTab` / `onFocusTab` | `() => () => void` / `(path) => () => void` (:677/:674) | window event | `event:new-tab` / `event:focus-tab` | MED | P1 |
| `syncWindowTabs` | `(paths) => void` (:660) | window | `command:sync_window_tabs` (fire-and-forget) | LOW | P1 |
| `syncWindowUnreadCount` | `(count) => void` (:663) | window | `command:sync_unread` (+ `tauri-plugin-badge`) | LOW-MED | P1 |
| `syncActiveTaskSession` | `(sessionId) => void` (:665) | window | `no-op` (already no-op in Electron, `desktopPlatform.ts:52`) | LOW | P0 |

### 1c. Dialogs / file selection

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `selectDirectory` | `() => Promise<string \| null>` (:509) | dialog | `plugin:dialog` (rfd) | LOW | P2 |
| `selectFile` | `() => Promise<string \| null>` (:512) | dialog | `plugin:dialog` | LOW | P2 |
| `selectFiles?` | `() => Promise<string[]>` (:515) | dialog | `plugin:dialog` multi | LOW | P2 |
| `getPathForFile?` | `(file) => string \| null` — **SYNC** (:530) | dialog | **BLOCKED / no equivalent** — Electron `webUtils.getPathForFile`; Tauri drop has no host path (INVENTORY §2 "getPathForFile no equivalent") → ASSUMPTION: drag-drop file → `command:` resolve via a temp registration | HIGH | OUT(P4 spike) |
| `saveFile?` | `(SaveFileRequest) => Promise<SaveFileResult>` — **ArrayBuffer in** (:518) | dialog/fs | `plugin:dialog` + `Channel`/`ArrayBuffer` command (binary; PORTING trap) | HIGH | P2 |

### 1d. Filesystem / temp attachment

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `createTempTextAttachment?` | `(req) => Promise<CreateTempTextAttachmentResult>` (:539) | fs | `command:create_temp_attachment` (Rust `~/.zcode` tmp) or `ws` host | MED | P7/P8 |
| `createLocalMediaPreviewUrl?` | `(path) => string` — SYNC (:533) | fs | `sync` string build (`zcode-media://`), but **URL must resolve** via `register_asynchronous_uri_scheme_protocol` (Range/seek, INVENTORY §1) | MED-HIGH | P4 spike |
| `exportLogs` | `() => Promise<{success;path?;error?}>` (:780) | fs/misc | `command:export_logs` (zip `~/.zcode/v2`) or `ws` host | MED | P7 |

### 1e. Shell / open

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `openExternal` | `(url) => void` (:607) | shell | `plugin:opener` (openUrl); fire-and-forget wrapper | LOW | P3 |
| `openInFileManager` | `(path) => Promise<{success;error?}>` (:630) | shell | `plugin:opener` `revealItemInDir` | LOW | P3 |
| `openExternalFile?` | `(path) => Promise<{success;error?}>` (:633) | shell | `plugin:opener` (openPath) | LOW | P3 |
| `getInstalledEditors` | `() => Promise<EditorInfo[]>` (:893) | shell/device | `command:get_installed_editors` (icons = base64 data URL; needs `image`/icns crate, INVENTORY §1 nativeImage MED) | MED | P3 |
| `openInEditor` | `(editorId, path, options?) => Promise<{success;error?}>` (:896) | shell | `command:open_in_editor` (Remote-SSH URI composition) | MED | P3 |
| `getApplicationIcon?` | `(string \| ApplicationIconRequest) => Promise<ApplicationIconInfo \| null>` (:610) | device/shell | `command:get_application_icon` (base64; icns/png decode in Rust) | MED | P3 |

### 1f. OAuth / deep link / payment / share

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `registerOAuthState` | `(OAuthStateRegistration) => void` (:636) | oauth | `command:register_oauth_state` (Rust registry) | MED | P5 |
| `onOAuthCallback` | `(url) => () => void` (:642) | oauth event | `plugin:deep-link` → `event:oauth-callback` | MED | P5 |
| `onPaymentCallback` | `(url) => () => void` (:648) | oauth event | `event:payment-callback` | MED | P5 |
| `onShareImport?` | `({shareCode}) => () => void` (:651) | oauth event | `event:share-import` (+ pending replay cache, INVENTORY §2) | MED | P5 |
| `notifyRendererReady` | `() => void` (:654) | oauth/misc | `command:notify_renderer_ready` (flush cached cold-start deep links) | MED | P5 |
| `openFeedback` | `() => Promise<void>` (:615) | oauth/misc | `command:open_feedback` (Electron routes via `executeDesktopCommand(OpenFeedback)`) | LOW | P5 |
| `onOpenFeedbackDialog?` | `() => () => void` (:618) | event | `event:open-feedback-dialog` | LOW | P5 |
| `onOpenTicketsPanel?` | `() => () => void` (:621) | event | `event:open-tickets-panel` | LOW | P5 |
| `openCommunity` | `() => Promise<void>` (:624) | misc | `command:open_community` (locale-aware) | LOW | P5 |
| `canOpenCommunity` | `(locale) => Promise<boolean>` (:627) | misc | `command:can_open_community` | LOW | P5 |

### 1g. Updates (HIGH per INVENTORY §2 — `electron-updater` semantics differ)

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `onUpdateReady` | `(version) => () => void` (:832) | update event | `event:update-ready` (`plugin:updater`) | HIGH | P6 |
| `onUpdateCheckResult` | `(payload) => () => void` (:835) | update event | `event:update-check-result` | HIGH | P6 |
| `onUpdateStateChanged?` | `(payload) => () => void` (:838) | update event | `event:update-state-changed` | HIGH | P6 |
| `getUpdateState?` | `() => Promise<UpdateStatePayload>` (:841) | update | `command:get_update_state` | HIGH | P6 |
| `downloadUpdate` | `() => Promise<void>` (:844) | update | `command:download_update` | HIGH | P6 |
| `cancelUpdateDownload` | `() => Promise<void>` (:847) | update | `command:cancel_update_download` | HIGH | P6 |
| `openUpdateStatusWindow?` | `() => Promise<void>` (:850) | update | `command:open_update_window` (new `WebviewWindow`) | MED | P6 |
| `getAutoUpdatePreferences?` | `() => Promise<{autoDownloadAndInstallUpdates:boolean}>` (:853) | update | `command:get_auto_update_prefs` (Rust config) | MED | P6 |
| `setAutoDownloadAndInstallUpdates?` | `(enabled) => Promise<void>` (:858) | update | `command:set_auto_update_prefs` | MED | P6 |
| `skipUpdateVersion` | `(version) => Promise<void>` (:861) | update | `command:skip_update_version` | MED | P6 |
| `onPostUpdateReleaseNotes` | `(payload) => () => void` (:884) | update event | `event:post-update-release-notes` | HIGH | P6 |
| `acknowledgePostUpdateReleaseNotes` | `(version) => Promise<void>` (:887) | update | `command:ack_release_notes` | MED | P6 |
| `quitAndInstallUpdate` | `() => Promise<void>` (:890) | update | `command:quit_and_install` (installer/lock parity, HIGH) | HIGH | P6 |

### 1h. Notifications

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `showTaskNotification` | `(TaskNotificationPayload) => void` (:657) | notify | `plugin:notification` | LOW | P4 |
| `onTaskNotificationClick` | `(taskId) => () => void` (:777) | notify event | `event:notification-click` (action payload) | LOW-MED | P4 |

### 1i. Device / identity / locale

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `getSystemLocale?` | `() => Promise<Locale>` (:881) | device | **DONE** `command:get_system_locale` (`getTauriSystemLocale`, `tauriBridge.ts:37`) | LOW | P0 |
| `getDeviceId` | `(): string` — **SYNC** (:918) | device | **DONE (partial)** `command:get_device_id` exists but is async → `sync-cache` prewarm (see §4) | LOW-MED | P0 |
| `onApplicationLocaleChanged?` | `(locale) => () => void` (:878) | device event | `event:locale-changed` (broadcast, no-loop guard) | LOW | P1 |
| `setApplicationLocale` | `(locale) => Promise<void>` (:907) | misc | `command:set_application_locale` (rebuild menu) | LOW-MED | P1 |

### 1j. Remote / workspace management (sidecar-WS dependent)

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `connectRemote` | `(target, requestId?, context?) => Promise<{success;error?;sessionId?}>` (:558) | remote | `command:connect_remote` + `ws` host attachment registry | LOW (INVENTORY §2) / **ws-dep** | P7 |
| `cancelPendingRemoteConnection?` | `(requestId?) => Promise<void>` (:569) | remote | `command:cancel_pending_remote` | LOW / **ws-dep** | P7 |
| `bindRemoteWorkspaceSessionContext?` | `(ctx) => Promise<void>` (:572) | remote | `command:bind_remote_ws_session_ctx` | LOW / **ws-dep** | P7 |
| `disposeRemoteSession` | `(sessionId) => Promise<void>` (:577) | remote | `command:dispose_remote_session` | LOW / **ws-dep** | P7 |
| `onRemoteConnectionLog` | `(entry) => () => void` (:544) | remote event | `event:remote-conn-log` (push from host over `ws`) | MED / **ws-dep** | P7 |
| `onRemoteSessionClosed` | `(event) => () => void` (:547) | remote event | `event:remote-session-closed` | MED / **ws-dep** | P7 |
| `onBotRemoteWorkspaceReconnected` | `(event) => () => void` (:550) | remote event | `event:bot-remote-reconnected` | MED / **ws-dep** | P7 |
| `isDockerAvailable` | `() => Promise<boolean>` (:580) | remote/device | `command:is_docker_available` (spawn probe) | LOW | P7 |
| `listWSLDistros` | `() => Promise<WSLDistro[]>` (:583) | remote/device | `command:list_wsl_distros` (Windows-only; fallback `[]`) | MED | P7 |
| `listDockerContainers` | `() => Promise<DockerContainerInfo[]>` (:586) | remote/device | `command:list_docker_containers` | MED | P7 |
| `listSSHConfigAliases` | `() => Promise<SSHConfigAliasOption[]>` (:589) | remote/device | `command:list_ssh_config_aliases` | MED | P7 |
| `getDesktopSessionActivity?` | `() => Promise<{runningAgentSessionCount:number}>` (:864) | remote/misc | `ws` host query (session count lives in host) | MED / **ws-dep** | P7 |

### 1k. Resource / storage / MCP / settings sync

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `loadMcpFromUserDirectory?` | `(payload?) => Promise<LoadCliMcpFromUserDirectoryResult>` (:592) | storage/mcp | `command:load_mcp_user_dir` (host config on `~/.zcode`) or `ws` | LOW-MED / **ws-dep** | P8 |
| `saveMcpToUserDirectory?` | `(payload) => Promise<{success;error?}>` (:596) | storage/mcp | `command:save_mcp_user_dir` | LOW-MED / **ws-dep** | P8 |
| `migrateLegacyCommonMcp?` | `(payload?) => Promise<MigrateLegacyCommonMcpResult>` (:601) | storage/mcp | `command:migrate_legacy_common_mcp` | MED / **ws-dep** | P8 |
| `syncAppSettings?` | `(patch) => void` (:668) | storage/misc | `command:sync_app_settings` (fire-and-forget) | LOW | P8 |
| `onSettingsChanged?` | `() => () => void` (:875) | storage event | `event:settings-changed` | LOW | P8 |
| `getZCodeStdioTapDevState?` | `() => Promise<ZCodeStdioTapDevState>` (:869) | misc/dev | `command:get_stdio_tap_state` (dev only; else default) | LOW | P0 |

### 1l. Browser-view / CDP / embedded browser — **mostly OUT of adapter scope**

Per `INVENTORY.md` TOP port-blockers #1–#4 (`webContents.debugger` CDP, `<webview>` multi-
webview on Linux, main-world injection, session partitions). These are **CRITICAL**; they stay
out of the adapter until the P4 spikes resolve. Rows default to `BLOCKED`/throwing stub that
mirrors Electron's optional-chain fallback (`desktopPlatform.ts:59-66`).

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `printPageToPdf?` | `() => Promise<PrintPageToPdfResult>` — **ArrayBuffer out** (:524) | browser-view/fs | `BLOCKED` — `webContents.printToPDF` no Tauri equiv (INVENTORY blocker #3) | HIGH | OUT |
| `captureWindowScreenshot?` | `() => Promise<WindowScreenshotResult \| null>` (:783) | browser-view | `BLOCKED` — per-webview `capturePage` N/A; needs screen-capture plugin | MED | OUT(P4) |
| `onOpenBrowserUrl?` | `(req) => () => void` (:683) | browser-view event | `BLOCKED` — `<webview>` guest | CRITICAL | OUT |
| `onBrowserViewReady?` | `(payload) => () => void` (:685) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `onBrowserViewOperation?` | `(payload) => () => void` (:697) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `onBrowserViewVisibility?` | `(payload) => () => void` (:700) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `onBrowserViewViewportChanged?` | `(payload) => () => void` (:713) | browser-view event | `BLOCKED` (CDP viewport emu) | CRITICAL | OUT |
| `onBrowserViewScreenshotSurfacePrepare?` | `(payload) => () => void` (:718) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `onBrowserViewScreenshotSurfaceRelease?` | `(payload) => () => void` (:723) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `browserViewScreenshotSurfaceReady?` | `(payload) => void` (:728) | browser-view | `BLOCKED` | CRITICAL | OUT |
| `onBrowserViewCloseTab?` | `(payload) => () => void` (:730) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `onBrowserViewSuspend?` | `(payload) => () => void` (:733) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `onBrowserViewRestore?` | `(payload) => () => void` (:738) | browser-view event | `BLOCKED` | CRITICAL | OUT |
| `browserViewAttachGuest?` | `(payload) => Promise<BrowserGuestAttachResult>` (:786) | browser-view | `BLOCKED` (webContentsId identity) | CRITICAL | OUT |
| `browserViewDetachGuest?` | `(payload) => Promise<boolean>` (:798) | browser-view | `BLOCKED` (CDP detach) | CRITICAL | OUT |
| `browserViewCloseTab?` | `(payload) => Promise<void>` (:801) | browser-view | `BLOCKED` | CRITICAL | OUT |
| `browserViewReportResidency?` | `(payload) => Promise<void>` (:804) | browser-view | `BLOCKED` | CRITICAL | OUT |
| `browserViewSuspendReady?` | `(payload) => Promise<void>` (:807) | browser-view | `BLOCKED` | CRITICAL | OUT |
| `browserViewEnsureResident?` | `(payload) => Promise<void>` (:810) | browser-view | `BLOCKED` | CRITICAL | OUT |
| `browserViewRestoreTabs?` | `(payload) => Promise<BrowserViewRestoredTabShell[]>` (:813) | browser-view | `BLOCKED` | CRITICAL | OUT |
| `browserViewUpdateViewport? | `(payload) => Promise<void>` (:818) | browser-view | `BLOCKED` | CRITICAL | OUT |
| `importChromeBrowserData?` | `(options?) => Promise<ChromeBrowserDataImportResult>` (:824) | browser-view | `BLOCKED` — DPAPI/CDP + `node:sqlite` (keep in Node sidecar, INVENTORY §4) | HIGH | OUT |
| `clearEmbeddedBrowserData?` | `("cache"\|"all") => Promise<EmbeddedBrowserDataClearResult>` (:829) | browser-view | `BLOCKED` — `session.fromPartition` | HIGH | OUT |

### 1m. Menu / commands / misc

| method | signature (ret) | cat | mechanism | risk | phase |
| --- | --- | --- | --- | --- | --- |
| `executeDesktopCommand` | `(command) => Promise<unknown>` (:904) | misc | `command:execute_desktop_command` (dispatch on `DesktopCommandId`; window/zoom/relaunch/about) | MED | P1 |
| `setShortcutRecordingActive?` | `(active) => void` (:671) | misc | `command:set_shortcut_rec_active` (suspend menu accelerators) | LOW-MED | P1 |
| `onCloseActiveContextRequest?` | `() => () => void` (:680) | event | `event:close-active-context` | LOW | P1 |
| `onNewTask` | `() => () => void` (:743) | event | `event:menu-new-task` | LOW | P1 |

> **Row tally**: 2 props + 104 methods = 106 rows across §1a–§1m. `DONE`-backed commands:
> `getSystemLocale` (fully), `getDeviceId` (command exists, sync-shape gap), plus infra
> commands `get_app_version`/`get_platform_info`/`get_app_name`/`get_download_directory`/
> `get_documents_directory` (no dedicated interface method yet). **2 of 104 methods are
> retired at the adapter level**; the rest require new commands/events/plugins.

---

## 2. Event / stream methods → Tauri `listen()` / sidecar-WS push

All `on*` return a **disposer** `() => void`. Contract in Tauri: wrap
`const un = await listen(name, cb)` in a sync-returning closure `() => { un() }`; the
adapter method itself stays sync-returning per the interface, so buffer the `UnlistenFn`
from the awaited `listen` and expose it (ASSUMPTION: `listen` promise resolves before first
event; if not, queue until resolved — PORTING.md async trap). Disposer removes ONLY that
callback (never `emit`-side teardown), matching Electron `on*` semantics.

| on* method (line) | Tauri event name | source (who emits) | notes |
| --- | --- | --- | --- |
| `onRemoteConnectionLog` (:544) | `remote-conn-log` | Host sidecar → Rust relay → renderer (`ws`) | high-frequency; `ws`-dep |
| `onRemoteSessionClosed` (:547) | `remote-session-closed` | Host (`ws`) | `ws`-dep |
| `onBotRemoteWorkspaceReconnected` (:550) | `bot-remote-reconnected` | Host (`ws`) | `ws`-dep |
| `onOAuthCallback` (:642) | `oauth-callback` | `plugin:deep-link` | + replay cache |
| `onPaymentCallback` (:648) | `payment-callback` | `plugin:deep-link` | + replay cache |
| `onShareImport` (:651) | `share-import` | `plugin:deep-link` | + replay cache (INVENTORY §2) |
| `onOpenFeedbackDialog` (:618) | `open-feedback-dialog` | Rust menu/handler | — |
| `onOpenTicketsPanel` (:621) | `open-tickets-panel` | Rust menu/handler | — |
| `onFocusTab` (:674) | `focus-tab` | Rust window mgr | single-instance second-window |
| `onNewTab` (:677) | `new-tab` | Rust menu | — |
| `onCloseActiveContextRequest` (:680) | `close-active-context` | Rust menu | — |
| `onBrowserViewReady`/`Operation`/`Visibility`/`ViewportChanged`/`CloseTab`/`Suspend`/`Restore`/`ScreenshotSurface*` | `browser-view-*` | **BLOCKED** (guest CDP) | OUT — §1l |
| `onOpenBrowserUrl` (:683) | `open-browser-url` | **BLOCKED** (`<webview>`) | OUT |
| `onNewTask` (:743) | `menu-new-task` | Rust menu | — |
| `onOpenWorkspace` (:746) | `menu-open-workspace` | Rust menu | — |
| `onOpenWorkspacePath` (:749) | `deep-link-open-workspace` | `plugin:deep-link` | + replay cache |
| `onWindowFullscreenChanged` (:752) | `window-fullscreen-changed` | Rust window events | — |
| `onDesktopWindowChromeStateChanged` (:758) | `window-chrome-changed` | Rust window events | maximize/unmaximize |
| `onWindowControlsOverlayChanged` (:766) | `overlay-metrics-changed` | Rust (traffic-light overlay) | paired with sync getter |
| `onDesktopZoomLevelChanged` (:774) | `zoom-changed` | Rust webview zoom | — |
| `onTaskNotificationClick` (:777) | `notification-click` | `plugin:notification` action | — |
| `onUpdateReady` (:832) | `update-ready` | `plugin:updater` | HIGH |
| `onUpdateCheckResult` (:835) | `update-check-result` | `plugin:updater` | HIGH |
| `onUpdateStateChanged` (:838) | `update-state-changed` | `plugin:updater` | HIGH |
| `onPostUpdateReleaseNotes` (:884) | `post-update-release-notes` | Rust on version bump | HIGH |
| `onSettingsChanged` (:875) | `settings-changed` | Rust fs watch / command | — |
| `onApplicationLocaleChanged` (:878) | `locale-changed` | Rust (broadcast, loop-guard) | AGENTS.md broadcast loop rule |

**Replay-cache pattern** (INVENTORY §2 "update late-event replay-cache"): `OpenWorkspacePath`,
`ShareImport`, `UpdateReady` may fire before a subscriber registers on cold start. Rust must
buffer the last event per key and re-`emit` on first `listen`/`notifyRendererReady`.

---

## 3. Runtime-selection design (additive; Electron stays intact)

### 3.1 The seam

- Current single injection site: `packages/desktop/src/renderer/src/main.tsx:138`
  `const desktopPlatform = createDesktopPlatform({ isLocalDevelopmentRuntime });`
- Existing runtime gate (proven): `tauriBridge.ts:21` `isTauriRuntime()` →
  `"__TAURI_INTERNALS__" in window`. In Electron this is `false`; in Tauri `true`. This is
  exactly the additive guard `BRIDGE.md` "Runtime detection" mandates.

### 3.2 Proposed (NOT yet created) files & edit

1. **New** `packages/desktop/src/renderer/src/tauriPlatform.ts`:
   `export function createTauriPlatform(options: { isLocalDevelopmentRuntime: boolean }): IPlatformService`
   implementing every in-scope row above; out-of-scope browser-view rows reuse the
   Electron option-chain fallback style (return `no-op` disposers / `undefined`) so optional
   members are simply absent and UI degrades as it does today.
2. **New** `packages/desktop/src/renderer/src/platformFactory.ts`:
   ```ts
   import { isTauriRuntime } from "./tauriBridge.js";
   import { createDesktopPlatform } from "./desktopPlatform.js";
   import { createTauriPlatform } from "./tauriPlatform.js";

   export function createPlatform(options: { isLocalDevelopmentRuntime: boolean }): IPlatformService {
     return isTauriRuntime() ? createTauriPlatform(options) : createDesktopPlatform(options);
   }
   ```
3. **Single one-line edit** at `main.tsx:138`:
   `const desktopPlatform = createPlatform({ isLocalDevelopmentRuntime });`
   and swap the import on `main.tsx:29`. Electron path is byte-identical because
   `isTauriRuntime()` returns `false` when `window.zcode` exists and `__TAURI_INTERNALS__`
   is absent. No other `main.tsx` line changes; no Electron/main/preload file touched.

### 3.3 Flow

```
main.tsx boot
   │
   ├── isTauriRuntime()  ── read window.__TAURI_INTERNALS__ ──┐
   │                                                          │
   │   false (Electron)                     true (Tauri)      │
   │      │                              │                    │
   │      ▼                              ▼                    │
   │  createDesktopPlatform()     createTauriPlatform()       │
   │  (over window.zcode)         (over invoke()/listen)      │
   │      │                              │                    │
   │      └──────────┬───────────────────┘                    │
   │                 ▼                                        │
   │        desktopPlatform: IPlatformService                 │
   │                 │  <Root platform={desktopPlatform}>  (main.tsx:314)
   │                 ▼                                        │
   │            packages/ui  (UI never sees Tauri/Electron)   │
   └──────────────────────────────────────────────────────────┘
```

### 3.4 Boot-order constraint (grounded)

`main.tsx:302` calls `desktopPlatform.getDeviceId()` **synchronously** before render, and
`main.tsx:160/309` pass `getSystemLocale` as an async resolver. So the Tauri factory must
**prewarm the device-id sync cache before `createPlatform()` returns**, or `getDeviceId()`
must be seeded synchronously (see §4). `getSystemLocale` being async is fine (already awaited
by `ZCodeIntlProvider`).

---

## 4. Binary / sync special cases

Plain `invoke()` is JSON (structured-clone in Electron IPC ≠ Tauri `invoke` = JSON → PORTING.md
trap). The following cannot be a plain `invoke`:

| method | why | chosen approach |
| --- | --- | --- |
| `getDeviceId` (SYNC `string`, :918) | interface is sync; Tauri `invoke` is async; `bridge get_device_id` is async | **prewarm cache**: Rust emits device id during init (or `getTauriDeviceId()` awaited in `createPlatform` before return, stored in a module `let`); `getDeviceId()` returns the cached string (mirror `main.tsx:109-111` global-injection pattern; `desktopPlatform.ts:133` reads `__ZCODE_DEVICE_ID__`). ASSUMPTION: init handshake injects it before first render. |
| `getWindowControlsOverlayMetrics` (SYNC, :763) | sync, no sync `invoke` | **prewarm cache** filled from `event:overlay-metrics-changed` + one-shot `command:get_overlay_metrics` at boot; return cached `metrics ?? null` (Electron already returns `null` fallback, `desktopPlatform.ts:84`). |
| `getPathForFile` (SYNC `string\|null`, :530) | `webUtils.getPathForFile` has no Tauri equiv | **spike** (OUT of P2). Interim: return `null` (matches Web/phone behavior, :528 doc) so UI degrades safely. |
| `createLocalMediaPreviewUrl` (SYNC `string`, :533) | returns URL; loading needs Range/seek | sync string build is fine; **resolution** depends on `register_asynchronous_uri_scheme_protocol` with manual Range (INVENTORY blocker #5). |
| `saveFile` (ArrayBuffer **in**, :518) | binary payload | Tauri `invoke` accepts `ArrayBuffer`/typed arrays (v2 IPC supports binary args) OR `Channel`; use `Channel`/binary command. |
| `printPageToPdf` (ArrayBuffer **out**, :524) | binary return | **BLOCKED** (no print engine); if later implemented → return bytes via `asset:`/custom protocol reference, not inline JSON. |
| `getApplicationIcon` / `getInstalledEditors` (base64 `iconDataUrl`, :610/:893) | image bytes | encode in Rust to base64 data URL string → plain JSON `invoke` OK (base64 stays text). icns/png decode needs `image` crate (INVENTORY §1 nativeImage MED). |
| `captureWindowScreenshot` (base64, :783) | image bytes | base64 string over JSON (OUT/P4). |
| binary-over-RPC services (skill-sync archives, etc.) | high-freq binary | **stays on sidecar-WS**, which already frames binary (`SIDECAR-TRANSPORT.md` §5: `DataType.Buffer/VSBuffer`, `binaryType="arraybuffer"`). Not adapter JSON. |

**Decision**: adapter binary methods go through either (a) Tauri `Channel`/binary `invoke`
for small payloads, or (b) `asset:`/custom URI-scheme protocol reference for large/seekable
media. The business-service binary streams (screenshots of guests, archives) stay on the
`ws` transport and are NOT reimplemented in the adapter.

---

## 5. Phased build order (each slice = a category)

Verification gate applied at EVERY phase (PORTING.md non-negotiables):
`cargo check && cargo test && cargo clippy -- -D warnings && cargo fmt --check` (Rust
commands), `tsc` on `tauriBridge.ts`/`tauriPlatform.ts`, and — once the P1 language-neutral
harness exists — a runtime round-trip through the Tauri webview. No parity claim without
harness output on Linux/macOS/Windows where applicable.

| Phase | Slice (category) | Depends on sidecar-WS? | Gate |
| --- | --- | --- | --- |
| **P0** | Runtime gate + factory + device/locale identity. Wire `getSystemLocale`, `getDeviceId` (prewarm), `isLocalDevelopmentRuntime`, `syncActiveTaskSession` no-op, `getZCodeStdioTapDevState`. | No | `tsc` + `getTauriDeviceId/getTauriSystemLocale` round-trip already green (`tauriBridge.ts`); add Rust unit tests. |
| **P1** | Window / chrome / zoom / overlay + `executeDesktopCommand` + menu events (`onNewTask`/`onOpenWorkspace`/`onFocusTab`/`onNewTab`/`onCloseActiveContextRequest`) + `setApplicationLocale`/`setTitleBarTheme` + sync overlay prewarm. | No | cargo gate + round-trip: minimize/maximize/fullscreen + zoom + overlay events. `setTitleBarTheme` HIGH → spike alongside. |
| **P2** | Dialogs + filesystem: `selectDirectory/File/Files`, `canSelectFilePath`, `saveFile` (binary `Channel`). `getPathForFile` deferred to P4 spike (return `null` interim). | No | plugin-dialog round-trip; `saveFile` binary equality vs Electron. |
| **P3** | Shell/open + editors/icons: `openExternal`, `openInFileManager`, `openExternalFile`, `getInstalledEditors`, `openInEditor`, `getApplicationIcon`. | No | opener plugin + icon base64 decode test per OS. |
| **P4** | Notifications: `showTaskNotification`, `onTaskNotificationClick`. **(also = hard-spike gate for browser-view/printToPDF/getPathForFile)**. | No | notification plugin; click-through routing. |
| **P5** | OAuth / deep-link / community / feedback: `registerOAuthState`, `onOAuthCallback`, `onPaymentCallback`, `onShareImport`, `notifyRendererReady`, `openFeedback`/`openCommunity`/`canOpenCommunity`, `onOpenFeedbackDialog`/`onOpenTicketsPanel`, `onOpenWorkspacePath` + replay caches. | No | `plugin:deep-link` + `plugin:single-instance` handoff (structured `additionalData` gap → argv-only, INVENTORY §1 MED). |
| **P6** | Updates (HIGH): full `onUpdate*`/`getUpdateState`/`downloadUpdate`/`cancelUpdateDownload`/`openUpdateStatusWindow`/`get+setAutoUpdatePreferences`/`skipUpdateVersion`/release-notes/`quitAndInstallUpdate`. | No | `plugin:updater` (minisign); installer/lock semantics spike. |
| **P7** | **Remote/workspace mgmt** — requires the `ws` sidecar-WS transport to be live (`SIDECAR-TRANSPORT.md` §6 step 1-5). `connectRemote`, `cancel/bind/dispose`, `onRemote*` events, `isDockerAvailable`, `listWSLDistros/DockerContainers/SSHConfigAliases`, `getDesktopSessionActivity`, `createTempTextAttachment`, `exportLogs`. | **YES** | smallest proof = `subagents.list` WS round-trip (`SIDECAR-TRANSPORT.md` §6.5), then session/agent flows; remote attach per AGENTS.md owner/lease rules. |
| **P8** | **Resource / storage / MCP / settings sync**: `loadMcpFromUserDirectory`, `saveMcpToUserDirectory`, `migrateLegacyCommonMcp`, `syncAppSettings`, `onSettingsChanged`. | **YES** (host-owned config) | cargo + `ws` command round-trip; identity key `workspaceIdentity?.trim() \|\| workspacePath` (AGENTS.md). |
| **OUT (P4 spike-gated)** | Browser-view / CDP cluster (§1l): all `onBrowserView*`, `browserView*`, `printPageToPdf`, `captureWindowScreenshot`, `importChromeBrowserData`, `clearEmbeddedBrowserData`, `createLocalMediaPreviewUrl` resolution. | mixed | **Blocked** until INVENTORY top blockers #1–#5 spike; interim no-op/`undefined` fallback preserving UI degradation parity. |

Sidecar-WS-dependent categories (P7, P8, and the binary-stream services behind them) MUST
NOT start until the localhost-WS `ChannelServer` drop-in is proven (`SIDECAR-TRANSPORT.md`
§6 steps 1-5). P0-P6 are Rust-command/plugin work independent of the transport.

---

## 6. Explicit non-goals / blockers (out of adapter scope)

Grounded in `INVENTORY.md` TOP PORT-BLOCKERS (§4) and §2 "Browser-view / CDP" = **CRITICAL**:

1. **`webContents.debugger` / CDP-on-`<webview>`** (blocker #1) — the entire §1l
   browser-view + residency + guest-attach + viewport-emulation cluster. No Tauri/system-
   webview CDP. Adapter exposes them only as optional no-op/`undefined` members until a Rust
   WebKit-inspector/wry-multi-webview spike passes.
2. **`<webview>` multi-webview on Linux/WebKitGTK** (blocker #2) — `browserViewAttachGuest`
   /`DetachGuest` and guest identity (`webContentsId` → Tauri `WebviewWindow` label remap,
   PORTING.md trap). CRITICAL.
3. **`webContents.printToPDF`** (blocker #3) — `printPageToPdf`. Needs headless-Chromium /
   Cairo re-architecture. HIGH.
4. **Main-world `executeJavaScript`/`insertCSS` into third-party pages** (blocker #4) — coding-
   plan purchase bridge / JS dialogs. Not in `IPlatformService` but blocks related flows.
5. **Chromium `session.fromPartition` isolation + Range/seek media protocol** (blocker #5) —
   `clearEmbeddedBrowserData`, `importChromeBrowserData` (DPAPI+CDP+`node:sqlite`, kept in the
   Node sidecar per INVENTORY §4), and `createLocalMediaPreviewUrl` (`zcode-media://`) Range/
   seek reimplementation.

Also out of this adapter's scope: MessagePort→`ws` transport implementation itself
(`SIDECAR-TRANSPORT.md` owns it), the P1 test/E2E harness (repo has ~4 tests, PORTING.md
Phase 1 prerequisite), and `remote-debugging-port` E2E re-architecture (INVENTORY §1 HIGH).

---

## Appendix: already-ported bridge commands → interface mapping

| `tauriBridge.ts` wrapper (command) | maps to IPlatformService | status |
| --- | --- | --- |
| `getTauriSystemLocale` (`get_system_locale`) | `getSystemLocale` (:881) | **DONE** — direct |
| `getTauriDeviceId` (`get_device_id`) | `getDeviceId` (:918) | **partial** — async; needs sync prewarm (§4) |
| `getTauriAppVersion` (`get_app_version`) | (no interface method; backs `executeDesktopCommand(ShowAbout)` / update UI) | infra |
| `getTauriPlatformInfo` (`get_platform_info`) | (no interface method; OS/arch for chrome/device) | infra |
| `getTauriAppName` (`get_app_name`) | (no interface method; app identity) | infra |
| `getTauriDownloadDir` (`get_download_directory`) | backs `saveFile` default dir | infra |
| `getTauriDocumentsDir` (`get_documents_directory`) | backs dialog defaults | infra |

`window_*` controls (minimize/maximize/close/toggle-fullscreen) surface through
`executeDesktopCommand(DesktopCommandIds.*)` (:904) and the chrome/overlay/zoom getters, NOT
as dedicated interface methods — so `tauriBridge`'s window-control commands support P1 rows
rather than retire a distinct method.
