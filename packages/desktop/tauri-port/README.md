# ZCode Electron → Tauri v2 port — document index

Entry point for the parallel-shell port. **Electron remains the shipped product**; every Tauri
artifact here is additive and gated behind `isTauriRuntime()`. Nothing is pushed. Read in this order.

## Status legend
- ✅ done & verified · 🟡 in flight (subagent running) · ⬜ not started

## Core spec
| Doc | Purpose | Status |
| --- | --- | --- |
| `INVENTORY.md` | Phase-0 Electron-surface inventory (main APIs, IPC bridge, process model, webview/native) + risk ratings + top blockers | ✅ |
| `PORTING.md` | Source→target mapping, the `IPlatformService` adapter seam, sidecar strategy, phased plan, semantic traps, **living status checkpoint** | ✅ |
| `BRIDGE.md` | Command contract for the vertical slices (names/args/returns, no-stub rules) | ✅ |
| `PLATFORM-ADAPTER-PLAN.md` | All 104 `IPlatformService` methods → command/event/plugin, phased order, additive runtime-selection design | ✅ |

## Transport & sidecars
| Doc | Purpose | Status |
| --- | --- | --- |
| `SIDECAR-TRANSPORT.md` | Design: run Local Host + Agent as sidecars, MessagePort → localhost WS (reuses existing `@zcode/rpc`) | ✅ |
| `poc/ws-rpc-roundtrip.ts` | **Runtime proof** the WS transport works headlessly (`POC PASS`) | ✅ |
| `SIDECAR-PACKAGING.md` | Runbook: build host/agent as `externalBin` sidecars, shell wiring, orphan-kill, port/secret | ✅ |

## Hard-blocker spikes (feasibility / go-no-go)
| Doc | Blocker | Verdict | Status |
| --- | --- | --- | --- |
| `BROWSER-CDP-SPIKE.md` | #1 embedded browser + CDP | No byte-parity; Windows feasible via WebView2 CDP, macOS/Linux hard → product go/no-go | ✅ |
| `PRINT-PDF-SPIKE.md` | #3 printToPDF | Two-tier: native per-OS print + headless-Chrome sidecar on Linux | ✅ |
| `UPDATER-SPIKE.md` | #2 electron-updater | Use Tauri plugin as install engine only; rebuild feed/skip/force-gate/install-lock app-side. Effort L / risk HIGH | ✅ |
| `WEBVIEW-PROTOCOL-SPIKE.md` | #4 main-world injection, #5 session/Range media | Coding-plan page is first-party → wry init-script bridge; Range→206 Rust protocol; residual = embedded-browser call. MED-HIGH | ✅ |

## Phase 1 (parity gate)
| Doc | Purpose | Status |
| --- | --- | --- |
| `TEST-HARNESS.md` | Language-neutral harness run against BOTH Electron + Tauri (Layer A transport / B adapter conformance / C UI smoke) | 🟡 |

## Code landed (each: cargo test/clippy/fmt + tauriBridge tsc green)
- `src-tauri/` scaffold; `pnpm dev:tauri` loads the Vite renderer (:5174).
- Command slices 1–4: app version, locale, device id, platform info, app name, fallible app-path
  dirs (error seam), window controls. Slice 5 (native dialogs) 🟡.
- `renderer/src/tauriBridge.ts`: typed `invoke` wrappers + `isTauriRuntime()`.

## What is NOT done (binding before any cutover)
- ⬜ P1 harness **code** (design 🟡) — parity is not yet verifiable end-to-end.
- ⬜ Full `tauriPlatform.ts` (104 methods) + the `main.tsx` runtime-selection edit.
- ⬜ Sidecar runtime PoC (echo sidecar → WS round-trip in a real Tauri window).
- ⬜ Embedded-browser product decision (go/no-go from `BROWSER-CDP-SPIKE.md`).
- ⬜ Per-OS build/signing/notarization + CI matrix.
