# Spec: Windows boot — `git clone` → `pnpm i` → `pnpm dev:tauri`

Status: active. Written before implementation per `AGENTS.md`. Owner: `apps/zcode-tauri` (Rust host) + `scripts/dev-tauri.mjs`.

Closes the compile failures reported in `legacy7838-create/SCode#2` ("Issue for windows"):
the `zcode-tauri` lib had **never been compiled for a Windows target** (the `build.yml`
Windows rows are tag/manual-only and were never dispatched; Linux dev compiles a
different cfg surface), so five platform-specific errors survived unnoticed.

## Acceptance (the product rule)

On a clean Windows machine with Node, pnpm and a current Rust stable installed:

1. `git clone … && pnpm i && pnpm dev:tauri` boots — no manual extra steps.
2. `pnpm dev:tauri` self-heals the one thing `pnpm i` cannot produce: the compiled
   Rust napi binaries (`packages/rust/*.node`). If none exist for this checkout, the
   launcher runs `pnpm --filter @zcode/rust build:native` before booting the server,
   logging that the first run compiles for several minutes.
3. Windows compile proof comes from GitHub Actions only (`tauri-dev-simulate`,
   windows-22 row). No Windows toolchain is installed on developer machines for this.

## The five errors and their fixes

| # | Location | Error | Root cause | Fix |
|---|---|---|---|---|
| 1 | `session.rs:787` | `notify_rust::NotificationHandle` not found | notify-rust 4.18 exports the handle at crate root only for macOS/unix; the Windows module is private, so `show()`'s Windows handle is unnameable outside the crate | cfg type alias `PlatformNotificationHandle`; on Windows the handle is dropped after `show()` (toast already displayed) and the entry stores `None` |
| 2 | `session.rs:1044` | `.hint()` not found | `Hint::SuppressSound` is a D-Bus hint; notify-rust gates `.hint()` to `all(unix, not(macos))` | gate the call with the same cfg; the rest of the builder (`.summary/.body/.appname/.id`) is cross-platform and stays |
| 3 | `credential.rs:124` | `current_uid` not found | the `/etc/passwd` scanner calls `current_uid()`, which is `#[cfg(unix)]`, but the scanner itself was ungated | `#[cfg(unix)]` on the scanner; the existing `#[cfg(not(unix))]` stub becomes the only non-unix definition |
| 4 | `credential.rs` | E0428 duplicate definition | the ungated scanner and the `#[cfg(not(unix))]` stub are both compiled on Windows | same fix as #3 — one definition per platform |
| 5 | `ssh_config.rs:249` | E0658 `path_is_empty` unstable | `rest` is `&Path`; `Path::is_empty()` is unstable in toolchains older than its stabilization (the reporter's Windows rustc) | `rest.as_os_str().is_empty()` — portable on every toolchain |

Plus the boot-flow gap: `@zcode/server` loads `packages/rust/*.node` at startup, but
`pnpm i` does not build them (root `prepare` is only `husky`) — without the launcher
heal in `dev-tauri.mjs`, a fresh clone fails at the server stage even after the compile
fixes.

## Platform semantics after the fix (state owner: `NotificationRouter`)

```text
show_task_notification
  ├─ accept()  → dedupe + routes (window_label, task_id)   [all platforms]
  ├─ show()    → platform toast                             [all platforms]
  ├─ retain handle + waiter thread (wait_for_action click)  [not windows]
  └─ retain entry with handle: None, no waiter             [windows — known gap]
```

- The router (dedupe window, live cap, eviction order, re-tagging) is platform-neutral
  and unchanged; tests already construct entries with `handle: None`.
- **Known platform gap (Windows):** notify-rust cannot deliver click actions there —
  the handle type is unnameable, so no `wait_for_action`. Toasts still show; click →
  tab routing is deferred until a Windows activation path (e.g. tauri notification
  activation events) is wired. This is recorded, not papered over.
- macOS: `.hint()` was already unavailable there (notify-rust gates it to non-macOS
  unix); the cfg in this fix matches notify-rust exactly, so macOS compiles too.

## CI run 37050820634 findings (first tauri-dev-simulate dispatch)

Both matrix rows ran; both failed for reasons now fixed — **neither re-opens the
five issue #2 compile errors**:

1. **win32-x64: `zcode-packaging` host-target spelling (real repo bug).**
   `cargo build --release` of `packages/rust` **succeeded** on windows-2022 (every
   crate compiles clean on MSVC), but `plan --target host` exited 64:
   `unsupported target "windows-x64"`. `Target::host()` concatenated
   `std::env::consts::OS` ("windows") raw, bypassing the `windows-x64` aliases in
   `resolve()`. Fixed in `crates/zcode-packaging/src/target.rs` — one
   `from_consts(os, arch)` normalizer (windows→win32, macos→darwin); see
   `rust-native-packaging.md` finding 1.
2. **linux-x64: headless GTK panic (environmental).** The debug build finished and
   `target/debug/zcode-tauri` launched, then tao panicked: `Failed to initialize gtk
   backend` — GitHub's Linux runners have no display server. Server :3030 and Vite
   :5199 both came up; only the GUI needed a display. Fixed in the workflow: `xvfb`
   package + `xvfb-run` wrapping the simulate step on ubuntu.
3. The simulate step on win32 was **skipped** (the job failed earlier at
   build:native), so the issue #2 compile fixes from `7bf681f` still await their
   first Windows verification in the next run.

## Verification

- Linux: `cargo check` / `cargo test` for `apps/zcode-tauri/src-tauri` stay green;
  `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` pass.
- Windows: dispatch `tauri-dev-simulate` (workflow input `boot_timeout_seconds=3600`
  for the cold first compile). Success = the workflow's supervisor sees :3030, :5199
  and the `zcode-tauri.exe` process stable for the stabilize window.
- Toolchain note for the reporter: error #5 also means their Rust predates the
  `Path::is_empty` stabilization — `rustup update` on their machine; the repo-side
  portable fix means the repo no longer depends on it.

## 修复原因（中文）

- 根因（已确认）：`zcode-tauri` Rust 宿主从未针对 Windows 目标编译过（build.yml 的
  Windows 行仅手动/标签触发，从未跑过；Linux 开发编译的是另一套 cfg 面），因此5 个
  平台相关编译错误一直存在。通知代码用了 notify-rust 的 XDG/D-Bus 专用 API，
  credential 的 passwd 扫描函数缺少 `#[cfg(unix)]`，ssh_config 用了不稳定的
  `Path::is_empty()`。
- 修复原则：平台分叉在编译期用 cfg 显式表达（类型别名 + 方法门控），不在运行时
  加 fallback 分支；Windows 上通知照常显示，句柄与点击路由是明确记录的平台缺口；
  `dev:tauri` 启动器在原生二进制缺失时自动执行 `build:native`，使
  clone → pnpm i → dev:tauri 成为完整可用路径。
