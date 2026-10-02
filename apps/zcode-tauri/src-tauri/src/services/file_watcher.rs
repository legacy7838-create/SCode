//! `file-watcher` channel — directory change events.
//!
//! Replaces the `@zcode/server` `file-watcher` channel (`IFileWatcherService`).
//! `watch` starts a `std::fs::watch` on a directory and returns a watcher id;
//! `onDynamicChange(id)` is the dynamic-event subscription (the rpc-server's
//! `on_event_listen` forwards the returned receiver as `EventFire` frames);
//! `unwatch` stops it. Events are broadcast to every subscriber of a watcher
//! (fan-out senders), so two views watching the same id each see the change.
//!
//! `std::fs::watch` is non-recursive on Linux (inotify top-level only). The
//! renderer's actual use (`useWatchedReaddir`) watches a single directory and
//! only needs that directory's own entries, so this matches; a recursive watch
//! is not silently faked.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use notify::Watcher as _;
use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

/// One directory change, matching the shared `FileWatchEvent` wire shape.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileWatchEventView {
    dir_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    changed_path: Option<String>,
}

struct WatcherState {
    /// Kept alive here; dropping it stops the OS watcher.
    _watcher: notify::RecommendedWatcher,
    /// One sender per subscriber (fan-out broadcast). Shared with the notify
    /// callback so a subscriber added after `watch` still receives events.
    subscribers: Arc<Mutex<Vec<crossbeam_channel::Sender<JsonValue>>>>,
}

pub struct FileWatcherService {
    watchers: Mutex<HashMap<String, WatcherState>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl FileWatcherService {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn watch_dir(&self, path: &str, recursive: bool) -> Result<String, HandlerError> {
        let dir = PathBuf::from(path);
        if !dir.is_dir() {
            return Err(HandlerError::message(format!(
                "file-watcher.watch path is not a directory: {path}"
            )));
        }
        if recursive {
            // Honest gap: `std::fs::watch` is non-recursive on Linux; the TS
            // `fs.watch({recursive})` is not reproduced, so this is refused
            // rather than silently watching one level.
            return Err(HandlerError::message(
                "file-watcher recursive watch is not supported by the Rust host \
                 (std::fs::watch is non-recursive); watch the directory directly",
            ));
        }
        let id = format!("watch-{}", self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        let subscribers: Arc<Mutex<Vec<crossbeam_channel::Sender<JsonValue>>>> =
            Arc::new(Mutex::new(Vec::new()));
        let subscribers_for_cb = Arc::clone(&subscribers);
        let dir_path = dir.to_string_lossy().into_owned();
        let dir_path_for_cb = dir_path.clone();

        let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            // Debounce/coalesce is the host's business; here each OS event
            // becomes one FileWatchEvent with the directory and the changed file.
            let Ok(event) = result else { return };
            let changed_path = event.paths.iter().next().map(|p| p.to_string_lossy().into_owned());
            let payload = serde_json::to_value(&FileWatchEventView {
                dir_path: dir_path_for_cb.clone(),
                changed_path,
            })
            .unwrap_or(JsonValue::Null);
            if let Ok(subscribers) = subscribers_for_cb.lock() {
                for sender in subscribers.iter() {
                    let _ = sender.send(payload.clone());
                }
            }
        })
        .map_err(|error| HandlerError::message(format!("file-watcher.watch failed: {error}")))?;
        watcher
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .map_err(|error| HandlerError::message(format!("file-watcher.watch failed: {error}")))?;

        self.watchers.lock().unwrap().insert(
            id.clone(),
            WatcherState {
                _watcher: watcher,
                subscribers,
            },
        );
        Ok(id)
    }

    fn unwatch(&self, id: &str) -> Result<(), HandlerError> {
        // Dropping the state drops the OS watcher, which stops the callback.
        self.watchers
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| HandlerError::message(format!("file-watcher: unknown watcher id {id}")))?;
        Ok(())
    }

    fn subscribe_changes(&self, id: &str) -> Result<crossbeam_channel::Receiver<JsonValue>, HandlerError> {
        let watchers = self.watchers.lock().unwrap();
        let Some(state) = watchers.get(id) else {
            return Err(HandlerError::message(format!(
                "file-watcher.onDynamicChange: unknown watcher id {id}"
            )));
        };
        let (sender, receiver) = crossbeam_channel::unbounded();
        state.subscribers.lock().unwrap().push(sender);
        Ok(receiver)
    }
}

impl Default for FileWatcherService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for FileWatcherService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        match method {
            "watch" => {
                let path = params
                    .get("path")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("file-watcher.watch requires a `path` string"))?;
                let recursive = params.get("recursive").and_then(JsonValue::as_bool).unwrap_or(false);
                let id = self.watch_dir(path, recursive)?;
                Ok(serde_json::json!({ "id": id }))
            }
            "unwatch" => {
                let id = params
                    .get("id")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("file-watcher.unwatch requires an `id` string"))?;
                self.unwatch(id)?;
                Ok(JsonValue::Null)
            }
            other => Err(HandlerError::message(format!(
                "file-watcher.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        event: &str,
        arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        // `onDynamicChange(id)`: the rpc client passes the id as the subscribe
        // arg. Returning the receiver lets `on_event_listen` forward events.
        if event != "onDynamicChange" {
            return None;
        }
        let id = arg.and_then(JsonValue::as_str)?;
        self.subscribe_changes(id).ok()
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watching_a_directory_delivers_a_change_event_to_a_subscriber() {
        let dir = std::env::temp_dir().join(format!(
            "zcode-filewatch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let service = FileWatcherService::new();

        let id = service
            .watch_dir(&dir.to_string_lossy(), false)
            .expect("watch should succeed");
        let receiver = service
            .subscribe_changes(&id)
            .expect("subscribe should succeed");

        // Write a file; notify should deliver a change event.
        let target = dir.join("probe.txt");
        std::fs::write(&target, b"hello").unwrap();

        let event = receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("a change event should arrive");
        assert_eq!(event["dirPath"], serde_json::json!(dir.to_string_lossy().to_string()));
        assert!(event.get("changedPath").is_some(), "changedPath should be present: {event}");

        service.unwatch(&id).expect("unwatch should succeed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_recursive_watch_is_refused_not_silently_downgraded() {
        let dir = std::env::temp_dir().join(format!("zcode-filewatch-rec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let service = FileWatcherService::new();
        let error = service
            .watch_dir(&dir.to_string_lossy(), true)
            .expect_err("recursive watch must be refused");
        assert!(format!("{error:?}").contains("recursive"), "error should mention recursive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unwatching_an_unknown_id_is_an_error() {
        let service = FileWatcherService::new();
        assert!(service.unwatch("nope").is_err());
    }
}
