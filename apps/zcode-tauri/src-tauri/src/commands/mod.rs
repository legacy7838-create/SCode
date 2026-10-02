//! Renderer→main command surface — the Tauri replacement for the 65
//! `ipcMain.handle(...)` registrations in `packages/desktop/src/main`.
//!
//! Naming rule (mechanical, reversible):
//!   Electron `zcode:SyncWindowTabs` → Tauri command `sync_window_tabs`
//!   i.e. strip the `zcode:` prefix and snake_case the remainder.
//! The inverse mapping lives in `apps/zcode-tauri/src/platform/commands.ts`,
//! which is generated from the same list so the two cannot drift.
//!
//! Payloads use `#[serde(rename_all = "camelCase")]` everywhere, so the existing
//! TypeScript payload interfaces are reused verbatim — no reshaping in between.

pub mod app;
pub mod capability;
pub mod editor;
pub mod fs;
pub mod mcp_config;
pub mod native;
pub mod rpc;
pub mod session;
pub mod surface;
pub mod terminal;
pub mod urls;
pub mod window;

use serde::{Deserialize, Serialize};

/// Uniform error type returned across the command boundary.
///
/// Tauri serialises a `Result<T, E>` command return; a plain `String` keeps the
/// wire format stable and matches the Electron handlers, which surfaced
/// `error instanceof Error ? error.message : String(error)`.
pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum CommandError {
    /// The calling window is not registered, or was destroyed mid-call.
    #[error("window not available: {0}")]
    WindowUnavailable(String),
    /// The payload failed validation against the expected shape.
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    /// A platform operation (file dialog, opener, …) failed.
    #[error("{0}")]
    Platform(String),
    /// The window that issued the call is not authorised for this operation.
    #[error("not permitted: {0}")]
    Forbidden(String),
}

impl From<tauri::Error> for CommandError {
    fn from(value: tauri::Error) -> Self {
        CommandError::Platform(value.to_string())
    }
}

/// Resolve the caller's window label and prove it is registered.
///
/// This is the Tauri replacement for the `event.sender` validation that several
/// Electron handlers performed inconsistently — `OpenResourceManager` validated
/// nothing while its neighbours validated the sender. Deriving the label from the
/// injected `WebviewWindow` rather than trusting a payload field means a caller
/// cannot address a window it does not own.
pub fn require_registered_window(
    state: &crate::app_state::AppState,
    label: &str,
) -> CommandResult<()> {
    if state.window_labels().iter().any(|l| l == label) {
        Ok(())
    } else {
        Err(CommandError::WindowUnavailable(label.to_string()))
    }
}
