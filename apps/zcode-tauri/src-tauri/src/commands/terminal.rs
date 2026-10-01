//! Terminal commands — the pty spawn and lifecycle, and the confinement the
//! Electron service never had.
//!
//! Replaces `packages/services/src/terminal/terminalService.ts` (446 lines) on
//! the Tauri path. The shell-resolution and profile-detection halves of that
//! file are already ported to `zcode-terminal-profile`
//! (`docs/specs/rust-native-terminal-profile.md`); what is missing in the Tauri
//! process is the part that actually starts a process and feeds it bytes, and
//! this module is that part. The pty itself is `portable-pty`, already in
//! `Cargo.toml`: on Unix it is the same `openpty` + `setsid` + `TIOCSCTTY` +
//! `TIOCSWINSZ` sequence the hand-rolled version would have been, and on Windows
//! it is ConPTY, so `spawnTerminalProcess`'s `useConptyDll` path
//! (`terminalService.ts:226-253`) is covered by a maintained implementation
//! rather than by untested FFI written here.
//!
//! ## Why this module exists at all, and what it changes
//!
//! `terminalService.create()` (`terminalService.ts:353-365`) has **no permission
//! service, no confirmation and no sandbox** anywhere in its method body, and
//! `write()` (`:415`) pipes caller bytes straight into the pty. The Tauri path
//! inherited nothing of the above because it had no pty at all; what it would
//! inherit is the *absence of a boundary*, because the natural thing to write
//! against `#[tauri::command]` is "spawn a shell wherever the payload says".
//! Three decisions below exist specifically to not do that.
//!
//! ## 1. Confinement is a required field, not a setting
//!
//! [`TerminalCreateRequest::roots`] is a **required** `Vec<String>` with
//! `deny_unknown_fields` and no `#[serde(default)]`. Omitting it is a
//! deserialisation failure, not an empty allowlist; an empty allowlist is a
//! refusal (`cwd-outside-roots`). There is no optional form, no default and no
//! bypass, so no call site can compile its way to an unconfined spawn.
//!
//! The rule is the one `zcode-fs` uses (`packages/rust/crates/zcode-fs/src/
//! containment.rs:97-199`): canonicalise the request and every root — so every
//! symlink is resolved and every `..` is folded — and admit on component-wise
//! `Path::starts_with`, which is also what stops `/ws-evil` satisfying `/ws`.
//! Both sides are canonicalised, so the sibling-prefix guard and the symlink
//! guard are the same comparison.
//!
//! **The `$HOME` → `/` fallback is gone, deliberately.**
//! `resolveTerminalCwd` (`terminalService.ts:310-321`) accepted any absolute
//! path and, when it did not stat as a directory, fell back to `$HOME` and then
//! to `/`. That fallback is a hole: a request the host cannot honour silently
//! became "run a shell in `$HOME`", which is outside every allowlist a caller
//! would have written. Here a `cwd` that does not resolve, is not a directory,
//! or sits outside every root is a typed refusal, and the spawn re-checks that
//! the directory still exists immediately before `spawn_command` — because
//! `portable_pty`'s own `as_command` would fall back to `$HOME` in that case,
//! and that fallback must be unreachable on this path.
//!
//! ## 2. The caller is derived, and it has to be a workspace window
//!
//! Every command takes the injected `WebviewWindow` and reads the label off it;
//! no command accepts a window label, a terminal id owned by somebody else, or
//! an origin on the wire. Tauri has no `event.senderFrame.url`
//! (`PORT_STATUS.md:161`), so the check is made where the truth still exists:
//! [`require_terminal_caller`] requires the label to be registered **and** to be
//! a main workspace window. `AppState::is_main_window` excludes the tray, the
//! overlay and every guest child webview, which is what stops a page in a child
//! webview — where `initialization_script` has put `window.zcodeBridge` in the
//! main world (`PORT_STATUS.md:160`) — from asking for a shell.
//!
//! Ownership is then sticky: a terminal records the label of the window that
//! created it, and every later command resolves the entry **through** that
//! owner, so a second window cannot drive — or even enumerate — a terminal it
//! did not spawn.
//!
//! ## 3. What the child inherits, and why it is a denylist
//!
//! `resolveTerminalEnv` (`terminalService.ts:198`) returned `{...process.env}`
//! with no scrub, so a terminal inherited every secret in the host process
//! environment. The fix is **not** an allowlist, and the reason is concrete: an
//! allowlist that keeps only what this module can enumerate breaks every user's
//! shell — `PATH`, `HOME`, `SHELL`, `SSH_AUTH_SOCK`, `XDG_DATA_HOME`, `GOPATH`,
//! `NVM_DIR`, the cloud and CI credentials tools look for, and the locale. A
//! confinement change that makes the product unusable is not a confinement
//! change.
//!
//! So the child inherits the parent environment **minus**
//! [`DEFAULT_ENV_DENYLIST`] — the six names `zcode-terminal-profile` already
//! fixed as the baseline for every host
//! (`src/policy.rs:71-80`): `LD_PRELOAD`, `LD_LIBRARY_PATH`,
//! `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`,
//! `ELECTRON_RUN_AS_NODE`. Those are the variables whose entire purpose is to
//! make a process load code it was not meant to load, and a child that inherits
//! them inherits the host's loader configuration as an attack surface. The list
//! is the same one in the same order, so the wire vocabulary does not fork.
//!
//! The variables that **do** change terminal behaviour are set explicitly in
//! [`resolve_terminal_env`], ported verbatim from `terminalService.ts:169-203`:
//! `TERM=xterm-256color` (without it starship/p10k render unstyled), `COLORTERM`
//! defaulting to `truecolor`, `CI` dropped when the inherited `TERM` was `dumb`
//! (so the login shell takes its interactive branch), the `LANG`/`LC_CTYPE`/
//! `LC_ALL` UTF-8 fallback (so non-ASCII paths are not rendered as `\M-^`), and
//! the macOS GUI `PATH` merge (so a Dock-launched app still finds Homebrew
//! tools). None of that touches the parent's own environment, exactly as the
//! TypeScript comment at `:176` requires.
//!
//! The result is not a merge left to a child process API: [`command_builder_for`]
//! calls `CommandBuilder::env_clear()` — which is required, because
//! `CommandBuilder::new` seeds itself from *this* process's environment — and
//! then sets exactly the computed map. `portable_pty` then `env_clear()`s again
//! and re-applies the builder's own map, so the child receives the computed
//! environment and nothing else. `resolve_terminal_env` is a pure function over
//! a map, and `the_child_environment_is_exactly_the_computed_one` asserts the
//! result, so a future scrub regression fails `cargo test` rather than shipping.
//!
//! ## Why the pty is not a `supervisor/` child
//!
//! `supervisor::Supervisor` restarts a child with bounded exponential backoff
//! and distinguishes `Stopped` from `Failed`
//! (`PORT_STATUS.md:39-44`, `src/supervisor/mod.rs`). That model is correct for
//! the long-lived hosts it was written for and **wrong** for a shell: a user who
//! types `exit` must get a terminal that exits. Restarting a pty on exit is the
//! opposite of the intent, and conflating the two would make `ChildStatus`
//! meaningless.
//!
//! So a pty is owned by [`TerminalRegistry`], which is an ownership and lifecycle
//! registry rather than a restart policy: ids are handed out, every entry is
//! keyed to the window that created it, a kill signals the child (closing the
//! master then makes the kernel `SIGHUP` the foreground group), the reader
//! thread reaps the child so no zombie survives, `Drop` kills whatever is left,
//! and `terminal_kill_all` is one window's share of `disposeAll`
//! (`terminalService.ts:368-375`) — scoped to one window because the Tauri host
//! has more than one.
//!
//! Window teardown is **not** automatic, and that is a wiring gap rather than a
//! design one: the reader thread blocks in `read`, so it cannot poll for its
//! window's existence, and `lib.rs`'s `on_window_event` is currently a no-op
//! (`lib.rs:223`). A closed window's terminals therefore survive until the app
//! exits, at which point `Drop` kills them. The fix is one line in the window
//! close path — see the report's `REQUIRED-CHANGE`.
//!
//! ## What this module does *not* return
//!
//! `create()` also returned `fontFamily`, `fontSize`, `theme`,
//! `fontFamilySource` and `windowsPty` (`terminalService.ts:337-345`). The font
//! detector is `zcode-terminal-profile`, an napi cdylib: a Tauri process is not
//! Node and cannot load a `.node`. Those four fields are **not** returned by
//! `terminal_create`; they keep coming from the existing profile path over the
//! service channel, and a renderer must not read them off this command's result.
//! `windowsPty` is a Windows build-number probe with no meaning elsewhere.
//!
//! ## Wiring
//!
//! `lib.rs` must call `.manage(commands::terminal::TerminalRegistry::default())`,
//! `commands/mod.rs` must declare `pub mod terminal;`, and the six commands
//! below must be listed in `generate_handler!`. The `State` extractor panics at
//! invoke time if the `manage` call is missing. `events.rs` must gain
//! [`TERMINAL_DATA_EVENT`] and [`TERMINAL_EXIT_EVENT`] in `ALL`, because
//! `events::tests::event_names_match_typescript_mirror` asserts that the Rust
//! list and the TypeScript mirror agree.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use super::{require_registered_window, CommandError, CommandResult};
use crate::app_state::AppState;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Bytes read from a pty, pushed to the window that owns the terminal.
/// Replaces `webContents.send("zcode:TerminalData", …)`.
pub const TERMINAL_DATA_EVENT: &str = "zc-terminal-data";

/// A pty's process exited, carrying the code `onDynamicExit` reported.
pub const TERMINAL_EXIT_EVENT: &str = "zc-terminal-exit";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// `policy.rs` `max_cols` / `max_rows` (`zcode-terminal-profile/src/policy.rs:90-91`).
///
/// An xterm cell count above this is a bug or a hostile request; `PtySize` is a
/// `u16` so the wire type cannot express more, and 1000 is two orders of
/// magnitude past any real terminal.
pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 1000;

/// The `exitCode` a terminal reports when the child could not be reaped, so the
/// renderer can tell "the shell ended" from "the host lost track of the shell".
/// Named rather than inlined so the value is one thing in the wire vocabulary
/// instead of a bare `u32::MAX` in a closure.
pub const EXIT_CODE_REAP_FAILED: u32 = u32::MAX;

/// Largest single `terminal_write` payload, in bytes.
///
/// A paste of a large file is the legitimate large case. Beyond this the request
/// is refused rather than buffered, because the bytes are about to be handed to
/// a shell that runs with the user's credentials.
pub const MAX_WRITE_BYTES: usize = 1024 * 1024;


// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/// The env-denylist every host starts from: variables that make a process load
/// code it was not meant to load.
///
/// Identical to `zcode-terminal-profile/src/policy.rs:73-80` — same names, same
/// order. See the module docs for why the child inherits the rest of the parent
/// environment rather than an allowlist.
pub const DEFAULT_ENV_DENYLIST: [&str; 6] = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
];

/// `DARWIN_GUI_FALLBACK_PATHS` (`terminalService.ts:131-140`).
///
/// An app launched from the Dock/Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin`
/// at best and no `PATH` at worst, so `npm`, `node` and `pnpm` are missing and
/// some profiles never load. Only the child gets these; the parent is untouched.
pub const DARWIN_GUI_FALLBACK_PATHS: [&str; 8] = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// `process.platform` as the legacy code spells it.
fn legacy_platform_id() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

/// The `path.delimiter` of the host, which is a host property and not a
/// target property — a differential that exercises the `win32` branch from Linux
/// has to split on `;` to agree with it.
fn path_delimiter() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

/// `/utf-?8/i` (`terminalService.ts:122-124`).
fn is_utf8_locale(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        let lowered = value.to_ascii_lowercase();
        lowered.contains("utf-8") || lowered.contains("utf8")
    })
}

/// `isMissingOrCLocale` (`terminalService.ts:126-129`): trim, upper-case, then
/// compare — so `" c "` and `"posix"` both count as "no locale set".
fn is_missing_or_c_locale(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        None => true,
        Some(value) => {
            let normalized = value.to_ascii_uppercase();
            normalized.is_empty() || normalized == "C" || normalized == "POSIX"
        }
    }
}

/// `mergePathEntries` (`terminalService.ts:142-156`): split on the host
/// delimiter, trim, drop empties, keep the first occurrence, rejoin. The user's
/// existing order is retained and the fallbacks are appended, never prepended.
pub fn merge_path_entries(entries: &[Option<&str>]) -> String {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut merged: Vec<&str> = Vec::new();
    for value in entries.iter().flatten() {
        for entry in value.split(path_delimiter()) {
            let trimmed = entry.trim();
            if trimmed.is_empty() || !seen.insert(trimmed) {
                continue;
            }
            merged.push(trimmed);
        }
    }
    merged.join(&path_delimiter().to_string())
}

/// `resolveFallbackUtf8Locale` (`terminalService.ts:162-167`): keep a UTF-8
/// locale the user already set, otherwise pick the platform's default.
fn resolve_fallback_utf8_locale(parent: &BTreeMap<String, String>, platform: &str) -> String {
    let get = |name: &str| parent.get(name).map(String::as_str);
    if let Some(found) = [get("LC_ALL"), get("LC_CTYPE"), get("LANG")]
        .into_iter()
        .flatten()
        .find(|value| is_utf8_locale(Some(value)))
    {
        return found.to_string();
    }
    if platform == "darwin" {
        "en_US.UTF-8".to_string()
    } else {
        "C.UTF-8".to_string()
    }
}

/// `resolveTerminalEnv` (`terminalService.ts:169-203`), then the denylist.
///
/// Pure over `(parent, platform)` so a test can assert the exact environment the
/// child receives. The parent map is never mutated: the TypeScript comment at
/// `:176` is explicit that the fix must not change `process.env` globally, and
/// mutating a process-wide environment from a command is a data race besides.
pub fn resolve_terminal_env(
    parent: &BTreeMap<String, String>,
    platform: &str,
) -> BTreeMap<String, String> {
    let get = |name: &str| parent.get(name).map(String::as_str);
    let mut next = parent.clone();
    let fallback_locale = resolve_fallback_utf8_locale(parent, platform);

    if platform == "darwin" {
        let mut path_sources: Vec<Option<&str>> = vec![get("PATH")];
        path_sources.extend(DARWIN_GUI_FALLBACK_PATHS.iter().copied().map(Some));
        let merged = merge_path_entries(&path_sources);
        if !merged.is_empty() {
            next.insert("PATH".to_string(), merged);
        }
    }

    // The real terminal panel must start as an interactive terminal; without
    // this, starship, p10k and colour detection all degrade to unstyled output.
    next.insert("TERM".to_string(), "xterm-256color".to_string());
    let colourterm = get("COLORTERM").map(str::trim).unwrap_or_default();
    next.insert(
        "COLORTERM".to_string(),
        if colourterm.is_empty() {
            "truecolor".to_string()
        } else {
            colourterm.to_string()
        },
    );
    // The runtime collects login-shell environments with `TERM=dumb`/`CI=1` to
    // keep profile scripts out of their interactive branch. A real terminal is
    // the opposite case, so `CI` goes when that marker is what we inherited.
    if get("CI") == Some("1") && get("TERM") == Some("dumb") {
        next.remove("CI");
    }

    // UTF-8 is substituted only when the locale is missing or explicitly
    // C/POSIX; a locale the user configured is kept, so a `LANG=ja_JP.UTF-8`
    // host does not silently become `C.UTF-8` and render non-ASCII paths as
    // `\M-^`.
    if is_missing_or_c_locale(get("LANG")) {
        next.insert("LANG".to_string(), fallback_locale.clone());
    }
    if is_missing_or_c_locale(get("LC_CTYPE")) {
        next.insert("LC_CTYPE".to_string(), fallback_locale.clone());
    }
    if get("LC_ALL").is_some() && is_missing_or_c_locale(get("LC_ALL")) {
        next.insert("LC_ALL".to_string(), fallback_locale);
    }

    for name in DEFAULT_ENV_DENYLIST {
        next.remove(name);
    }
    next
}

/// The ambient environment as the map [`resolve_terminal_env`] takes it.
pub fn parent_environment() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

// ---------------------------------------------------------------------------
// Shell ladder
// ---------------------------------------------------------------------------

/// `POSIX_SHELL_CANDIDATES` (`zcode-terminal-profile/src/shell.rs:12`). The
/// order is the security property: the user's own shell first, then the
/// fallbacks, and a `$SHELL` that no longer exists never reaches `execve`.
pub const POSIX_SHELL_CANDIDATES: [&str; 3] = ["/bin/zsh", "/bin/bash", "/bin/sh"];

/// `WINDOWS_SHELL_CANDIDATES` (`zcode-terminal-profile/src/shell.rs:17`).
/// PowerShell 7+ redraws the input line correctly under ConPTY where Windows
/// PowerShell 5.1's PSReadLine does not, and `%ComSpec%` is preferred over a
/// hard-coded `cmd.exe` because it names the user's own shell.
pub const WINDOWS_SHELL_CANDIDATES: [&str; 2] = ["pwsh.exe", "powershell.exe"];

/// `isExecutable` (`shell.rs:29-41`): a candidate with a separator is probed
/// directly, otherwise each non-empty `PATH` entry is probed with it appended.
fn is_executable(command: &str, path_env: Option<&str>) -> bool {
    if command.contains('/') || command.contains('\\') {
        return access_executable(Path::new(command));
    }
    let Some(path_env) = path_env else {
        return false;
    };
    path_env
        .split(path_delimiter())
        .filter(|directory| !directory.is_empty())
        .any(|directory| access_executable(&PathBuf::from(directory).join(command)))
}

/// `access(2)`, declared here because `libc` is in the lock file but is not a
/// direct dependency of `zcode-tauri`, and `src-tauri/Cargo.toml` is
/// main-session-owned. One declaration of one function is a smaller ask than a
/// new dependency for a three-line check.
#[cfg(unix)]
mod access_ffi {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    extern "C" {
        fn access(path: *const c_char, mode: c_int) -> c_int;
    }

    /// `accessSync(path, constants.X_OK)`. `X_OK` is 1 on Linux and on the BSDs
    /// alike, and this crate cannot name a constant it does not depend on.
    pub fn access_x_ok(path: &Path) -> bool {
        let Ok(raw) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `raw` is a valid NUL-terminated path for the duration of the
        // call, and `access` only reads it.
        unsafe { access(raw.as_ptr(), 1) == 0 }
    }
}

/// `access(2)` with `X_OK` (`shell.rs:48-56`), not a mode-bit test: the two
/// disagree for a grant that comes from an ACL rather than the permission bits.
#[cfg(unix)]
fn access_executable(path: &Path) -> bool {
    access_ffi::access_x_ok(path)
}

#[cfg(not(unix))]
fn access_executable(path: &Path) -> bool {
    // Windows has no `X_OK`; Node's `X_OK` degrades to an existence test there.
    std::fs::metadata(path).is_ok()
}

/// Every shell a spawn is allowed to exec, in ladder order.
///
/// This is the `allowed_shells` of `policy.rs:19-20`, and it is a **constant set
/// derived in Rust** — the caller picks a rung of the ladder, it cannot
/// introduce a binary. The default (the ladder head) is what `create()` used
/// before anyone expressed a preference.
pub fn allowed_shells(env: &BTreeMap<String, String>, platform: &str) -> Vec<String> {
    let path = env.get("PATH").map(String::as_str);
    let mut allowed: Vec<String> = Vec::new();
    let mut consider = |candidate: Option<&str>| {
        let Some(candidate) = candidate.filter(|value| !value.is_empty()) else {
            return;
        };
        if is_executable(candidate, path) && !allowed.iter().any(|seen| seen == candidate) {
            allowed.push(candidate.to_string());
        }
    };
    if platform == "win32" {
        // `%ComSpec%` is the user's own shell, so it is probed before `cmd.exe`.
        consider(env.get("ComSpec").map(String::as_str));
        for candidate in WINDOWS_SHELL_CANDIDATES {
            consider(Some(candidate));
        }
        consider(Some("cmd.exe"));
    } else {
        consider(env.get("SHELL").map(String::as_str));
        for candidate in POSIX_SHELL_CANDIDATES {
            consider(Some(candidate));
        }
    }
    allowed
}

/// `resolveTerminalShell` (`shell.rs:80-114`): the head of the ladder, or the
/// error the legacy code threw. A terminal that silently got a *different*
/// shell than the ladder names is a behaviour fork, and a terminal that spawns
/// nothing is the safe failure — so exhaustion is an error, never a guess.
pub fn resolve_terminal_shell(
    env: &BTreeMap<String, String>,
    platform: &str,
) -> Result<String, String> {
    allowed_shells(env, platform)
        .into_iter()
        .next()
        .ok_or_else(|| "no usable shell found for terminal startup".to_string())
}

// ---------------------------------------------------------------------------
// Confinement
// ---------------------------------------------------------------------------

/// The canonicalised allowlist one spawn is confined to.
///
/// Mirrors `zcode-fs::Roots` (`packages/rust/crates/zcode-fs/src/containment.rs:97`).
/// A root that cannot be canonicalised is **skipped**, not an error: it cannot
/// contain anything, so dropping it is fail-closed. If every root is dropped the
/// allowlist is empty and every cwd is refused.
#[derive(Debug, Default, Clone)]
pub struct TerminalRoots {
    canonical: Vec<PathBuf>,
}

impl TerminalRoots {
    /// Canonicalise each root once. Symlinks inside a root are resolved here, so
    /// the comparison later is between two fully-resolved paths.
    pub fn from_raw(raw: &[String]) -> Self {
        let mut canonical = Vec::with_capacity(raw.len());
        for root in raw {
            if let Ok(resolved) = std::fs::canonicalize(root) {
                canonical.push(resolved);
            }
        }
        Self { canonical }
    }

    /// An allowlist that admits nothing. There is no "unconfined" constructor.
    pub fn is_empty(&self) -> bool {
        self.canonical.is_empty()
    }

    /// `Path::starts_with` compares whole components, so `/ws-evil` does not
    /// start with `/ws`. That sibling-prefix guard is why no separator is
    /// appended by hand.
    fn contains(&self, canonical: &Path) -> bool {
        self.canonical
            .iter()
            .any(|root| canonical == root.as_path() || canonical.starts_with(root))
    }

    /// The canonical cwd a request may start in, or the refusal it earns.
    ///
    /// The reason strings are the ones `policy.rs:50-52` fixed, so a client can
    /// branch on them without this module inventing a second vocabulary.
    pub fn admit(&self, requested: &str) -> CommandResult<PathBuf> {
        let resolved = std::fs::canonicalize(requested).map_err(|error| {
            CommandError::Forbidden(format!(
                "cwd-unresolvable: {requested}: {}",
                error.kind()
            ))
        })?;
        if !resolved.is_dir() {
            return Err(CommandError::Forbidden(format!(
                "cwd-unresolvable: not a directory: {requested}"
            )));
        }
        if !self.contains(&resolved) {
            return Err(CommandError::Forbidden(format!(
                "cwd-outside-roots: path is not inside an allowed root: {requested}"
            )));
        }
        Ok(resolved)
    }
}

/// Reject a payload whose `roots` resolve to nothing, before anything else
/// happens. Kept separate from [`TerminalRoots`] so "you must state the roots"
/// reads as a rule, not as a consequence of an empty vector.
fn require_roots(roots: &[String]) -> CommandResult<TerminalRoots> {
    let allowlist = TerminalRoots::from_raw(roots);
    if allowlist.is_empty() {
        return Err(CommandError::Forbidden(
            "cwd-outside-roots: the terminal roots allowlist is empty, so no working \
             directory is reachable; a spawn without roots is refused, not defaulted"
                .to_string(),
        ));
    }
    Ok(allowlist)
}

/// A caller must be a registered window **and** a workspace window.
///
/// `AppState::is_main_window` excludes the tray, the update-status overlay and
/// every guest child webview, which is the surface where `initialization_script`
/// has exposed `window.zcodeBridge` to the page (`PORT_STATUS.md:160`). A guest
/// webview therefore cannot ask for a shell, and the label is read off the
/// injected `WebviewWindow` rather than off the payload.
fn require_terminal_caller(state: &AppState, label: &str) -> CommandResult<()> {
    require_registered_window(state, label)?;
    if !state.is_main_window(label) {
        return Err(CommandError::Forbidden(format!(
            "window {label} is not a workspace window; terminals are host-confined"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// `terminal_create`'s payload.
///
/// `deny_unknown_fields` and a **required** `roots`, per the command contract
/// in `CUTOVER_SPEC.md` §2. `cols`/`rows` are `u16`, so a negative, fractional
/// or absurd number fails at the deserialiser instead of reaching an `ioctl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCreateRequest {
    pub cols: u16,
    pub rows: u16,
    /// **Required.** Directories this terminal may start in, compared after
    /// symlink resolution. Omitting the field is a deserialisation error;
    /// sending `[]` is a refusal. There is no form of this request that spawns
    /// an unconfined shell.
    pub roots: Vec<String>,
    /// Where the shell starts. Must resolve inside `roots`. There is no
    /// `$HOME`/`/` fallback — see the module docs.
    pub cwd: Option<String>,
    /// Optional rung of the shell ladder. It must be one of the shells
    /// [`allowed_shells`] derives in Rust; a payload cannot introduce a binary.
    pub shell: Option<String>,
}

/// What `terminal_create` returns: the `{id, shell, …}` half of `create()`'s
/// result (`terminalService.ts:337-345`). The font and theme half is
/// `NO_NATIVE_EQUIV` here — see the module docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHandle {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: u32,
}

/// One entry of `terminal_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: u32,
}

/// `TERMINAL_DATA_EVENT`'s payload — the `onDynamicData` channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub id: String,
    pub data: String,
}

/// `TERMINAL_EXIT_EVENT`'s payload — the `onDynamicExit` channel, carrying the
/// same exit code `exitEmitter.fire(exitCode)` did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub id: String,
    pub exit_code: u32,
}

/// A `cols`/`rows` pair, range-checked before it reaches the pty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

fn check_size(cols: u16, rows: u16) -> CommandResult<(u16, u16)> {
    if !(1..=MAX_COLS).contains(&cols) {
        return Err(CommandError::InvalidPayload(format!(
            "cols-out-of-range: {cols} is not in 1..={MAX_COLS}"
        )));
    }
    if !(1..=MAX_ROWS).contains(&rows) {
        return Err(CommandError::InvalidPayload(format!(
            "rows-out-of-range: {rows} is not in 1..={MAX_ROWS}"
        )));
    }
    Ok((cols, rows))
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/// A spawn whose every input has been decided and admitted. Nothing in here
/// starts a process, which is what makes the confinement testable without a
/// `WebviewWindow` and without a pty.
#[derive(Debug, Clone)]
pub struct PlannedSpawn {
    pub shell: String,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub env: BTreeMap<String, String>,
}

/// Decide every input to a spawn, or refuse. There is no partial success: the
/// first refusal is the answer, and no process exists at that point.
pub fn plan_spawn(
    request: &TerminalCreateRequest,
    env: &BTreeMap<String, String>,
    platform: &str,
) -> CommandResult<PlannedSpawn> {
    let (cols, rows) = check_size(request.cols, request.rows)?;

    // The allowlist is required and non-empty. This is the check no caller can
    // route around: there is no path from a request without roots to a pty.
    let roots = require_roots(&request.roots)?;

    let cwd = request
        .cwd
        .as_deref()
        .ok_or_else(|| {
            CommandError::InvalidPayload(
                "cwd is required: the terminal service's $HOME-then-/ fallback is not \
                 reproduced, because it lands outside every allowlist a caller writes"
                    .to_string(),
            )
        })
        .and_then(|cwd| roots.admit(cwd))?;

    let allowed = allowed_shells(env, platform);
    let shell = match request.shell.as_deref() {
        None => allowed
            .first()
            .cloned()
            .ok_or_else(|| CommandError::Platform("no usable shell found for terminal startup".to_string()))?,
        Some(requested) => {
            // `==` against a Rust-derived set, never a prefix and never a
            // basename, so `/tmp/zsh` cannot satisfy a request for `/bin/zsh`.
            if !allowed.iter().any(|candidate| candidate == requested) {
                return Err(CommandError::Forbidden(format!(
                    "shell-not-allowed: {requested} is not a rung of the shell ladder"
                )));
            }
            requested.to_string()
        }
    };

    Ok(PlannedSpawn {
        shell,
        cwd,
        cols,
        rows,
        env: resolve_terminal_env(env, platform),
    })
}

/// The exact `CommandBuilder` a [`PlannedSpawn`] is executed with.
///
/// `CommandBuilder::new` seeds itself from **this process's** environment, and
/// `portable_pty` then clears and re-applies the builder's own map, so the
/// `env_clear` here is what makes the child environment exactly `plan.env`:
/// without it, a host variable that appeared after [`resolve_terminal_env`] ran
/// would still reach the shell. It is separated out so a test can read the
/// builder's full environment back with `iter_full_env_as_str` and assert the
/// whole map, not just the six denylisted names.
pub fn command_builder_for(plan: &PlannedSpawn) -> CommandBuilder {
    let mut builder = CommandBuilder::new(plan.shell.as_str());
    builder.cwd(&plan.cwd);
    builder.env_clear();
    for (name, value) in &plan.env {
        builder.env(name, value);
    }
    builder
}

/// A live pty: the master, the writer half, the reader half, and the child.
struct LivePty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
    pid: u32,
}

/// End a child that was spawned but will never reach a reader thread: `kill`
/// then `wait`, so the failure path leaves a reaped child rather than a zombie.
fn abandon_child(mut child: Box<dyn Child + Send + Sync>) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Open a pty and run the planned spawn on it.
fn open_pty(plan: &PlannedSpawn) -> Result<LivePty, String> {
    // `portable_pty`'s `as_command` substitutes `$HOME` when the configured cwd
    // is not a directory. That is a *silent* escape from the allowlist, so it
    // must be unreachable here: the plan was admitted as a directory, and this
    // re-check covers the window between the plan and the spawn.
    if !plan.cwd.is_dir() {
        return Err(format!(
            "the working directory {} is no longer a directory",
            plan.cwd.display()
        ));
    }

    let size = PtySize {
        rows: plan.rows,
        cols: plan.cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("openpty failed: {error}"))?;

    let child = pair
        .slave
        .spawn_command(command_builder_for(plan))
        .map_err(|error| format!("failed to start '{}': {error}", plan.shell))?;
    let pid = child.process_id().unwrap_or_default();
    // A `dup` of the same open file description, so the blocking read and the
    // write never contend. This is also why a write is never blocked by an idle
    // reader, and the reverse.
    //
    // A failure from here on has to end the child rather than just dropping the
    // master: closing the master `SIGHUP`s the foreground group, but nothing
    // reaps it, so returning an error would leave a zombie behind.
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            abandon_child(child);
            return Err(format!("could not clone the pty reader: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            abandon_child(child);
            return Err(format!("could not take the pty writer: {error}"));
        }
    };

    Ok(LivePty {
        master: pair.master,
        writer,
        reader,
        child,
        pid,
    })
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type SharedKiller = Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>;

/// A live terminal: the handles every later command needs, plus the provenance
/// that decides whether the caller may use them.
struct TerminalEntry {
    /// The window label that created it. Never from a payload.
    owner: String,
    shell: String,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    pid: u32,
    master: SharedMaster,
    writer: SharedWriter,
    killer: SharedKiller,
}

/// Hand-written because the handles are trait objects without `Debug`: the
/// registry's own `Debug` is what a `tracing` field or a poisoned-lock
/// diagnostic prints, and a pty fd is not a string.
impl std::fmt::Debug for TerminalEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalEntry")
            .field("owner", &self.owner)
            .field("shell", &self.shell)
            .field("cwd", &self.cwd)
            .field("cols", &self.cols)
            .field("rows", &self.rows)
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

impl TerminalEntry {
    fn info(&self, id: &str) -> TerminalInfo {
        TerminalInfo {
            id: id.to_string(),
            shell: self.shell.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            cols: self.cols,
            rows: self.rows,
            pid: self.pid,
        }
    }
}

/// Process-lifetime registry of live terminals, keyed by id.
///
/// `Clone` shares one registry: the reader thread gets a clone so it can remove
/// its own entry when the child exits, exactly as `terminals.delete(id)` ran
/// inside `p.onExit` (`terminalService.ts:328-334`).
#[derive(Debug, Default, Clone)]
pub struct TerminalRegistry {
    inner: Arc<RegistryInner>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    next_id: AtomicU64,
    entries: Mutex<HashMap<String, TerminalEntry>>,
}

impl Drop for RegistryInner {
    /// Kill whatever is still alive at teardown.
    ///
    /// Closing a pty master makes the kernel `SIGHUP` the foreground group, so an
    /// orphan would usually die on its own — but only once the process is gone,
    /// and not for a descendant that changed its own group. Signalling
    /// explicitly is the difference between "usually cleaned up" and "reaped".
    fn drop(&mut self) {
        let entries = self
            .entries
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in entries.values() {
            if let Ok(mut killer) = entry.killer.lock() {
                let _ = killer.kill();
            }
        }
        entries.clear();
    }
}

impl TerminalRegistry {
    /// The next id. `t`-prefixed so it cannot collide with the host ids
    /// `AppState::allocate_host_id` mints, which are bare `host-N` strings.
    fn allocate_id(&self) -> String {
        format!("t{}", self.inner.next_id.fetch_add(1, Ordering::SeqCst))
    }

    fn insert(&self, entry: TerminalEntry) -> String {
        let id = self.allocate_id();
        self.lock().insert(id.clone(), entry);
        id
    }

    fn remove(&self, id: &str) -> Option<TerminalEntry> {
        self.lock().remove(id)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, TerminalEntry>> {
        self.inner
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Resolve `id` **through its owner**: a window that did not create the
    /// terminal gets the same "not found" answer a wrong id would, so the
    /// registry does not become an existence oracle across windows.
    fn owned(&self, id: &str, owner: &str) -> CommandResult<TerminalEntry> {
        let entries = self.lock();
        let entry = entries
            .get(id)
            .filter(|entry| entry.owner == owner)
            .ok_or_else(|| CommandError::Platform(format!("Terminal not found: {id}")))?;
        // Only the shared handles are cloned, so the returned value holds no
        // descriptor of its own and cannot outlive the registry's entry.
        Ok(TerminalEntry {
            owner: entry.owner.clone(),
            shell: entry.shell.clone(),
            cwd: entry.cwd.clone(),
            cols: entry.cols,
            rows: entry.rows,
            pid: entry.pid,
            master: Arc::clone(&entry.master),
            writer: Arc::clone(&entry.writer),
            killer: Arc::clone(&entry.killer),
        })
    }

    fn owned_ids(&self, owner: &str) -> Vec<String> {
        self.lock()
            .iter()
            .filter(|(_, entry)| entry.owner == owner)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start a pty, confined to `request.roots`.
///
/// Electron: `create()` (`terminalService.ts:286-346`) — resolve the shell
/// (`:296`), resolve the cwd (`:297`), build the env (`:298`), spawn (`:314-321`),
/// register the `onData`/`onExit` emitters (`:328-334`). Async because the
/// original was, and because `spawn` is a syscall burst that must not sit on the
/// UI thread.
#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    terminals: State<'_, TerminalRegistry>,
    request: TerminalCreateRequest,
) -> CommandResult<TerminalHandle> {
    let label = window.label().to_string();
    require_terminal_caller(&app_state, &label)?;
    let plan = plan_spawn(&request, &parent_environment(), legacy_platform_id())?;
    let owner = label;

    let live = open_pty(&plan).map_err(|error| {
        CommandError::Platform(format!(
            "failed to start terminal with shell '{}' in '{}': {error}",
            plan.shell,
            plan.cwd.display()
        ))
    })?;

    let killer = live.child.clone_killer();
    let id = terminals.insert(TerminalEntry {
        owner: owner.clone(),
        shell: plan.shell.clone(),
        cwd: plan.cwd.clone(),
        cols: plan.cols,
        rows: plan.rows,
        pid: live.pid,
        master: Arc::new(Mutex::new(live.master)),
        writer: Arc::new(Mutex::new(live.writer)),
        killer: Arc::new(Mutex::new(killer)),
    });

    if let Err(error) = spawn_reader(
        app,
        terminals.inner.clone(),
        id.clone(),
        owner,
        live.reader,
        live.child,
    ) {
        // A reader that never starts would leave the pty registered and the
        // child unreaped, so the spawn is undone rather than half-committed.
        if let Some(entry) = terminals.remove(&id) {
            if let Ok(mut killer) = entry.killer.lock() {
                let _ = killer.kill();
            }
        }
        return Err(CommandError::Platform(format!(
            "failed to start the pty reader: {error}"
        )));
    }

    Ok(TerminalHandle {
        id,
        shell: plan.shell,
        cwd: plan.cwd.to_string_lossy().into_owned(),
        cols: plan.cols,
        rows: plan.rows,
        pid: live.pid,
    })
}

/// Push pty output to the owning window, and reap the child when it ends.
///
/// The reader and the child move in; the master and the writer stay in the
/// registry entry, because closing the master is what makes the kernel `SIGHUP`
/// the foreground process group, and the entry is what a kill drops.
fn spawn_reader(
    app: AppHandle,
    inner: Arc<RegistryInner>,
    id: String,
    owner: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
) -> Result<(), std::io::Error> {
    std::thread::Builder::new()
        .name(format!("zcode-pty-{id}"))
        .spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut exit_code = None;

            loop {
                // Checked before the blocking read, because an exit that leaves a
                // descendant holding the slave open produces no EOF at all.
                match child.try_wait() {
                    Ok(Some(status)) => {
                        exit_code = Some(status.exit_code());
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(%error, %id, "pty child could not be waited on");
                        break;
                    }
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let _ = app.emit_to(
                            &owner,
                            TERMINAL_DATA_EVENT,
                            TerminalDataEvent {
                                id: id.clone(),
                                data: String::from_utf8_lossy(&buffer[..count]).into_owned(),
                            },
                        );
                    }
                    // A pty master reports EIO rather than EOF once the last
                    // slave descriptor closes. That is the normal end of a
                    // terminal, not a failure.
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::BrokenPipe
                        ) =>
                    {
                        break
                    }
                    Err(error) => {
                        tracing::warn!(%error, %id, "pty reader stopped");
                        break;
                    }
                }
            }

            let exit_code = match exit_code {
                Some(code) => code,
                // The child is known to be gone (the read saw the slave close),
                // so the blocking wait returns immediately; it is also what
                // reaps it, which is why no zombie survives a terminal.
                None => child
                    .wait()
                    .map(|status| status.exit_code())
                    .unwrap_or(EXIT_CODE_REAP_FAILED),
            };
            // Dropping the entry closes the last master descriptor, which is
            // what makes the kernel SIGHUP anything still holding the slave.
            inner
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            let _ = app.emit_to(
                &owner,
                TERMINAL_EXIT_EVENT,
                TerminalExitEvent { id, exit_code },
            );
        })
        .map(|_handle| ())
}

/// Write caller bytes into a pty.
///
/// Electron: `write()` (`terminalService.ts:348-350`) piped `params.data`
/// straight through with no size limit. The limit is added here because the
/// bytes land in a shell that runs with the user's credentials, and an unbounded
/// buffer is a denial of service the renderer can aim at the host.
#[tauri::command]
pub async fn terminal_write(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    terminals: State<'_, TerminalRegistry>,
    id: String,
    data: String,
) -> CommandResult<()> {
    let label = window.label().to_string();
    require_terminal_caller(&app_state, &label)?;
    if data.len() > MAX_WRITE_BYTES {
        return Err(CommandError::InvalidPayload(format!(
            "terminal_write payload is {} bytes, over the {MAX_WRITE_BYTES} byte limit",
            data.len()
        )));
    }
    let entry = terminals.owned(&id, &label)?;

    // A pty's input buffer is finite and a shell that is not reading will fill
    // it, so the write can block. On the async runtime that stalls a worker and
    // every command behind it, so it goes to a blocking task — contract 4 of
    // `CUTOVER_SPEC.md` by another route.
    let writer = entry.writer;
    tokio::task::spawn_blocking(move || {
        let mut writer = writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        writer.write_all(data.as_bytes())
    })
    .await
    .map_err(|error| CommandError::Platform(error.to_string()))?
    .map_err(|error| CommandError::Platform(error.to_string()))
}

/// Tell a pty it was resized.
///
/// Electron: `resize()` (`terminalService.ts:352-354`) → `pty.resize(cols, rows)`.
/// The size is applied to the **pty**, not to a local field, so the kernel
/// delivers `SIGWINCH` to the shell's foreground group.
#[tauri::command]
pub async fn terminal_resize(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    terminals: State<'_, TerminalRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    let label = window.label().to_string();
    require_terminal_caller(&app_state, &label)?;
    let (cols, rows) = check_size(cols, rows)?;
    let entry = terminals.owned(&id, &label)?;

    let master = entry.master;
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    master
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .resize(size)
        .map_err(|error| CommandError::Platform(format!("TIOCSWINSZ failed for {id}: {error}")))?;

    if let Some(live) = terminals.lock().get_mut(&id) {
        live.cols = cols;
        live.rows = rows;
    }
    Ok(())
}

/// Kill one terminal. Electron: `dispose()` (`terminalService.ts:356-358`).
#[tauri::command]
pub async fn terminal_kill(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    terminals: State<'_, TerminalRegistry>,
    id: String,
) -> CommandResult<()> {
    let label = window.label().to_string();
    require_terminal_caller(&app_state, &label)?;
    let entry = terminals.owned(&id, &label)?;
    terminals.remove(&id);
    // Dropping the entry closed the master, which is what makes the kernel
    // SIGHUP the foreground group; the explicit kill is what reaches a shell
    // that has left that group.
    entry
        .killer
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .kill()
        .map_err(|error| CommandError::Platform(format!("failed to kill terminal {id}: {error}")))?;
    Ok(())
}

/// Kill every terminal this window owns — one window's share of `disposeAll`
/// (`terminalService.ts:368-375`). This is the call a window's close path should
/// make; see the report's `REQUIRED-CHANGE`.
#[tauri::command]
pub async fn terminal_kill_all(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    terminals: State<'_, TerminalRegistry>,
) -> CommandResult<Vec<String>> {
    let label = window.label().to_string();
    require_terminal_caller(&app_state, &label)?;
    let ids = terminals.owned_ids(&label);
    for id in &ids {
        if let Some(entry) = terminals.remove(id) {
            let _ = entry
                .killer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .kill();
        }
    }
    Ok(ids)
}

/// List this window's terminals. No other window's terminals are visible.
#[tauri::command]
pub async fn terminal_list(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    terminals: State<'_, TerminalRegistry>,
) -> CommandResult<Vec<TerminalInfo>> {
    let label = window.label().to_string();
    require_terminal_caller(&app_state, &label)?;
    let mut listed: Vec<TerminalInfo> = terminals
        .lock()
        .iter()
        .filter(|(_, entry)| entry.owner == label)
        .map(|(id, entry)| entry.info(id))
        .collect();
    listed.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(listed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    // -----------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------

    /// A scratch directory that canonicalises cleanly, so an assertion about
    /// the allowlist is not an assertion about `/tmp` being a symlink.
    fn scratch(name: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!(
            "zcode-terminal-test-{}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst),
            name
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("scratch dir");
        std::fs::canonicalize(&base).expect("canonical scratch dir")
    }

    /// `admit` takes the requested path as a `&str`, because that is what
    /// arrives on the wire.
    fn admits(roots: &TerminalRoots, path: &Path) -> bool {
        roots.admit(&path.to_string_lossy()).is_ok()
    }

    fn owned_root(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn env_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    // -----------------------------------------------------------------------
    // F1: the allowlist is mandatory and cannot be omitted
    // -----------------------------------------------------------------------

    #[test]
    fn omitting_the_roots_field_does_not_deserialise() {
        // A request with no `roots` must fail at the deserialiser. If this ever
        // starts succeeding, a caller has found the way to an unconfined spawn.
        for payload in [
            r#"{"cols":80,"rows":24}"#,
            r#"{"cols":80,"rows":24,"cwd":"/tmp"}"#,
            r#"{"cols":80,"rows":24,"cwd":"/tmp","roots":null}"#,
        ] {
            let parsed = serde_json::from_str::<TerminalCreateRequest>(payload);
            assert!(
                parsed.is_err(),
                "roots must be required; {payload} deserialised into {parsed:?}"
            );
        }
    }

    #[test]
    fn an_unknown_field_is_rejected() {
        let error = serde_json::from_str::<TerminalCreateRequest>(
            r#"{"cols":80,"rows":24,"roots":["/tmp"],"shell":"/bin/sh","sudo":true}"#,
        )
        .expect_err("deny_unknown_fields must reject `sudo`");
        assert!(error.to_string().contains("sudo"), "{error}");
    }

    #[test]
    fn an_empty_allowlist_reaches_nothing() {
        let request = TerminalCreateRequest {
            cols: 80,
            rows: 24,
            roots: Vec::new(),
            cwd: Some("/tmp".to_string()),
            shell: None,
        };
        let error =
            plan_spawn(&request, &env_of(&[]), "linux").expect_err("empty roots must refuse");
        assert!(
            matches!(&error, CommandError::Forbidden(message) if message.starts_with("cwd-outside-roots")),
            "{error:?}"
        );
    }

    #[test]
    fn a_cwd_outside_the_allowlist_is_refused() {
        let root = scratch("outside");
        let outside = scratch("outside-target");
        let request = TerminalCreateRequest {
            cols: 80,
            rows: 24,
            roots: vec![owned_root(&root)],
            cwd: Some(owned_root(&outside)),
            shell: None,
        };
        let error = plan_spawn(&request, &env_of(&[]), "linux").expect_err("must refuse");
        assert!(
            matches!(&error, CommandError::Forbidden(message) if message.starts_with("cwd-outside-roots")),
            "{error:?}"
        );
    }

    #[test]
    fn a_symlinked_cwd_escaping_the_root_is_refused() {
        let root = scratch("symlink-root");
        let outside = scratch("symlink-target");
        // The symlink lives *inside* the root and points out of it, which is the
        // case a lexical `starts_with` check admits and a canonicalising one does
        // not.
        let link = root.join("escape");
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");
        let request = TerminalCreateRequest {
            cols: 80,
            rows: 24,
            roots: vec![owned_root(&root)],
            cwd: Some(link.to_string_lossy().into_owned()),
            shell: None,
        };
        let error = plan_spawn(&request, &env_of(&[]), "linux").expect_err("must refuse");
        assert!(
            matches!(&error, CommandError::Forbidden(message) if message.starts_with("cwd-outside-roots")),
            "{error:?}"
        );
        // The same root still admits its real contents, so the refusal is about
        // the symlink and not about the allowlist being broken.
        assert!(admits(&TerminalRoots::from_raw(&[owned_root(&root)]), &root));
    }

    #[test]
    fn a_sibling_prefix_is_not_inside_the_root() {
        let base = scratch("sibling");
        let root = base.join("ws");
        let sibling = base.join("ws-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let allowlist = TerminalRoots::from_raw(&[owned_root(&root)]);
        assert!(admits(&allowlist, &root));
        assert!(!admits(&allowlist, &sibling));
    }

    #[test]
    fn a_cwd_that_does_not_exist_is_refused_rather_than_defaulted() {
        let root = scratch("missing");
        let request = TerminalCreateRequest {
            cols: 80,
            rows: 24,
            roots: vec![owned_root(&root)],
            cwd: Some(owned_root(&root.join("nope"))),
            shell: None,
        };
        let error = plan_spawn(&request, &env_of(&[]), "linux").expect_err("must refuse");
        assert!(
            matches!(&error, CommandError::Forbidden(message) if message.starts_with("cwd-unresolvable")),
            "{error:?}"
        );
    }

    #[test]
    fn omitting_cwd_does_not_fall_back_to_home_or_root() {
        // `resolveTerminalCwd` (terminalService.ts:310-321) fell back to `$HOME`
        // and then `/`. Reproducing that would put a shell outside every
        // allowlist the caller wrote, so a missing cwd is a refusal.
        let request = TerminalCreateRequest {
            cols: 80,
            rows: 24,
            roots: vec!["/".to_string()],
            cwd: None,
            shell: None,
        };
        let error =
            plan_spawn(&request, &env_of(&[("HOME", "/home/someone")]), "linux")
                .expect_err("must refuse");
        assert!(
            matches!(&error, CommandError::InvalidPayload(message) if message.starts_with("cwd is required")),
            "{error:?}"
        );
    }

    #[test]
    fn a_root_that_cannot_be_canonicalised_is_skipped_not_ignored() {
        let allowlist = TerminalRoots::from_raw(&["/definitely/not/here".to_string()]);
        assert!(allowlist.is_empty());
        let error = allowlist.admit("/tmp").expect_err("must refuse");
        assert!(matches!(&error, CommandError::Forbidden(_)), "{error:?}");
    }

    #[test]
    fn a_confinement_decision_starts_no_process() {
        // The refusal has to happen before `openpty`, not after: a plan that is
        // refused must not have a child, a pty or a registry entry behind it.
        let root = scratch("no-process");
        let request = TerminalCreateRequest {
            cols: 80,
            rows: 24,
            roots: vec![owned_root(&root)],
            cwd: Some("/definitely/not/here".to_string()),
            shell: None,
        };
        assert!(plan_spawn(&request, &parent_environment(), legacy_platform_id()).is_err());
    }

    // -----------------------------------------------------------------------
    // F2: the caller
    // -----------------------------------------------------------------------

    #[test]
    fn only_a_workspace_window_may_reach_the_terminal_surface() {
        let state = AppState::new();
        state.register_window("main", true);
        state.register_window("guest", false);
        require_terminal_caller(&state, "main").expect("a workspace window may spawn");
        let guest = require_terminal_caller(&state, "guest").expect_err("a guest may not");
        assert!(matches!(&guest, CommandError::Forbidden(_)), "{guest:?}");
        let unknown = require_terminal_caller(&state, "never-registered").expect_err("unregistered");
        assert!(
            matches!(&unknown, CommandError::WindowUnavailable(_)),
            "{unknown:?}"
        );
    }

    // -----------------------------------------------------------------------
    // F3: the shell is a rung of the ladder, not a payload
    // -----------------------------------------------------------------------

    #[test]
    fn the_shell_must_be_a_ladder_rung() {
        let root = scratch("shell");
        let env = env_of(&[("SHELL", "/bin/sh"), ("PATH", "/bin:/usr/bin")]);
        let allowed = allowed_shells(&env, "linux");
        assert!(allowed.contains(&"/bin/sh".to_string()), "{allowed:?}");

        let root_string = owned_root(&root);
        let request = |shell: &str| TerminalCreateRequest {
            cols: 80,
            rows: 24,
            roots: vec![root_string.clone()],
            cwd: Some(root_string.clone()),
            shell: Some(shell.to_string()),
        };

        // A rung of the ladder is admitted.
        let rung = allowed.first().expect("at least one rung").clone();
        plan_spawn(&request(&rung), &env, "linux")
            .unwrap_or_else(|error| panic!("{rung} is a ladder rung but was refused: {error:?}"));

        // A same-basename binary outside the ladder is not, even though the
        // ladder contains `/bin/sh`.
        let error = plan_spawn(&request("/tmp/sh"), &env, "linux").expect_err("must refuse");
        assert!(
            matches!(&error, CommandError::Forbidden(message) if message.starts_with("shell-not-allowed")),
            "{error:?}"
        );
    }

    #[test]
    fn the_ladder_order_is_the_users_shell_first() {
        let env = env_of(&[("SHELL", "/bin/bash"), ("PATH", "/usr/bin:/bin")]);
        let allowed = allowed_shells(&env, "linux");
        assert_eq!(
            allowed.first().map(String::as_str),
            Some("/bin/bash"),
            "{allowed:?}"
        );
        assert_eq!(resolve_terminal_shell(&env, "linux").unwrap(), "/bin/bash");
    }

    #[test]
    fn an_exhausted_ladder_is_an_error_not_a_guess() {
        // A stale `$SHELL` never reaches `execve`; the ladder continues past it
        // to the first fallback that actually exists on this host.
        let posix = env_of(&[("SHELL", "/nowhere/zsh"), ("PATH", "/usr/bin:/bin")]);
        let resolved = resolve_terminal_shell(&posix, "linux").unwrap();
        assert_ne!(resolved, "/nowhere/zsh", "a shell that is not there was chosen");
        assert!(POSIX_SHELL_CANDIDATES.contains(&resolved.as_str()));

        // Every `win32` candidate is a bare name, so it is only reachable through
        // `PATH`. With no `PATH` and no `%ComSpec%` the ladder is genuinely
        // empty, and exhaustion is an error — never a guess at some `sh`.
        let windows = env_of(&[("PATH", "")]);
        assert!(allowed_shells(&windows, "win32").is_empty());
        assert!(resolve_terminal_shell(&windows, "win32").is_err());
    }

    // -----------------------------------------------------------------------
    // F4: the size range
    // -----------------------------------------------------------------------

    #[test]
    fn cols_and_rows_are_range_checked() {
        assert!(check_size(80, 24).is_ok());
        assert!(check_size(MAX_COLS, MAX_ROWS).is_ok());
        assert!(check_size(0, 24).is_err());
        assert!(check_size(80, 0).is_err());
        assert!(check_size(MAX_COLS + 1, 24).is_err());
        assert!(check_size(80, MAX_ROWS + 1).is_err());
        // `u16` on the wire means a negative or fractional size never reaches
        // these checks — it fails to deserialise first.
        assert!(serde_json::from_str::<TerminalSize>(r#"{"cols":-1,"rows":24}"#).is_err());
        assert!(serde_json::from_str::<TerminalSize>(r#"{"cols":80.5,"rows":24}"#).is_err());
    }

    // -----------------------------------------------------------------------
    // F5: the environment the child receives
    // -----------------------------------------------------------------------

    #[test]
    fn the_child_environment_strips_the_loader_injection_names() {
        let parent = env_of(&[
            ("PATH", "/usr/bin:/bin"),
            ("LD_PRELOAD", "/tmp/evil.so"),
            ("LD_LIBRARY_PATH", "/tmp/evil"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib"),
            ("DYLD_LIBRARY_PATH", "/tmp/evil"),
            ("NODE_OPTIONS", "--require /tmp/evil.js"),
            ("ELECTRON_RUN_AS_NODE", "1"),
            ("HOME", "/home/someone"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
            ("GITHUB_TOKEN", "ghp_secret"),
        ]);
        let child = resolve_terminal_env(&parent, "linux");
        for name in DEFAULT_ENV_DENYLIST {
            assert!(
                !child.contains_key(name),
                "{name} crossed into the terminal environment"
            );
        }
        // The rest of the environment is inherited: an allowlist here would break
        // every user's shell, which is documented in the module header.
        for name in ["PATH", "HOME", "SSH_AUTH_SOCK", "GITHUB_TOKEN"] {
            assert_eq!(child.get(name), parent.get(name), "{name} must be inherited");
        }
    }

    #[test]
    fn the_terminal_behaviour_variables_are_set_explicitly() {
        let parent = env_of(&[("CI", "1"), ("TERM", "dumb"), ("LANG", "C")]);
        let child = resolve_terminal_env(&parent, "linux");
        // `TERM` is what stops starship/p10k rendering unstyled output.
        assert_eq!(child.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(
            child.get("COLORTERM").map(String::as_str),
            Some("truecolor"),
            "an absent COLORTERM defaults to truecolor"
        );
        // `CI=1` is only dropped when the host was itself the runtime probe.
        assert!(!child.contains_key("CI"));
        // The C locale is replaced so non-ASCII paths are not rendered as `\M-^`.
        assert_eq!(child.get("LANG").map(String::as_str), Some("C.UTF-8"));
        assert_eq!(child.get("LC_CTYPE").map(String::as_str), Some("C.UTF-8"));
    }

    #[test]
    fn ci_and_a_non_dumb_term_are_left_alone() {
        let parent = env_of(&[("CI", "1"), ("TERM", "xterm")]);
        assert_eq!(
            resolve_terminal_env(&parent, "linux")
                .get("CI")
                .map(String::as_str),
            Some("1"),
            "CI is the user's, not the probe's, when the host TERM is not dumb"
        );
    }

    #[test]
    fn a_locale_the_user_configured_is_never_replaced() {
        let parent = env_of(&[("LANG", "ja_JP.UTF-8"), ("LC_ALL", "zh_CN.GB18030")]);
        let child = resolve_terminal_env(&parent, "linux");
        assert_eq!(child.get("LANG").map(String::as_str), Some("ja_JP.UTF-8"));
        assert_eq!(
            child.get("LC_ALL").map(String::as_str),
            Some("zh_CN.GB18030"),
            "LC_ALL is set, so an explicit C value is replaced but a real one is kept"
        );
    }

    #[test]
    fn an_absent_lc_all_is_not_invented() {
        // The legacy code only rewrites `LC_ALL` when it is already present, so
        // inventing one would override `LANG` in glibc and change behaviour.
        let child = resolve_terminal_env(&env_of(&[("LANG", "en_US.UTF-8")]), "linux");
        assert!(!child.contains_key("LC_ALL"));
    }

    #[test]
    fn the_darwin_gui_path_merge_is_darwin_only_and_keeps_order() {
        let parent = env_of(&[("PATH", "/custom/bin:/usr/bin"), ("LANG", "en_US.UTF-8")]);
        let mac = resolve_terminal_env(&parent, "darwin");
        let path = mac.get("PATH").expect("PATH");
        assert!(path.starts_with("/custom/bin"), "user order is kept: {path}");
        assert!(path.contains("/opt/homebrew/bin"), "{path}");
        assert_eq!(
            path.matches("/usr/bin").count(),
            1,
            "duplicates are dropped: {path}"
        );

        let linux = resolve_terminal_env(&parent, "linux");
        assert_eq!(
            linux.get("PATH").map(String::as_str),
            Some("/custom/bin:/usr/bin"),
            "no Homebrew paths on a non-darwin host"
        );
    }

    #[test]
    fn the_parent_environment_is_never_mutated() {
        let parent = env_of(&[("TERM", "dumb"), ("CI", "1"), ("LANG", "C")]);
        let before = parent.clone();
        let _ = resolve_terminal_env(&parent, "linux");
        assert_eq!(parent, before, "resolve_terminal_env must not touch the parent");
    }

    #[test]
    fn the_child_environment_is_exactly_the_computed_one() {
        // The whole map, not just the six denylisted names: `CommandBuilder::new`
        // seeds itself from this process's environment, so without the
        // `env_clear` in `command_builder_for` every host variable — including
        // whatever the host gained after the plan was made — would reach the
        // shell. This is the assertion that makes a scrub regression a test
        // failure rather than a shipped behaviour change.
        // The parent map is the *live* process environment minus one variable,
        // so the assertion below is about a variable that is genuinely set in
        // this process and must not reach the shell.
        let mut parent = parent_environment();
        let host_only = parent
            .keys()
            .next()
            .cloned()
            .expect("the test process has an environment");
        parent.remove(&host_only);
        parent.insert("LD_PRELOAD".to_string(), "/tmp/evil.so".to_string());

        let plan = PlannedSpawn {
            shell: "/bin/sh".to_string(),
            cwd: PathBuf::from("/"),
            cols: 80,
            rows: 24,
            env: resolve_terminal_env(&parent, "linux"),
        };
        let actual: BTreeMap<String, String> = command_builder_for(&plan)
            .iter_full_env_as_str()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();

        assert_eq!(
            actual, plan.env,
            "the builder's environment must be the computed one and nothing else"
        );
        assert!(
            !actual.contains_key("LD_PRELOAD"),
            "a denylisted loader variable reached the child environment"
        );
        assert!(
            !actual.contains_key(&host_only),
            "{host_only} is set in this process but not in the computed \
             environment, so it must not have leaked into the child"
        );
    }

    // -----------------------------------------------------------------------
    // F6: the pty itself
    // -----------------------------------------------------------------------

    /// A real pty, end to end: bytes in, bytes out through the pty, a resize the
    /// **kernel** holds, and a kill that takes the child with it.
    #[test]
    fn a_pty_carries_data_a_resize_and_a_kill() {
        let root = scratch("pty");
        let plan = PlannedSpawn {
            // `cat` rather than a shell: it echoes stdin to stdout through the
            // line discipline, so the assertion is about the pty and not about a
            // shell's start-up banner.
            shell: "/bin/cat".to_string(),
            cwd: root,
            cols: 80,
            rows: 24,
            env: resolve_terminal_env(
                &env_of(&[("PATH", "/usr/bin:/bin"), ("LANG", "C"), ("TERM", "dumb")]),
                "linux",
            ),
        };
        let mut live = open_pty(&plan).expect("spawn a pty");
        assert!(live.pid > 0);

        // 1. Data reaches the child and comes back through the pty.
        live.writer
            .write_all(b"zcode-pty-roundtrip\n")
            .expect("write to the pty");
        let echoed = drain_until(&mut live.reader, "zcode-pty-roundtrip", Duration::from_secs(10));
        assert!(
            echoed.contains("zcode-pty-roundtrip"),
            "the pty round-trip failed; saw {echoed:?}"
        );

        // 2. The size the kernel holds for the pty is the size we asked for.
        let initial = live.master.get_size().expect("the pty has a size");
        assert_eq!((initial.cols, initial.rows), (80, 24));

        // 3. A resize reaches the terminal — read back from the pty, not from a
        //    field this process kept.
        live.master
            .resize(PtySize {
                cols: 132,
                rows: 43,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("resize the pty");
        let resized = live.master.get_size().expect("the pty has a size");
        assert_eq!((resized.cols, resized.rows), (132, 43));

        // 4. A kill reaches the child and it is reaped, so it does not survive as
        //    a zombie.
        live.child.kill().expect("kill the pty child");
        let status = live.child.wait().expect("reap the pty child");
        assert!(!status.success(), "a SIGKILLed shell does not exit successfully");
        assert_reaped(live.pid);
    }

    /// The registry path the commands use: an entry is only reachable, and only
    /// enumerable, through the window that created it.
    #[test]
    fn a_terminal_is_only_reachable_by_its_owner() {
        let root = scratch("ownership");
        let registry = TerminalRegistry::default();
        let id = registry.insert(fake_entry("main", root));
        let other = registry.insert(fake_entry("other", scratch("ownership-other")));

        assert!(registry.owned(&id, "main").is_ok(), "the owner may resolve it");
        assert!(
            registry.owned(&id, "other").is_err(),
            "a second window must not resolve another window's terminal"
        );
        assert_eq!(registry.owned_ids("main"), vec![id.clone()]);
        assert_eq!(registry.owned_ids("other"), vec![other]);
    }

    /// `Drop` kills what is left, which is the teardown guarantee `disposeAll`
    /// provided and a reader thread alone does not give.
    #[test]
    fn dropping_the_registry_kills_what_is_left() {
        let root = scratch("drop");
        let plan = PlannedSpawn {
            shell: "/bin/sh".to_string(),
            cwd: root.clone(),
            cols: 80,
            rows: 24,
            env: resolve_terminal_env(&env_of(&[("PATH", "/usr/bin:/bin")]), "linux"),
        };
        let mut live = open_pty(&plan).expect("spawn a pty");
        let pid = live.pid;
        let killer = live.child.clone_killer();
        // The master, the writer and the reader all stay alive in `live`: the
        // point is that the *registry* is what ends the child, not the last
        // descriptor to close. The reader thread is the thing that reaps in
        // production, so this test does the same by hand.
        {
            let registry = TerminalRegistry::default();
            registry.insert(live_entry("main", root, pid, killer));
        }
        live.child.wait().expect("the kill left the child waitable");
        assert_reaped(pid);
    }

    // -- pty test helpers ---------------------------------------------------

    fn drain_until(
        reader: &mut Box<dyn Read + Send>,
        needle: &str,
        timeout: Duration,
    ) -> String {
        let deadline = Instant::now() + timeout;
        let mut seen = String::new();
        let mut buffer = [0u8; 4096];
        while Instant::now() < deadline {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    seen.push_str(&String::from_utf8_lossy(&buffer[..count]));
                    if seen.contains(needle) {
                        break;
                    }
                }
            }
        }
        seen
    }

    /// A `Box<dyn Write + Send>` is not constructible without a pty, so the
    /// ownership tests use `/dev/null` through `portable_pty`'s own writer
    /// semantics: an in-memory sink is enough because those tests never write.
    fn sink() -> Box<dyn Write + Send> {
        Box::new(std::io::sink())
    }

    fn killer_stub() -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(StubKiller)
    }

    #[derive(Debug)]
    struct StubKiller;

    impl ChildKiller for StubKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            killer_stub()
        }
    }

    fn fake_entry(owner: &str, cwd: PathBuf) -> TerminalEntry {
        TerminalEntry {
            owner: owner.to_string(),
            shell: "/bin/sh".to_string(),
            cwd,
            cols: 80,
            rows: 24,
            pid: 0,
            master: Arc::new(Mutex::new(unused_master())),
            writer: Arc::new(Mutex::new(sink())),
            killer: Arc::new(Mutex::new(killer_stub())),
        }
    }

    fn live_entry(
        owner: &str,
        cwd: PathBuf,
        pid: u32,
        killer: Box<dyn ChildKiller + Send + Sync>,
    ) -> TerminalEntry {
        TerminalEntry {
            owner: owner.to_string(),
            shell: "/bin/sh".to_string(),
            cwd,
            cols: 80,
            rows: 24,
            pid,
            master: Arc::new(Mutex::new(unused_master())),
            writer: Arc::new(Mutex::new(sink())),
            killer: Arc::new(Mutex::new(killer)),
        }
    }

    /// A pty opened and immediately dropped, for the tests that only need the
    /// handle types to exist.
    fn unused_master() -> Box<dyn MasterPty + Send> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        pair.master
    }

    /// On Linux a reaped pid has no `/proc` entry and an unreaped one still
    /// does, so this distinguishes "gone" from "zombie".
    #[cfg(target_os = "linux")]
    fn assert_reaped(pid: u32) {
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "pid {pid} survived the kill; a zombie would still have a /proc entry"
        );
    }

    #[cfg(not(target_os = "linux"))]
    fn assert_reaped(_pid: u32) {}
}
