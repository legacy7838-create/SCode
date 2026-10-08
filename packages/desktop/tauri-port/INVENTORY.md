# Electron → Tauri v2 Port — Phase 0 Inventory

> Status: **IN PROGRESS**. Section 1 is populated; sections 2–4 are being filled by parallel
> read-only inventory subagents. This document is the Phase-0 "scope and inventory" artifact
> required before any porting code is written (per the repo's port playbook + AGENTS.md
> "spec before implementation").
>
> Ground rule: **Electron stays fully intact.** Tauri is added as a parallel shell
> (`pnpm dev:tauri`) that loads the *same* Vite renderer (dev server, port **5174**). No
> Electron code is removed until Tauri reaches verified parity, and parity is only claimed
> with test/build output.

## Environment (verified on this machine)

- Rust toolchain: `cargo 1.98.1`, `rustc 1.98.1`.
- Tauri v2 Linux system deps present: `webkit2gtk-4.1 2.52.6`, `gtk+-3.0 3.24.52`,
  `libsoup-3.0 3.6.6`, `javascriptcoregtk-4.1 2.52.6`; `gcc/cc/ld/pkg-config` present.
- `@tauri-apps/cli` available (2.12.1).
- Electron: `41.0.3` in `packages/desktop`.
- Test baseline: only **4** test files repo-wide → a language-neutral test harness must be
  built before parity can be *verified* (port playbook Phase 1 is currently unmet).

## 1. Electron main-process API surface

Scope: `packages/desktop/src/main/**` plus `from "electron"` reach into `src/preload` and
`src/host/electronPort.ts`. Note: `globalShortcut`, `clipboard`, `powerMonitor`,
`systemPreferences`, `TouchBar` are **not** used in main (zero grep hits); menu accelerators
are used instead.

| Electron API | Files (count) | Purpose | Tauri v2 mapping | Risk |
| --- | --- | --- | --- | --- |
| `app` (lifecycle, setName/setPath/getPath/getAppPath/getVersion/isPackaged/isReady/relaunch/quit/exit/setBadgeCount) | index, desktopElectronApp, applicationIcons, desktopProviderConfig, desktopWindowLifecycle (~15) | App identity, userData/sessionData/home paths, badge, quit barriers | `tauri::App`/`Manager`, `app.path()`, `tauri-plugin-badge`, `app.exit`/`run_on_main_thread` | MED |
| `app.requestSingleInstanceLock` + `second-instance` (structured `additionalData` argv) | index, desktopSecondInstanceDeepLink, desktopDeepLinkUrl | Deep-link relaunch into running window | `tauri-plugin-single-instance` (closure) — no structured `additionalData` channel | MED |
| `app.setAsDefaultProtocolClient` / OAuth & workspace deep links | desktopOAuthDeepLink, desktopLinuxDeepLinkRegistration, desktopDarwinCloseBehavior | Register `zcode://` scheme per OS | `tauri-plugin-deep-link` | LOW-MED |
| `BrowserWindow` (frameless, `titleBarStyle:"hidden"`, `trafficLightPosition`, `setTitleBarOverlay`, `vibrancy`, transparent bg, `frame:false`, `webviewTag:true`) | desktopWindowChrome, index, resourceManagerWindow, aboutWindow, forceUpdatePrompt (~10) | Custom window chrome, multi-window, overlay traffic lights | `WebviewWindowBuilder` + `decorations`/`overlay`/window effects | HIGH |
| `webContents` (`send`, `fromId`, `getZoomFactor`, `executeJavaScript`, `printToPDF`, events `render-process-gone`/`did-*`/`destroyed`) | index, desktopPrintToPdf, browserGuestManager, chromeLocalStorageManager (~12) | Injection, per-tab control, PDF export, crash recovery | `WebviewWindow` eval/`print`(pdf) + `on_page_load` — no arbitrary-webcontents handle | HIGH |
| `webContents.debugger` (CDP `attach/sendCommand/detach`) | browserGuestManager (~30 calls), chromeLocalStorageManager | Embedded-browser automation, cookie/localStorage import via CDP | **No equivalent** — needs custom Rust via WebKit inspector / CDP-on-WKV | HIGH |
| `<webview>` tag / guest `webContents` registry | desktopWindowChrome, browserGuestManager, index | In-app browser tabs as guest webviews | **No multi-webview in main webview**; needs `wry` multi-webview (Linux Tier-2 gap) | HIGH |
| `session`/`fromPartition` (`setProxy`, `cookies.*`, `clearCache/clearStorageData`, `will-download`) | browserDataManager, chromeCookieManager, desktopNetworkPolicy, desktopCommandHandlers, browserGuestManager (~8) | Persistent partitioned sessions, proxy policy, cookie jar, downloads | `http` feature + `tauri-plugin-http`/`reqwest`+`cookie_store`; no WebView cookie/proxy API → custom Rust | HIGH |
| `protocol.registerSchemesAsPrivileged` + `registerFileProtocol` (seekable Range media) | localMediaPreviewProtocol, index | Privileged `zcode-media://` file loader with Chromium Range/seek | `register_asynchronous_uri_scheme_protocol` — Range/seek semantics must be reimplemented | MED-HIGH |
| `ipcMain` (`handle`/`on`, `IpcMainInvokeEvent`) | desktopMainIpc*, desktopBrowserViewIpc, desktopSaveFile, desktopPrintToPdf, resourceManagerStorage (~12) | Renderer↔main RPC | `#[tauri::command]` + `invoke`/events | MED (large surface rewrite) |
| `MessageChannelMain`/`MessagePortMain` (postMessage to host) | desktopHostProcess, desktopRemoteSessions, desktopWindowLifecycle, host/electronPort | Zero-copy port forwarding main↔utility host | **No MessagePort model**; redesign to sidecar stdio/socket IPC | HIGH |
| `utilityProcess` (window-scoped Local Host + cron scheduler) | desktopHostProcess, desktopCronScheduler, resourceManagerWindow, broadcastHub, taskRealtimeBus | Node child processes for host/scheduler | `tauri-plugin-shell` sidecar binaries (repack host as standalone Node bin) | MED-HIGH |
| `Menu` (accelerators, rebuild) + `Tray` | desktopApplicationMenu, desktopTray, desktopWindowLifecycle | App menu, tray + tray menu | `tauri::menu`/`Muda`, `tray-icon` | LOW-MED |
| `Notification` | desktopNotifications | Native OS notifications | `tauri-plugin-notification` | LOW |
| `dialog` (save/open/message) | desktopSaveFile, desktopMainIpcPlatform, desktopCommandHandlers, desktopOAuthDeepLink, about | Native dialogs | `tauri-plugin-dialog` | LOW |
| `shell` (openExternal/openPath/showItemInFolder) | openInEditor, desktopMainIpcHelpers, desktopCommandHandlers, forceUpdateGuard, exportLogs, resourceManagerStorage (~10) | Open URL/path, reveal in file manager | `tauri-plugin-opener` + `revealItemInDir` | LOW |
| `nativeImage` (createFromPath/Buffer, icns/png) | editors, index, desktopWindowChrome, embeddedBrowserJavaScriptDialog | Icon decoding/normalization | `tauri::image::Image` (bytes) — no icns decode; needs `image`/icns crate in Rust | MED |
| `nativeTheme` (themeSource, shouldUseDarkColors, updated) | desktopMainIpcPlatform, desktopWindowChrome, desktopWindowButtonPosition, forceUpdatePrompt | Dark/light sync | window theme + `NativeTheme` events | LOW |
| `screen` (displays, cursor point) | desktopWindowChrome | Multi-monitor/window placement | `available_monitors`/`cursor_position` | LOW |
| `net.fetch` | desktopHelpConfig | Chromium-stack HTTP for help config | `tauri-plugin-http`/`reqwest` | LOW |
| `powerSaveBlocker` (prevent-app-suspension) | index | Keep-awake during agent runs | no core API → crate `keepawake-rs`/`wakefield` | MED |
| `crashReporter` (Crashpad, annotations, attachments) | desktopCrashCapture, crashDumpAnnotations | Crash capture/upload | **No equivalent** → Sentry/crash-handler plugin | MED |
| `app.commandLine.appendSwitch("remote-debugging-port")` | index | E2E/WebDriver CDP attach | No Chromium remote debug under WKWebView; E2E harness must be redesigned | HIGH |
| `electron-updater` (autoUpdater, quitAndInstall, setFeedURL, install-lock cleanup) | autoUpdater, forceUpdateGuard/Prompt, manifestUpdateProvider | Signed auto-update per OS | `tauri-plugin-updater` (minisign) — installer/format/lock semantics differ | HIGH |
| `contextBridge`/`ipcRenderer`/`webFrame`/`webUtils` (preload) | preload/index, resourceManager, codingPlanWebview, browserVideoRecorder | Exposed `window.zcode` bridge + `nodeIntegration:false`/`contextIsolation:true` assumptions | Tauri `core.invoke`/capabilities/`__TAURI__` allowlist; no preload script | HIGH |

### Top highest-risk items (main process)

- **Embedded in-app browser**: `<webview>` guest webContents + `webContents.debugger` CDP
  automation (`browserGuestManager.ts`, `chromeLocalStorageManager.ts`) — no Tauri multi-webview
  or CDP; needs `wry` multi-webview + per-OS inspector bridge. **Single largest port blocker.**
- **Partitioned `session` control** (cookies import, `setProxy`, `will-download`,
  `clearStorageData`) — WebView cookie/proxy jars not exposed; requires custom Rust.
- **`MessageChannelMain`/`MessagePortMain` + `utilityProcess`** host/scheduler IPC — Tauri has no
  MessagePort; main↔host transport must be re-engineered onto sidecar stdio/socket.
- **Custom frameless chrome** (`vibrancy`, `titleBarStyle:hidden`, `trafficLightPosition`,
  `setTitleBarOverlay`, transparent bg) — inconsistent across WKWebView/WebView2/GTK.
- **Chromium remote-debugging + `webContents` injection** used for E2E and tab control — no
  WKWebView attach path.
- **`electron-updater`** (Windows NSIS resource-lock cleanup + `quitAndInstall`) — different
  signing/installer model in `tauri-plugin-updater`.
- **Privileged seekable file protocol** (`localMediaPreviewProtocol.ts`) relying on Chromium
  Range handling for MP4 — Tauri URI-scheme protocol must reimplement Range/seek.
- **`app.requestSingleInstanceLock` structured `additionalData`** deep-link handoff — plugin
  passes argv only.
- **`crashReporter`/Crashpad + `nativeImage` icns decode + `powerSaveBlocker`** — each needs a
  dedicated Rust crate/plugin.

Cross-cutting: the preload contract (`nodeIntegration:false`/`contextIsolation:true`,
`contextBridge` → `window.zcode`) and `IPlatformService` (`packages/shared/src/platform.ts`) are
the abstraction seam to reuse; but every `IpcMainInvokeEvent.sender`/`event.senderWindow`
dependency implies per-webContents identity that Tauri windows label differently.

## 2. Preload + IPC bridge surface

**Headline counts** (verified against source):
- `window.zcode` exposed methods (`packages/desktop/src/preload/index.ts`,
  `contextBridge.exposeInMainWorld("zcode", …)`): **~100** top-level keys, plus a sync global
  `__ZCODE_DEVICE_ID__`. ~35 are `on*` subscription listeners (return a disposer).
- `IPlatformService` (`packages/shared/src/platform.ts`): **104 methods** + 2 boolean properties.
- `PlatformChannels` (`packages/shared/src/channels.ts`): **113** channels. `InternalChannels`:
  **6**. Total ≈ **119**.
- Split: ~70 Promise request/response (`invoke`) or fire-and-forget (`send`) vs ~40 main→renderer
  **event/push streams** (`on*` + `StorageScanProgress`, `ServicePort`/`ScopedServicePort`
  MessagePort transport, resource/storage progress).

**Renderer consumption (AGENTS.md verified TRUE):** `packages/ui` has **zero** real `window.zcode.*`
calls — all matches are doc comments (the CodingPlan dialog uses `window.zcodeBridge`, a separate
`<webview>`-guest channel). Direct `window.zcode` access is confined to the adapter
`packages/desktop/src/renderer/src/desktopPlatform.ts` (`createDesktopPlatform(): IPlatformService`)
and sub-adapter `desktopBrowserPlatformBridge.ts`. **⇒ Tauri port reimplements the adapter, not the UI.**

| Domain | #methods/channels | Electron mechanism | Tauri v2 mechanism | Risk |
| --- | --- | --- | --- | --- |
| Remote/workspace mgmt | ~14 | `invoke` | `#[tauri::command]` + `invoke` | Low |
| Dialogs/filesystem (select*, saveFile, printToPdf, createTempTextAttachment, getPathForFile) | ~8 | `invoke` + `webUtils` (sync) | `tauri-plugin-dialog`; **`getPathForFile` no equivalent** | **High** |
| Window chrome/zoom/overlay | ~10 | `invoke` + sync cache + `webFrame` | `tauri::Window` API + events | Medium |
| Menu/shortcut/commands | ~8 | `send`/`invoke` | Tauri menu plugin + command | Medium |
| OAuth/deeplink/payment/share | ~7 | `send` + `on` callbacks | `tauri-plugin-deep-link`, events | Medium |
| Updates (download, install, prefs, release notes) | ~14 | `invoke` + event streams | `tauri-plugin-updater` (semantics differ) | **High** |
| Browser-view / CDP-on-`<webview>` | ~25 | `invoke`/`send` + events + `<webview>` guest | **No Tauri equivalent** | **Critical** |
| Notifications, editors, clipboard-adjacent, device id, logs, screenshot | ~10 | `send`/`invoke` | tauri plugins + commands | Low–Medium |
| MessagePort RPC transport (`ServicePort`/`ScopedServicePort`) | 4 | `ipcRenderer` port + `window.postMessage` transfer | **No MessagePort transfer**; sidecar/TCP or custom | **Critical** |
| Resource/Storage manager | 7 | `invoke` + push stream | command + `emit` | Medium |

**Hardest-to-port bridge items:** CDP-on-`<webview>` embedded browser; MessagePort RPC to host;
binary/high-frequency streams (`saveFile` ArrayBuffer-in, `printToPdf` ArrayBuffer-out,
`screenshot`, `getApplicationIcon`, `zcode-media://`); synchronous IPC (`getWindowControlsOverlayMetrics`,
`getDeviceId`, `__ZCODE_DEVICE_ID__`); `webUtils.getPathForFile`; `custom://` schemes
(`zcode://`, `zcode-browser-restore://`, `zcode-media://`); update late-event replay-cache pattern
(pending queues for `OpenWorkspacePath`/`ShareImport`/`UpdateReady`). `IPlatformService` is a
superset of `window.zcode`, so the **adapter is the correct Tauri seam**, not a 1:1 preload mirror.

## 3. Process model & sidecar/build pipeline

**Runtime topology (verified):** Electron `main` is the parent of two `utilityProcess.fork()`
children — the **window-scoped Local Host** and the **cron scheduler**. The **Agent CLI** is spawned
**inside the Host** by `@zcode/services` (`zcodeAgentProcessManager.ts:368`) via
`child_process.spawn(process.execPath, [entry,"app-server","--stdio"], {env:{ELECTRON_RUN_AS_NODE:"1"}})`.
Three `node:worker_threads` helpers run in-process (main: `storageScanWorker`, `zcodeDataSizeWorker`;
host: `tasksStorageWorker`).

| Process/Worker | Entry | Spawned via | Transport | Tauri approach | Risk |
|---|---|---|---|---|---|
| Electron main | `src/main/index.ts` | Electron bootstrap | (renderer IPC) | Tauri Rust core + WebView | High |
| Local Host (1/window) | `out/host/index.js` | `utilityProcess.fork()` `desktopHostProcess.ts:219` | **MessagePort** RPC + Node IPC control | Node sidecar (`externalBin`); MessagePort must be replaced | High |
| RPC Host↔Renderer | `packages/rpc/src/channelServer.ts` + `host/electronPort.ts` | — | framed binary over `MessagePortLike` | protocol reusable; transport → WebSocket/Tauri channel | High |
| Cron scheduler | `out/scheduler/index.js` | `utilityProcess.fork()` `desktopCronScheduler.ts:61` | Node IPC `parentPort.postMessage` | Node sidecar or Rust command | Med |
| Agent CLI (`zcode-cli` app-server) | bundled `resources/glm/zcode.cjs` | `spawn` (child of Host) | **JSON-RPC over stdio** (`zcode-protocol`) | Sidecar via `tauri-plugin-shell` — transport survives | Low |
| storageScan / zcodeDataSize / tasksStorage Workers | `src/main/*Worker.ts`, `src/host/tasksStorageWorker.ts` | `new Worker(node:worker_threads)` | Node `postMessage` | keep inside Node sidecar, or Rust `tokio::spawn` | Low |
| Windows browser-import helper | `zcode-browser-import-helper.exe` | `spawn` `windowsChromeAppBoundKey.ts` | custom `ZCODE_BROWSER_IMPORT_V1` stdio | prebuilt native exe, reused as-is | Low (Win) |

**Native deps needing Rust/system equivalents:** `node-pty`→`portable-pty`; `node:sqlite`→
`rusqlite`/`sqlx` (or keep in Node sidecar); Electron `safeStorage`/Win DPAPI→
`tauri-plugin-stronghold`/keychain crate; single-instance→`tauri-plugin-single-instance`;
`zcode://`→Tauri deep-link; `ssh2`→`russh`. `bfs`/`ugrep`/`ripgrep` are prebuilt external binaries
(reusable). No custom `.node` addons / `binding.gyp` in repo.

**Survives unchanged:** JSON-over-stdio Agent protocol, external prebuilt binaries, the RPC
*framing* protocol, scheduler logic, worker scan logic (if kept in a Node sidecar). **Must rebuild:**
every Node-only transport (`utilityProcess.fork` lifecycle, **MessagePort** Host↔Renderer RPC →
WebSocket/Tauri channel), and the `process.execPath`+`ELECTRON_RUN_AS_NODE` trick (Tauri sidecars are
standalone binaries). Signing/entitlements move to Tauri `bundle` config.

## 4. Chromium/webview-specific features & OS-native integrations

| Feature | Where (files) | Electron/Chromium API | Tauri v2 path | Risk |
|---|---|---|---|---|
| In-app browser (IAB) as embedded guests | `desktopWindowChrome.ts` (`webviewTag:true`), `browserView/browserGuestManager.ts` | `<webview>` + guest `webContents` | multi-webview **unstable on Linux**; no in-page `<webview>` | **HIGH** |
| Browser automation / CDP | `browserGuestManager.ts` (`guest.debugger`), `chromeLocalStorageManager.ts` | `webContents.debugger` (CDP) | **No equivalent** | **HIGH** |
| print-to-PDF | `desktopPrintToPdf.ts` | `webContents.printToPDF()` | none built-in; headless-Chromium/Cairo re-arch | **HIGH** |
| Main-world JS/CSS injection into guest | `preload/codingPlanWebview.ts`, `index.ts` | `executeJavaScript`/`insertCSS`/`executeInMainWorld` | not achievable vs OS-webview content; IPC only | **HIGH** |
| Isolated storage partitions | `index.ts`, `desktopNetworkPolicy.ts`, `browserDataManager.ts` | `session.fromPartition()` | per-webview `data_directory` only | MED |
| Custom URI schemes / file protocol | `localMediaPreviewProtocol.ts`, `browserRestoreBootstrapProtocol.ts` | `protocol.*` | `register_*_uri_scheme_protocol` (manual Range/seek) | MED |
| Page/window screenshot | `browserGuestManager.ts`, `desktopMainIpcHelpers.ts` | `webContents.capturePage()` | screen-capture plugin; per-webview capture N/A | MED |
| Browser video recorder | `preload/browserVideoRecorder.ts` | MessagePort + guest media capture | rebuild over Tauri channel IPC | MED |
| `requestIdleCallback` | `ui/src/hooks/useTabPersistence.ts` | Chromium API | absent in older WebKit/WKWebView → fallback | MED |
| `navigator.userAgent` branching | several in `packages/ui` | UA string | UA differs on system webview → misfires | MED |
| Local media / video codecs | `localMediaPreviewProtocol.ts` (MP4) | Chromium H.264/AAC | WebKitGTK needs GStreamer plugins | MED |
| Chrome data import (cookies/creds) | `chromeCookieManager.ts`, `windowsChromeAppBoundKey.ts`, `chromeLocalStorageManager.ts` | `node:sqlite` + DPAPI + CDP | keep in Node sidecar; CDP path unusable | MED |
| Dialogs / Notification / Tray / Menu | `desktopSaveFile.ts`, `desktopNotifications.ts`, `desktopTray.ts`, `desktopApplicationMenu.ts` | `dialog`/`Notification`/`Tray`/`Menu` | plugin-dialog/-notification/tray/menu | LOW |
| Deep links / OAuth / single-instance | `desktopOAuthDeepLink.ts`, `index.ts`, `desktopLinuxDeepLinkRegistration.ts` | protocol + `second-instance` | plugin-deep-link + plugin-single-instance | LOW |
| Frameless chrome / traffic-lights / zoom | `desktopWindowChrome.ts`, `desktopZoom.ts` | titleBar overlay, `setZoomFactor` | Tauri decorations + `set_zoom` | LOW-MED |
| Crash / minidump | `desktopCrashCapture.ts` | `crashReporter`/minidump | Breakpad/Crashpad Rust crates | MED |

Residual CUA/browser leftovers still present despite CUA removal: `packages/ui/src/browser-use/`
and the whole `main/browserView/` subsystem. No `playwright`/`desktopCapturer`/`globalShortcut`/
`powerMonitor` usage found.

### TOP PORT-BLOCKERS (no clean Tauri/system-webview equivalent)
1. **`webContents.debugger` / CDP-on-guest** — IAB viewport emulation, synthetic input, Chrome
   localStorage import all depend on CDP. No Tauri/system-webview CDP. Re-architecture required.
2. **`<webview>` multi-webview (Linux/WebKitGTK)** — embedded browser renders real `<webview>`
   guests; Tauri v2 multi-webview unreliable/limited on Linux.
3. **`webContents.printToPDF`** — Chromium-only; presentation PDF export must be re-implemented.
4. **Main-world `executeJavaScript`/`insertCSS` into third-party guest pages** (coding-plan purchase
   bridge, JS dialogs) — not achievable vs OS-webview content.
5. **Chromium session partitions (`fromPartition`) + Chromium-handled media Range/seek protocol** —
   rebuild on Tauri URI-scheme protocols with manual Range handling.

`node:sqlite` lives in `packages/services` (host/sidecar), not the webview → lowest-risk; keep in
the Node sidecar rather than migrate to `tauri-plugin-sql`.

## Consolidated port verdict

- **Reusable seams (biggest lever):** the React renderer (`packages/ui` + `desktop/src/renderer`)
  is platform-agnostic behind `IPlatformService`; the Agent CLI stdio protocol and the RPC framing
  are language-agnostic; `node:sqlite`/scheduler/workers can stay inside a Node sidecar.
- **Genuinely hard (may never be byte-identical):** the embedded in-app browser + CDP automation,
  `<webview>` multi-webview on Linux, `printToPDF`, main-world injection into third-party pages,
  Chromium session partitions, and `electron-updater` install semantics. These are the items to
  scope, spike, or consciously de-scope before committing to a full cutover.
- **Prerequisite before any cutover:** a language-neutral test/E2E harness (repo has ~4 tests),
  per port playbook Phase 1.
