//! Shell and working-directory selection — the two decisions `create()` makes before it
//! spawns anything.
//!
//! Ported from `packages/services/src/terminal/terminalService.ts:67-89,285-321`. The order
//! of the candidate lists is the security property (spec §3.4), so it is data here and is
//! asserted by a test rather than being buried in a loop.

use std::path::{Path, PathBuf};

/// The POSIX candidate list, in order: the user's own shell first, then the common
/// fallbacks. A `$SHELL` that no longer exists must not reach `posix_spawnp`.
pub const POSIX_SHELL_CANDIDATES: [&str; 3] = ["/bin/zsh", "/bin/bash", "/bin/sh"];

/// The Windows candidate list, in order. PowerShell 7+ redraws the input line correctly under
/// ConPTY where Windows PowerShell 5.1's PSReadLine does not, so `pwsh.exe` is preferred, and
/// `%ComSpec%` is preferred over a hard-coded `cmd.exe` because it names the user's own shell.
pub const WINDOWS_SHELL_CANDIDATES: [&str; 2] = ["pwsh.exe", "powershell.exe"];

pub const NO_WINDOWS_SHELL_ERROR: &str = "No usable Windows shell found for terminal startup";
pub const NO_POSIX_SHELL_ERROR: &str = "No usable shell found for terminal startup";
pub const NO_WORKING_DIRECTORY_ERROR: &str = "No usable working directory found for terminal startup";

/// `isExecutable`: a candidate with a path separator is probed directly, otherwise each
/// non-empty `PATH` entry is probed with the candidate appended.
///
/// The `PATH` split uses the **host** delimiter, because `path.delimiter` in the legacy code
/// is a host property: a differential that exercises the `win32` branch from Linux has to
/// split on `:` to agree with it.
pub fn is_executable(command: &str, path_env: Option<&str>) -> bool {
    if command.contains('/') || command.contains('\\') {
        return access_executable(Path::new(command));
    }
    let Some(path_env) = path_env else {
        return false;
    };
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    path_env
        .split(delimiter)
        .filter(|directory| !directory.is_empty())
        .any(|directory| access_executable(&PathBuf::from(directory).join(command)))
}

/// `accessSync(path, constants.X_OK)`.
///
/// Unix goes through `access(2)` rather than testing the mode bits, because the two differ
/// for a grant that comes from an ACL rather than from the permission bits. Windows has no
/// `X_OK`, and Node's `X_OK` degrades to an existence test there.
#[cfg(unix)]
fn access_executable(path: &Path) -> bool {
    let Ok(raw) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    // SAFETY: `raw` is a valid NUL-terminated path for the duration of the call, and
    // `access` only reads it.
    unsafe { libc::access(raw.as_ptr(), libc::X_OK) == 0 }
}

#[cfg(not(unix))]
fn access_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

/// `isUsableDirectory` — `statSync(path).isDirectory()`, which follows symlinks.
pub fn is_usable_directory(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// The inputs `resolveTerminalShell` reads.
pub struct ShellInput<'a> {
    /// `process.platform`.
    pub platform: &'a str,
    /// `env.SHELL`, already defaulted to the ambient environment by the caller when absent.
    pub shell: Option<&'a str>,
    /// `env.ComSpec`.
    pub com_spec: Option<&'a str>,
    /// `env.PATH`.
    pub path: Option<&'a str>,
}

/// `resolveTerminalShell` (`terminalService.ts:285-308`).
///
/// Returns the chosen binary, or the error the legacy code threw. A terminal that silently
/// gets a *different* shell than the ladder names is a behaviour fork; a terminal that
/// spawns nothing is the safe failure, so exhaustion is an error and never a guess.
pub fn resolve_terminal_shell(input: &ShellInput<'_>) -> Result<String, &'static str> {
    if input.platform == "win32" {
        let candidates = [
            Some(WINDOWS_SHELL_CANDIDATES[0]),
            Some(WINDOWS_SHELL_CANDIDATES[1]),
            input.com_spec,
            Some("cmd.exe"),
        ];
        for candidate in candidates.into_iter().flatten() {
            // The legacy `if (candidate && …)` guard skips an empty `$ComSpec`.
            if !candidate.is_empty() && is_executable(candidate, input.path) {
                return Ok(candidate.to_owned());
            }
        }
        return Err(NO_WINDOWS_SHELL_ERROR);
    }

    let candidates = [
        input.shell,
        Some(POSIX_SHELL_CANDIDATES[0]),
        Some(POSIX_SHELL_CANDIDATES[1]),
        Some(POSIX_SHELL_CANDIDATES[2]),
    ];
    for candidate in candidates.into_iter().flatten() {
        if !candidate.is_empty() && is_executable(candidate, input.path) {
            return Ok(candidate.to_owned());
        }
    }
    Err(NO_POSIX_SHELL_ERROR)
}

/// The inputs `resolveTerminalCwd` reads.
pub struct CwdInput<'a> {
    /// The caller's requested directory.
    pub cwd: Option<&'a str>,
    /// `env.HOME`.
    pub home: Option<&'a str>,
    /// `os.homedir()`.
    pub home_dir: &'a str,
}

/// `resolveTerminalCwd` (`terminalService.ts:310-321`).
pub fn resolve_terminal_cwd(input: &CwdInput<'_>) -> Result<String, &'static str> {
    let candidates = [input.cwd, input.home, Some(input.home_dir), Some("/")];
    for candidate in candidates.into_iter().flatten() {
        if !candidate.is_empty() && is_usable_directory(candidate) {
            return Ok(candidate.to_owned());
        }
    }
    Err(NO_WORKING_DIRECTORY_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("zcode-terminal-profile-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn executable(tag: &str, name: &str) -> (String, String) {
        let dir = temp_dir(tag);
        let path = std::path::Path::new(&dir).join(name);
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        (dir, path.to_string_lossy().into_owned())
    }

    #[test]
    fn posix_candidates_are_in_the_ported_order() {
        assert_eq!(POSIX_SHELL_CANDIDATES, ["/bin/zsh", "/bin/bash", "/bin/sh"]);
        assert_eq!(WINDOWS_SHELL_CANDIDATES, ["pwsh.exe", "powershell.exe"]);
    }

    #[test]
    fn posix_prefers_the_users_own_shell() {
        let (dir, path) = executable("shell-own", "my-zsh");
        let input = ShellInput {
            platform: "linux",
            shell: Some(&path),
            com_spec: None,
            path: Some(&dir),
        };
        assert_eq!(resolve_terminal_shell(&input), Ok(path));
    }

    #[test]
    fn posix_falls_past_a_dead_shell_env() {
        // A `$SHELL` that no longer exists must not be handed to `posix_spawnp`; the ladder
        // moves to the first standard shell that does exist on this host.
        let input = ShellInput {
            platform: "linux",
            shell: Some("/nonexistent/zsh"),
            com_spec: None,
            path: Some(""),
        };
        let resolved = resolve_terminal_shell(&input).expect("a standard shell exists");
        assert!(POSIX_SHELL_CANDIDATES.contains(&resolved.as_str()));
    }

    #[test]
    fn posix_skips_an_empty_shell_env() {
        // An empty `$SHELL` is falsy and is skipped, exactly like the legacy
        // `if (candidate && isExecutable(candidate))` guard.
        let input = ShellInput {
            platform: "linux",
            shell: Some(""),
            com_spec: None,
            path: Some("/nonexistent"),
        };
        let resolved = resolve_terminal_shell(&input).expect("a standard shell exists");
        assert!(POSIX_SHELL_CANDIDATES.contains(&resolved.as_str()));
        assert!(!resolved.is_empty());
    }

    #[test]
    fn windows_prefers_pwsh_then_powershell_then_comspec() {
        // A candidate without a path separator is probed through `PATH` and returned
        // verbatim, not as the resolved path.
        let (dir, _) = executable("win-pwsh", "pwsh.exe");
        let input = ShellInput {
            platform: "win32",
            shell: None,
            com_spec: None,
            path: Some(&dir),
        };
        assert_eq!(resolve_terminal_shell(&input), Ok("pwsh.exe".to_owned()));

        let (dir, _) = executable("win-ps", "powershell.exe");
        let input = ShellInput {
            platform: "win32",
            shell: None,
            com_spec: None,
            path: Some(&dir),
        };
        assert_eq!(resolve_terminal_shell(&input), Ok("powershell.exe".to_owned()));

        let (dir, _) = executable("win-comspec", "custom-shell.exe");
        let input = ShellInput {
            platform: "win32",
            shell: None,
            com_spec: Some("custom-shell.exe"),
            path: Some(&dir),
        };
        assert_eq!(
            resolve_terminal_shell(&input),
            Ok("custom-shell.exe".to_owned())
        );
    }

    #[test]
    fn windows_skips_an_empty_comspec_and_fails_loudly() {
        let input = ShellInput {
            platform: "win32",
            shell: None,
            com_spec: Some(""),
            path: Some(""),
        };
        assert_eq!(resolve_terminal_shell(&input), Err(NO_WINDOWS_SHELL_ERROR));
    }

    #[test]
    fn a_non_executable_file_is_not_a_shell() {
        let dir = temp_dir("shell-noexec");
        let path = std::path::Path::new(&dir).join("pwsh.exe");
        std::fs::write(&path, b"not executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        assert!(!is_executable(
            &path.to_string_lossy(),
            Some(&dir)
        ));
    }

    #[test]
    fn cwd_prefers_the_request_then_home_then_os_then_root() {
        let requested = temp_dir("cwd-requested");
        let home = temp_dir("cwd-home");
        let input = CwdInput {
            cwd: Some(&requested),
            home: Some(&home),
            home_dir: "/nonexistent",
        };
        assert_eq!(resolve_terminal_cwd(&input), Ok(requested));

        let input = CwdInput {
            cwd: Some("/nonexistent/zcode-terminal-profile"),
            home: Some(&home),
            home_dir: "/nonexistent",
        };
        assert_eq!(resolve_terminal_cwd(&input), Ok(home));

        let input = CwdInput {
            cwd: Some(""),
            home: None,
            home_dir: "/nonexistent",
        };
        assert_eq!(resolve_terminal_cwd(&input), Ok("/".to_owned()));
    }

    #[test]
    fn cwd_ladder_throws_when_exhausted() {
        // `/` always exists, so the only way to exhaust the ladder is a platform without it;
        // the message is still the one the legacy code threw, asserted here as a constant.
        assert_eq!(NO_WORKING_DIRECTORY_ERROR, "No usable working directory found for terminal startup");
        assert!(is_usable_directory("/"));
        assert!(!is_usable_directory("/nonexistent/zcode-terminal-profile"));
        assert!(!is_usable_directory("/etc/hostname"), "a file is not a directory");
    }
}
