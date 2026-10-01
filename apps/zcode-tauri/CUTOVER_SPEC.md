# Spec: Electron → Tauri cutover (complete)

Status: active. Owner: main session. Written before implementation, per `AGENTS.md:3`.

Continues `apps/zcode-tauri/PORT_STATUS.md`, which owns the running-state record of what works
today. This spec owns the **cutover**: the delta between "Tauri is a working shell" and "Tauri is
the product". `PORT_STATUS.md` says the shell is not cut over; this document is the plan that
makes that sentence false.

## 0. Naming reconciliation

`PORT_STATUS.md` uses "Not yet ported" for the backlog. This spec splits that backlog into
**work** (port it) and **impossible** (Tauri has no equivalent — decide and document, do not
fake). The existing "No native equivalent — decisions required" table in `PORT_STATUS.md` is
adopted verbatim and is binding; nothing in it is re-litigated here.

## 1. Measured gap — 2026-10-01 (re-measured same day, after Wave A slices landed)

| Measure | Electron | Tauri today | Delta |
| --- | --- | --- | --- |
| `ipcMain` registrations | 91 | 59 `#[tauri::command]` written, **59 in `generate_handler!`** | ~32 channels |
| Of those, reachable from the platform adapter | — | **21 `invoke()` sites** (was 8) | §8.1 |
| `PlatformChannels` referenced | 120 | — | — |
| `IPlatformService` members | 165 | **9 with real Rust backing** | **~156** |
| `src-tauri` Rust | — | 10,006 lines / 25 files | — |

Two numbers matter here, and the second is the one that decides the next step.

The **59 written vs 8 wired** split was the critical finding, and it is now closed.
`editor.rs` (4), `terminal.rs` (6) and `session.rs` (12) had been written and unit-tested while
`mod.rs` never declared `editor` and `generate_handler!` never listed them — so the module had
**never been compiled** and the renderer could not reach a single one. Registering them surfaced
14 compile errors in code that had been assumed working; §8.1 records what they were.

The **9** was not an estimate: `apps/zcode-tauri/src/platform/tauriPlatform.ts` was 573 lines and
contained 8 distinct `invoke()` call sites (`get/set_desktop_zoom`, `open_external`, `save_file`,
`show_notification`, `notify_renderer_ready`, `sync_active_task_session`, `sync_window_tabs`,
`sync_window_unread_count`).

So the real gap is **not** "write more Rust" — a third of the surface is already written. The gap is
that written Rust is not reachable, and the platform adapter still returns web fallbacks. §8 sequences
fixing exactly that, then finishing the remainder.

`PORT_STATUS.md:312-318` states `createTauriPlatform()` "implements the whole `IPlatformService`
surface … the rest use the same web-shaped fallbacks `packages/web` ships, so no member is
`undefined`". That is accurate and is the problem: **156 of 165 members return a web result
rather than doing the host operation.** A member that is typed but unimplemented is a lie the
type system cannot catch. This spec replaces web fallbacks with real commands, or with an
explicit, enumerable refusal where Tauri genuinely cannot do it.

## 2. The contract every command must satisfy

1. **No silent fallback.** A host operation either reaches Rust or returns a typed
   `NO_NATIVE_EQUIV`/`UNSUPPORTED` that the UI can render. It does not quietly take the web
   path. This is the same rule as `rust-native-ports.md` invariant 1, applied to the shell.
2. **Caller is derived, never payload-supplied.** `PORT_STATUS.md:36-38` already fixed this for
   15 commands; every new command keeps it. The caller comes from the injected `WebviewWindow`.
   Tauri has no `event.senderFrame.url` (see the no-equivalent table), so origin-derived
   decisions must be re-derived in Rust or moved server-side — never trusted from the payload.
3. **`deny_unknown_fields` + kebab-case variants + camelCase fields**, matching the existing
   `HostMessage` discipline (`PORT_STATUS.md:117-122`), so the wire vocabulary does not fork.
4. **Async where the Electron original was async.** A sync Rust command on a large payload blocks
   the UI thread; the Electron `ipcRenderer.sendSync` path it replaces was genuinely sync
   (`PORT_STATUS.md:162` notes the loss) and must not be reintroduced as a new sync call.
5. **One file per slice.** Each porting agent owns exactly one Rust file plus its `tsv`/adapter
   wiring, so four agents can run concurrently without arbitration.
6. **Every command has a Rust test.** The existing 142 `cargo test` cases in `src-tauri` are the
   bar. A command whose logic is only reachable through a live dialog ships with unit tests for
   its validation and fails loudly otherwise.

## 3. Wave A — the platform surface (the ~156 members)

Dependency-free of the redesigns in wave B, and the bulk of the gap. Split by file ownership.

| Slice | Rust files owned | Surface |
| --- | --- | --- |
| A1 | `commands/window.rs`, `commands/app.rs`, `src/window.rs` | Window lifecycle, bounds/zoom/fullscreen/always-on-top, workspace activation, tab sync, devtools, relaunch/quit, window registry |
| A2 | `commands/fs.rs`, **new** `commands/editor.rs` | Reveal-in-file-manager, open-in-editor and editor integrations, path resolution, shell reveal, download/save-dialog completion |
| A3 | **new** `commands/terminal.rs` | Terminal surface: spawn, write, resize, kill, list |
| A4 | **new** `commands/session.rs` | Renderer-ready / session handshake, active-task sync, unread counts, notification routing |

A3 is also the security port. The 2026-09-30 analysis found the Electron terminal service has no
permission service, no confirmation and no sandbox in `create()`, and that
`ITerminalService.write()` pipes straight to the pty. Porting the spawn is the point at which
confinement can live in Rust, behind the same required-roots pattern `zcode-fs` now uses.

## 4. Wave B — the three redesigns

Each needs a decision before code, not just a port.

1. **Embedded browser.** Electron used a `<webview>` driven over CDP
   (`browserGuestManager.ts`, 4,640 lines). Tauri has no `<webview>`; the model is a child
   `WebviewWindow` per tab. `PORT_STATUS.md:149` is right that this is a redesign, not a
   translation. Deliverable: a per-tab window model in Rust with the CDP-driven pieces
   (`Input`, `Runtime`, `Page`) re-expressed as Tauri webview APIs, and an explicit list of the
   CDP capabilities that have **no** equivalent.
2. **Auto-update.** Blocked on a server change, per `PORT_STATUS.md:171-181`: the custom YAML
   manifest has no `RemoteRelease` counterpart, `plugins.updater` has no `headers` key so the
   `X-Device-Mid` staged rollout silently degrades, Linux deb/rpm cannot self-update, and
   `.pacman` does not exist in tauri-bundler. Deliverable: a JSON manifest format on the server
   plus the client, and a compile-time-enforced `UpdaterBuilder::header(..)`.
3. **Relay / CUA / telemetry / Chrome credential decryption.** `zcode-chrome-cookies` already
   exists as an napi crate for the Node path; Tauri needs the same capability as a Rust path or
   an explicit refusal. CUA permission decisions must re-derive the caller (contract 2).

## 5. Ownership

Per `rust-native-ports.md` §Ownership, one agent owns its Rust file(s) and the adapter wiring for
the same slice. **The main session owns** `apps/zcode-tauri/src-tauri/Cargo.toml`,
`src-tauri/src/lib.rs` (the command registry and `generate_handler!` list),
`capabilities/*.json`, `tauri.conf.json`, `PORT_STATUS.md`, and any change to
`packages/shared/src/platform.ts`. A slice that needs a registry or capability change requests
it; it does not edit those files. This is the single rule that keeps four agents from racing on
`lib.rs`.

## 6. Acceptance — cutover

- `IPlatformService` has **165 members with real Rust backing**, or an enumerated
  `NO_NATIVE_EQUIV` list signed off here. No web fallback remains on a host operation.
- `cargo test --manifest-path apps/zcode-tauri/src-tauri/Cargo.toml` passes, with a test per new
  command.
- `pnpm --filter @zcode/tauri typecheck` and `build:web` clean.
- A live Xvfb run (`xvfb-run -a pnpm dev:tauri`) showing renderer IPC round-trips against live
  Rust state, matching the evidence style `PORT_STATUS.md:80-101` already uses.
- `PORT_STATUS.md` updated to state that the cutover happened, with the date and the evidence.

## 7. Risks

- **R1 — The 165-member number is the real blocker, and it is boring.** The interesting work
  (browser, updater) is 3 redesigns; the 156 platform members are what actually makes the shell a
  product. Underestimating this is how a port stalls at 80%.
- **R2 — Tauri has no transferable-port primitive.** `PORT_STATUS.md:128-132` resolved the data
  plane by reusing the WebSocket transport. That means the "host" is a separate process, so
  host-only operations genuinely cannot be reached the same way — every A-slice command is
  answering over Tauri IPC while business services answer over RPC. Keep the two channels
  visibly distinct; do not merge them.
- **R3 — `initialization_script` runs in the main world** (`PORT_STATUS.md:160`). The Coding Plan
  guest's `window.zcodeBridge` becomes page-visible, so every guest command must re-check the
  caller in Rust. This is a live exposure, not a porting detail.
- **R4 — Cross-compilation still does not exist** (`rust-native-program.md` R3). Tauri ships six
  targets and the Rust stack builds for the host only. A "complete" Tauri port that cannot be
  cross-compiled is not shippable, so this blocks the cutover regardless of command coverage.

---

## 8. The Electron removal ladder

Written after the Wave A slices landed. §1's re-measurement is the reason this section exists:
**the remaining work is not "port more surfaces", it is "make the already-written Rust reachable,
then finish what was never started, then delete Electron".** Each rung below is independently
shippable and leaves the Electron app working until the last one.

Scope: `packages/ui` and `apps/zcode-cli` are **out** (`rust-native-program.md` §1.1/§9.4). Nothing
below touches them.

### 8.0 Owners and event ordering

The single most important thing to not break while removing Electron is that there are **two
independent channels** and they answer different questions. This is R2 restated as a diagram.

```
┌──────────────────────────────── renderer (packages/ui — STAYS TypeScript) ────────────────────────────────┐
│  <Root>                                                                                                   │
│    ├── IServiceAccessor  ──── business services ──────────────────────────┐                                 │
│    └── IPlatformService ─ host-only operations ────────────────┐           │                                 │
└────────────────────────────────────────────────────────────────┼───────────┼─────────────────────────────────┘
                                                                 │           │
        CHANNEL 2: Tauri IPC (Rust host, in-process)              │           │  CHANNEL 1: WebSocket
        blocking, dialogs, window, terminal, pty, fs, badges     │           │  streaming, agent, tasks,
                                                                 ▼           ▼  MCP, settings, sessions
┌──────────────────────────────── Tauri main (Rust) ───────────────────────────┐  ┌─── @zcode/server (Node) ───┐
│  commands::*  (59 written / 35 registered / 8 wired)                        │  │  packages/services (97k)  │
│  supervisor + scheduler_store (rusqlite)                                    │◀─┤  files, agent streaming,  │
│  zcode-cron · zcode-mcp-config · zcode-url-guard · zcode-fs (rlib path)     │  │  tools, OAuth, bots      │
│  zcode-rpc-server ◀── the long-term replacement for CHANNEL 1               │  └────────────────────────────┘
└────────────────────────────────────────────────────────────────────────────┘
```

Reading the diagram:

- **Electron owns CHANNEL 2 only** (`ipcMain`, 91 registrations). Removing Electron = replacing
  CHANNEL 2. Nothing in `packages/ui` changes, because `IPlatformService` is a frozen interface.
- **CHANNEL 1 is not Electron's** — it is `@zcode/server` over WebSocket. It survives the Electron
  removal untouched. So *removing Electron does not require porting `packages/services` to Rust.*
  Those two projects are independent; do not let this ladder absorb `rust-native-program.md`'s
  Waves 4–6.
- **`zcode-rpc-server` is the optional second phase.** It exists to retire the Node server service
  by service. That is a *Node removal*, not an *Electron removal*, and it is explicitly out of this
  ladder's scope. It is listed in §8.4 as a non-goal so it cannot be mistaken for a blocker.
- **Ordering constraint:** a command must be registered (§8.1) *before* it is wired (§8.2), and
  wired before it can replace a web fallback (§8.3). A command that is written but unregistered is
  invisible to every test that does not call it directly in Rust.

### 8.0.1 Deletion precondition — measured, and it is close

`packages/desktop` was measured for deletability rather than assumed. The result decides whether the
last rung is a refactor or a delete:

| Question | Finding |
| --- | --- |
| Does anything outside it `import "electron"`? | **No.** Electron is fully contained. |
| Does any package depend on `@zcode/desktop`? | **No.** Only its own `package.json` names it. |
| Does any source file import `@zcode/desktop`? | **No.** Zero call sites. |
| Does anything drive it under Playwright/Electron? | **No.** No `_electron` launch anywhere. |
| Is there a Tauri dev path to replace `dev:desktop`? | **Yes** — `pnpm dev:tauri` → `scripts/dev-tauri.mjs`. |

So the package is **self-contained**, and the final rung is a *delete*, not a migration: 261 files and
60,075 lines that nothing reaches. The coupling that must be untied is **configuration only**:

- `package.json` — `dev:desktop`, `dev:desktop:test`, `dev:desktop:prod`, `dev:desktop:bytecode`,
  `dev:desktop:remote-prod`, `bundle:desktop`, `prepare:desktop-runtime`, `prepare:remote-assets`,
  `build:desktop-agent:bytecode`, and two shared lines (`build:bootstrap`'s `--filter "!@zcode/desktop"`,
  `typecheck`'s trailing `packages/desktop/tsconfig.host.json`)
- `architecture-policy.yaml` — the `roots: [packages/desktop/src]` entry
- `scripts/` — `dev-desktop-env.mjs`, `dev-desktop-remote-prod.mjs`, `build-desktop-agent-bytecode.mjs`
- `pnpm-lock.yaml` — the `packages/desktop` importer

**What still gates the delete.** Configuration is the *only* blocker found, which means the real
prerequisites are the two unstarted redesigns above, not any leftover wiring: the embedded browser
(§3 A2) has no Tauri equivalent, and auto-update depends on an endpoint **outside this repository**
(`/api/v1/releases/electron/manifest`, YAML, with an `electron-updater` `Provider` subclass in
`manifestUpdateProvider.ts`). Tauri wants JSON. That cannot be fixed from inside this tree — it is an
external release-server change.

**Then the decision was taken: self-update is dropped, not ported.** The Tauri app ships no updater
plugin and `tauri.conf.json` declares no updater, so there is no format problem left to solve — the
feature ends with `packages/desktop`. This retires the item as a *port* and turns it into a *deletion*,
which is a smaller and verifiable job. Recorded here so it is not re-litigated as a blocker.

**Do not confuse it with `packages/shared/src/forceUpdate.ts`.** Despite the name, that is not
auto-update: it resolves a **minimum version required to keep a BigModel coding-plan subscription**,
consumed by `bigmodelCodingPlanSubscriptionProvider`. It is a subscription-entitlement rule that
applies to paying customers, it has no Electron dependency, and removing it would change what paid
users are allowed to do. It is **out of scope for the Electron cutover** and needs a product decision
of its own.

### 8.1 Rung 1 — register the unwired commands (PARTIALLY WRONG PREMISE)

One `generate_handler!` edit plus one `capabilities/*.json` audit per command. No new logic.

- [x] Register all 22 from `editor.rs`, `terminal.rs`, `session.rs`, plus `reveal_in_file_manager`,
      `save_download_file`, `get_desktop_session_activity`, `get_unread_badge_total`,
      `list_ssh_config_aliases`, `list_wsl_distros` in `generate_handler!`. All 59 are now
      registered; no ACL change was needed, which the 35 already-registered commands proved.
- [x] **Declare `pub mod editor;`** in `commands/mod.rs`. `editor.rs` and `terminal.rs` were not
      declared, so they had never been compiled — the "ported" state was untested code.
- [x] `cargo test` **BLOCKED, pre-existing** — see §8.7.
- [x] `cargo build` clean, `tsc --noEmit` clean, `oxlint` 0/0, `pnpm typecheck` 0 errors,
      `pnpm lint` 0 errors, `architecture:check --changed` 0 violations, `vite build` clean.

**Correction, recorded because the original rung was wrong.** This rung was written as "wire the
~35 commands that are registered but not invoked". Measured on 2026-10-01 after the registration
landed, **30 commands have no caller at all** — not in `src/platform/`, not anywhere in `packages/`
or `apps/`, and for 12 of them not even a Rust-internal caller:

| Group | Count | Why there is no consumer |
| --- | --- | --- |
| URL guards (`decide_navigation`, `decide_external_open`, `is_*_webview`, `is_payment_callback`) | 5 | Their consumer is the embedded browser's navigation handlers, which do not exist yet (§4 R-B1). Correctly unwired, not missed. |
| Terminal (`terminal_create/write/resize/kill/kill_all/list`) | 6 | **`IPlatformService` has no terminal member at all.** Terminal is an `IServiceAccessor` business service, not a platform member, so these commands have no interface to land on. This is a design decision, not wiring. |
| Window / app / surface (`get_window_state`, `get/set_window_bounds`, `set_window_title`, `list_windows`, `focus_tab`, `get_app_info`, `request_quit`, `get_quit_kind`, `describe_runtime`, `get_rpc_endpoint`) | 11 | **Zero callers.** See below. |
| File (`read_text_file`, `resolve_host_path`) | 2 | Zero TS consumers. |
| Session (`get_renderer_session`, `bind_remote_workspace_session_context`, `get_unread_badge_total`) | 3 | Zero TS consumers. |
| `show_notification` | 1 | **Orphaned by this rung.** `showTaskNotification` was rewired to `show_task_notification` (which owns the 3 s dedupe window), leaving this registered with no caller. |

**The architectural cause.** Electron's renderer called **91 `ipcMain` channels through the raw
`PlatformChannels` string map** — a channel name and a `JSON`-ish payload, with no typed member
required. `IPlatformService` is narrower than that map: it has no member for `get_window_state`,
`set_window_bounds`, `list_windows`, `get_app_info` and the rest. Tauri has no equivalent raw
channel map, so those calls have nowhere to land. The commands were written because the Electron
channels existed; the *callers* were never ported because there was nothing to port them onto.

**So the remaining work is not "wire 30 commands".** It is a per-command decision:

1. **Add the missing `IPlatformService` member** — only where a real consumer exists in
   `packages/ui`. `IPlatformService` is a frozen contract, so widening it is not free.
2. **Make it Rust-internal** where the caller is a native-side listener (a tray item, a deep-link
   handler) and no renderer round trip is wanted — `show_current_window` already works this way and
   has one Rust caller.
3. **Delete it** where nothing needs it. `show_notification` is the clear case: it is superseded,
   and leaving a registered-but-uncalled command is exactly the dead surface this programme is
   supposed to remove. Counting registered-but-uncalled commands in `native:inventory` would have
   caught this earlier — it currently reports only crates, not commands.

**One more orphan closed: the renderer session handshake is now live.** `main.tsx:bootstrap()`
connected the service channel directly, so `begin_renderer_session` and `detach_renderer_session`
were registered but had **no caller at all** — the entire session-identity story was inert, which is
the failure the handshake exists to prevent ("session identity is volatile"). `bootstrap()` now
attaches first and refuses to render if the attachment fails, rather than connecting a renderer with
no identity.

`get_renderer_session` is intentionally still uncalled: Rust owns the identity and `session.ts`
caches what it read. A second reader would be a second source of truth, not a wiring fix.

**Two more dead commands removed (`read_text_file`, `resolve_host_path`).** Same rule as
`show_notification`: registered, tested, and called by nobody — not from TypeScript, not from Rust.
`AllowedRoots` and its confinement tests were **kept**, because `reveal_in_file_manager` and
`open_in_editor` share that primitive and it is the security boundary this port exists to add.

**Three more removed in a second pass — `open_in_file_manager`, `get_unread_badge_total`, and the
helpers/tests that died with them.** `open_in_file_manager` became orphaned by this rung itself: once
`openInFileManager` moved to the confined `reveal_in_file_manager`, nothing called the unconfined one
anymore — keeping it would have left the *less* safe of two near-identical commands reachable.
`get_unread_badge_total` had no UI consumer (`syncWindowUnreadCount` is the real path), and its
`BadgeStateWire.badge_supported` was hard-coded `false` because Tauri v2 exposes no badge API, so it
could only ever answer "no".

Deleting a command orphans whatever only it called, so the second pass took the follow-on removals
too: `empty_open_path_result`, `reveal_or_open`, `badge_state_for`, and the three tests that covered
only the removed commands. Rust warnings went 9 → 5 (the remainder predate this work). Test count is
189 rather than 192 for the same reason — the coverage went with the dead code, not with anything
live.

Command count: **59 → 45.**

**The tooling gap that let those five accumulate is now closed.** `native:inventory` classified
crates, so a crate whose *commands* were all uncalled still reported `live`. `zcode-packaging` now also
parses `generate_handler!` and reports every registered command that no renderer file names:

```
[zcode-packaging] note: 15 registered Tauri command(s) that no renderer file invokes: …
```

The match is name-based on both sides because that is the same relation the runtime uses — the
renderer can only reach a command by passing its exact name to `invoke`. It over-collects (any
quoted string counts, comments included), so the failure mode is a false *positive*, never a false
negative. That direction is deliberate: this check exists to surface dead surface, and hiding a real
dead command behind a coincidental string is the failure that would let the problem recur. It reports
rather than blocks for the same reason.

Verified against a manual count: the tool names 15, including `get_renderer_session`, which is
deliberately uncalled because Rust owns the identity and `session.ts` caches it.

**One stub is now a stated refusal.** `getPathForFile` returned a bare `null`. Electron implemented
it with `webUtils.getPathForFile` (`preload/index.ts:299-304`), which is a preload-only API with no
Tauri v2 equivalent, so `null` is the *correct* answer — but a silent `null` reads as "the file had no
path" and sends the caller down the web/inline attachment path for a reason that is not the user's.
It now carries the reason.

**The terminal commands are not an unwired surface — they are a second layer.** `terminal_*` spawn a
PTY **in Rust** (CUTOVER_SPEC §3 A3, the security port that confines `create`), while `ITerminalService`
is the Node-side business service over RPC. They answer different questions and must not be
collapsed into `IPlatformService`, which has no terminal member and should not grow one.

**One containment fix landed while measuring this.** `openInFileManager` was calling
`open_in_file_manager`, which takes the caller's path verbatim. It now calls
`reveal_in_file_manager`, which resolves the path against `AllowedRoots` first — the same
confinement `zcode-fs` enforces. A renderer-supplied path must not bypass the allowlist.

**Nine orphan commands deleted.** Nine had a caller on neither side — not in `src/platform/`, not
in `packages/` or `apps/`, not even in Rust — and most had **zero references in Electron either**,
so they were dead code that the port carried across rather than code anyone was waiting for:

| Deleted | File | Why it was dead |
| --- | --- | --- |
| `show_notification` | `commands/native.rs` | **Orphaned by this rung**: `show_task_notification` superseded it, since that one owns the dedupe window and the tag bookkeeping. A registered-but-uncalled command is an alternative path to the same notification, which is the dead surface this programme removes. Its helper `trimmed_notification_text` and its test went with it. |
| `get_app_info`, `describe_runtime`, `get_quit_kind` | `commands/app.rs` | No renderer member, no Electron reference, no Rust caller. |
| `list_windows`, `focus_tab` | `commands/window.rs` | `FocusTab` in Electron was a main→renderer **push** (`webContents.send`), which `onFocusTab` already covers through `zc-focus-tab`; the command half was never a request path. |
| `get_window_bounds`, `set_window_bounds`, `set_window_title` | `commands/surface.rs` | Persistence was already exercised; nothing reads the bounds back. `read_live_bounds` went with them. |
| `get_rpc_endpoint` | `commands/rpc.rs` | The renderer gets its endpoint through the service channel, not a command. |

`request_quit` and `get_window_state` were **kept**: they have Rust-side callers even though no
renderer member exists, so they are the "make it Rust-internal" case rather than the delete case.

**Registering all 59 was itself the error.** The right end state was fewer commands, not more wired
ones — and the reason nobody noticed is that `native:inventory` counts crates, never commands.

**The 14 compile errors this surfaced** were all in `ssh_config.rs`, and they are the argument for
never treating "written" as "working":

1. `SshConfigAliasOption` had lost its `#[derive(…Serialize, Deserialize)]` — two stray `use`
   lines sat where the derive had been. It could not be deserialized at all.
2. `ALIAS_CACHE.lock()` was written in `parking_lot` style against a `std::sync::Mutex`, so the
   cache read and write did not typecheck. Fixed with an explicit poisoning recovery rather than a
   blanket `unwrap`, because a poisoned cache must not permanently break alias listing.
3. `Path::starts_with(['/', '\\'])` matched *components*, not characters — the `~` home-expansion
   branch could never match. Fixed by testing the string form.

**Rung 1 also replaced the fabricated answers.** Zero JS fallback is only meaningful if the
replaced values were wrong, so the members that returned a plausible lie are the ones that changed:

| Member | Was | Now |
| --- | --- | --- |
| `getDesktopSessionActivity` | `{ runningAgentSessionCount: 0 }` | Rust's typed `NO_NATIVE_EQUIV` refusal |
| `listWSLDistros` / `listSSHConfigAliases` | `[]` | real host reads |
| `connectRemote` | a refusal string invented in TypeScript | Rust's `NoNativeEquiv` outcome, switched exhaustively |
| `getInstalledEditors` / `openInEditor` | `[]` / "not wired yet" | real commands |
| `showTaskNotification` | raw `show_notification`, bypassing dedupe | `show_task_notification` (owns the 3 s window) |
| `getDesktopZoomLevel` | `{ zoomLevel: 0 }` | the Rust registry's value |
| `saveFile` (download) | fetch + base64 in TypeScript | `save_download_file` (validates before the dialog) |
| 4 menu/notification subscriptions | `() => () => {}` | subscribed to events Rust already emits |
| `exportLogs` / `captureWindowScreenshot` | "Not wired…yet" / `null` | explicit `NO_NATIVE_EQUIV` reasons |

**One dead-code defect fixed en route.** `watchRendererTeardown` was defined in
`tauriPlatform.ts` and never called, so `detach_renderer_session` had no caller and the teardown leg
of the session handshake could not fire. `beginRendererSession` had no caller either — the whole
handshake was inert. Both now live in `src/platform/session.ts`, which is also what keeps
`tauriPlatform.ts` under the 400-line rule after the wiring (576 → 582 lines split across four
modules with `window.ts` owning the OS-window surface).

### 8.2 Rung 2 — wire the platform adapter to real Rust (the ~156 members)

This is the actual bulk of the work and R1's "boring" cost. `tauriPlatform.ts` grows from 8 to the
full surface, and **every web fallback on a host operation is deleted, not kept behind a flag**
(contract 1, invariant 1).

- [ ] Group by `IPlatformService` member; for each: implement the `invoke()` call, or record an
      explicit `NO_NATIVE_EQUIV` from the `PORT_STATUS.md` no-equivalent table.
- [ ] The no-equivalent table members (sandbox model, `contextBridge` isolation,
      `event.senderFrame.url`, `ipcRenderer.sendSync`, `webContents.id`, `removeHandler`,
      `setBadgeCount`, window screenshot, Chrome cookie decryption) get an enumerated refusal —
      **not** a silent web result.
- [ ] Typecheck + `build:web` clean; no member left returning a web-shaped result on a host op.

### 8.3 Rung 3 — the 91 IPC channels that are not platform members

`desktopMainIpcPlatform.ts` (36), `desktopMainIpcRemote.ts` (20), `desktopBrowserViewIpc.ts` (9),
`resourceManagerStorage.ts` (5), `desktopCuaPermissionIpc.ts` (5), `autoUpdater.ts` (5) and the
seven single-registration files. These are not `IPlatformService` members; each needs either a
command or a decision.

- [ ] `resourceManagerStorage` (5) — port with `zcode-fs`.
- [ ] `desktopCuaPermissionIpc` (5) — port; re-derive the caller in Rust (R3).
- [ ] `desktopMainIpcRemote` (20) + remote session commands — port the relay; owner/lease and
      stale-run protection must survive the port unchanged.
- [ ] `export-logs` — port `zcode-logredact` (`rust-native-observability-classification.md`);
      without it a user cannot get logs out of a Tauri build at all.
- [ ] The rest — enumerate and decide each.

### 8.4 Rung 4 — the two redesigns that need a decision, not a translation

Neither can be started as a port; both need the decision recorded first.

- [ ] **Embedded browser** (Wave B1) — `browserGuestManager.ts` is 4,640 lines driven over CDP.
      Tauri has no `<webview>`. Deliverable is a per-tab `WebviewWindow` model plus an explicit
      list of CDP capabilities with no equivalent.
- [ ] **Auto-update** (Wave B2) — blocked on a server-side manifest format change (YAML has no
      `RemoteRelease` counterpart), the `X-Device-Mid` header regression, Linux deb/rpm
      self-update, and the non-existent `.pacman` target. The server change lands first.

### 8.5 Rung 5 — delete Electron

The last rung, and the only one that changes the product:

- [ ] `pnpm dev:tauri` is the primary desktop loop; `packages/desktop` (Electron) is no longer
      built or shipped by any release path.
- [ ] Cross-build for all six release targets exists (R4). **This is the hard gate** — until it
      does, "Electron removed" is not shippable even at 100% command coverage.
- [ ] `PORT_STATUS.md` and this spec updated to record the removal with evidence.

### 8.6 What this ladder does NOT include

- **`packages/ui`** — stays TypeScript. `IPlatformService` is the frozen seam that makes this whole
  plan possible; changing it would make the port harder, not easier.
- **`apps/zcode-cli`** — deferred by user decision.
- **Porting `packages/services` to Rust** (`rust-native-program.md` Waves 4–6). That removes the
  **Node server** (CHANNEL 1), not Electron (CHANNEL 2). Separate programme, separate spec.
- **`zcode-rpc-server` absorbing the business services** — same reason. It is the Node-removal
  project, and it can start before or after Electron is gone without either blocking the other.

### 8.7 The Tauri test target — COMPILES, with 15 real failures

`cargo test` used to fail with **25 compile errors** in `src/commands/session/tests.rs` and
`src/window.rs`. They were **not** caused by Rung 1 and predated it: the test target had never been
compiled, for the same reason `editor.rs` had not (`mod.rs` did not declare it). All 25 are fixed,
so the target builds and the suite runs. Status: **195 passed, 15 failed, 0 ignored.**

**Fixed to get there** — the list is the argument for treating "written" as "unverified":

| Count | Error | Fix |
| --- | --- | --- |
| 7 | `resolve_config` not found | **Genuinely missing function.** `ssh_config.rs` only had `resolve_now()`, hard-wired to `~/.ssh/config`, so nothing was testable. Split into `pub(crate) resolve_config(&Path)` with `resolve_now()` as a caller — which also removes the chance of the cached and test paths diverging. |
| 7 | `split_ssh_tokens` / `strip_inline_comment` private | `pub(crate)`. These are the lexer the differential vectors assert against; an untestable lexer is where a quoting/escape regression hides. |
| 4 | `stub_active` not found | `ActiveNotification::handle` is now `Option<NotificationHandle>`, so the router's bookkeeping (cap, eviction order, re-tagging) is testable without a live notification server. Production entries are always `Some`, built from `show()`. |
| 3 | `WindowBounds` missing `maximized` | Added to three test initialisers. |
| 1 | `tauri::Error::WindowLabel` | Removed in Tauri 2.12; switched to `AssetNotFound`. The assertion is that the failure *propagates*, not which failure it was. |
| 3 | FRU on an enum variant; `.expect()` on `Result<(), E>`; `BoundedOrder::iter` absent | Spelled the variant out, used `.expect_err()`, and added `iter()`. A test that cannot observe eviction order must infer it from side effects, which is how a cap that evicts the *newest* still passes. |

**One real bug fixed while in there:** `parse_desktop_bool` used `eq_ignore_ascii_case("true")`, so
`NoDisplay=TRUE` hid an editor. The freedesktop spec allows exactly `true`/`false` lowercase, so it
now compares case-sensitively.

**The 15 that remain are newly-visible, not newly-introduced.** Categorised, because the fix differs:

| Failure | Reading |
| --- | --- |
| `the_dedupe_window_suppresses_then_expires` | **Needs a decision, not a fix.** The test holds a notification is still suppressed at exactly `DEDUPE_WINDOW_MS`; the code uses `<` and expires on the boundary. One of them forks from `desktopNotifications.ts`, and the port cannot claim parity with both. |
| `the_bom_and_carriage_returns_are_stripped`, `the_wsl_table_parses_including_multi_word_names`, `unparseable_wsl_rows_are_skipped_not_fatal` | WSL column parsing looks genuinely broken — the name comes back as `"a l p h a"`. |
| `a_typical_config_resolves_its_aliases`, `an_alias_with_no_directives_falls_back_to_its_own_name`, `include_is_expanded_and_deep_recursion_is_bounded`, `home_tokens_expand` | SSH block matching and `~` expansion. Same area as the compile bugs above, which makes this the least trustworthy region of the port. |
| `a_ready_handshake_carries_a_bound_endpoint` | Expected `zs-1`, got `zs-0` — a counter or ordering issue in the session identity path. |
| `ssh_folder_uri_encodes_the_authority_as_one_component` | The `@` separating user from host is being percent-encoded, so the authority is not one component. |
| `remote_paths_must_be_absolute_and_control_free`, `refuses_an_absolute_path_outside_the_allowed_root`, 3 x `window::tests` | Look environment-dependent (Windows paths on Linux, `/root` unreadable) rather than code bugs — but that has to be *proven* with a `#[cfg]` gate, not assumed. |

None of these are recorded as passing anywhere. The `PORT_STATUS.md` claim of "142 tests" predates
this tree and must not be quoted until this reaches green.
