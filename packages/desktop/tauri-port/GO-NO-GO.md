# GO / NO-GO — Electron→Tauri port decision memo

Synthesis of the Phase-0/1 artifacts and all five hard-blocker spikes into a single
recommendation + the explicit product decisions required. **Electron is the shipped product today;
this is a parallel-shell feasibility call, not a cutover yet.**

## What is PROVEN feasible (verified, not assumed)
- **Renderer reuse**: UI is 100% behind `IPlatformService` (0 direct `window.zcode` in `packages/ui`) →
  the React app loads unchanged in a Tauri window (`pnpm dev:tauri` → Vite :5174). `cargo check` green.
- **Transport reuse**: the localhost-WS RPC stack already exists + is production-tested on the
  web/remote path. Now proven **in-tree**: `test/layer-a/a1-ws-rpc.test.ts` drives a real `@zcode/rpc`
  `ChannelServer` ⇄ `@zcode/client` `connectViaWebSocket` round-trip (`SIDECAR-TRANSPORT.md §6.5`);
  `a2` binary framing byte-equal; `a3` stdio round-trip; `a4` spawns the echo sidecar + WS round-trip +
  clean kill. `spawn_sidecar_echo_discover_port` (slice 31) returns the OS-ephemeral port by reading the
  sidecar's `ZCODE_WS_READY` stdout. Seam = `IMessagePassingProtocol` (`packages/rpc/src/protocol.ts`).
- **Command seam**: **79 real `#[tauri::command]`s** landed across slices 1–31 (window ops, dirs, dialogs
  + file/dir pickers, clipboard, notifications, shell/open, monitors, cursor, theme, zoom set+get,
  sidecar spawn/discover/kill, app lifecycle), each cargo build/test/clippy/fmt + renderer-tsc green.
  `a5-contract.test.ts` statically enforces command⇄wrapper ⇄ `generate_handler` 1:1 parity + camelCase
  args; `a6-bridge-import.test.ts` proves the bridge imports with zero side effects (Electron intact).
- **Adapter**: `tauriPlatform.ts` `createTauriPlatformSubset()` backs **9** `IPlatformService` methods via
  `Pick<>` (type-checked against the real interface, no stubs), Layer-B-conformance-tested (`b1`, 14/14).
  Additive — NOT yet wired into the Electron factory.
- **Sidecar packaging**: runbook exists; `externalBin` naming resolved (`<name>-<rust-target-triple>`).
- **Gate**: canonical `pnpm typecheck` green AND `tsconfig.renderer.json` clean for bridge/adapter (the
  two are disjoint projects — see `TEST-HARNESS.md §4.5`). Full `pnpm test:tauri` (layer-a/b/rust) green.

## Hard-blocker verdicts (from the spikes)
| # | Blocker | Verdict | Source |
| --- | --- | --- | --- |
| 1 | Embedded browser + CDP (`<webview>`, `webContents.debugger`) | **No byte-parity.** Windows feasible via WebView2 CDP on a separate `WebviewWindow`; macOS/Linux have no CDP. In-DOM parity needs a Chromium/CEF sidecar (negates Tauri's size win). | `BROWSER-CDP-SPIKE.md` |
| 2 | `electron-updater` | Use `tauri-plugin-updater` as install engine only; rebuild feed/skip/channel/release-notes/force-gate app-side + install-lock in sidecar. Real cost = signing/manifest pipeline. Effort L / risk HIGH. | `UPDATER-SPIKE.md` |
| 3 | `printToPDF` | Two-tier: native per-OS webview print (Win/mac) + headless-Chrome sidecar on Linux. Renderer already emits an engine-agnostic print host. Effort/risk MED. | `PRINT-PDF-SPIKE.md` |
| 4 | Main-world injection | Coding-plan page is **first-party** → port via wry `initialization_script` + eval/emit (LOW-MED). Third-party `alert/confirm` patching folds into #1. | `WEBVIEW-PROTOCOL-SPIKE.md` |
| 5 | Session partitions + Range/seek media | Rust `register_asynchronous_uri_scheme_protocol` with manual Range→206; per-window `data_directory`. MED-HIGH; top risk Linux MP4/GStreamer. | `WEBVIEW-PROTOCOL-SPIKE.md` |

## Recommended posture
**Continue the parallel port for the CORE app, and treat the embedded browser as a scoped product
decision — do not let it block the rest.** Concretely:
1. Ship a Tauri core that covers everything except the in-app browser (which is already partly
   de-scoped: CUA + browser plugins were removed; only the manual IAB + Chrome-data import remain).
2. Adopt the reduced browser plan (separate `WebviewWindow` + headless-Chrome import helper) OR keep
   the IAB Electron-only behind a feature flag.
3. Do NOT commit to cutover until the Phase-1 harness (`TEST-HARNESS.md` → Layer A/B) is GREEN on both
   runtimes across the OS matrix.

## Decisions needed from the product owner (blocking full parity)
1. **Embedded browser**: is in-DOM `<webview>` browser + CDP automation a hard requirement? If yes →
   Tauri cannot match it without a Chromium sidecar (size/complexity cost) → likely stay Electron. If
   "separate window, no automation" is acceptable → proceed.
2. **Updater**: invest in the minisign + static-manifest release pipeline, or keep auto-update
   Electron-only / fall back to "download update" deep link?
3. **Target OS priority**: Windows is the most Tauri-viable (WebView2 = Chromium + CDP). Linux is the
   hardest (WebKitGTK: no CDP, no printToPDF, MP4 seek risk). Confirm the OS the port is FOR.
4. **Bundle-size / security motivation**: if the driver is size/attack-surface, the sidecar approach
   (bundling Node for Host/Agent) erodes much of the size win — confirm the goal still holds.

## Decision → what it unblocks (to answer fast)
Each remaining interface family is blocked on a specific decision, NOT on more slice work:
- **D1 browser** → `browserView*` (~12 methods), `onOpenBrowserUrl`, `onBrowserView*` events,
  `clearEmbeddedBrowserData`, `importChromeBrowserData`. If "separate window, no CDP automation" is
  acceptable, these become a scoped `WebviewWindow` port; if full CDP automation is required, stay
  Electron for that surface.
- **D2 updater** → `getUpdateState`, `checkForUpdates`(`CheckForUpdates` id), `downloadUpdate`,
  `cancelUpdateDownload`, `quitAndInstallUpdate`, `setAutoDownloadAndInstallUpdates`,
  `skipUpdateVersion`, `onUpdate*` events (~10 methods).
- **D3 target OS** → gates `getDesktopWindowChromeState` (macOS version), `listWSLDistros` (Windows),
  `printPageToPdf` (Linux), media Range/seek (Linux WebKitGTK). Without a target OS I cannot ship
  faithful (non-partial) versions of these.
- **D4 size/security motivation** → determines whether the Node-sidecar bundling for
  Host/Agent (erodes size win) is acceptable at all.
- **Also blocked (transport wiring, not a product decision per se):** `getHostPort`-style factory
  selection + the renderer↔sidecar `connectViaWebSocket` glue + `executeDesktopCommand` router +
  all `on*` push events + `notifyRendererReady` — need the Rust-spawns-Host-sidecar step, which needs
  D1–D4 settled to know what the Host must expose.

## Honest status
Foundation + 79 verified commands + 9-method adapter + transport proof + full blocker analysis are DONE
and verified (all gates green). **The faithful, un-gated, non-partial command/adapter increments are now
exhausted** — every remaining `IPlatformService` method is gated on D1–D4 or the Host-sidecar transport
wiring (see the Decision→unblocks map), and forcing one now would ship a stub or a partial substitute,
which AGENTS.md + the port playbook forbid. This is a multi-week effort gated on those decisions, **not**
closeable by continuing to add slices blindly. Electron remains the shipped product, fully intact.
