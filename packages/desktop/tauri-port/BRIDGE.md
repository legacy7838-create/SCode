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

## Slice 18 contract — seam-drift closure + 1:1 contract guard

A static audit (`comm` over the two files) found three Rust commands that shipped WITHOUT a TS
`invoke` wrapper — the renderer could not reach them: `get_window_theme` / `set_window_theme` (slice
12) and `spawn_sidecar_echo` (sidecar PoC). This slice closes that drift and locks the invariant so
it cannot silently recur.

TS bridge (new wrappers): `getWindowTheme(label)` → `invoke<string>("get_window_theme", { label })`;
`setWindowTheme(label, theme)` → `invoke<void>("set_window_theme", { label, theme })` where `theme:
string | null` maps to Rust `Option<String>` (null/omitted ⇒ `None`); `spawnTauriSidecarEcho(port)` →
`invoke<number>("spawn_sidecar_echo", { port })` (returns the OS pid). No Rust change.

Contract guard: `tauri-port/test/layer-a/a5-contract.test.ts` parses BOTH languages and asserts
(a) every `#[tauri::command] fn` name appears in some `invoke("…")` call in `tauriBridge.ts`, (b)
every `invoke("…")` target is a real command, (c) the Rust parse yields ≥40 commands (a
false-green tripwire if the layout breaks), and (d) every invoke arg-object key is camelCase — a
key still containing an underscore (e.g. `default_path:`) is the signature of forgetting the Rust
`snake_case`→JS `camelCase` conversion, a silent runtime bug where the arg never arrives
(PORTING.md Phase-6). Guard (d) scans comment-stripped code, so command-name string literals
(quoted, followed by `,`/`)`) and `/** … */` docs never false-positive. It is headless-safe and
wired into `pnpm test:tauri:layer-a` (glob `*.test.ts`). This is the Phase-1 "tests are the contract"
gate for the invoke seam.

## Slice 19 contract — monitor information (multi-display / HiDPI)

Real `screen.getAllDisplays()`/`getPrimaryDisplay()` parity. `WebviewWindow` exposes three
display queries returning `tauri::Monitor` (confirmed in `tauri-2.12.1/src/webview/webview_window.rs`:
`current_monitor` :1931, `primary_monitor` :1938, `available_monitors` :1948; `Monitor` accessors
`name` :81, `size` :86, `position` :91, `scale_factor` :101 in `src/window/mod.rs`). All three resolve
a live window through the shared `require_window` helper (so they take `label`), and map `Monitor`
through one pure `monitor_to_info` helper for DRY field wiring.

New serialized shape (reuses the existing `WindowSize`/`WindowPosition` structs):

```
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
  pub name: Option<String>,
  pub size: WindowSize,
  pub position: WindowPosition,
  pub scale_factor: f64,
}
```

The `#[serde(rename_all = "camelCase")]` is deliberate: Tauri auto-camelCases command **arguments**
but NOT returned struct fields (serde controls those), so without the rename the JSON key would be
`scale_factor`. Renaming keeps every bridge identifier camelCase, which the A5 guard (d) enforces
bridge-wide — a returned snake_case field would (correctly) fail that guard.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `get_window_current_monitor` | `label` | `Result<Option<MonitorInfo>,String>` | `window.current_monitor()` |
| `get_primary_monitor` | `label` | `Result<Option<MonitorInfo>,String>` | `window.primary_monitor()` |
| `get_available_monitors` | `label` | `Result<Vec<MonitorInfo>,String>` | `window.available_monitors()` |

TS bridge: `TauriMonitor { name: string | null; size: TauriWindowSize; position: {x,y}; scaleFactor:
number }` interface + three wrappers (`getTauriCurrentMonitor`, `getTauriPrimaryMonitor` →
`Promise<TauriMonitor | null>`, `getTauriAvailableMonitors` → `Promise<TauriMonitor[]>`). A live
GUI/OS is required to enumerate real displays, so these are compile-verified (exercised under
`pnpm dev:tauri`); `monitor_to_info` needs a runtime `Monitor`, which a pure test cannot fabricate —
no fake (no-stub rule), but the new wrappers are auto-covered by the A5 name + arg-parity guards.

## Slice 20 contract — sidecar lifecycle (track spawned children + kill)

Closes the orphan-sidecar gap PORTING.md flags ("process lifecycle: sidecars must be explicitly
terminated; `utilityProcess` auto-kills with main but a Tauri sidecar does not"). The PoC
`spawn_sidecar_echo` previously let the `CommandChild` drop, so a launched sidecar could never be
stopped from the shell. This slice stores each spawned child in Tauri managed state and adds a kill
command.

Owned API facts (verified in `tauri-plugin-shell-2.4.1/src/process/mod.rs`): `CommandChild` is
`{ inner: Arc<SharedChild>, stdin_writer: PipeWriter }` → `Send` (so it is `Sync` once wrapped in a
`Mutex`); `kill(self)` **consumes** the child (:78); `pid(&self) -> u32` (:84). `spawn()` returns
`Result<(Receiver, CommandChild), _>`; the `Receiver` stays deliberately dropped for this PoC
stdout-free sidecar.

Managed state + commands (`commands.rs`):
- `#[derive(Default)] pub struct SidecarRegistry(Mutex<HashMap<u32, CommandChild>>)` — keyed by pid;
  `Mutex<HashMap<_, CommandChild>>` is `Send + Sync` (Tauri managed-state requirement).
- `spawn_sidecar_echo(app, port: u16) -> Result<u32,String>` — now locks the registry (`.map_err` on
  a poisoned lock, never `.unwrap()`), inserts the child by pid, returns the pid.
- `kill_sidecar(app, pid: u32) -> Result<(),String>` — removes the child from the registry (missing
  pid ⇒ `Err("no such sidecar")`) and calls `child.kill()` (`.map_err(|e| e.to_string())`).
- `main.rs` adds `.manage(commands::SidecarRegistry::default())` (managed exactly once — a duplicate
  `manage` of the same type panics per `app.rs:1989`).

TS bridge: `killTauriSidecar(pid: number)` → `invoke<void>("kill_sidecar", { pid })`; the existing
`spawnTauriSidecarEcho` wrapper is unchanged. A poisoned-lock `Err` and a missing-pid `Err` both
surface as rejected Promises (the slice-3 error seam). Sidecar child management needs a live process
spawn (a real window + externalBin), so the commands are compile-verified and exercised under
`pnpm dev:tauri`; the a4 Layer-A test already proves the standalone echo child can be killed without
orphaning, which is the same guarantee these commands must hold inside the shell.

## Slice 21 contract — window frame & interaction (decorations, click-through, min/max size)

Completes window geometry constraints and the frameless/overlay controls. All confirmed present and
ungated in `tauri-2.12.1/src/webview/webview_window.rs` (`set_decorations` :2110,
`set_ignore_cursor_events` :2260, `set_min_size` :2364, `set_max_size` :2369). `set_min_size`/
`set_max_size` take `Option<S: Into<Size>>`, so a concrete size is `Some(PhysicalSize<u32>)` and a
clear is `None::<PhysicalSize<u32>>` (the deferred Option semantics from slice 14).

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `set_window_decorations` | `label`, `decorations: bool` | `Result<(),String>` | native title bar/frame on/off (Electron `setFrame`) |
| `set_window_ignore_cursor_events` | `label`, `ignore: bool` | `Result<(),String>` | click-through window (overlays/tooltips) |
| `set_window_min_size` | `label`, `width: u32`, `height: u32` | `Result<(),String>` | `set_min_size(Some(PhysicalSize))` |
| `set_window_max_size` | `label`, `width: u32`, `height: u32` | `Result<(),String>` | `set_max_size(Some(PhysicalSize))` |
| `clear_window_min_size` | `label` | `Result<(),String>` | `set_min_size(None::<PhysicalSize<u32>>)` |
| `clear_window_max_size` | `label` | `Result<(),String>` | `set_max_size(None::<PhysicalSize<u32>>)` |

TS bridge: one typed `invoke` wrapper per command; every Rust arg is single-word (`decorations`,
`ignore`, `width`, `height`, `label`) so the A5 camelCase guard is trivially satisfied. No new
plugin/capability. All require a live GUI window (compile-verified; exercised under `pnpm dev:tauri`;
no fake-window unit test per the no-stub rule).

## Slice 22 contract — window background color

Electron `win.setBackgroundColor` parity. `WebviewWindow::set_background_color(Option<Color>)`
(confirmed `tauri-2.12.1/src/webview/webview_window.rs:2411`) sets the window/webview backdrop, which
matters during load and behind any transparent region. `Color` is the tuple struct
`tauri::webview::Color(pub u8, pub u8, pub u8, pub u8)` = `(r, g, b, a)` (re-exported from
`tauri-utils` config, `webview/mod.rs:35`). Passing `None` restores the default (OS/webview) background
— the clear path.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `set_window_background_color` | `label`, `red: u8`, `green: u8`, `blue: u8`, `alpha: u8` | `Result<(),String>` | `set_background_color(Some(Color(r,g,b,a)))` |
| `clear_window_background_color` | `label` | `Result<(),String>` | `set_background_color(None)` |

The four channel args are separate single-word `u8` params (JS passes numbers 0..=255; Tauri
deserializes each to `u8`), so the A5 camelCase guard is satisfied and no nested color object is
needed. `clear_window_background_color` needs no turbofish: `set_background_color`'s parameter type
`Option<Color>` fixes the `None`'s type. No new plugin/capability. Requires a live GUI window
(compile-verified; exercised under `pnpm dev:tauri`; no fake-window unit test per the no-stub rule).

## Slice 23 contract — window Spaces visibility + cursor grab/visibility

Three confirmed, stable boolean `WebviewWindow` mutators mapping to real Electron capabilities:
`set_visible_on_all_workspaces` (`:2173`, Electron `setVisibleOnAllWorkspaces`), `set_cursor_grab`
(`:2232`, pointer-lock), `set_cursor_visible` (`:2245`, hide/show the system cursor over the window).
All take a single `bool` and return `crate::Result<()>`.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `set_window_visible_on_all_workspaces` | `label`, `visible_on_all_workspaces: bool` | `Result<(),String>` | show across all macOS Spaces |
| `set_window_cursor_grab` | `label`, `grab: bool` | `Result<(),String>` | confine cursor to the window |
| `set_window_cursor_visible` | `label`, `visible: bool` | `Result<(),String>` | show/hide the system cursor |

TS bridge: three typed `invoke` wrappers; the multi-word Rust arg `visible_on_all_workspaces` maps to
the JS key `visibleOnAllWorkspaces` (A5 camelCase guard), `grab`/`visible`/`label` unchanged. No new
plugin/capability. Requires a live GUI window (compile-verified; exercised under `pnpm dev:tauri`;
no fake-window unit test per the no-stub rule).

## Slice 24 contract — application lifecycle (relaunch + exit)

A new capability class beyond window ops, grounded in the real menu command ids
`DesktopCommandIds.RelaunchApp` (`packages/shared/src/platform.ts:477`) and the app-quit need. These
map to Electron `app.relaunch()`+`app.quit()`. Tauri exposes both on the **core `AppHandle`** (no
extra plugin/dependency): `AppHandle::restart(&self) -> !` (`tauri-2.12.1/src/app.rs:606`, diverges —
terminates and relaunches) and `AppHandle::exit(&self, code: i32)` (`:581`, triggers
`RunEvent::ExitRequested`/`Exit`). Because they are called from Rust inside our commands (not the
JS-facing core API), no capability entry is needed — same as every other command in this bridge.

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `relaunch_app` | none (uses `AppHandle`) | `Result<(),String>` | `app.restart()` — the `!` return coerces to `Ok`'s type, so the call never returns |
| `exit_app` | `code: i32` | `Result<(),String>` | `app.exit(code)`; returns `()` then `Ok(())` |

TS bridge: `relaunchTauriApp()` → `invoke<void>("relaunch_app")` (no args); `exitTauriApp(code)` →
`invoke<void>("exit_app", { code })` (`code` single-word, camelCase trivially satisfied). `relaunch_app`
terminates the process (the `invoke` Promise never resolves because the runtime is gone) — the same
behavior Electron's relaunch has; documented, not stubbed. Compile-verified; exercised under
`pnpm dev:tauri`.

## Slice 25 contract — directory picker (`selectDirectory` parity)

Grounded directly in the `IPlatformService.selectDirectory` method (`platform.ts`), the workspace-open
flow. Slice 5 shipped `show_open_dialog` (file picker) but not a **folder** picker. This uses the
already-installed `tauri-plugin-dialog` (no new dependency): `FileDialogBuilder::blocking_pick_folder()
-> Option<FilePath>` and `blocking_pick_folders() -> Option<Vec<FilePath>>`
(`tauri-plugin-dialog-2.8.1/src/lib.rs:738`/`:761`), reusing the existing `file_path_to_string` helper
and the slice-5 async-worker bridging pattern (async command so the blocking native picker never
freezes the event loop).

| Command | Args | Returns | Behavior |
| --- | --- | --- | --- |
| `select_directory` | `multiple: bool` | `Result<Option<Vec<String>>,String>` | folder picker; `None` on cancel; `Vec<String>` of chosen dir paths |

No file-type filters (directory selection has none). Normalized to `Vec<String>` for both single and
multi pick, mirroring `show_open_dialog`. TS bridge: `selectDirectory(multiple = false)` →
`invoke<string[] | null>("select_directory", { multiple })`. No new capability beyond the existing
`dialog:default` already granting the file pickers. Requires a live GUI dialog (compile-verified;
exercised under `pnpm dev:tauri`; no headless dialog unit test — no-stub rule).

## Slice 26 contract — desktop zoom GETTER (supersedes the slice-13 deferral)

Closes the one deviation slice 13 left open: `getDesktopZoomLevel` (`platform.ts:771`, `DesktopZoomState
{ zoomLevel }`) was deferred because **Tauri 2.12.1 has no zoom getter** (`set_zoom` exists, no `zoom()`
reader — confirmed in `webview_window.rs`). The only correct port is to track the last-set zoom in
managed state (the same `Mutex<HashMap>` pattern as the slice-20 `SidecarRegistry`), then convert the
stored factor back to a level through the already-tested `zoom_factor_to_level` helper — which this
slice activates, removing its `#[allow(dead_code)]`.

Managed state + commands (`commands.rs`):
- `#[derive(Default)] pub struct ZoomRegistry(Mutex<HashMap<String /*label*/, f64 /*factor*/>>)` —
  `Send + Sync` (the `Mutex<HashMap<_, f64>>` is).
- `set_desktop_zoom_level(app, label, level)` — now **also records** the applied `factor` under `label`
  after `set_zoom` succeeds (lock poisoning mapped to `Err`, never `.unwrap()`).
- `get_desktop_zoom_level(app, label) -> Result<f64,String>` — resolves the live window via
  [`require_window`] (so an unknown label errors, matching the sibling getters), then reads the
  registry: a recorded factor is converted with `zoom_factor_to_level`; an unrecorded window returns
  `0.0` (== 100%), the documented initial default. This is the platform's best-effort for Electron's
  live read — a genuine implementation, not a stub; the residual (a zoom set outside this shell would
  be invisible) is inherent to Tauri lacking a getter and is noted, not hidden.

TS bridge: `getTauriDesktopZoomLevel(label)` → `invoke<number>("get_desktop_zoom_level", { label })`.
The `get_desktop_zoom_level` name is a real command so the A5 wrapper-exists guard covers it. Requires
a live GUI window (compile-verified; exercised under `pnpm dev:tauri`).
