# GO / NO-GO — Electron→Tauri port decision memo

Synthesis of the Phase-0/1 artifacts and all five hard-blocker spikes into a single
recommendation + the explicit product decisions required. **Electron is the shipped product today;
this is a parallel-shell feasibility call, not a cutover yet.**

## What is PROVEN feasible (verified, not assumed)
- **Renderer reuse**: UI is 100% behind `IPlatformService` (0 direct `window.zcode` in `packages/ui`) →
  the React app loads unchanged in a Tauri window (`pnpm dev:tauri` → Vite :5174). `cargo check` green.
- **Transport reuse**: the localhost-WS RPC stack already exists + is production-tested on the
  web/remote path; `poc/ws-rpc-roundtrip.ts` proves `subagents.list` round-trips over plain WS with no
  Electron/MessagePort (`POC PASS`). Seam = `IMessagePassingProtocol` (`packages/rpc/src/protocol.ts`).
- **Command seam**: 12 real `#[tauri::command]`s landed across slices 1–4 (each cargo test/clippy/fmt +
  tauriBridge tsc green), incl. the fallible `Result→rejected-Promise` error seam and window controls.
- **Sidecar packaging**: runbook exists; `externalBin` naming resolved (`<name>-<rust-target-triple>`).

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

## Honest status
Foundation + core-command slices + transport proof + full blocker analysis are DONE and verified.
The remaining work is large and partly gated on the four product decisions above. This is a
multi-week effort, not closeable by continuing to add slices blindly.
