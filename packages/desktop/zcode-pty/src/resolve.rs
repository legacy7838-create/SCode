//! Port of the shell/cwd/env resolution from the old node-pty service.
//!
//! These are pure-OS functions (no PTY), unit-tested in isolation. They preserve the exact
//! candidate order and fallback semantics of `resolveTerminalShell`, `resolveTerminalCwd`
//! and `resolveTerminalEnv`, including the macOS GUI PATH fix, the `TERM`/`COLORTERM` force,
//! and the UTF-8 locale backfill.

use std::collections::BTreeMap;
use std::path::Path;

/// macOS Dock/Finder/Launchpad launches hand the Electron host a very narrow `PATH`
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) or none at all, so the login shell inherits it and
/// loses `npm`/`pnpm`/brew tooling. Merged only into the terminal env, never the host.
#[cfg(target_os = "macos")]
const DARWIN_GUI_FALLBACK_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// True when `value` advertises a UTF-8 codeset (parity with the old `/utf-?8/i` test).
fn is_utf8_locale(value: Option<&str>) -> bool {
    match value {
        Some(v) => {
            let lower = v.to_ascii_lowercase();
            lower.contains("utf8") || lower.contains("utf-8")
        }
        None => false,
    }
}

/// True when a locale is absent or the classic C/POSIX locale (which mangles non-ASCII).
fn is_missing_or_c_locale(value: Option<&str>) -> bool {
    match value {
        None => true,
        Some(v) => {
            let normalized = v.trim().to_ascii_uppercase();
            normalized.is_empty() || normalized == "C" || normalized == "POSIX"
        }
    }
}

/// A candidate is executable: an explicit path is checked directly (plus the exec bit on
/// unix); a bare name is looked up on `PATH`, mirroring the old `isExecutable`.
fn is_executable(command: &str) -> bool {
    if command.is_empty() {
        return false;
    }
    let has_separator = command.contains('/') || command.contains('\\');
    if has_separator {
        return path_is_executable(Path::new(command));
    }
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    std::env::split_paths(&path).any(|dir| {
        if dir.as_os_str().is_empty() {
            return false;
        }
        let candidate = dir.join(command);
        path_is_executable(&candidate)
    })
}

#[cfg(unix)]
fn path_is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(windows)]
fn path_is_executable(path: &Path) -> bool {
    // Windows has no exec bit; existence of the file is the executable signal here, and the
    // candidates are all `.exe` (pwsh/powershell/cmd) or `ComSpec`.
    path.is_file()
}

/// Resolve the shell to launch, preserving the old candidate order per platform.
pub fn resolve_shell() -> Result<String, &'static str> {
    #[cfg(windows)]
    let candidates: Vec<Option<String>> = {
        let comspec = std::env::var("ComSpec").ok();
        vec![
            Some("pwsh.exe".to_string()),
            Some("powershell.exe".to_string()),
            comspec,
            Some("cmd.exe".to_string()),
        ]
    };

    #[cfg(not(windows))]
    let candidates: Vec<Option<String>> = {
        let shell = std::env::var("SHELL").ok();
        vec![
            shell,
            Some("/bin/zsh".to_string()),
            Some("/bin/bash".to_string()),
            Some("/bin/sh".to_string()),
        ]
    };

    for candidate in candidates.into_iter().flatten() {
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err("No usable shell found for terminal startup")
}

/// Resolve the working directory: requested path, then HOME, then homedir, then root.
pub fn resolve_cwd(cwd: Option<&str>) -> Result<String, &'static str> {
    let home_env = std::env::var("HOME").ok();
    let home_dir = home::home_dir().map(|p| p.to_string_lossy().into_owned());

    let candidates = [
        cwd.map(|s| s.to_string()),
        home_env,
        home_dir,
        Some(if cfg!(windows) { "C:\\".to_string() } else { "/".to_string() }),
    ];

    for candidate in candidates.into_iter().flatten() {
        if Path::new(&candidate).is_dir() {
            return Ok(candidate);
        }
    }
    Err("No usable working directory found for terminal startup")
}

/// Merge PATH entries (existing first, fallbacks appended) deduplicating, order-preserving.
#[cfg(target_os = "macos")]
fn merge_path_entries(entries: &[Option<String>], fallbacks: &[&str]) -> String {
    let mut seen: Vec<String> = Vec::new();
    for value in entries.iter().flatten() {
        for part in std::env::split_paths(std::ffi::OsStr::new(value)) {
            let s = part.to_string_lossy().into_owned();
            let trimmed = s.trim();
            if !trimmed.is_empty() && !seen.iter().any(|e| e == trimmed) {
                seen.push(trimmed.to_string());
            }
        }
    }
    for fb in fallbacks {
        let trimmed = (*fb).trim();
        if !trimmed.is_empty() && !seen.iter().any(|e| e == trimmed) {
            seen.push(trimmed.to_string());
        }
    }
    std::env::join_paths(seen.iter().map(std::ffi::OsString::from))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| seen.join(":"))
}

/// The UTF-8 locale to fall back to when the inherited one is missing or C/POSIX.
fn resolve_fallback_utf8_locale(env: &BTreeMap<String, String>) -> String {
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if is_utf8_locale(env.get(key).map(String::as_str)) {
            return env[key].clone();
        }
    }
    if cfg!(target_os = "macos") {
        "en_US.UTF-8".to_string()
    } else {
        "C.UTF-8".to_string()
    }
}

/// True when an `LD_LIBRARY_PATH`/`LD_PRELOAD` entry points into the running AppImage's mounted
/// squashfs — either under `$APPDIR` or the `/tmp/.mount_*` signature — and so shadows a system lib.
fn is_appimage_mount_entry(entry: &str, appdir: &str) -> bool {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return false;
    }
    if !appdir.is_empty() && (trimmed == appdir || trimmed.starts_with(&format!("{appdir}/"))) {
        return true;
    }
    trimmed.contains("/.mount_")
}

/// Strip AppImage-mount entries from the child shell's `LD_LIBRARY_PATH` so host binaries launched
/// from the integrated terminal resolve system libraries (not the AppImage's unversioned bundled
/// copies). Removes the variable entirely if nothing remains. No-op when the path is clean.
fn sanitize_appimage_library_path(env: &mut BTreeMap<String, String>) {
    let appdir = env.get("APPDIR").cloned().unwrap_or_default();
    if let Some(value) = env.get("LD_LIBRARY_PATH").cloned() {
        let total = value.split(':').count();
        let kept: Vec<&str> = value
            .split(':')
            .filter(|entry| !is_appimage_mount_entry(entry, &appdir))
            .collect();
        if kept.len() != total {
            if kept.is_empty() {
                env.remove("LD_LIBRARY_PATH");
            } else {
                env.insert("LD_LIBRARY_PATH".to_string(), kept.join(":"));
            }
        }
    }
}

/// Build the environment passed to the shell: inherited env plus the interactive-terminal
/// fixes (macOS PATH backfill, `TERM=xterm-256color`, `COLORTERM`, `CI` removal, UTF-8 locale).
pub fn resolve_env() -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    let inherited_term = env.get("TERM").cloned();
    let fallback_locale = resolve_fallback_utf8_locale(&env);

    #[cfg(target_os = "macos")]
    {
        let merged = merge_path_entries(&[env.get("PATH").cloned()], DARWIN_GUI_FALLBACK_PATHS);
        env.insert("PATH".to_string(), merged);
    }

    env.insert("TERM".to_string(), "xterm-256color".to_string());
    let color_empty = env
        .get("COLORTERM")
        .map(|v| v.trim().is_empty())
        .unwrap_or(true);
    if color_empty {
        env.insert("COLORTERM".to_string(), "truecolor".to_string());
    }

    // A CI=1 probe environment captured with TERM=dumb would keep the shell non-interactive;
    // drop it only in that specific case so prompt/starship color detection is not degraded.
    if env.get("CI").map(String::as_str) == Some("1") && inherited_term.as_deref() == Some("dumb") {
        env.remove("CI");
    }

    // AppImage self-containment leaks into the shell: AppRun prepends the mounted `$APPDIR/usr/lib`
    // to LD_LIBRARY_PATH, and that env is inherited by the shell we spawn. Host tools launched from
    // the terminal (e.g. eza → libgit2 → libpcre2-8.so.0) then resolve the AppImage's *unversioned*
    // bundled copy and emit `no version information available`. The bundled lib must stay in the
    // package (the app's own libglib depends on it), but it must NOT shadow the shell's system libs,
    // so drop AppImage-mount entries from the child shell's LD_LIBRARY_PATH.
    sanitize_appimage_library_path(&mut env);

    if is_missing_or_c_locale(env.get("LANG").map(String::as_str)) {
        env.insert("LANG".to_string(), fallback_locale.clone());
    }
    if is_missing_or_c_locale(env.get("LC_CTYPE").map(String::as_str)) {
        env.insert("LC_CTYPE".to_string(), fallback_locale.clone());
    }
    // LC_ALL only when present but C/POSIX — never invent it (parity with the JS `!== undefined`).
    if env.contains_key("LC_ALL") && is_missing_or_c_locale(env.get("LC_ALL").map(String::as_str)) {
        env.insert("LC_ALL".to_string(), fallback_locale);
    }

    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_locale_detects_variants() {
        assert!(is_utf8_locale(Some("en_US.UTF-8")));
        assert!(is_utf8_locale(Some("C.utf8")));
        assert!(!is_utf8_locale(Some("C")));
        assert!(!is_utf8_locale(None));
    }

    #[test]
    fn missing_or_c_covers_posix() {
        assert!(is_missing_or_c_locale(None));
        assert!(is_missing_or_c_locale(Some("  ")));
        assert!(is_missing_or_c_locale(Some("C")));
        assert!(is_missing_or_c_locale(Some("POSIX")));
        assert!(!is_missing_or_c_locale(Some("en_US.UTF-8")));
    }

    #[test]
    fn shell_resolution_returns_an_executable_or_err() {
        // Whatever the CI host, either a real shell is found or we get the documented error.
        match resolve_shell() {
            Ok(shell) => assert!(is_executable(&shell), "resolved shell must be executable"),
            Err(msg) => assert_eq!(msg, "No usable shell found for terminal startup"),
        }
    }

    #[test]
    fn cwd_falls_back_to_an_existing_dir() {
        // A bogus requested cwd must not error; it falls back to HOME/root.
        let cwd = resolve_cwd(Some("/no/such/dir/xyz-123")).unwrap();
        assert!(Path::new(&cwd).is_dir());
    }

    #[test]
    fn strips_appimage_mount_from_ld_library_path() {
        let mut env = BTreeMap::new();
        env.insert(
            "LD_LIBRARY_PATH".to_string(),
            "/tmp/.mount_ZCode_abc/usr/lib:/usr/lib:/usr/local/lib".to_string(),
        );
        env.insert("APPDIR".to_string(), "/tmp/.mount_ZCode_abc".to_string());
        sanitize_appimage_library_path(&mut env);
        assert_eq!(
            env.get("LD_LIBRARY_PATH").map(String::as_str),
            Some("/usr/lib:/usr/local/lib")
        );
    }

    #[test]
    fn removes_ld_library_path_when_only_appdir_entries() {
        let mut env = BTreeMap::new();
        env.insert(
            "LD_LIBRARY_PATH".to_string(),
            "/tmp/.mount_ZCode_abc/usr/lib".to_string(),
        );
        sanitize_appimage_library_path(&mut env);
        assert!(!env.contains_key("LD_LIBRARY_PATH"));
    }

    #[test]
    fn leaves_a_normal_ld_library_path_untouched() {
        let mut env = BTreeMap::new();
        env.insert("LD_LIBRARY_PATH".to_string(), "/usr/lib:/opt/lib".to_string());
        sanitize_appimage_library_path(&mut env);
        assert_eq!(
            env.get("LD_LIBRARY_PATH").map(String::as_str),
            Some("/usr/lib:/opt/lib")
        );
    }
}
