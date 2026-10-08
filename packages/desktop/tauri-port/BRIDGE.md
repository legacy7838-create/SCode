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

## Slice 14 contract — window chrome extras (HiDPI scale factor, always-on-top, resizable)

Completes the window-management family (slices 4/9/10/12) with three real, stable
`WebviewWindow` capabilities that the frameless custom-titlebar shell needs. All confirmed present
and ungated for the default desktop build in `tauri-2.12.1/src/webview/webview_window.rs`
(`scale_factor` :1819, `is_always_on_top` :1887 / `set_always_on_top` :2168, `is_resizable` :1873 /
`set_resizable` :2319). Each returns a scalar through the existing fallible seam
(`Result<_, String>` via `.map_err`), resolved through the shared `require_window` helper.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `get_window_scale_factor` | `label` | `Result<f64,String>` | device-pixel-ratio via `scale_factor()` (HiDPI layout) |
| `is_window_always_on_top` | `label` | `Result<bool,String>` | read `is_always_on_top()` |
| `set_window_always_on_top` | `label`, `always_on_top: bool` | `Result<(),String>` | apply `set_always_on_top(..)` |
| `is_window_resizable` | `label` | `Result<bool,String>` | read `is_resizable()` |
| `set_window_resizable` | `label`, `resizable: bool` | `Result<(),String>` | apply `set_resizable(..)` |

TS bridge: one typed `invoke` wrapper per command, mirroring the existing wrappers. No new plugin or
capability entry (these are custom commands called from Rust, not JS-facing core APIs). Min/max-size
setters are deliberately deferred (they take `Option<Size>` with clear semantics — a separate slice).

## Slice 15 contract — window visibility & protection

Continues the window family with five confirmed, stable, scalar `WebviewWindow` mutators that map to
real Electron `BrowserWindow` capabilities (`win.show()`/`win.hide()`, `skipTaskbar`, focusability,
and the anti-screen-capture `setContentProtection` that mirrors `captureWindowScreenshot` in
`packages/shared/src/platform.ts`). All confirmed present and returning `crate::Result<()>` in
`tauri-2.12.1/src/webview/webview_window.rs` (`show` :2334, `hide` :2339, `set_skip_taskbar` :2219,
`set_focusable` :2397, `set_content_protected` :2354). Each resolves the live window through the
shared `require_window` helper and uses the existing `Result<_, String>` `.map_err` seam.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `show_window` | `label` | `Result<(),String>` | `window.show()` |
| `hide_window` | `label` | `Result<(),String>` | `window.hide()` |
| `set_window_skip_taskbar` | `label`, `skip: bool` | `Result<(),String>` | `set_skip_taskbar(skip)` |
| `set_window_focusable` | `label`, `focusable: bool` | `Result<(),String>` | `set_focusable(focusable)` |
| `set_window_content_protected` | `label`, `protected: bool` | `Result<(),String>` | `set_content_protected(protected)` |

TS bridge: one typed `invoke` wrapper per command; Rust snake_case args map to JS camelCase
(`focusable`, `protected`, `skip` are single words; `label` unchanged). `request_user_attention` is
deliberately excluded: its `UserAttentionType` public re-export path is not confirmed in this crate
and the behavior is a platform-specific no-op/error on Linux — it is not stubbed (no-stub rule). All
five require a live GUI window, so they are compile-verified and exercised under `pnpm dev:tauri`.

## Slice 16 contract — window state completion (minimize/inner-position/enabled)

Finishes the window-state family by covering the gaps left by slices 4/9/10. All confirmed present
and `crate::Result`-returning in `tauri-2.12.1/src/webview/webview_window.rs` (`unminimize` :2103,
`is_minimized` :1853, `inner_position` :1824, `is_enabled` :1878 / `set_enabled` :2324). The
`inner_position` command reuses the existing `WindowPosition { x: i32, y: i32 }` struct from slice 9
(both `outer_position` and `inner_position` report a signed physical origin).

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `window_unminimize` | `label` | `Result<(),String>` | `window.unminimize()` (Electron `restore`-from-minimized) |
| `is_window_minimized` | `label` | `Result<bool,String>` | `window.is_minimized()` |
| `get_window_inner_position` | `label` | `Result<WindowPosition,String>` | `window.inner_position()` → `{x,y}` |
| `is_window_enabled` | `label` | `Result<bool,String>` | `window.is_enabled()` (user-interaction enabled) |
| `set_window_enabled` | `label`, `enabled: bool` | `Result<(),String>` | `window.set_enabled(enabled)` |

TS bridge: one typed `invoke` wrapper per command; `get_window_inner_position` returns the same
`{ x, y }` object shape as the slice-9 `get_window_position`. No new plugin/capability. `inner_size`
is NOT re-added (slice 9 already exposes `get_window_size`). All require a live GUI window
(compile-verified; exercised under `pnpm dev:tauri`; no fake-window unit test per the no-stub rule).

## Slice 17 contract — frame geometry & global cursor

Two genuinely-uncovered reads. `get_window_outer_size` (frame-inclusive dimensions — Electron
`win.getBounds()` includes the window frame, whereas slice-9 `get_window_size` reports the client
area) reuses the existing `WindowSize { width: u32, height: u32 }` struct, mapping
`WebviewWindow::outer_size` (`:1843`, `crate::Result<PhysicalSize<u32>>`). `get_cursor_position`
exposes the OS-wide mouse location for drag/overlay geometry, mapping `WebviewWindow::cursor_position`
(`:2025`, `crate::Result<PhysicalPosition<f64>>`) through a new `CursorPosition { x: f64, y: f64 }`
(f64, not i32, because a global cursor is a sub-pixel float and may be negative off the primary
monitor).

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `get_window_outer_size` | `label` | `Result<WindowSize,String>` | `window.outer_size()` → `{ width, height }` |
| `get_cursor_position` | `label` | `Result<CursorPosition,String>` | `window.cursor_position()` → `{ x, y }` (f64, global) |

`get_cursor_position` takes `label` to reach the window's cursor API (Tauri exposes `cursor_position`
on the window; it returns the desktop-wide cursor, per the crate doc at `:2018`). TS bridge: two typed
`invoke` wrappers, `get_window_outer_size` mirroring the slice-9 `get_window_size` object shape. No
new plugin/capability. Both require a live GUI window (compile-verified; exercised under
`pnpm dev:tauri`; no fake-window unit test per the no-stub rule).
