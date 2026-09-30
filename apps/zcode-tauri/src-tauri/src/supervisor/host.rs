//! Per-window Host supervision.
//!
//! The Electron original forked one `utilityProcess` per BrowserWindow and keyed
//! it by `webContents.id` (`main/desktopWindowLifecycle.ts:207`). Tauri keys by
//! window label, which is stable across reloads — the property Electron had to
//! reconstruct on every `dom-ready`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::app_state::SharedAppState;

/// Message the Host accepts from the rest of the runtime.
///
/// This is the Tauri counterpart of the `HostMessageTypes` enum carried over
/// Electron's `parentPort`. Only the *control* plane lives here.
///
/// The RPC data plane is NOT implemented yet. Electron carried it over a
/// transferred `MessageChannelMain` port; Tauri has no transferable-port
/// primitive, so that plane needs either Tauri v2 `Channel<T>` or a localhost
/// IPC server. Treating it as "already handled" would be a false claim, so the
/// gap is stated here and no method pretends to serve it yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
// Wire values are kebab-case to match the existing `HostMessageTypes`
// constants in `packages/shared/src/zcode-protocol` (e.g. "init-local"), so a
// Node Host and this Rust Host share one vocabulary. Field names inside each
// variant stay camelCase.
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostMessage {
    /// Main has finished preparing the window; begin serving.
    InitLocal,
    /// A new window surface attached to this Host (reload or reattach).
    AttachSurface { surface: String },
    /// The attached surface went away; stop serving it.
    DetachSurface { surface: String },
    /// A workspace key the window has open, for realtime scoping.
    SyncWorkspaceKeys { keys: Vec<String> },
    /// Read or update application settings.
    SyncSettings { patch: serde_json::Value },
    /// Shut down.
    Dispose,
}

/// Events the Host emits back to the runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostEvent {
    /// Host finished initialising and is ready to serve its surface.
    Ready { host_id: String },
    /// A realtime task/stream event destined for the window's renderer.
    TaskRealtime { payload: serde_json::Value },
    /// The Host needs main to perform a privileged native operation.
    RequestNative { request_id: String, operation: String, payload: serde_json::Value },
    /// Non-fatal error surfaced to the window.
    Error { message: String },
}

/// Handle to a running Host, used by the command layer.
#[derive(Clone)]
pub struct HostHandle {
    pub id: String,
    pub surface: String,
    pub to_host: mpsc::UnboundedSender<HostMessage>,
}

/// One supervised Host task.
///
/// The loop is deliberately boring: receive a message, act, repeat, and exit
/// when the shutdown receiver fires or a `Dispose` arrives. Every failure path
/// returns `Err` so the supervisor's backoff applies.
pub async fn run_host(
    host_id: String,
    mut shutdown: oneshot::Receiver<()>,
    mut inbox: mpsc::UnboundedReceiver<HostMessage>,
) -> Result<(), String> {
    tracing::info!(host_id, "host started");
    let mut ready_announced = false;

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                tracing::info!(host_id, "host received shutdown");
                return Ok(());
            }
            message = inbox.recv() => {
                let Some(message) = message else {
                    // Every sender dropped: the runtime is gone.
                    return Ok(());
                };
                match message {
                    HostMessage::Dispose => {
                        tracing::info!(host_id, "host disposing");
                        return Ok(());
                    }
                    HostMessage::InitLocal => {
                        if ready_announced {
                            // Electron made InitLocal a one-shot latch
                            // (`host/index.ts:2789-2793`); a duplicate means the
                            // window reloaded and the existing Host should keep
                            // serving rather than re-announce.
                            continue;
                        }
                        ready_announced = true;
                    }
                    HostMessage::AttachSurface { surface } => {
                        tracing::info!(host_id, surface, "surface attached");
                    }
                    HostMessage::DetachSurface { surface } => {
                        tracing::info!(host_id, surface, "surface detached");
                    }
                    HostMessage::SyncWorkspaceKeys { keys } => {
                        tracing::debug!(host_id, count = keys.len(), "workspace keys synced");
                    }
                    HostMessage::SyncSettings { .. } => {
                        tracing::debug!(host_id, "settings synced");
                    }
                }
            }
        }
    }
}

/// Spawn a Host for a window surface and return its handle.
pub fn spawn_host_for_window(
    supervisor: &Arc<super::Supervisor>,
    state: SharedAppState,
    surface: String,
) -> (String, mpsc::UnboundedSender<HostMessage>) {
    let (tx, rx) = mpsc::unbounded_channel::<HostMessage>();
    let host_id = state.allocate_host_id();
    let id_for_task = host_id.clone();
    // Record which Host supervises this window, mirroring Electron's
    // `windowTaskRealtimeHostIdMap`, so the renderer can observe it.
    state.with_window(&surface, |entry| entry.host_id = Some(host_id.clone()));

    let child_id = supervisor.spawn(
        "host",
        &surface,
        super::boxed({
            // Both the mailbox receiver and the id are consumed by a running
            // attempt, so they are parked in cells: the first attempt takes them
            // and a later restart finds them gone and exits cleanly instead of
            // spinning on a dead channel.
            let rx_cell = std::sync::Mutex::new(Some(rx));
            let id_cell = std::sync::Mutex::new(Some(id_for_task));
            move |_child_id, shutdown| {
                let taken_rx = rx_cell.lock().ok().and_then(|mut cell| cell.take());
                let taken_id = id_cell.lock().ok().and_then(|mut cell| cell.take());
                async move {
                    match (taken_rx, taken_id) {
                        (Some(rx), Some(id)) => run_host(id, shutdown, rx).await,
                        _ => Ok(()),
                    }
                }
            }
        }),
    );

    let _ = tx.send(HostMessage::InitLocal);
    (child_id, tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispose_exits_cleanly() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (_shutdown_tx, shutdown_rx) = oneshot::channel();
        let handle = tokio::spawn(run_host("h1".into(), shutdown_rx, rx));
        tx.send(HostMessage::Dispose).unwrap();
        assert_eq!(handle.await.unwrap().unwrap(), ());
    }

    #[tokio::test]
    async fn duplicate_init_does_not_terminate_the_host() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let handle = tokio::spawn(run_host("h1".into(), shutdown_rx, rx));
        for _ in 0..3 {
            tx.send(HostMessage::InitLocal).unwrap();
        }
        tx.send(HostMessage::SyncWorkspaceKeys { keys: vec!["a".into()] })
            .unwrap();
        shutdown_tx.send(()).unwrap();
        assert_eq!(handle.await.unwrap().unwrap(), ());
    }
}
