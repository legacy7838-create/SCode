# Spec: `tauri-dev-simulate` — CI boot simulation for `pnpm dev:tauri`

Status: active. Written before implementation per `AGENTS.md`. Owner: CI/diagnostic tooling.

## Problem

The Windows desktop boot (`pnpm dev:tauri`) fails on a developer machine, but the failure
is only observable on that machine. A build matrix (`build.yml`) proves `tauri build`
compiles, yet **compiling is not booting**: `tauri dev` additionally boots `@zcode/server`
(:3030), starts Vite (:5199 via `beforeDevCommand`), compiles the debug Rust host, and
launches the app exe with WebView2. Each of those stages can fail independently on
Windows (missing WebView2 runtime, MSVC-only compile errors, missing `.node` binaries for
the server, port conflicts), and today no CI surface reproduces that sequence.

## Purpose

A **manually dispatched** workflow that boots the real `pnpm dev:tauri` on a clean runner
and prints the actual failure into the workflow log — evidence, not hypotheses.

## Contracts

### Workflow: `.github/workflows/tauri-dev-simulate.yml`

- Trigger: `workflow_dispatch` **only** (with optional inputs `boot_timeout_seconds`,
  `stabilize_seconds`). Manual-only because a dev boot needs a long cold cargo debug
  compile and is a diagnostic, not a push/PR gate.
- Matrix: `windows-2022` + `ubuntu-22.04`, `fail-fast: false` — the Windows row is the
  target; the Linux row isolates platform-specific failures by comparison.
- Setup mirrors `build.yml`: pnpm 10.33.2, Node 24.14.0 (repo pins in `mise.toml`), Rust
  stable, cargo cache for `packages/rust` + `apps/zcode-tauri/src-tauri`, WebKitGTK apt
  deps on Ubuntu, `pnpm install --frozen-lockfile`, then `pnpm --filter @zcode/rust
build:native` — the `.node` binaries `@zcode/server` loads must exist before boot.
- The boot step runs `node scripts/ci-dev-tauri-simulate.mjs` (the supervisor below).
- On `always()`, the captured log `dev-tauri-ci.log` is uploaded as an artifact
  (`dev-tauri-log-<platform>`), so a failed run keeps the full boot transcript.

### Supervisor: `scripts/ci-dev-tauri-simulate.mjs`

- Runs the **real** `pnpm dev:tauri` command (via `cmd.exe /c` on Windows, direct spawn on
  POSIX — same pattern as `scripts/dev-tauri.mjs`); it supervises, it does not reimplement
  the boot.
- Tees the child's stdout/stderr to `dev-tauri-ci.log` and to its own stdout, so the
  Actions log shows the boot live.
- Polls three signals every 5 s:
  1. `@zcode/server` listening on :3030,
  2. Vite listening on :5199,
  3. the app process alive (`zcode-tauri.exe` via `tasklist` on Windows,
     `zcode-tauri` via `pgrep` on POSIX — evidence that cargo finished and the webview host launched).
- **Success** = all three signals green and still green after `STABILIZE_SECONDS`
  (default 45) with the supervisor child alive the whole time.
- **Failure** = supervisor child exits early (prints its exit code), any signal never
  turns green within `BOOT_TIMEOUT_SECONDS` (default 1800 — cold debug builds are slow),
  or a signal goes green then a child exit is observed. On failure the last 120 log lines
  are printed and the exit code is 1.
- Teardown (always, including success): Windows `taskkill /PID <pid> /T /F`; POSIX
  `SIGTERM` to the process group, then `SIGKILL` after a grace period.

### State ownership / event order

```text
ci-dev-tauri-simulate.mjs (supervisor — sole owner of pass/fail)
  └─ spawns pnpm dev:tauri (scripts/dev-tauri.mjs)
       ├─ @zcode/server :3030      (unless already listening / ZCODE_TAURI_NO_SERVER=1)
       └─ pnpm tauri dev
            ├─ beforeDevCommand → vite :5199 (strictPort)
            ├─ cargo build (debug) → target/debug/zcode-tauri(.exe)
            └─ app exe launches → WebView2/WebKitGTK window
poll loop: :3030 ∧ :5199 ∧ app-process ∧ child-alive ── stable 45s ──► success
any child exit before stability ──► failure (log tail + exit code)
```

No timeouts paper over ordering: a port opening early does not mask a later child exit;
the stability window is what distinguishes "compiled" from "booted".

## Acceptance scenarios

1. Manual dispatch of `tauri-dev-simulate` runs both matrix rows and shows the live boot
   transcript; on failure the log tail names the failing stage (server / vite / cargo /
   app process) and the artifact holds the full log.
2. On a healthy runner the workflow exits 0 only after the app process has been alive for
   the stability window; killing the exe mid-window makes the run fail.
3. `ci.yml` and `build.yml` are both manually dispatchable (`workflow_dispatch` present).
4. The supervisor script is also runnable on a developer machine
   (`node scripts/ci-dev-tauri-simulate.mjs`) to reproduce a Windows boot locally.

## 修复原因（中文）

- 问题：Windows 上 `pnpm dev:tauri` 无法启动，但该失败只在开发者机器上可见；
  `build.yml` 只证明 `tauri build` 能编译，不能证明 dev 启动链路（server :3030 →
  vite :5199 → cargo debug 编译 → 应用进程 + WebView2）能跑通。
- 方案：新增**仅手动触发**的 `tauri-dev-simulate` workflow，在干净的 Windows/Linux
  runner 上运行真实的 `pnpm dev:tauri`，由监督脚本按端口 + 进程存活信号判定是否
  真正启动，并把完整启动日志作为 artifact 上传，用于定位真实原因而不是猜测。
