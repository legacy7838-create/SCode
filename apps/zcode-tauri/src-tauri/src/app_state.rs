//! Process-wide application state.
//!
//! Mirrors the four parallel registries that Electron's `main/index.ts` kept as
//! module-level Maps (`windowWorkspaceMap`, `windowTaskRealtimeHostIdMap`,
//! `windowUnreadCountMap`, `windowHostProcessMap`). Those Electron Maps were keyed
//! inconsistently — three by `win.id` and one by `win.webContents.id` — which made
//! the lookup contract ambiguous. Tauri exposes a stable string window label, so
//! every registry here is keyed by that label and the ambiguity cannot recur.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// Per-window bookkeeping, equivalent to the three Maps keyed by window id.
#[derive(Debug, Default, Clone)]
pub struct WindowState {
    /// Workspace paths this window has open. Drives `TaskRealtimeBus` scoping.
    pub workspace_keys: HashSet<String>,
    /// Unread task count; drives the dock/taskbar badge.
    pub unread_count: u64,
    /// Session id the window is currently focused on, if any.
    pub active_session_id: Option<String>,
    /// Host id supervising this window.
    pub host_id: Option<String>,
}

impl WindowState {
    pub fn to_wire(&self) -> WindowStateWire {
        WindowStateWire {
            unread_count: self.unread_count,
            active_session_id: self.active_session_id.clone(),
            host_id: self.host_id.clone(),
        }
    }
}

/// The subset of per-window state that is safe to hand to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStateWire {
    pub unread_count: u64,
    pub active_session_id: Option<String>,
    pub host_id: Option<String>,
}

/// Handle shared with every Tauri command and event emitter.
#[derive(Debug)]
pub struct AppState {
    windows: Mutex<HashMap<String, WindowState>>,
    /// Labels of windows that are real workspace windows (excludes tray-only,
    /// update-status, and other auxiliary surfaces). Electron expressed this as
    /// `getMainApplicationWindows()`; see `main/index.ts:1441-1443`.
    main_windows: Mutex<HashSet<String>>,
    /// Set once the first primary window exists, mirroring `primaryWindowCoordinator`.
    primary_ready: AtomicBool,
    /// Monotonic id source for host instances; replaces the `Map<webContentsId, …>` key.
    next_host_id: AtomicU64,
    /// Mirrors `forceQuitRef` / `explicitQuitRef` in `main/index.ts:609-610`.
    /// Electron allowed an update-initiated quit to silently skip the confirm
    /// prompt; here the flag is explicit so the quit path can branch on it.
    pub quit_flag: AtomicBool,
    pub quit_kind: Mutex<Option<QuitKind>>,
    /// Latch for the shutdown drain, deliberately SEPARATE from `quit_flag`.
    ///
    /// Gating the drain on `quit_flag` was a bug: an explicit quit must set that
    /// flag *first* or `window.rs` swallows the close as close-to-tray, so every
    /// explicit quit had `quit_flag == true` by the time `ExitRequested` fired and
    /// therefore skipped the drain entirely. Electron kept these distinct too
    /// (`explicitQuitRef` at `main/index.ts:609-610` vs `hasPreparedAppQuit` at
    /// `main/index.ts:1077`).
    shutdown_drained: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitKind {
    Normal,
    UpdateInstall,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
            main_windows: Mutex::new(HashSet::new()),
            primary_ready: AtomicBool::new(false),
            next_host_id: AtomicU64::new(1),
            quit_flag: AtomicBool::new(false),
            quit_kind: Mutex::new(None),
            shutdown_drained: AtomicBool::new(false),
        }
    }

    /// True exactly once: the first caller owns the shutdown drain, later callers
    /// (a second `ExitRequested`, a tray quit racing a window quit) get `false`.
    pub fn take_shutdown_drain(&self) -> bool {
        !self.shutdown_drained.swap(true, Ordering::SeqCst)
    }

    pub fn allocate_host_id(&self) -> String {
        format!("host-{}", self.next_host_id.fetch_add(1, Ordering::SeqCst))
    }

    pub fn register_window(&self, label: &str, is_main: bool) {
        self.windows
            .lock()
            .expect("window registry poisoned")
            .entry(label.to_string())
            .or_default();
        if is_main {
            self.main_windows
                .lock()
                .expect("main window set poisoned")
                .insert(label.to_string());
        }
    }

    pub fn forget_window(&self, label: &str) {
        self.windows
            .lock()
            .expect("window registry poisoned")
            .remove(label);
        self.main_windows
            .lock()
            .expect("main window set poisoned")
            .remove(label);
    }

    pub fn is_main_window(&self, label: &str) -> bool {
        self.main_windows
            .lock()
            .expect("main window set poisoned")
            .contains(label)
    }

    pub fn main_window_labels(&self) -> Vec<String> {
        self.main_windows
            .lock()
            .expect("main window set poisoned")
            .iter()
            .cloned()
            .collect()
    }
    pub fn quit_requested(&self) -> bool {
        self.quit_flag.load(Ordering::SeqCst)
    }

    pub fn window_labels(&self) -> Vec<String> {
        self.windows
            .lock()
            .expect("window registry poisoned")
            .keys()
            .cloned()
            .collect()
    }

    pub fn with_window<T>(&self, label: &str, f: impl FnOnce(&mut WindowState) -> T) -> Option<T> {
        let mut guard = self.windows.lock().expect("window registry poisoned");
        guard.get_mut(label).map(f)
    }

    /// Total unread across every main window; drives the app badge.
    pub fn total_unread(&self) -> u64 {
        self.main_windows
            .lock()
            .expect("main window set poisoned")
            .iter()
            .filter_map(|label| {
                self.windows
                    .lock()
                    .expect("window registry poisoned")
                    .get(label)
                    .map(|w| w.unread_count)
            })
            .sum()
    }

    pub fn set_primary_ready(&self, ready: bool) {
        self.primary_ready.store(ready, Ordering::SeqCst);
    }

    pub fn is_primary_ready(&self) -> bool {
        self.primary_ready.load(Ordering::SeqCst)
    }

    pub fn request_quit(&self, kind: QuitKind) {
        self.quit_flag.store(true, Ordering::SeqCst);
        *self.quit_kind.lock().expect("quit kind poisoned") = Some(kind);
    }

    pub fn quit_kind(&self) -> Option<QuitKind> {
        *self.quit_kind.lock().expect("quit kind poisoned")
    }

    /// Snapshot of all window state, for diagnostics commands.
    pub fn snapshot(&self) -> HashMap<String, WindowStateWire> {
        self.windows
            .lock()
            .expect("window registry poisoned")
            .iter()
            .map(|(k, v)| (k.clone(), v.to_wire()))
            .collect()
    }
}

pub type SharedAppState = Arc<AppState>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_distinct_host_ids() {
        let state = AppState::new();
        let a = state.allocate_host_id();
        let b = state.allocate_host_id();
        assert_ne!(a, b);
    }

    #[test]
    fn badge_sums_only_main_windows() {
        let state = AppState::new();
        state.register_window("main", true);
        state.register_window("update-status", false);
        state.with_window("main", |w| w.unread_count = 3);
        state.with_window("update-status", |w| w.unread_count = 99);
        assert_eq!(state.total_unread(), 3);
    }

    #[test]
    fn forgetting_a_window_drops_it_from_both_registries() {
        let state = AppState::new();
        state.register_window("main", true);
        state.forget_window("main");
        assert!(!state.is_main_window("main"));
        assert!(state.main_window_labels().is_empty());
    }
}
