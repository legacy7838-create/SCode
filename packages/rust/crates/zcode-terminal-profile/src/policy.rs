//! The terminal spawn policy — the typed shape wave 2 gates the pty spawn on.
//!
//! `terminalService.create()` (`terminalService.ts:353-365`) has no permission service, no
//! confirmation and no sandbox anywhere in its method body, and `write()` (`:415`) pipes
//! straight to the pty. This wave does **not** port the pty, so it cannot add the gate. What
//! it does is own the decision's shape, so the gate is a call rather than a habit and so a
//! caller that forgets to configure a policy gets a **denial** instead of an unrestricted
//! shell. See `docs/specs/rust-native-terminal-profile.md` §5.


use napi_derive::napi;

/// What the host permits a terminal to do.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct TerminalSpawnPolicy {
  /// Exact binaries `resolve_terminal_shell` is allowed to return. Compared with `==`, never
  /// by prefix or basename, so `/tmp/zsh` cannot satisfy an entry of `/bin/zsh`.
  pub allowed_shells: Vec<String>,
  /// Directories a pty may start in, after symlink resolution.
  pub allowed_cwd_roots: Vec<String>,
  /// Environment variable names stripped from the child environment. Seeded with the
  /// loader-injection names, because the child inherits an environment and none of those
  /// should cross into it.
  pub env_denylist: Vec<String>,
  /// Whether the child inherits the parent environment at all. `resolveTerminalEnv` is an
  /// allow-everything-else merge; flipping this is the one-line change that stops it.
  pub inherit_env: bool,
  pub max_cols: f64,
  pub max_rows: f64,
}

/// A spawn the host is about to perform.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct TerminalSpawnRequest {
  /// `process.platform`.
  pub platform: String,
  pub shell: String,
  pub cwd: String,
  pub cols: f64,
  pub rows: f64,
}

/// The verdict. `allowed: false` is the answer to anything that cannot be evaluated.
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSpawnDecision {
  pub allowed: bool,
  /// `allowed` | `shell-not-allowed` | `cwd-unresolvable` | `cwd-outside-roots` |
  /// `cols-out-of-range` | `rows-out-of-range`.
  pub reason: String,
}

impl TerminalSpawnDecision {
    fn allow() -> Self {
        Self {
            allowed: true,
            reason: "allowed".to_owned(),
        }
    }

    fn deny(reason: &str) -> Self {
        Self {
            allowed: false,
            reason: reason.to_owned(),
        }
    }
}

/// The env-denylist every host should start from: variables that make a process load code it
/// was not meant to load.
pub const DEFAULT_ENV_DENYLIST: [&str; 6] = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
];

/// A sane default policy: no shell is allowed until one is named. Deny-by-default is the
/// whole point — an unconfigured host must not get an unrestricted pty by accident.
pub fn default_policy() -> TerminalSpawnPolicy {
    TerminalSpawnPolicy {
        allowed_shells: Vec::new(),
        allowed_cwd_roots: Vec::new(),
        env_denylist: DEFAULT_ENV_DENYLIST.iter().map(|name| (*name).to_owned()).collect(),
        inherit_env: true,
        max_cols: 1000.0,
        max_rows: 1000.0,
    }
}

/// `check_terminal_spawn_policy` — deny by default, in this order:
///
/// 1. the shell must equal an entry of `allowed_shells`;
/// 2. the cwd must resolve through symlinks and then sit inside an allowed root;
/// 3. `cols`/`rows` must be finite and in range.
///
/// Anything that cannot be evaluated is a denial. There is no "allowed on error" branch.
pub fn check_terminal_spawn_policy(
    policy: &TerminalSpawnPolicy,
    request: &TerminalSpawnRequest,
) -> TerminalSpawnDecision {
    if !policy
        .allowed_shells
        .iter()
        .any(|allowed| allowed == &request.shell)
    {
        return TerminalSpawnDecision::deny("shell-not-allowed");
    }

    let Some(cwd) = resolve_directory(&request.cwd) else {
        return TerminalSpawnDecision::deny("cwd-unresolvable");
    };
    let roots: Vec<_> = policy
        .allowed_cwd_roots
        .iter()
        .filter_map(|root| resolve_directory(root))
        .collect();
    if roots.is_empty() || !roots.iter().any(|root| cwd.starts_with(root)) {
        return TerminalSpawnDecision::deny("cwd-outside-roots");
    }

    if !is_in_range(request.cols, policy.max_cols) {
        return TerminalSpawnDecision::deny("cols-out-of-range");
    }
    if !is_in_range(request.rows, policy.max_rows) {
        return TerminalSpawnDecision::deny("rows-out-of-range");
    }

    TerminalSpawnDecision::allow()
}

fn is_in_range(value: f64, maximum: f64) -> bool {
    value.is_finite() && value >= 1.0 && value <= maximum
}

/// `realpath` + "is a directory", so a symlink that points out of an allowed root is
/// resolved **before** the containment test rather than after it.
fn resolve_directory(path: &str) -> Option<std::path::PathBuf> {
    let resolved = std::fs::canonicalize(path).ok()?;
    if resolved.is_dir() {
        Some(resolved)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(shell: &str, cwd: &str) -> TerminalSpawnRequest {
        TerminalSpawnRequest {
            platform: "linux".to_owned(),
            shell: shell.to_owned(),
            cwd: cwd.to_owned(),
            cols: 80.0,
            rows: 24.0,
        }
    }

    fn policy(root: &str) -> TerminalSpawnPolicy {
        TerminalSpawnPolicy {
            allowed_shells: vec!["/bin/bash".to_owned()],
            allowed_cwd_roots: vec![root.to_owned()],
            env_denylist: DEFAULT_ENV_DENYLIST.iter().map(|name| (*name).to_owned()).collect(),
            inherit_env: true,
            max_cols: 500.0,
            max_rows: 500.0,
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zcode-tp-policy-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_unconfigured_policy_denies_everything() {
        let decision = check_terminal_spawn_policy(
            &TerminalSpawnPolicy::default(),
            &request("/bin/bash", "/tmp"),
        );
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "shell-not-allowed");
    }

    #[test]
    fn a_configured_policy_allows_a_conforming_spawn() {
        let decision = check_terminal_spawn_policy(&policy("/tmp"), &request("/bin/bash", "/tmp"));
        assert!(decision.allowed);
        assert_eq!(decision.reason, "allowed");
    }

    #[test]
    fn the_shell_match_is_exact() {
        // A path that merely ends with an allowed name is a different binary.
        let decision = check_terminal_spawn_policy(&policy("/tmp"), &request("/tmp/zsh", "/tmp"));
        assert_eq!(decision.reason, "shell-not-allowed");
    }

    #[test]
    fn a_cwd_outside_every_root_is_refused() {
        let decision = check_terminal_spawn_policy(&policy("/tmp"), &request("/bin/bash", "/etc"));
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "cwd-outside-roots");
    }

    #[test]
    fn a_sibling_directory_with_the_root_as_a_prefix_is_refused() {
        let base = temp_dir("prefix");
        let inside = base.join("workspace");
        let sibling = base.join("workspacely");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let decision = check_terminal_spawn_policy(
            &policy(inside.to_str().unwrap()),
            &request("/bin/bash", sibling.to_str().unwrap()),
        );
        assert_eq!(decision.reason, "cwd-outside-roots");
    }

    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let base = temp_dir("symlink");
        let inside = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = inside.join("escape");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, &link).unwrap();
        // The symlink resolves *before* the containment test, so it is refused.
        let decision = check_terminal_spawn_policy(
            &policy(inside.to_str().unwrap()),
            &request("/bin/bash", link.to_str().unwrap()),
        );
        assert_eq!(decision.reason, "cwd-outside-roots");
    }

    #[test]
    fn policy_denies_when_it_cannot_evaluate() {
        let decision = check_terminal_spawn_policy(
            &policy("/tmp"),
            &request("/bin/bash", "/nonexistent/zcode-terminal-profile"),
        );
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "cwd-unresolvable");

        // A cwd that resolves to a file rather than a directory is unresolvable too.
        let file = temp_dir("file").join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        let decision = check_terminal_spawn_policy(
            &policy("/tmp"),
            &request("/bin/bash", file.to_str().unwrap()),
        );
        assert_eq!(decision.reason, "cwd-unresolvable");
    }

    #[test]
    fn a_root_that_does_not_exist_denies_rather_than_opens_up() {
        let decision = check_terminal_spawn_policy(
            &policy("/nonexistent/zcode-terminal-profile"),
            &request("/bin/bash", "/tmp"),
        );
        assert_eq!(decision.reason, "cwd-outside-roots");
    }

    #[test]
    fn dimensions_are_range_checked() {
        let mut wide = request("/bin/bash", "/tmp");
        wide.cols = 501.0;
        assert_eq!(
            check_terminal_spawn_policy(&policy("/tmp"), &wide).reason,
            "cols-out-of-range"
        );
        let mut tall = request("/bin/bash", "/tmp");
        tall.rows = 0.0;
        assert_eq!(
            check_terminal_spawn_policy(&policy("/tmp"), &tall).reason,
            "rows-out-of-range"
        );
        let mut not_a_number = request("/bin/bash", "/tmp");
        not_a_number.cols = f64::NAN;
        assert_eq!(
            check_terminal_spawn_policy(&policy("/tmp"), &not_a_number).reason,
            "cols-out-of-range"
        );
    }

    #[test]
    fn the_default_policy_denylist_covers_the_loader_injection_names() {
        let defaults = default_policy();
        for name in ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"] {
            assert!(
                defaults.env_denylist.iter().any(|entry| entry == name),
                "{name} must be denied by default"
            );
        }
        assert!(defaults.inherit_env);
        assert!(defaults.allowed_shells.is_empty(), "deny by default");
    }
}
