# Electron → Tauri v2 Port — PORTING.md

Companion to `INVENTORY.md`. This maps source (Electron/TypeScript shell) patterns to target
(Tauri v2 / Rust + system webview) patterns, and defines a **phased, parallel-run** plan where
Electron is never removed until Tauri reaches verified parity.

## Non-negotiables (from the port playbook + user instruction)

1. **Behavior parity over elegance.** Same inputs → same outputs/errors/envelope.
2. **Electron stays intact.** Tauri is added alongside (`pnpm dev:tauri`). No Electron deletion
   until every in-scope feature is verified on Tauri.
3. **Tests are the contract.** Repo currently has ~4 tests → **Phase 1 prerequisite**: build a
   language-neutral black-box harness (drive the app over its stdio/WS/CLI surface + a UI smoke
   suite) before claiming parity for any subsystem.
4. **One subsystem per commit**, reviewed by a non-author. No stubs/`TODO`/silenced warnings as
   "done."

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

## Success criteria for declaring parity (per subsystem)

P1 harness green on BOTH Electron and Tauri for that subsystem's flows, on Linux/macOS/Windows where
applicable, plus a manual side-by-side read of tricky paths. No "works on my machine" claims.
