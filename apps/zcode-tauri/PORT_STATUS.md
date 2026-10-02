# ZCode Electron → Tauri port

Status document. Written as the port is executed, so it records what is
**verified working**, what is **ported but unwired**, and what has **no Tauri
equivalent** — rather than claiming a complete cutover that does not exist.

## Scope

Source of truth: `packages/desktop/src` (265 files, 61,048 lines).

| Electron unit | Lines | Tauri replacement | State |
|---|---|---|---|
| `main` | 47,628 | `src-tauri/src/{lib,window,tray,events,app_state}.rs` + `commands/` | Shell + OS surface ported |
| `host` | 10,010 | `src-tauri/src/supervisor/host.rs` | Control plane only |
| `preload` | 1,407 | `src/platform/tauriPlatform.ts` | ~27 of ~110 members |
| `scheduler` | 735 | `src-tauri/src/supervisor/scheduler.rs` + `scheduler_store.rs` | Wired to a live SQLite store |
| `renderer` | 1,074 | `src/main.tsx` | Replaced |

**This is a working shell, not a finished port.** The Electron app is untouched
and remains the shipping product; nothing here was cut over.

## Verified working

Evidence: `cargo test` **64/64**, `cargo build` clean, `tsc --noEmit` clean,
`vite build` clean, and the app launched under Xvfb where the renderer completed
IPC round-trips against live Rust state (see "Live proof" below).

- **Window lifecycle** — `ensure_primary_window` reveals before it creates, so a
  second workspace window cannot be spawned. Mirrors
  `primaryWindowCoordinator.ensurePrimaryWindow`.
- **Window registry** — all four Electron Maps are now keyed by one string window
  label. Electron keyed three by `win.id` and one by `win.webContents.id`
  (`main/index.ts:612-616`), which made the lookup contract ambiguous; the label
  removes that class of bug.
- **Command layer** — 15 `#[tauri::command]`s replacing the first tranche of the
  91 `ipcMain` registrations. The caller is derived from an injected
  `WebviewWindow`, never from a payload field, so a renderer cannot address a
  window it does not own.
- **Supervisor with crash recovery** — the Electron scheduler had **no
  supervision**: `spawnCronScheduler` logged one line on exit and kept the dead
  handle, so a single crash disabled all cron and off-peak dispatch until relaunch
  (`main/desktopCronScheduler.ts:195-198`). The Rust supervisor restarts with
  bounded exponential backoff, and distinguishes a clean `Stopped` from a
  `Failed`. Both behaviours are covered by tests.
- **Scheduler semantics** — 20 s poll, single-flight tick, 5 min misfire grace,
  one-shot finalisation, retry exemption, and the stable
  `${automationId}:${scheduledAt}` run id are ported and unit-tested.
- **Path allowlisting** — `read_text_file` rejects anything outside the data base
  dir, including `../` traversal. Electron handed absolute paths to the renderer
  and left validation entirely to downstream consumers.

## Phase 2 (added under five parallel subagents)

Five slices were implemented concurrently, each owning exactly one file, with a
command contract fixed up front so the Rust and TypeScript halves agreed without
coordination:

| Slice | File | What landed |
|---|---|---|
| Native OS commands | `commands/native.rs` (523 lines) | `pick_directory`, `pick_file`, `save_file`, `open_external` (scheme allowlist), `open_in_file_manager`, `show_notification` |
| Window surface | `commands/surface.rs` | `set/get_desktop_zoom` (main-side registry), `set_window_title`, `get/set_window_bounds` (atomic JSON persistence) |
| Tray | `tray.rs` | `build_tray` — icon, Show/Quit menu, left-click reveal, quit path |
| Scheduler store | `scheduler_store.rs` (1580 lines) | `rusqlite` claim/settle with `BEGIN IMMEDIATE`, schema transcribed verbatim from `AUTOMATION_SCHEMA` in `packages/rust/crates/zcode-task-index/src/schema.rs` |
| TS adapter + renderer | `platform/*.ts`, `main.tsx` | Typed wrappers for all 11 commands plus a panel that exercises each one |

Also fixed in this pass:

- **Plugin ACL** — all six plugins (`dialog`, `os`, `opener`, `fs`, `shell`,
  `deep-link`) now resolve in the ACL manifest and are granted in
  `capabilities/default.json`. The earlier failure was `tauri-plugin-dialog` being
  absent from `Cargo.toml`, not a build-system defect.
- **Shutdown drain latch** — `ExitRequested` keyed the drain on `quit_flag`, but an
  explicit quit must set that flag *first* (or `window.rs` swallows the close as
  close-to-tray), so every explicit quit skipped the drain and the supervised
  children never shut down cleanly. Now keyed on a dedicated
  `AppState::take_shutdown_drain()` latch. Electron kept these separate too
  (`explicitQuitRef` `main/index.ts:609-610` vs `hasPreparedAppQuit` `main/index.ts:1077`).
  Found by the tray subagent, not by me.

### Live proof

Run under Xvfb with `ZCODE_DATA_BASE_DIR=/tmp/zcode-tauri-smoke`. The renderer
Activity log recorded, in order:

```
bounds moved to: x=70 y=90 1280×820
window title set to "ZCode"
bounds: x=60 y=90 1280×820 maximized=false
show_notification: dispatched
zoom set to 1.1, read back 1.1
show_notification: dispatched
window "main" announced ready
```

That is a genuine IPC round-trip for `set_window_bounds`, `set_window_title`,
`get_window_bounds`, `show_notification`, `set_desktop_zoom` → `get_desktop_zoom`,
and `notify_renderer_ready`. The window visibly moved from x=60 to x=70 on
screen, which is `set_window_bounds` reaching the OS rather than only the renderer.

`tasks-index.sqlite` plus its `-wal`/`-shm` were created in the data base dir at
runtime, which is the scheduler-store wiring running, not a test fixture.

**Not exercised (needs a user or an external app):** `pick_directory`,
`pick_file`, `save_file` are modal; `open_external` and `open_in_file_manager`
launch other applications. Their logic is unit-tested (scheme allowlist, path
traversal, base64, `{success,error}` wire shape) but the dialogs themselves are
unverified end to end.

## Two Electron defects deliberately not reproduced

1. **`panic = "abort"`** would have made the supervisor unreachable — an aborting
   panic in any task kills the process, so there is no `JoinError` to catch and no
   restart to schedule. Removed from the release profile with a comment.
2. **Mixed window key-spaces** (`win.id` vs `win.webContents.id`) are replaced by a
   single label key.

## Correctness fixes carried into the port

- `HostMessage`/`HostEvent` use `rename_all = "kebab-case"` at the variant level
  and `rename_all_fields = "camelCase"` at the field level, plus
  `deny_unknown_fields`, matching the existing `HostMessageTypes` wire vocabulary
  and the strictness of the zod schemas they replace.

## Not yet ported

Ordered by how much they block a real cutover.

1. **Host RPC data plane.** ~~Electron transferred a `MessageChannelMain` pair to
   carry renderer↔Host RPC. Tauri has no transferable-port primitive.~~
   **Resolved** by reusing the Web client's transport: the renderer connects the
   full `IServiceAccessor` over a WebSocket to `@zcode/server`
   (`connectViaWebSocket`), so no transferable port is needed. See "UI status".
2. **The remaining IPC surface.** ~~The remaining ~94 IPC commands~~ Re-measured 2026-10-01, after
   the Rung 1 work: all 59 written `#[tauri::command]` are now in `generate_handler!` (the missing
   `pub mod editor;` was the reason `editor.rs`/`terminal.rs` had never compiled), and the platform
   adapter grew from 8 to 21 `invoke()` sites. What remains is the ~156 `IPlatformService` members
   that still return web-shaped fallbacks, plus the IPC channels that are not platform members.
   The ordered ladder is `CUTOVER_SPEC.md` §8.
3. ~~**Scheduler cron engine.**~~ **Resolved.** `computeAutomationNextRunAt` is
   now `zcode-cron` (`packages/rust/crates/zcode-cron`), linked as an rlib
   because a Tauri process is not Node and cannot `require()` a `.node` — the
   same reason `zcode-rpc-server` is a plain path dependency. A *recurring*
   automation that misses its fire is now rescheduled with a real timestamp
   instead of being re-claimed as a misfire every 20 s tick. `skip_misfire` is
   still called with `None` when the stored rule cannot be parsed or has no
   future fire, which leaves the schedule untouched rather than writing a
   fabricated timestamp.
   The engine itself is ported with a differential corpus against the
   `croner@10.0.1` output it replaces (530 rows, 4 enumerated divergences), so
   the Tauri host and the Electron host schedule automations through the same
   semantics. See `docs/specs/rust-native-cron.md`.
4. **Embedded browser.** Electron used a `<webview>` driven over CDP
   (`browserGuestManager.ts`, 4,640 lines). Tauri's model is a child
  `WebviewWindow` per tab — a redesign, not a translation.
5. **Auto-update.** The custom YAML manifest provider needs a server-side format
   change (see below) before any Tauri client ships.
6. **Remote/mobile relay, CUA permission broker, telemetry, Chrome credential
   decryption.**

## No native equivalent — decisions required

| Electron capability | Tauri reality | Required approach |
|---|---|---|
| `webPreferences.sandbox` | No sandbox concept | The capability/ACL system is the only boundary. Ship per-surface capability files (`main`, `guest-*`, `coding-plan-*`, overlay) with zero IPC on overlays. |
| `contextBridge` isolation | `initialization_script` runs in the **main world** | The Coding Plan guest's `window.zcodeBridge` becomes page-visible. Every guest command must re-derive and re-check the caller in Rust; never trust a client-supplied origin. |
| `event.senderFrame.url` | Does not exist | Non-forgeable in Electron, renderer-supplied in Tauri. Resolve origin in Rust via `with_webview`, or move the decision server-side. |
| `ipcRenderer.sendSync` | No synchronous IPC | The embedded-browser dialog must become async; the ordering guarantee is genuinely lost. |
| `webContents.id` | No analogue | Becomes a guest **window label**; do not synthesise an integer id. |
| `ipcMain.removeHandler` | Registration is static for process lifetime | Feature flags in `tauri::State<bool>` checked inside the command body. |
| `ArrayBuffer` over IPC | JSON transport turns it into `{}` | `SaveFileRequest.data` must become `number[]` on the TS side and `Vec<u8>` in Rust. **Mandatory in the same commit as the Rust commands.** |
| Chrome cookie decryption (DPAPI/Keychain/App-Bound v20) | No equivalent | FFI or a sidecar binary. |
| `mac.signIgnore`, dual entitlements | Tauri signs recursively; one entitlements file | Re-notarize as one unit, or stop pre-signing nested binaries. |

## Build/packaging breaks that need a server or pipeline change first

- **Update manifest format.** `parseYaml` has no Tauri counterpart;
  `RemoteRelease` deserializes JSON. A server still emitting YAML makes every
  update check fail. The server change must land before any Tauri client.
- **`plugins.updater` has no `headers` key.** The `X-Device-Mid` staged rollout
  only works via `UpdaterBuilder::header(..)` at runtime. Dropping that call
  silently degrades per-device rollout to everyone-in-one-bucket. Make it a
  compile-time-enforced constructor step.
- **Linux deb/rpm cannot self-update** under `tauri-plugin-updater` (AppImage only).
  Route those users to a manual download rather than a silent no-op.
- **`.pacman` target does not exist** in tauri-bundler (Linux targets are exactly
  `appimage`, `deb`, `rpm`). Arch packaging needs an external `makepkg` step.

## Running it

```bash
# one command: builds the Rust crate, starts Vite, launches the app
pnpm dev:tauri
```

`dev:tauri` is **not** a plain `tauri dev` alias — it runs
`scripts/dev-tauri.mjs`, a thin launcher that boots `@zcode/server` (unless one
is already listening) and then runs `tauri dev` in its own process group so one
Ctrl-C tears down the app and Vite together. `tauri dev` itself runs
`build.beforeDevCommand` (`pnpm --filter @zcode/tauri dev:web`) first, so Vite
comes up on :5199 before the binary starts. The target-dir cache makes subsequent
runs fast; the first is a full `cargo build`.

### GPU rendering (WebKitGTK on NVIDIA)

On Linux, Tauri renders through **WebKitGTK**, not Chromium. With the NVIDIA
proprietary driver, WebKitGTK's DMABUF path aborts the GDK display a few hundred
milliseconds after `setup()` returns:

```
INFO zcode_tauri_lib: zcode-tauri ready
Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
```

…and `tauri dev` exits 1. This is not an app bug: upstream, "most of these come
from the WebKitGTK DMABUF renderer requesting buffer formats the NVIDIA driver
does not provide" (see Tauri's own
[Linux graphics troubleshooting](https://v2.tauri.app/develop/debug/linux-graphics/),
upstream tauri#9394).

**The fix that keeps hardware acceleration** is `__NV_DISABLE_EXPLICIT_SYNC=1`.
It disables only NVIDIA's explicit-sync mode, which is what WebKitGTK's DMABUF
path trips, and it is documented upstream as fixing `Error 71` *without a
performance cost* — i.e. the app stays GPU-accelerated. It is set inside the
process, on every launch, by `src-tauri/src/rendering.rs` before the first EGL
display is initialized; it is not an env var a launcher has to remember.
Verified here on Wayland + driver 610.57.04: the live process maps
`libEGL_nvidia`, `libGLX_nvidia`, `libnvidia-glcore` and `libnvidia-gpucomp`,
holds `nvidia0` / `nvidiactl` open, and loads **no** software rasteriser
(`swrast` / `llvmpipe`).

Two earlier hypotheses in this file were wrong and have been removed:

- A missing `/dev/dri/card0` node is **not** a fault. Mesa skips absent nodes and
  NVIDIA's GBM backend is installed correctly at `/usr/lib/gbm/nvidia-drm_gbm.so`.
- `GDK_BACKEND=x11` does stop the crash, but it is **not** hardware-accelerated:
  the process then maps no NVIDIA GL libraries at all.

#### Rendering is fixed in the process, not probed by the launcher

The variable is set in Rust, so there is no tier ladder, no remembered marker,
and no JavaScript retry that relaunches the app under a different renderer. A
rendering environment is fixed where it is read; the dev launcher stays a
descriptor of *how to start the app*, not a component of the graphics path.

`src-tauri/src/rendering.rs` is the single owner of the Linux graphics
environment. It is inert on Mesa-based drivers, and it never clobbers a value
already exported by the operator. Its two escape hatches are explicit and
native — they change what `rendering.rs` sets, and nothing else:

```bash
ZCODE_WEBKIT_SOFTWARE=1 pnpm dev:tauri   # force CPU rendering from the start
ZCODE_WEBKIT_HARDWARE=1 pnpm dev:tauri   # skip the workaround, test the stock path
```

The DMABUF and software variables are **not** shipped unconditionally: they cost
every user a faster path for no benefit on working hardware, so they only appear
behind `ZCODE_WEBKIT_SOFTWARE=1`.

Note that WebKitGTK masks the WebGL renderer string (`WEBGL_debug_renderer_info`
reports `Apple GPU` on every Linux host), so the UI cannot self-detect which
renderer it landed on. Verify from outside with `/proc/<pid>/maps`.

Individual steps, if you need them:

```bash
cargo build --manifest-path apps/zcode-tauri/src-tauri/Cargo.toml
cargo test  --manifest-path apps/zcode-tauri/src-tauri/Cargo.toml
pnpm --filter @zcode/tauri build:web
```

Headless (no display at all):

```bash
xvfb-run -a pnpm dev:tauri
```

`ZCODE_DATA_BASE_DIR` redirects the settings, bounds, and `tasks-index.sqlite`
paths — set it to a temp dir to keep a dev run out of `~/.zcode`.

## UI status — the renderer now mounts the real `<Root>`

`apps/zcode-tauri/src/main.tsx` mounts the real `@zcode/ui` `<Root>` — the same
component the Electron and Web clients mount (sidebar, greeting, prompt box,
projects list). It is no longer a diagnostic panel.

The key realisation: the 165-member `IPlatformService` was never the blocker, and
porting it to Rust was the wrong axis. `<Root>` needs two inputs — an
`IServiceAccessor` (the business-service RPC channel: files, agent streaming,
tasks, automations, MCP, settings, …) and an `IPlatformService` (host-only
operations: native dialogs, window lifecycle, notifications).

The Web client already solved the hard half: it delivers the full
`IServiceAccessor` over a WebSocket to `@zcode/server`, where every business
service already runs in TypeScript. The Tauri renderer now does exactly the same
thing (`connectViaWebSocket("ws://…/ws")`), so the entire data plane is reused
rather than reimplemented. This is the standard Tauri shape: a webview plus a
local service process.

- Services: `connectViaWebSocket` → `@zcode/server` (started by `dev:tauri`,
  Vite proxies `/ws` + `/api` to :3030, mirroring `packages/web`).
- Platform: `createTauriPlatform()` in `src/platform/tauriPlatform.ts` implements
  the whole `IPlatformService` surface — native-capable members
  (`selectDirectory`/`selectFile`/`saveFile`/`openExternal`/`openInFileManager`/
  notifications/window sync/workspace activation/renderer-ready) call the Rust
  commands; the rest use the same web-shaped fallbacks `packages/web` ships, so
  no member is `undefined`. Outside Tauri (plain `vite dev`) native members fall
  back to web behaviour instead of throwing.

Verified: `vite build` bundles the full UI, `tsc --noEmit` is clean (0 errors),
and `@zcode/server` boots and serves `/ws` on :3030 (with `ZCODE_NATIVE_DIR`
pointing at the compiled `packages/rust` binaries, which `dev:tauri` now sets).

Still not wired through the Tauri path (documented, not faked): remote/SSH/WSL
workspaces, MCP native-directory read/write, embedded browser, auto-update, log
export, and editor integrations — all return the web-style unsupported result
for now. The embedded browser and auto-update need the redesigns listed above
before they can be honoured.

> Prerequisite: run `pnpm --filter @zcode/rust build:native` once so
> `@zcode/server` can load its native git/diff binaries.

## Known open issues

- **The Tauri test suite now runs, and 15 of its tests fail.** The 25 compile errors that
  prevented `cargo test` from running at all are fixed — they predated this work (the test target,
  like `editor.rs`, had never been compiled). Status is **195 passed / 15 failed**. The failures are
  newly *visible*, not newly introduced: a WSL column parser that returns the name `"a l p h a"`,
  SSH block matching and `~` expansion, a session-id ordering fault, a URI authority being
  double-encoded, and one genuine spec question about the dedupe window boundary. Full
  categorisation is in `CUTOVER_SPEC.md` §8.7. The "142 tests pass" evidence quoted above predates
  this tree and must not be quoted until the suite is green.

- ~~**Recurring misfire does not advance.**~~ **Fixed** — see "Not yet ported"
  item 3. `scheduler_store::tests::a_missed_recurring_fire_is_rescheduled_rather_than_re_claimed_forever`
  asserts the schedule advances, and it fails if `skip_misfire` is called with
  `None` again, so the pre-port behaviour cannot come back unnoticed.
- **Dock/taskbar badge has no Tauri equivalent.** `sync_window_unread_count`
  stores the count in `AppState` for in-app display; there is no `setBadgeCount`
  API, so no fake one was added. Documented in `commands/surface.rs`.
- **`ChildStatus` reports** are exposed via `Supervisor::list()`/`status()` but no
  command surfaces them to the UI yet.
- **Notification `tag` cannot be honoured.** `tauri-plugin-notification` on
  desktop forwards only title/body/icon/sound and returns no handle, so Electron's
  same-tag replacement behaviour is unavailable. The parameter is kept for wire
  compatibility and flagged `NO_NATIVE_EQUIV` in `commands/native.rs`.
- **Dialogs are unparented.** Electron parented the save dialog to the sender
  window; `set_parent` needs a window handle that is not safe to take from an
  async command context.
- **Tray click-to-show is effectively Windows-only.** Tauri 2.12 emits no tray
  click events on Linux at all — the icon and right-click menu work, `Click` does
  not arrive. Electron never created a macOS tray either (`main/desktopTray.ts:28`).
- **Tray has no "Check for Updates" item** because the crate has no updater plugin;
  Electron only showed it on the production flavor anyway.
