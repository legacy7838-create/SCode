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
