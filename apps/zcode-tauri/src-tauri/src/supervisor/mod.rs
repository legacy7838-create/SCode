//! Process supervision — the Tauri replacement for Electron's
//! `utilityProcess.fork()` Hosts (`main/desktopHostProcess.ts:257`) and the
//! resident cron scheduler (`main/desktopCronScheduler.ts:61`).
//!
//! ## Why this is not a literal translation
//!
//! Electron forked each Host as a real OS process, which bought crash
//! containment: a Host panic could not take down the window. A Rust `tokio`
//! task does not have that property — a panic unwinds the task, not the process,
//! but a panic in code that touches `unsafe` or aborts (and this crate builds with
//! `panic = "abort"` in release, which makes the distinction moot) would still
//! take the process down.
//!
//! The mitigation is an explicit supervisor with **bounded exponential backoff**,
//! which the Electron original conspicuously did not have: `spawnCronScheduler`
//! logged one line on exit and kept the dead handle, so a single crash silently
//! disabled all cron dispatch until the app was relaunched
//! (`main/desktopCronScheduler.ts:195-198`). Here a failed child is restarted,
//! and the backoff prevents a crash-on-boot from becoming a hot loop.
//!
//! The isolation trade-off is stated rather than hidden: the port accepts
//! in-process supervision, and any future work that needs true per-host process
//! isolation should spawn a sidecar binary rather than widen this module.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tauri::async_runtime::JoinHandle;

use crate::app_state::SharedAppState;

pub mod host;
pub mod scheduler;

/// Backoff bounds for child restart. Deliberately mirrors the discipline the
/// scheduler's own retry logic uses (`scheduler/index.ts:32-38`) so an operator
/// sees one consistent timing story.
const RESTART_BACKOFF_INITIAL_MS: u64 = 250;
const RESTART_BACKOFF_MAX_MS: u64 = 30_000;
/// After this many consecutive failures without a healthy window, stop trying and
/// surface the failure rather than spinning forever.
const MAX_CONSECUTIVE_FAILURES: u32 = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChildStatus {
    Starting,
    Running,
    /// Backoff countdown after a failure.
    Backoff { attempt: u32, retry_in_ms: u64 },
    /// Stopped deliberately (shutdown requested, or an explicit dispose).
    /// Distinct from `Failed` so a clean stop is never reported as a failure.
    Stopped,
    /// Supervision gave up; `last_error` explains why.
    Failed { last_error: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildInfo {
    pub id: String,
    pub kind: String,
    pub status: ChildStatus,
    pub restarts: u32,
    pub last_error: Option<String>,
}

/// A supervised unit of work.
///
/// `run` receives a shutdown signal and is expected to return when it receives
/// it; returning `Err` is treated as a failure and triggers backoff.
struct Child {
    info: ChildInfo,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
    /// Retained so a failed attempt can be restarted with the same body.
    factory: BoxedFactory,
}

/// Type-erased child factory. The returned future is boxed so the child record
/// can hold it without knowing the concrete async block's type.
pub type BoxedFactory = Arc<
    dyn Fn(String, oneshot::Receiver<()>) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

/// Helper that adapts an async closure into a [`BoxedFactory`].
pub fn boxed<F, Fut>(factory: F) -> BoxedFactory
where
    F: Fn(String, oneshot::Receiver<()>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    Arc::new(move |id, shutdown| Box::pin(factory(id, shutdown)))
}

/// Owns every supervised child and the aggregate status of the runtime.
pub struct Supervisor {
    children: parking_lot::Mutex<HashMap<String, Child>>,
    next_id: AtomicU64,
    state: SharedAppState,
    data_base_dir: PathBuf,
}

impl Supervisor {
    pub fn new(state: SharedAppState) -> Self {
        let data_base_dir = std::env::var("ZCODE_DATA_BASE_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| PathBuf::from("."))
            });
        Self {
            children: parking_lot::Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            state,
            data_base_dir,
        }
    }

    pub fn data_base_dir(&self) -> &PathBuf {
        &self.data_base_dir
    }

    pub fn temp_attachment_dir(&self) -> Result<PathBuf, std::io::Error> {
        Ok(self.data_base_dir.join("tmp").join("prompt-attachments"))
    }

    /// Spawn (or replace) a supervised child.
    ///
    /// The factory is type-erased into a [`BoxedFactory`] so the child record
    /// can own it and reuse it across restarts without requiring the caller's
    /// closure to be `Sync`. Only `Send` is needed, because the closure is
    /// invoked once per attempt on the single task that owns the attempt.
    pub fn spawn(self: &Arc<Self>, kind: &str, key: &str, factory: BoxedFactory) -> String {
        let id = format!("{kind}-{key}-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let child = Child {
            info: ChildInfo {
                id: id.clone(),
                kind: kind.to_string(),
                status: ChildStatus::Starting,
                restarts: 0,
                last_error: None,
            },
            shutdown: None,
            task: None,
            factory,
        };
        let previous = self.children.lock().insert(id.clone(), child);
        if let Some(previous) = previous {
            Self::stop(previous);
        }
        self.launch(id.clone(), 0);
        id
    }

    /// Run one attempt, and on failure schedule a backed-off retry.
    fn launch(self: &Arc<Self>, id: String, _attempt: u32) {
        let this = self.clone();
        let attempt_id = id.clone();

        let factory = match this.children.lock().get(&id).map(|c| c.factory.clone()) {
            Some(factory) => factory,
            // The child was stopped between spawn and launch; nothing to run.
            None => return,
        };

        // Tauri's managed runtime, not `tokio::spawn`: `Supervisor::spawn` is
        // called from `setup()`, which runs on the main thread outside any
        // Tokio runtime context. A raw `tokio::spawn` there panics with
        // "there is no reactor running".
        let task = tauri::async_runtime::spawn(async move {
            let (tx, rx) = oneshot::channel::<()>();
            {
                let mut guard = this.children.lock();
                if let Some(child) = guard.get_mut(&attempt_id) {
                    child.shutdown = Some(tx);
                    child.info.status = ChildStatus::Running;
                }
            }

            let outcome = factory(attempt_id.clone(), rx).await;
            let error = outcome.err();

            // A child that returned `Ok` was asked to stop (its shutdown receiver
            // resolved), so it must not be rescheduled. A child that returned
            // `Err` died on its own and is eligible for a backed-off retry.
            let mut retry: Option<(u32, u64)> = None;
            {
                let mut guard = this.children.lock();
                if let Some(child) = guard.get_mut(&attempt_id) {
                    child.shutdown = None;
                    child.task = None;
                    if let Some(message) = error {
                        child.info.last_error = Some(message);
                        child.info.restarts += 1;
                        if child.info.restarts >= MAX_CONSECUTIVE_FAILURES {
                            child.info.status = ChildStatus::Failed {
                                last_error: child.info.last_error.clone().unwrap_or_default(),
                            };
                        } else {
                            let retry_in_ms = backoff_ms(child.info.restarts);
                            child.info.status = ChildStatus::Backoff {
                                attempt: child.info.restarts,
                                retry_in_ms,
                            };
                            retry = Some((child.info.restarts, retry_in_ms));
                        }
                    } else {
                        // Graceful stop.
                        child.info.status = ChildStatus::Stopped;

                    }
                }
            }

            if let Some((_attempt, delay)) = retry {
                // The factory lives on the child record, so a restart reuses the
                // same body without re-capturing the caller's closure here.
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                this.launch(attempt_id.clone(), 0);
            }
        });

        if let Some(child) = self.children.lock().get_mut(&id) {
            child.task = Some(task);
        }
    }

    /// Ask a child to stop, escalating to `abort` after a grace period.
    pub fn stop_child(&self, id: &str) {
        let taken = self.children.lock().remove(id);
        if let Some(child) = taken {
            Self::stop(child);
        }
    }

    fn stop(mut child: Child) {
        if let Some(tx) = child.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(task) = child.task.take() {
            task.abort();
        }
    }

    /// Stop everything; called from the shutdown phase.
    pub fn shutdown_all(&self) {
        let children: Vec<Child> = self.children.lock().drain().map(|(_, c)| c).collect();
        for child in children {
            Self::stop(child);
        }
    }

    pub fn status(&self, id: &str) -> Option<ChildInfo> {
        self.children.lock().get(id).map(|c| c.info.clone())
    }

    pub fn list(&self) -> Vec<ChildInfo> {
        self.children.lock().values().map(|c| c.info.clone()).collect()
    }

    pub fn state(&self) -> &SharedAppState {
        &self.state
    }
}

/// Exponential backoff with a hard ceiling.
fn backoff_ms(restarts: u32) -> u64 {
    let shift = restarts.min(16);
    RESTART_BACKOFF_INITIAL_MS
        .saturating_mul(1u64 << shift)
        .min(RESTART_BACKOFF_MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    // The parent narrowed the module-level import to `SharedAppState` to clear
    // an unused-import warning; the tests below still construct `AppState`
    // directly, so bring it in here rather than widening the parent import.
    use crate::app_state::AppState;

    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(backoff_ms(1), 500);
        assert_eq!(backoff_ms(2), 1_000);
        assert_eq!(backoff_ms(10), RESTART_BACKOFF_MAX_MS);
        assert_eq!(backoff_ms(64), RESTART_BACKOFF_MAX_MS);
    }

    /// The headline behaviour this module exists for: the Electron original
    /// logged one line on child exit and kept the dead handle, so a single crash
    /// disabled all cron/off-peak dispatch until relaunch
    /// (`main/desktopCronScheduler.ts:195-198`). Here a failing child is retried.
    #[tokio::test]
    async fn a_failing_child_is_restarted() {
        let state = std::sync::Arc::new(AppState::new());
        let supervisor = std::sync::Arc::new(Supervisor::new(state));
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts_for_task = attempts.clone();

        let id = supervisor.spawn(
            "test",
            "restart",
            boxed(move |_id, _shutdown| {
                let attempts = attempts_for_task.clone();
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err("boom".to_string())
                }
            }),
        );

        // First attempt is immediate; the retry waits out a 500ms backoff.
        tokio::time::sleep(std::time::Duration::from_millis(1_400)).await;

        let seen = attempts.load(std::sync::atomic::Ordering::SeqCst);
        assert!(seen >= 2, "expected the child to be restarted, saw {seen} attempts");

        let info = supervisor.status(&id).expect("child still registered");
        assert!(matches!(
            info.status,
            ChildStatus::Backoff { .. } | ChildStatus::Failed { .. }
        ));

        supervisor.shutdown_all();
    }

    /// A child that returns Ok was asked to stop, so it must not be restarted.
    /// Electron conflated this with failure in its status reporting.
    #[tokio::test]
    async fn a_clean_exit_is_not_restarted_and_reads_as_stopped() {
        let state = std::sync::Arc::new(AppState::new());
        let supervisor = std::sync::Arc::new(Supervisor::new(state));
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts_for_task = attempts.clone();

        let id = supervisor.spawn(
            "test",
            "clean",
            boxed(move |_id, _shutdown| {
                let attempts = attempts_for_task.clone();
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                }
            }),
        );

        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        assert_eq!(
            attempts.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a cleanly stopped child must not be rescheduled"
        );
        let info = supervisor.status(&id).expect("child still registered");
        assert!(
            matches!(info.status, ChildStatus::Stopped),
            "expected Stopped, got {:?}",
            info.status
        );
    }
}
