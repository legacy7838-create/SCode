//! `prompt-attachment-transfer` channel — the local, zero-copy transfer service.
//!
//! Transcribed from `packages/services/src/prompt-attachment-transfer/` — the
//! interface (`promptAttachmentTransfer.ts`) and its only host implementation
//! (`promptAttachmentTransferService.ts`, registered unconditionally by
//! `createLocalServices` at `node.ts:2617`). See
//! `docs/specs/rust-native-server.md` rung 6.
//!
//! What "local" means here, and why this is not a stub:
//!
//! * A local workspace keeps `localPath` **zero-copy** — `stage` hands the path
//!   straight back as the `ref`. Nothing is uploaded, so `staged` is `false`,
//!   and the renderer's remote path turns that into the loud
//!   `RemoteAttachmentNotStagedError` it is supposed to be.
//! * `adopt` / `cancel` / `cleanup` are no-ops because there is nothing to
//!   adopt or discard: no bytes ever left the machine.
//! * **No progress is ever emitted.** The TS service creates an `Emitter` per
//!   `operationId` and never fires it; the remote staging wrapper that does
//!   fire it is client-side and wraps the *remote* host. So a subscription here
//!   is a live subscription that delivers no frame — which is exactly what the
//!   JS listener observes, and unlike returning "no such event" it does not log
//!   a known listener as unknown.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value as JsonValue};
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

/// The operation ids the renderer still holds a progress listener for, with the
/// senders that keep those listeners' pumps alive.
///
/// The rpc-server exposes no dispose hook to a native handler (only the
/// Node-forwarding fallback path takes an `on_dispose` callback), so the entry
/// is released by `cleanup` — the caller's own end-of-operation signal — and
/// otherwise lives until the connection ends. A sender whose listener went away
/// fails silently; that is the same bound `file-watcher` accepts for its
/// per-watcher subscriber list.
pub struct PromptAttachmentTransferService {
    progress_subscribers: Mutex<HashMap<String, Vec<crossbeam_channel::Sender<JsonValue>>>>,
}

impl PromptAttachmentTransferService {
    pub fn new() -> Self {
        Self {
            progress_subscribers: Mutex::new(HashMap::new()),
        }
    }

    /// `stage(params)` — the zero-copy answer.
    ///
    /// `bytes` is the caller's own `sizeBytes` when it is a number greater than
    /// zero, else `stat(localPath).size`, else `0` when the path cannot be
    /// stat'ed — the original's `… > 0 ? sizeBytes : await stat(…).catch(() => 0)`,
    /// including the case where `sizeBytes` is present but `0`, negative, or not
    /// a number at all.
    fn stage(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let object = params.as_object().ok_or_else(|| {
            HandlerError::message("prompt-attachment-transfer.stage requires a params object")
        })?;
        // Both are required by the typed contract. The original would return
        // `ref: undefined` for a path it was not given — a key `JSON.stringify`
        // drops, leaving the caller to store a reference that names nothing —
        // so a missing one is refused instead of being handed back as `null`.
        let operation_id = required_str(object, "operationId")?;
        let local_path = required_str(object, "localPath")?;
        let bytes = match object
            .get("sizeBytes")
            .filter(|value| value.as_f64().is_some_and(|size| size > 0.0))
        {
            // The caller's own number, passed through unchanged.
            Some(value) => value.clone(),
            None => match std::fs::metadata(local_path) {
                // `fs.stat` follows symlinks and reports a size for anything
                // it can stat, so `metadata` (not `symlink_metadata`) is the
                // matching call.
                Ok(metadata) => json!(metadata.len()),
                Err(_) => json!(0),
            },
        };
        Ok(json!({
            "operationId": operation_id,
            "ref": local_path,
            "bytes": bytes,
            "staged": false,
        }))
    }

    /// Hold one sender per subscriber of an operation, so the rpc-server's pump
    /// has something to read until the operation ends.
    fn subscribe_progress(&self, operation_id: &str) -> crossbeam_channel::Receiver<JsonValue> {
        let (sender, receiver) = crossbeam_channel::unbounded();
        if let Ok(mut subscribers) = self.progress_subscribers.lock() {
            subscribers
                .entry(operation_id.to_owned())
                .or_default()
                .push(sender);
        }
        // A poisoned lock must not turn "subscribe" into a crash: the receiver
        // is still a valid subscription, it simply has no live sender — which
        // for a service that never emits is indistinguishable.
        receiver
    }

    /// `cleanup(operationId)`: the operation is over, so its listeners' senders
    /// go with it and their pumps end.
    fn release_progress(&self, operation_id: &str) {
        if let Ok(mut subscribers) = self.progress_subscribers.lock() {
            subscribers.remove(operation_id);
        }
    }
}

impl Default for PromptAttachmentTransferService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for PromptAttachmentTransferService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        // Positional arguments, per `ChannelHandler::call`.
        let first = args.first();
        match method {
            "stage" => self.stage(first.unwrap_or(&JsonValue::Null)),
            // No-ops in the original: `async adopt() {}`, `async cancel() {}`,
            // `async cleanup() {}`. They take an operation id and ignore it —
            // `cleanup` additionally releases this host's own bookkeeping,
            // which is a local concern and not part of the contract.
            "adopt" | "cancel" => Ok(JsonValue::Null),
            "cleanup" => {
                if let Some(JsonValue::String(operation_id)) = first {
                    self.release_progress(operation_id);
                }
                Ok(JsonValue::Null)
            }
            other => Err(HandlerError::message(format!(
                "prompt-attachment-transfer.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        event: &str,
        arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        // `onDynamicProgress(operationId)`: the rpc client passes the id as the
        // subscribe arg, exactly like `file-watcher`'s `onDynamicChange(id)`.
        if event != "onDynamicProgress" {
            return None;
        }
        let operation_id = arg.and_then(JsonValue::as_str)?;
        Some(self.subscribe_progress(operation_id))
    }
}

fn required_str<'a>(
    object: &'a serde_json::Map<String, JsonValue>,
    field: &str,
) -> Result<&'a str, HandlerError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .ok_or_else(|| {
            HandlerError::message(format!(
                "prompt-attachment-transfer.stage requires a string `{field}`"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "zcode-attachment-{}-{}.txt",
            tag,
            std::process::id()
        ));
        std::fs::write(&path, b"0123456789").expect("write fixture");
        path
    }

    fn params(path: &str, size_bytes: Option<JsonValue>) -> JsonValue {
        let mut object = json!({
            "operationId": "op-1",
            "sessionId": "s-1",
            "workspacePath": "/ws",
            "localPath": path,
            "fileName": "a.txt",
            "mime": "text/plain",
        });
        if let Some(size) = size_bytes {
            object["sizeBytes"] = size;
        }
        object
    }

    #[test]
    fn stage_hands_the_callers_size_back_and_never_claims_a_staging() {
        let service = PromptAttachmentTransferService::new();
        let path = temp_file("size");
        let result = service
            .stage(&params(&path.to_string_lossy(), Some(json!(4096))))
            .expect("stage");
        assert_eq!(result["bytes"], json!(4096), "the caller's size wins: {result}");
        assert_eq!(result["ref"], json!(path.to_string_lossy().to_string()));
        assert_eq!(result["operationId"], json!("op-1"));
        assert_eq!(result["staged"], json!(false), "a local path is never staged");

        // `0` and a non-number are "not given": the file is stat'ed instead.
        let result = service
            .stage(&params(&path.to_string_lossy(), Some(json!(0))))
            .expect("stage");
        assert_eq!(result["bytes"], json!(10), "stat decides when sizeBytes is 0: {result}");
        let result = service
            .stage(&params(&path.to_string_lossy(), Some(json!("100"))))
            .expect("stage");
        assert_eq!(result["bytes"], json!(10), "a string is not a number: {result}");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn stage_reports_zero_for_a_path_it_cannot_stat() {
        let service = PromptAttachmentTransferService::new();
        let missing = std::env::temp_dir().join(format!(
            "zcode-attachment-missing-{}.txt",
            std::process::id()
        ));
        let result = service
            .stage(&params(&missing.to_string_lossy(), None))
            .expect("stage");
        assert_eq!(result["bytes"], json!(0), "an unreadable path is 0, not an error: {result}");
        assert_eq!(result["staged"], json!(false));
    }

    #[test]
    fn stage_refuses_a_missing_path_or_operation_id() {
        let service = PromptAttachmentTransferService::new();
        let error = service
            .stage(&json!({ "operationId": "op-1" }))
            .expect_err("no localPath");
        assert!(format!("{error:?}").contains("localPath"), "{error:?}");
        let error = service
            .stage(&json!({ "localPath": "/tmp/x" }))
            .expect_err("no operationId");
        assert!(format!("{error:?}").contains("operationId"), "{error:?}");
        let error = service
            .stage(&json!("not-an-object"))
            .expect_err("not an object");
        assert!(format!("{error:?}").contains("params object"), "{error:?}");
    }

    #[test]
    fn adopt_cancel_and_cleanup_answer_null() {
        let service = PromptAttachmentTransferService::new();
        for method in ["adopt", "cancel", "cleanup"] {
            assert_eq!(
                service.call("", method, &[json!("op-1")]).expect(method),
                JsonValue::Null,
                "{method} is a no-op for a local workspace"
            );
        }
    }

    #[test]
    fn a_progress_subscription_exists_and_delivers_nothing() {
        let service = PromptAttachmentTransferService::new();
        let receiver = service
            .subscribe("", "onDynamicProgress", Some(&json!("op-1")))
            .expect("the listener is known");
        assert!(
            matches!(
                receiver.try_recv(),
                Err(crossbeam_channel::TryRecvError::Empty)
            ),
            "the local service never emits, but the subscription is live"
        );
        // `cleanup` ends the operation: the sender goes, so the pump ends.
        service.call("", "cleanup", &[json!("op-1")]).expect("cleanup");
        assert!(
            matches!(
                receiver.try_recv(),
                Err(crossbeam_channel::TryRecvError::Disconnected)
            ),
            "cleanup must release the subscription, not leave a pump spinning"
        );
    }

    #[test]
    fn an_unknown_event_or_a_non_string_id_subscribes_to_nothing() {
        let service = PromptAttachmentTransferService::new();
        assert!(service.subscribe("", "onDidSomethingElse", Some(&json!("op-1"))).is_none());
        assert!(service.subscribe("", "onDynamicProgress", None).is_none());
        assert!(service
            .subscribe("", "onDynamicProgress", Some(&json!({ "operationId": "op-1" })))
            .is_none());
    }

    #[test]
    fn an_unregistered_method_stays_a_loud_error() {
        let service = PromptAttachmentTransferService::new();
        let error = service
            .call("", "uploadDirectly", &[json!("op-1")])
            .expect_err("no such method");
        assert!(format!("{error:?}").contains("not implemented"), "{error:?}");
    }
}
