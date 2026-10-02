//! `broadcast` channel — cross-window messages and the claim primitive.
//!
//! Replaces the `@zcode/server` `broadcast` channel (`IBroadcastService`). In
//! Electron each window is a separate process and `Main`'s BroadcastHub relays
//! messages and arbitrates claims. The Tauri host is ONE process shared by every
//! window (a single `RpcHost`), so both halves collapse into in-process state:
//! `send` fans out to every `onMessage` subscriber, and the claim coordinator
//! is the single local map — which already sees every window's claims, so no
//! cross-process round-trip is needed. This matches the TS local-only branch
//! (`parentPort = null`) exactly, not a re-imagining.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

/// `BROADCAST_CLAIM_RETRY_MS`.
const CLAIM_RETRY_MS: u64 = 250;
/// `BROADCAST_CLAIM_RESERVATION_TTL_MS`.
const CLAIM_RESERVATION_TTL_MS: u64 = 5_000;
/// `MAX_LOCAL_CLAIMS`.
const MAX_LOCAL_CLAIMS: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimStatus {
    Reserved,
    Committed,
}

struct ClaimRecord {
    token: String,
    status: ClaimStatus,
    expires_at: Option<u64>,
}

pub struct BroadcastService {
    /// Every `onMessage` subscriber; `send` fans out to all of them.
    subscribers: Mutex<Vec<crossbeam_channel::Sender<JsonValue>>>,
    claims: Mutex<HashMap<String, ClaimRecord>>,
    sequence: AtomicU64,
}

impl BroadcastService {
    pub fn new() -> Self {
        Self {
            subscribers: Mutex::new(Vec::new()),
            claims: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        }
    }

    fn prune_claims(&self, now: u64) {
        let mut claims = self.claims.lock().unwrap();
        claims.retain(|_, claim| {
            !(claim.status == ClaimStatus::Reserved && claim.expires_at.is_some_and(|t| t <= now))
        });
        while claims.len() > MAX_LOCAL_CLAIMS {
            let Some(oldest) = claims.keys().next().cloned() else { break };
            claims.remove(&oldest);
        }
    }

    fn next_request_id(&self) -> String {
        format!("broadcast-claim-{}", self.sequence.fetch_add(1, Ordering::SeqCst))
    }

    /// Validate a `BroadcastMessage` (channel must be a non-empty string).
    fn validate_message(message: &JsonValue) -> Result<JsonValue, HandlerError> {
        let channel = message
            .get("channel")
            .and_then(JsonValue::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| HandlerError::message("broadcast message requires a non-empty `channel`"))?;
        let mut validated = serde_json::Map::new();
        validated.insert("channel".into(), serde_json::Value::String(channel.to_string()));
        validated.insert("payload".into(), message.get("payload").cloned().unwrap_or(JsonValue::Null));
        if let Some(source_window_id) = message.get("sourceWindowId") {
            validated.insert("sourceWindowId".into(), source_window_id.clone());
        }
        Ok(serde_json::Value::Object(validated))
    }

    /// `acquireClaim` (the TS local-only branch, which is exactly this model).
    fn acquire_claim(&self, key: &str) -> JsonValue {
        let normalized_key = key.trim();
        if normalized_key.is_empty() {
            return serde_json::json!({ "status": "unavailable" });
        }
        let now = now_ms();
        self.prune_claims(now);
        let mut claims = self.claims.lock().unwrap();
        if let Some(existing) = claims.get(normalized_key) {
            if existing.status == ClaimStatus::Committed {
                return serde_json::json!({ "status": "committed" });
            }
            let retry_after = CLAIM_RETRY_MS
                .min(existing.expires_at.map(|t| t.saturating_sub(now)).unwrap_or(0));
            return serde_json::json!({ "status": "busy", "retryAfterMs": retry_after });
        }
        let token = format!("local-{}", self.next_request_id());
        claims.insert(
            normalized_key.to_string(),
            ClaimRecord {
                token: token.clone(),
                status: ClaimStatus::Reserved,
                expires_at: Some(now + CLAIM_RESERVATION_TTL_MS),
            },
        );
        drop(claims);
        self.prune_claims(now);
        serde_json::json!({
            "status": "acquired",
            "lease": { "key": normalized_key, "token": token }
        })
    }

    fn commit_claim(&self, lease: &JsonValue) {
        let Some(key) = lease.get("key").and_then(JsonValue::as_str) else { return };
        let Some(token) = lease.get("token").and_then(JsonValue::as_str) else { return };
        self.prune_claims(now_ms());
        let mut claims = self.claims.lock().unwrap();
        if let Some(current) = claims.get_mut(key) {
            if current.status == ClaimStatus::Reserved && current.token == token {
                current.status = ClaimStatus::Committed;
                current.expires_at = None;
            }
        }
    }

    fn release_claim(&self, lease: &JsonValue) {
        let Some(key) = lease.get("key").and_then(JsonValue::as_str) else { return };
        let Some(token) = lease.get("token").and_then(JsonValue::as_str) else { return };
        self.prune_claims(now_ms());
        let mut claims = self.claims.lock().unwrap();
        if let Some(current) = claims.get(key) {
            if current.status == ClaimStatus::Reserved && current.token == token {
                claims.remove(key);
            }
        }
    }
}

impl Default for BroadcastService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for BroadcastService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        match method {
            "send" => {
                let message = params
                    .get("message")
                    .cloned()
                    .ok_or_else(|| HandlerError::message("broadcast.send requires a `message`"))?;
                let validated = Self::validate_message(&message)?;
                // Fan out to every `onMessage` subscriber (all windows).
                if let Ok(subscribers) = self.subscribers.lock() {
                    for sender in subscribers.iter() {
                        let _ = sender.send(validated.clone());
                    }
                }
                Ok(JsonValue::Null)
            }
            "acquireClaim" => {
                let key = params
                    .get("key")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("acquireClaim requires a `key`"))?;
                Ok(self.acquire_claim(key))
            }
            "commitClaim" => {
                self.commit_claim(&params);
                Ok(JsonValue::Null)
            }
            "releaseClaim" => {
                self.release_claim(&params);
                Ok(JsonValue::Null)
            }
            "tryClaim" => {
                let key = params
                    .get("key")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("tryClaim requires a `key`"))?;
                let result = self.acquire_claim(key);
                if result["status"] == "acquired" {
                    self.commit_claim(&result["lease"]);
                    return Ok(serde_json::json!(true));
                }
                Ok(serde_json::json!(false))
            }
            other => Err(HandlerError::message(format!(
                "broadcast.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        if event != "onMessage" {
            return None;
        }
        let (sender, receiver) = crossbeam_channel::unbounded();
        self.subscribers.lock().unwrap().push(sender);
        Some(receiver)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_is_acquired_committed_and_then_busy() {
        let service = BroadcastService::new();
        let result = service.acquire_claim("k");
        assert_eq!(result["status"], serde_json::json!("acquired"));
        service.commit_claim(&result["lease"]);
        // A committed claim is reported as committed, not acquired.
        assert_eq!(service.acquire_claim("k")["status"], serde_json::json!("committed"));

        // A separate key reserved by another claim is busy with a retry hint.
        let other = service.acquire_claim("other");
        assert_eq!(other["status"], serde_json::json!("acquired"));
        let again = service.acquire_claim("other");
        assert_eq!(again["status"], serde_json::json!("busy"));
        assert!(again["retryAfterMs"].as_u64().is_some());
    }

    #[test]
    fn try_claim_acquires_and_commits_in_one_step() {
        let service = BroadcastService::new();
        assert_eq!(service.call("", "tryClaim", &[serde_json::json!({ "key": "t" })]).unwrap(), serde_json::json!(true));
        // Second try on a committed claim returns false.
        assert_eq!(service.call("", "tryClaim", &[serde_json::json!({ "key": "t" })]).unwrap(), serde_json::json!(false));
    }

    #[test]
    fn send_fans_out_to_every_on_message_subscriber() {
        let service = BroadcastService::new();
        let receiver = service.subscribe("", "onMessage", None).expect("subscribe");
        service
            .call("", "send", &[serde_json::json!({ "message": { "channel": "state:theme", "payload": "dark" } })])
            .expect("send");
        let message = receiver.recv_timeout(std::time::Duration::from_secs(2)).expect("delivery");
        assert_eq!(message["channel"], serde_json::json!("state:theme"));
        assert_eq!(message["payload"], serde_json::json!("dark"));
    }

    #[test]
    fn a_channelless_message_is_rejected() {
        let service = BroadcastService::new();
        assert!(service.call("", "send", &[serde_json::json!({ "message": { "payload": 1 } })]).is_err());
    }
}
