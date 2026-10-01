//! How Chromium is started.
//!
//! Launch mode is a **security** decision, not a convenience one. A `--remote-debugging-port`
//! is a listening socket with no authentication: anything that can reach it can evaluate
//! script in every open tab and read every cookie. So the default is a pipe, and the port form
//! is only reachable through [`LaunchOptions::with_debugging_port`], which the caller has to
//! ask for by name.

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchMode {
    /// Chromium is launched with a `--remote-debugging-pipe` and spoken to over stdio.
    /// Nothing listens on a socket.
    Pipe,
    /// Chromium listens on a TCP port. Only for tests and debugging.
    DebuggingPort(u16),
}

impl LaunchMode {
    pub fn is_pipe(&self) -> bool {
        matches!(self, LaunchMode::Pipe)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchOptions {
    /// Path to the Chromium binary. Resolved from the shipped payload, never from `PATH`:
    /// a `PATH` lookup would let a user's local `chromium` become the automation target.
    pub executable: String,
    pub mode: LaunchMode,
    /// `--user-data-dir`. Chromium refuses to reuse the default profile, so this is required
    /// rather than optional — pointing it at the user's real profile would put browser tabs
    /// and their cookies into the same store as their login session.
    pub user_data_dir: String,
    pub headless: bool,
    pub viewport: Option<(u64, u64)>,
}

impl LaunchOptions {
    pub fn new(executable: impl Into<String>, user_data_dir: impl Into<String>) -> Self {
        Self {
            executable: executable.into(),
            mode: LaunchMode::Pipe,
            user_data_dir: user_data_dir.into(),
            headless: false,
            viewport: None,
        }
    }

    pub fn with_debugging_port(mut self, port: u16) -> Self {
        self.mode = LaunchMode::DebuggingPort(port);
        self
    }

    /// The argv Chromium is launched with. Pure, so the security-relevant flags are asserted
    /// in tests rather than inspected by hand at three call sites.
    pub fn argv(&self) -> Vec<String> {
        let mut argv = vec![
            format!("--user-data-dir={}", self.user_data_dir),
            // Suppresses the first-run flows that would otherwise block on UI.
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
        ];
        match &self.mode {
            LaunchMode::Pipe => argv.push("--remote-debugging-pipe".to_string()),
            LaunchMode::DebuggingPort(port) => {
                argv.push(format!("--remote-debugging-port={port}"))
            }
        }
        if self.headless {
            argv.push("--headless=new".to_string());
        }
        if let Some((width, height)) = self.viewport {
            argv.push(format!("--window-size={width},{height}"));
        }
        argv
    }

    /// A pipe launch must never carry a port, and vice versa. Checked before spawn because
    /// the failure mode otherwise is a Chromium that silently listens on localhost.
    pub fn validate(&self) -> Result<()> {
        if self.executable.trim().is_empty() {
            return Err(Error::Invalid("chromium executable path is empty".into()));
        }
        if self.user_data_dir.trim().is_empty() {
            return Err(Error::Invalid(
                "user data dir is required: sharing Chromium's default profile would merge \
                 browser tabs with the user's login session"
                    .into(),
            ));
        }
        match self.mode {
            LaunchMode::DebuggingPort(0) => Err(Error::Invalid(
                "debugging port 0 would let the OS pick, making the endpoint undiscoverable \
                 and unauditable"
                    .into(),
            )),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_is_the_default_and_never_opens_a_port() {
        let opts = LaunchOptions::new("/payload/chromium", "/tmp/profile");
        assert!(opts.mode.is_pipe());
        let argv = opts.argv();
        assert!(argv.iter().any(|a| a == "--remote-debugging-pipe"));
        assert!(
            !argv.iter().any(|a| a.starts_with("--remote-debugging-port")),
            "a pipe launch must not also expose a port: {argv:?}"
        );
    }

    #[test]
    fn port_mode_is_opt_in_and_excludes_the_pipe_flag() {
        let opts = LaunchOptions::new("/payload/chromium", "/tmp/profile").with_debugging_port(9222);
        let argv = opts.argv();
        assert!(argv.contains(&"--remote-debugging-port=9222".to_string()));
        assert!(
            !argv.contains(&"--remote-debugging-pipe".to_string()),
            "carrying both flags makes Chromium honour the port, which defeats the pipe: {argv:?}"
        );
    }

    #[test]
    fn profile_is_always_explicit() {
        // Chromium's default profile is the user's. Inheriting it would hand the automation
        // session every cookie the user has, so the flag is never omitted.
        for opts in [
            LaunchOptions::new("/payload/chromium", "/tmp/a"),
            LaunchOptions::new("/payload/chromium", "/tmp/a").with_debugging_port(1),
        ] {
            assert!(opts.argv().iter().any(|a| a.starts_with("--user-data-dir=")));
        }
    }

    #[test]
    fn empty_executable_is_rejected() {
        let err = LaunchOptions::new("  ", "/tmp/p").validate().unwrap_err();
        assert!(matches!(err, Error::Invalid(_)));
    }

    #[test]
    fn missing_profile_is_rejected_with_the_reason() {
        let err = LaunchOptions::new("/payload/chromium", "").validate().unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("login session"), "reason must survive: {msg}");
    }

    #[test]
    fn ephemeral_debugging_port_is_rejected() {
        let err = LaunchOptions::new("/c", "/p").with_debugging_port(0).validate().unwrap_err();
        assert!(err.to_string().contains("unauditable"));
    }

    #[test]
    fn valid_options_pass() {
        assert!(LaunchOptions::new("/payload/chromium", "/tmp/p").validate().is_ok());
    }
}
