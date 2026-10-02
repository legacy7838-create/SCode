//! Trusted-host capability tickets issued to the renderer.
//!
//! The web renderer (or a mobile remote attaching through the desktop) used to
//! `POST /api/rpc-host-capability` on the Node server. With no Node server in
//! the host path, issuing moves into a native command on the same in-memory
//! store the Rust trusted-host edge will consume. Contract preserved: the
//! ticket is short-lived (30 s) and single-use.

use std::sync::Mutex;

use tauri::State;

use crate::services::host_capability::{HostCapability, HostCapabilityStore};

/// `zcode:issue_rpc_host_capability` — returns `{ capability, expiresAt }`.
#[tauri::command]
pub fn issue_rpc_host_capability(
    store: State<'_, Mutex<HostCapabilityStore>>,
) -> Result<HostCapability, String> {
    store
        .lock()
        .map(|mut store| store.issue())
        .map_err(|_| "host capability store poisoned".to_string())
}
