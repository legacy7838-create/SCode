# Tauri Bridge — Phase 2 vertical-slice contract (v0)

This is the **coordination contract** for the first real (non-stub) Tauri vertical slice.
Rust side (`src-tauri`) and TS side (`renderer/src/tauriBridge.ts`) MUST both implement exactly
this. Keep it small: 3 low-risk, self-contained capabilities that prove the
`invoke()` ⇄ `#[tauri::command]` pattern end-to-end before scaling to the full
`IPlatformService` (104 methods) in later phases.

## Runtime detection

- Tauri exposes `window.__TAURI_INTERNALS__` (and `__TAURI__`). The renderer must NOT assume
  Electron's `window.zcode` exists under Tauri. Selection is additive: Tauri path only when the
  Tauri global is present; otherwise the existing Electron path is untouched.

## Command contract (names are snake_case; all return `String`)

| Command | Arg(s) | Returns | Rust source of truth | TS wrapper |
| --- | --- | --- | --- | --- |
| `get_app_version` | none | app package version, e.g. `"0.0.0"` | `app.package_info().version.to_string()` via `tauri::Manager` / `AppHandle` | `getTauriAppVersion()` |
| `get_system_locale` | none | BCP-47-ish locale, e.g. `"en-US"` | `sys_locale::get_locale()` (crate `sys-locale`), fallback `"en-US"` | `getTauriSystemLocale()` |
| `get_device_id` | none | stable device id string (may be `""` if unavailable) | `std::env::var("ZCODE_DEVICE_ID").unwrap_or_default()` (real env read; full machine-id parity is P2) | `getTauriDeviceId()` |

`shell_kind() -> "tauri"` already exists as the smoke marker.

## Rules (port playbook)

- **No stubs.** Each command returns a real value derived from a real source (package info, OS
  locale, env var). Do not return hardcoded constants except as documented fallbacks.
- **Electron stays intact.** Only add files under `src-tauri/` and one new
  `packages/desktop/src/renderer/src/tauriBridge.ts`. Do NOT modify `desktopPlatform.ts`,
  `main.tsx`, or any Electron main/preload file in this slice.
- **Verifiable.** Rust slice must pass `cargo check` and `cargo test` (add a `#[cfg(test)]` unit
  test for the pure logic behind each command). TS slice must pass `tsc` (the bridge file compiles
  against `@tauri-apps/api`).
- **AGENTS.md Rust rules apply:** no `.unwrap()` in library paths (use `.unwrap_or`/`.unwrap_or_else`
  with a documented fallback), meaningful error handling, `tracing`/`log` over `println!`, doc
  comments on public fns.

## Out of scope for this slice (deferred)

- The full `IPlatformService` adapter, window mgmt, dialogs, binary streams, MessagePort→WS RPC
  transport, embedded browser/CDP, updater, deep links. Those are later phases per PORTING.md.

## Slice 6 contract — shell / open (via `tauri-plugin-opener`) — READY to dispatch when `src-tauri` is free

Real `IPlatformService` capabilities (`openExternal`, `showItemInFolder`, `openPath`). Adds the
`tauri-plugin-opener` crate; commands wrap its Rust API (no `.unwrap()`; `Result<(),String>` via
`.map_err`). Register plugin in `main.rs` + add `opener:default` (or `allow-open-url`/`allow-reveal-item-in-dir`/
`allow-open-path`) to `capabilities/default.json`.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `open_url` | `url: String` | `Result<(),String>` | open in system default browser |
| `reveal_in_folder` | `path: String` | `Result<(),String>` | reveal file in OS file manager |
| `open_path` | `path: String` | `Result<(),String>` | open a file/dir with its default app |

TS bridge: `openExternal(url)`, `showItemInFolder(path)`, `openPath(path)` → `invoke(cmd, {…})`;
reject on Rust `Err`. URL/path validation (scheme allow-list for `open_url`) noted as a P2 hardening
item, not blocking this slice.

## Slice 13 contract — desktop zoom (set) via `WebviewWindow::set_zoom` — grounded in `packages/shared/src/platform.ts`

Real `IPlatformService` capabilities: the menu command ids `ZoomIn`/`ZoomOut`/`ResetZoom`
(`platform.ts:471-473`, `DesktopCommandIds`) and `getDesktopZoomLevel(): Promise<DesktopZoomState>`
(`platform.ts:771`, `DesktopZoomState { zoomLevel: number }` at `:393`). Tauri's window API exposes
`WebviewWindow::set_zoom(scale_factor: f64)` (`tauri-2.12.1/src/webview/webview_window.rs:2688`,
inside a `#[cfg(desktop)]`/`wry` impl — enabled by default on desktop), but has **no zoom getter**.

Chromium (Electron) zoom is *level*-based; Tauri is *factor*-based. Electron documents
`zoomLevel = log(zoomFactor) / log(1.2)`, i.e. `zoomFactor = 1.2^zoomLevel` (level `0` == 100% ==
factor `1.0`). This slice ports that mapping as a pure, unit-tested helper — the PORTING.md Phase-6
"float/unit-conversion" semantic trap — and wires the setter command through it.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `set_desktop_zoom_level` | `label: String`, `level: f64` | `Result<(),String>` | factor = `1.2^level`; `window.set_zoom(factor)` |

Pure helpers (unit-tested, no live window): `zoom_level_to_factor(level) -> f64` and
`zoom_factor_to_level(factor) -> f64` (exact inverse, for the deferred getter).

TS bridge: `setTauriDesktopZoomLevel(label, level)` → `invoke("set_desktop_zoom_level", { label, level })`.

**Getter deviation (documented, not stubbed):** `getDesktopZoomLevel` cannot read the current zoom
from Tauri (no `zoom()` getter in 2.12.1). Electron reads it live; Tauri parity requires the adapter
to track the last-set level in managed state. That belongs to the gated `tauriPlatform` adapter
(Task #45) and is deliberately NOT faked here (no-stub rule). Only the setter path (which
`zoomIn`/`zoomOut`/`resetZoom` all funnel through) ships in this slice.
