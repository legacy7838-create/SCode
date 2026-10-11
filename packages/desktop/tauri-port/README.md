# ZCode Electron → Tauri v2 port — document index

Entry point for the port. **The cutover is done — Tauri v2 is the sole desktop runtime.** The
Electron UI process layer (`src/main`, `src/preload`) and the `electron` dependency are removed; the
renderer installs `createTauriPlatform()` unconditionally (`renderer/src/main.tsx:138`), and
`a6-bridge-import.test.ts` asserts that Tauri is the sole desktop entry. Read in this order.

## Status legend

- ✅ done & verified · 🟡 in flight (subagent running) · ⬜ not started

## Core spec

| Doc                        | Purpose                                                                                                                                      | Status |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `INVENTORY.md`             | Phase-0 inventory of the (now-removed) Electron surface (main APIs, IPC bridge, process model, webview/native) + risk ratings + top blockers | ✅     |
| `PORTING.md`               | Source→target mapping, the `IPlatformService` adapter seam, sidecar strategy, phased plan, semantic traps, **living status checkpoint**      | ✅     |
| `BRIDGE.md`                | Command contract for the vertical slices (names/args/returns, no-stub rules)                                                                 | ✅     |
| `PLATFORM-ADAPTER-PLAN.md` | All 104 `IPlatformService` methods → command/event/plugin, phased order, runtime-selection design                                            | ✅     |

## Transport & sidecars

| Doc                       | Purpose                                                                                               | Status |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| `SIDECAR-TRANSPORT.md`    | Design: run Local Host + Agent as sidecars, MessagePort → localhost WS (reuses existing `@zcode/rpc`) | ✅     |
| `poc/ws-rpc-roundtrip.ts` | **Runtime proof** the WS transport works headlessly (`POC PASS`)                                      | ✅     |
| `SIDECAR-PACKAGING.md`    | Runbook: build host/agent as `externalBin` sidecars, shell wiring, orphan-kill, port/secret           | ✅     |

## Hard-blocker spikes (feasibility / go-no-go)

| Doc                         | Blocker                                         | Verdict                                                                                                                       | Status |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| `BROWSER-CDP-SPIKE.md`      | #1 embedded browser + CDP                       | No byte-parity; Windows feasible via WebView2 CDP, macOS/Linux hard → product go/no-go                                        | ✅     |
| `PRINT-PDF-SPIKE.md`        | #3 printToPDF                                   | Two-tier: native per-OS print + headless-Chrome sidecar on Linux                                                              | ✅     |
| `UPDATER-SPIKE.md`          | #2 electron-updater                             | Use Tauri plugin as install engine only; rebuild feed/skip/force-gate/install-lock app-side. Effort L / risk HIGH             | ✅     |
| `WEBVIEW-PROTOCOL-SPIKE.md` | #4 main-world injection, #5 session/Range media | Coding-plan page is first-party → wry init-script bridge; Range→206 Rust protocol; residual = embedded-browser call. MED-HIGH | ✅     |

## Phase 1 (parity gate)

| Doc               | Purpose                                                                                                                                  | Status |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `TEST-HARNESS.md` | Language-neutral harness (Layer A transport / B adapter conformance / C UI smoke); the Electron arm is retired with the Electron surface | 🟡     |

## Code landed (each: cargo test/clippy/fmt + tauriBridge tsc green)

- `src-tauri/` scaffold; `pnpm dev:tauri` loads the Vite renderer (:5174).
- **85 real `#[tauri::command]`s** in `src-tauri/src/commands.rs`: app version, locale, device id,
  platform info, app name, fallible app-path dirs (error seam), window controls, native dialogs
  (file/dir pickers), clipboard, notifications, shell/open, monitors, cursor, theme, zoom set+get,
  sidecar spawn/discover/kill, and app lifecycle. `a5-contract.test.ts` enforces command ⇄ wrapper ⇄
  `generate_handler` 1:1 parity + camelCase args.
- `renderer/src/tauriBridge.ts`: typed `invoke` wrappers + `isTauriRuntime()`.
- **16 backed `IPlatformService` methods** in `createTauriPlatformSubset()` via `Pick<>` (type-checked
  against the real interface, no stubs), Layer-B-conformance-tested (`b1`). `main.tsx` installs it as
  the platform — it is no longer behind a runtime switch.
- Cutover-A: `src/main` (114 files) + `src/preload` deleted, along with `desktopPlatform.ts`,
  `desktopBrowserPlatformBridge.ts`, the `main`/`preload` tsup targets, `electron-builder.config.js`,
  `dev-app-update.yml` and `tsconfig.main/preload.json`.

## What is NOT done

Cutover is no longer the gate — Tauri ships as the only runtime. What remains is the residual
`IPlatformService` surface plus the platform decisions D1–D4 in `GO-NO-GO.md`.

- ⬜ The remaining ~88 un-backed `IPlatformService` methods (the 16-method `Pick` subset is a floor,
  not the ceiling). Each is gated on D1–D4, the Host-sidecar transport wiring, or a confirmed
  capability gap — see `GO-NO-GO.md` for the per-method mapping.
- ⬜ Host → standalone WS sidecar, then Rust spawning the **real** Host (the echo sidecar is still the
  packaged entry; see `PORTING.md` Phase 2).
- ⬜ Embedded-browser product decision (go/no-go from `BROWSER-CDP-SPIKE.md`).
- ⬜ Per-OS build/signing/notarization. CI bundles Linux (AppImage) + Windows (MSI) only; macOS/dmg is
  not in the matrix yet.
- 🟡 P1 harness Layer C (UI smoke) — Layer A transport + Layer B adapter conformance are green.
