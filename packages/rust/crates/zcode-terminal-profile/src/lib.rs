//! `zcode-terminal-profile` — terminal profile detection, shell/cwd selection, and the
//! terminal spawn policy check.
//!
//! Spec: docs/specs/rust-native-terminal-profile.md
//!
//! Replaces, in TypeScript:
//!   * `packages/services/src/terminal/terminalProfile.ts:1-415` (deleted; the module is now a
//!     thin façade over this crate) and
//!   * `packages/services/src/terminal/terminalProfileMacOs.ts:1-367` (**deleted**), and
//!   * `packages/services/src/terminal/terminalService.ts:67-89,285-321` — `isExecutable`,
//!     `resolveTerminalShell`, `isUsableDirectory` and `resolveTerminalCwd`.
//!
//! The porting risk is **parity, not performance**: the output crosses into the renderer as
//! a `TerminalFontProfile` payload and decides which shell binary the host executes, so a
//! silently different result is a behaviour fork. The eight ECMAScript behaviours the legacy
//! code leaned on (trim, `parseFloat`, `Math.round`, `toFixed`, lenient base64, the archived
//! -font regex, the `kitty.conf` first-match rule, the two-attempt JSONC parse) are
//! transcribed in `jsval`, `jsonc` and `macos` and each has a named test.
//!
//! Invariants this crate protects:
//!   * **5 (process rule)** — zero child-process spawns. The one spawn in the legacy surface,
//!     `readMacOsPlistFile`'s `plutil` call, stays in TypeScript and feeds this crate the
//!     plist as a string; see spec §2.2 for exactly why.
//!   * **4 (event loop)** — the detection ladder runs as an async napi task because it can
//!     read eleven files; the shell/cwd ladders and the policy check are synchronous because
//!     each is a handful of syscalls.
//!   * **1 (zero JS fallback)** — there is no second implementation to fall back to. The
//!     TypeScript detection logic is deleted, not disabled.
pub mod detectors;
pub mod jsval;
pub mod jsonc;
pub mod macos;
pub mod policy;
pub mod shell;
pub mod types;

use napi::bindgen_prelude::{AsyncTask, Task};
use napi::{Env, Error, Result};
use napi_derive::napi;
use serde_json::Value;

use detectors::resolve_terminal_font_profile as resolve_font_profile;
use policy::{
    check_terminal_spawn_policy as run_policy_check, TerminalSpawnDecision, TerminalSpawnPolicy,
    TerminalSpawnRequest,
};
use shell::{CwdInput, ShellInput};
use types::{TerminalDetectedProfile, TerminalEnvInput, TerminalFontProfile};

/// The full input of `resolveTerminalFontProfile`.
#[napi(object)]
pub struct TerminalProfileRequest {
    /// `process.platform`.
    pub platform: String,
    pub env: TerminalEnvInput,
    /// `AppSettings.terminalFontFamily`.
    pub terminal_font_family: Option<String>,
    /// `AppSettings.terminalInheritSystemProfile`; absent means "inherit", matching the
    /// legacy `!== false` test.
    pub terminal_inherit_system_profile: Option<bool>,
    /// `plutil -convert json` output for `com.googlecode.iterm2.plist`, or `null`.
    pub iterm2_plist_json: Option<String>,
    /// `plutil -convert json` output for `com.apple.Terminal.plist`, or `null`.
    pub macos_terminal_plist_json: Option<String>,
}

fn parse_plist(raw: Option<&String>) -> Option<Value> {
    let parsed: Value = serde_json::from_str(raw?).ok()?;
    if parsed.is_object() {
        Some(parsed)
    } else {
        None
    }
}

/// The detection ladder, on a libuv worker thread.
///
/// Invariant 4 does not permit eleven file reads on the event loop, so this is an
/// [`AsyncTask`] rather than a synchronous call. The `async fn` sugar would need napi's
/// `async` feature (tokio); `AsyncTask` uses the thread pool the platform already has and
/// adds no dependency.
pub struct ResolveTerminalFontProfileTask {
    request: TerminalProfileRequest,
}

impl Task for ResolveTerminalFontProfileTask {
    type Output = TerminalFontProfile;
    type JsValue = TerminalFontProfile;

    fn compute(&mut self) -> Result<Self::Output> {
        let iterm2_plist = parse_plist(self.request.iterm2_plist_json.as_ref());
        let macos_terminal_plist = parse_plist(self.request.macos_terminal_plist_json.as_ref());
        Ok(resolve_font_profile(
            &self.request.platform,
            &self.request.env,
            self.request.terminal_font_family.as_deref(),
            self.request.terminal_inherit_system_profile,
            iterm2_plist.as_ref(),
            macos_terminal_plist.as_ref(),
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// `resolveTerminalFontProfile` — the whole detection ladder, in Rust.
#[napi]
pub fn resolve_terminal_font_profile(
    request: TerminalProfileRequest,
) -> AsyncTask<ResolveTerminalFontProfileTask> {
    AsyncTask::new(ResolveTerminalFontProfileTask { request })
}

/// `detectIterm2Profile` over an already-read plist. Exposed so the parsing is testable, and
/// so wave 2 can feed it a plist read in Rust instead of one read by `plutil`.
#[napi]
pub fn parse_iterm2_plist(plist_json: String) -> Result<Option<TerminalDetectedProfile>> {
    let Some(plist) = parse_plist(Some(&plist_json)) else {
        return Ok(None);
    };
    Ok(macos::parse_iterm2_plist(&plist))
}

/// `detectMacOsTerminalProfile` over an already-read plist.
#[napi]
pub fn parse_mac_os_terminal_plist(plist_json: String) -> Result<Option<TerminalDetectedProfile>> {
    let Some(plist) = parse_plist(Some(&plist_json)) else {
        return Ok(None);
    };
    Ok(macos::parse_mac_os_terminal_plist(&plist))
}

/// The inputs of `resolveTerminalShell`.
#[napi(object)]
pub struct TerminalShellRequest {
    /// `process.platform`.
    pub platform: String,
    /// `env.SHELL`.
    pub shell: Option<String>,
    /// `env.ComSpec`.
    pub com_spec: Option<String>,
    /// `env.PATH`.
    pub path: Option<String>,
}

/// `resolveTerminalShell` — `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`, and on Windows
/// `pwsh.exe` → `powershell.exe` → `%ComSpec%` → `cmd.exe`.
///
/// Throws with the legacy message when every candidate is missing, because a terminal that
/// spawns nothing is the safe failure and one that spawns a *different* shell is not.
#[napi]
pub fn resolve_terminal_shell(request: TerminalShellRequest) -> Result<String> {
    let input = ShellInput {
        platform: &request.platform,
        shell: request.shell.as_deref(),
        com_spec: request.com_spec.as_deref(),
        path: request.path.as_deref(),
    };
    shell::resolve_terminal_shell(&input).map_err(Error::from_reason)
}

/// The inputs of `resolveTerminalCwd`.
#[napi(object)]
pub struct TerminalCwdRequest {
    pub cwd: Option<String>,
    /// `env.HOME`.
    pub home: Option<String>,
    /// `os.homedir()`.
    pub home_dir: String,
}

/// `resolveTerminalCwd` — the requested directory → `$HOME` → `os.homedir()` → `/`.
#[napi]
pub fn resolve_terminal_cwd(request: TerminalCwdRequest) -> Result<String> {
    let input = CwdInput {
        cwd: request.cwd.as_deref(),
        home: request.home.as_deref(),
        home_dir: &request.home_dir,
    };
    shell::resolve_terminal_cwd(&input).map_err(Error::from_reason)
}

/// The deny-by-default gate the wave-2 spawn calls before `node-pty` is handed a shell.
/// Spec §5.
#[napi]
pub fn check_terminal_spawn_policy(
    policy: TerminalSpawnPolicy,
    request: TerminalSpawnRequest,
) -> TerminalSpawnDecision {
    run_policy_check(&policy, &request)
}
