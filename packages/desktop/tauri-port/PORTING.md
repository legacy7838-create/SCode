# Electron → Tauri v2 Port — PORTING.md

Companion to `INVENTORY.md`. This maps source (Electron/TypeScript shell) patterns to target
(Tauri v2 / Rust + system webview) patterns, and defines a **phased, parallel-run** plan where
Electron is never removed until Tauri reaches verified parity.

## Non-negotiables (from the port playbook + user instruction)

1. **Behavior parity over elegance.** Same inputs → same outputs/errors/envelope.
2. **Cutover is authorized.** The owner directed full Electron removal + Tauri parity (2026-10-09).
   Work happens on branch `remove-electron-tauri-default`; `main` stays intact until merge approval.
   The Electron UI process layer (`src/main`, `src/preload`) is already removed; the backend Host port
   (below) is the remaining hard part. Each subsystem lands one commit, reviewed by a non-author.
3. **Tests are the contract.** The Tauri harness (`test/layer-a` + `layer-b`) is the green gate per
   slice; a slice is not "done" until `pnpm test:tauri` + `pnpm typecheck` + `pnpm lint` are green.
4. **No stubs/`TODO`/silenced warnings as "done."** Inert platform fallbacks are permitted ONLY as an
   explicit degraded-boot state (`tauriPlatformFactory`), never as a fake passing implementation.

## Architecture mapping

| Layer | Electron today | Tauri target | Notes |
| --- | --- | --- | --- |
| UI | React (`packages/ui` + `desktop/src/renderer`) over Vite:5174 | **UNCHANGED** — same Vite app loaded by Tauri `WebviewWindow` | Only seam is `IPlatformService` |
| Platform abstraction | `IPlatformService` (104 methods) implemented by `renderer/src/desktopPlatform.ts` over `window.zcode` | New `tauriPlatform.ts` implementing the SAME `IPlatformService`, backed by `invoke()`/events | **This is the pivot** — UI never sees Tauri |
| Bridge | `preload/index.ts` `contextBridge` → `window.zcode` (~100 methods) + `ipcMain` (~119 channels) | `#[tauri::command]` fns + Tauri events; capability allowlist | ~70 request/response, ~40 event streams |
| Business services | window-scoped **Local Host** Node process (`utilityProcess.fork`) + `ServiceCollection` (`services/src/node.ts`) | **Node sidecar** (`externalBin`) — keep as-is | RPC *framing* reusable; **transport** must change |
| Agent runtime | Agent CLI spawned in Host over **JSON-RPC/stdio** | **Sidecar**, unchanged transport | language-agnostic ✅ |
| Scheduler / workers | `utilityProcess` + `node:worker_threads` | Node sidecar (keep) or Rust `tokio` | low risk |

## Key decisions

- **Reuse `IPlatformService` as the port boundary.** Do NOT reimplement UI. Provide a
  `createTauriPlatform(): IPlatformService` adapter that maps each method to a Tauri command/event.
  Web build already proves the interface is implementable without Electron.
- **Replace the MessagePort RPC transport with a local WebSocket (or Tauri IPC channel).** The
  `packages/rpc` framing/serialization protocol is language-agnostic; only the byte pipe changes.
  Simplest parity-preserving move: Local Host sidecar listens on a localhost WS; renderer connects.
- **Ship the Agent CLI + Local Host + scheduler as standalone Node binaries** (they already build
  to `out/*.js`), registered via `tauri.conf.json > bundle > externalBin`, launched with
  `tauri-plugin-shell`. This preserves the stdio JSON-RPC contract verbatim.
- **Native capabilities → Tauri plugins / Rust crates** (see INVENTORY §1/§3): dialog, notification,
  opener, deep-link, single-instance, updater, stronghold (secrets), portable-pty, rusqlite-or-sidecar.
- **`node:sqlite` stays in the Node sidecar** (services layer), not migrated to `tauri-plugin-sql`.

## De-scoped / spike-first (highest-risk, may not reach byte-parity)

These need a dedicated feasibility spike BEFORE any commitment, and are candidates to consciously
ship as "reduced on Tauri" rather than block the whole port:

1. Embedded in-app browser + CDP automation (`webContents.debugger`, `<webview>` guests).
2. `webContents.printToPDF` (presentation PDF export).
3. Main-world `executeJavaScript`/`insertCSS` into third-party pages (coding-plan purchase bridge).
4. Chromium `session.fromPartition` isolation + Range/seek media custom protocol.
5. `electron-updater` install/lock semantics.

## Phased plan (each phase keeps BOTH builds working; commit per phase)

- **P0 (this session): Foundation.** INVENTORY.md + PORTING.md + a Tauri scaffold
  (`packages/desktop/src-tauri`) + `pnpm dev:tauri` that opens a window loading the existing
  Vite:5174 renderer. Electron untouched. Success = a Tauri window renders the app shell (even if
  platform calls no-op). **No parity claimed.**
- **P1: Test harness.** Language-neutral black-box tests over the Agent stdio/CLI + a Playwright/
  WebDriver UI smoke over the Vite app (works on both Electron and Tauri webviews). Establishes the
  parity contract.
- **P2: Platform adapter + core IPC.** Implement `tauriPlatform.ts` for the LOW/MED-risk
  `IPlatformService` methods (window, dialogs, shell, notifications, device id, updates-read).
  Stand up the WS RPC transport to a Node Local-Host sidecar. Verify session/agent flows in Tauri.
- **P3: Native integrations.** single-instance, deep-link/OAuth, tray/menu, strongbox/secrets,
  pty, powerSaveBlocker, crash capture.
- **P4: Hard spikes.** Resolve or consciously de-scope the 5 blockers above.
- **P5: Cutover decision.** Only when P1–P4 pass on all target OSes.

## Semantic traps to check per file (Electron→Tauri)

- `ipcMain.handle` returns are structured-clone (Buffers/typed arrays OK) vs Tauri `invoke` = JSON →
  binary must go via `asset:`/custom protocol or Tauri `Channel`/`ArrayBuffer` commands.
- Synchronous IPC (`sendSync`, `webUtils.getPathForFile`, `getWindowControlsOverlayMetrics`) has no
  sync Tauri `invoke` → make async or prewarm a cache.
- `event.sender` / `webContentsId` identity → Tauri `WebviewWindow` label; re-map per-window routing.
- Chromium timing APIs (`requestIdleCallback`) and UA sniffing differ on WebKit → add fallbacks.
- Process lifecycle: `utilityProcess` auto-kills with main; sidecars must be explicitly terminated on
  exit (and on `tauri` window close) to avoid orphans.

## Transport porting — MessagePort → WebSocket (Phase 0/1)

The renderer↔Host RPC does **not** ride `process.parentPort`. Today main builds a
`MessageChannelMain`, keeps `port1` for the renderer `webContents`, and **transfers** `port2` into the
Host inside an `InitLocal` parentPort message; the Host then runs
`exposeServicesOnMessagePort` → `wrapElectronPort(port)` → `MessagePortProtocol` → `ChannelServer`
(`src/host/index.ts:1937-1954`). `parentPort` itself is only a side-channel to MAIN (~40 telemetry /
control flows). Mapping:

| Electron (source) | Tauri sidecar (target) | Notes |
| --- | --- | --- |
| `wrapElectronPort(MessagePortMain) → MessagePortLike` | **`@zcode/rpc` `wrapWebSocket(WebSocketLike) → ISocket`** (`packages/rpc/src/wsServer.ts`) | Shared server-side WS adapter; promoted from 3 hand-rolled copies (server, server-cli, layer-a `_host.ts`) |
| `MessagePortProtocol(wrappedPort)` | `SocketProtocol(socket)` | Same framing/serialization; `ChannelServer`/middleware stack unchanged |
| `InitLocal` parentPort message carrying `port2` + `{hostId, deviceMid, workspacePath, …}` | Host self-boots from **env/argv** (`ZCODE_HOST_ID`, `ZCODE_WORKSPACE_PATH`, `ZCODE_DEVICE_MID`, `ZCODE_DB_STARTUP_ID`, `ZCODE_WS_PORT`, shared secret), then `WebSocketServer.listen(127.0.0.1, port)` | Rust spawner provides the env; port 0 = ephemeral |
| renderer `webContents.postMessage(ServicePort, [port1])` | renderer `connectTauriHost()` → `connectViaWebSocket(ws://127.0.0.1:port)` | Client stack already production-proven |
| `AttachServicePort`/scoped attachments | per-WS-connection capability/attachment token | Preserve owner/lease + stale-run guards (AGENTS.md) |
| inbound MAIN→Host commands (`CronRun`, `OffPeakRun`, `SessionMessageDeliver`, `ProviderProvisioningExecute`, `ConnectRemoteWorkspace`, `Dispose`, `DatabaseStartupControl`, `ResourceUsageSnapshot`) | register as Host **channels** callable over WS by the renderer/Rust | Convert the `parentPort.on("message")` handler |
| ~40 outbound telemetry/report flows to MAIN | `IHostReportSink` → Tauri event / RPC stream; non-critical degrade to local log | Nearly all helpers already no-op when `parentPort` is null |

### Owned-buffer semantic trap (hit during Phase 0)

`ws` delivers inbound messages as Node `Buffer` fragments. `VSBuffer.wrap` **takes ownership** of the
array and the transport may reuse/zero its receive buffer after the `message` event. Two failure modes,
both proven by `test/layer-a/a2-framing.test.ts`:

- Returning the live `Buffer` without copying → data corrupts on the next frame.
- Using `buffer.slice()` → returns a **`Buffer`**, which the RPC serializer JSON-encodes as
  `{type:"Buffer",data:[…]}` instead of a `Uint8Array`, so a binary top-level arg does NOT round-trip.

**Rule:** normalize every inbound payload to a **plain, owned** `Uint8Array` via `new Uint8Array(raw)`
(never `raw.slice()`). `wsServer.ts:toUint8Array` encodes this and is regression-locked by A2.

## Success criteria for declaring parity (per subsystem)

P1 harness green on BOTH Electron and Tauri for that subsystem's flows, on Linux/macOS/Windows where
applicable, plus a manual side-by-side read of tricky paths. No "works on my machine" claims.

## Current status (living checkpoint)

**Cutover in progress on `remove-electron-tauri-default`.** The Electron UI layer is removed; the
backend Host WS-sidecar port and `main`-responsibility re-homing remain.

- **Cutover-A (done, this session):** removed `src/main` (114 files) + `src/preload`; `main.tsx` installs
  `createTauriPlatform()` unconditionally; deleted `desktopPlatform.ts`/`desktopBrowserPlatformBridge.ts`,
  the `main`/`preload` tsup targets, `electron-builder.config.js`, `dev-app-update.yml`,
  `tsconfig.main/preload.json` (+ refs). Rewrote `a6` as a Tauri-only-entry guard. Host still compiles
  clean; `electron` dep intentionally retained until Phase 1 removes the Host's `parentPort` coupling.
- **Phase 0 (done, this session):** promoted `@zcode/rpc` `wrapWebSocket` (`wsServer.ts`) + regression-
  locked it via layer-a A1/A2 against a real `ws` server. `pnpm typecheck`/`lint`/layer-a/layer-b green.
- **P0 foundation — DONE.** Inventory, this plan, a compiling `src-tauri` scaffold, `pnpm dev:tauri`.
- **P2 platform adapter + IPC — IN PROGRESS.** ~82 commands landed + a 16-method Tauri platform subset;
  blueprint in `PLATFORM-ADAPTER-PLAN.md`. Runtime selection now fixed (cutover-A).
- **P4 hard-blocker spikes — DONE (verdicts in `GO-NO-GO.md`).** Browser/CDP, printToPDF, updater,
  webview-injection/media-protocol, saveFile SSRF, sync-getters — each with a scoped plan + residual.

**Next:** Phase 1 (Host → standalone WS sidecar), then Phase 2 (Rust spawns real Host; renderer boots
connected; `connectTauriHost()` wired), then Phase 3 (`main` re-homing to `IPlatformService` parity).

## Phase 1 — DONE + runtime-verified (2026-10-09)

`src/host/standaloneHost.ts` boots the Local Host as a plain Node process (env-driven
`createLocalServices` under `createHostDatabaseStartup`) and serves it over a loopback WS
`ChannelServer` (`createWsChannelServer`), printing `ZCODE_WS_READY <port>` — the exact line Rust's
`spawn_sidecar_*_discover_port` parses. Layer-A **A8** proves it end-to-end: it spawns the BUILT
`out/host/standalone.js` as a real process, reads the ready port, and a production
`connectViaWebSocket` client receives a live `IServiceAccessor` (with `fileService`). Kept SEPARATE
from the Electron `InitLocal` path → zero regression. Build wiring: `dev:tauri` runs `tsup --watch`,
desktop `build` = `tsup && vite build`.

## Phase 2 — BLOCKED on two prerequisites (not faked)

Pointing `connectTauriHost` (currently at the echo command) at a real host spawn requires:
1. **`zcode-host` externalBin binary** — the ESM host (with native `node-pty`/`ssh2`, external `ws`)
   must be packaged as a standalone Node binary/SEA per-OS (`SIDECAR-PACKAGING.md`). This is the
   Phase 4 packaging step and must be validated by a real `tauri build`.
2. **Provider-config path + per-window env** — the deleted Electron `main` supplied
   `zcodeBuiltinProviderConfigFilePath` + workspace/device identity to `InitLocal`. Under Tauri the Rust
   shell must own and pass these (`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_PATH`, `ZCODE_WORKSPACE_PATH`,
   `ZCODE_DEVICE_MID`); that sourcing is a Phase 3 re-home.

A Rust `spawn_host_discover_port` mirroring `spawn_sidecar_echo_discover_port` is ready to write once
(1) exists, but writing it now would compile-only and provably fail to launch → deliberately not
shipped as "done."

## Phase 3 / 4 — remaining

`IPlatformService` surfaces (browser/CDP per D1, updater per D2, print, saveFile SSRF downloader,
tray/menu/deep-links, notifications-click, all telemetry channels) + node-pty Node-ABI + `pnpm install`
to prune `electron*` from the lockfile. Each needs a real desktop/build environment to verify.
