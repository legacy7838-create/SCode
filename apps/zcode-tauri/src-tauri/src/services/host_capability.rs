//! Trusted-host capability tickets.
//!
//! Replaces `packages/server/src/hostCapability.ts` (+ its
//! `/api/rpc-host-capability` endpoint and the `/ws/host` ticket check).
//!
//! # Why tickets, why single-use
//!
//! The trusted host is promoted to `desktop-continuous`, which receives live
//! session semantics a plain web client must never see. The old mode header was
//! a *replayable* long-term privilege, so this store deletes the ticket the
//! instant it is presented — consumed, expired, or replayed alike. A ticket
//! that is never presented dies with the 30 s TTL.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// `DEFAULT_HOST_CAPABILITY_TTL_MS`.
pub const DEFAULT_TTL_MS: u64 = 30_000;

/// One issued ticket. `expiresAt` is epoch milliseconds.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapability {
    pub capability: String,
    pub expires_at: u64,
}

pub struct HostCapabilityStore {
    ttl_ms: u64,
    /// Test seams: the store owns the clock and the entropy source in
    /// production; tests inject both so TTL and single-use are deterministic.
    now_ms: Box<dyn Fn() -> u64 + Send>,
    create_capability: Box<dyn Fn() -> String + Send>,
    expires_by_capability: HashMap<String, u64>,
}

fn random_capability() -> String {
    let mut bytes = [0u8; 32];
    use rand::RngCore as _;
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url(&bytes)
}

/// base64url without padding, matching Node's `randomBytes(32).toString("base64url")`.
fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl Default for HostCapabilityStore {
    fn default() -> Self {
        Self::new(DEFAULT_TTL_MS)
    }
}

impl HostCapabilityStore {
    pub fn new(ttl_ms: u64) -> Self {
        Self {
            ttl_ms,
            now_ms: Box::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or_default()
            }),
            create_capability: Box::new(random_capability),
            expires_by_capability: HashMap::new(),
        }
    }

    #[cfg(test)]
    fn with_clock(ttl_ms: u64, now_ms: Box<dyn Fn() -> u64 + Send>) -> Self {
        Self {
            ttl_ms,
            now_ms,
            create_capability: Box::new(random_capability),
            expires_by_capability: HashMap::new(),
        }
    }

    fn purge_expired(&mut self, at: u64) {
        self.expires_by_capability.retain(|_, expires_at| *expires_at > at);
    }

    pub fn issue(&mut self) -> HostCapability {
        let issued_at = (self.now_ms)();
        self.purge_expired(issued_at);
        let capability = (self.create_capability)();
        let expires_at = issued_at + self.ttl_ms;
        self.expires_by_capability.insert(capability.clone(), expires_at);
        HostCapability { capability, expires_at }
    }

    pub fn consume(&mut self, capability: Option<&str>) -> bool {
        let Some(capability) = capability.filter(|value| !value.is_empty()) else {
            return false;
        };
        let consumed_at = (self.now_ms)();
        // Delete before the validity check: an expired or replayed ticket must
        // not linger, and a valid ticket must not be usable twice.
        let expires_at = self.expires_by_capability.remove(capability);
        self.purge_expired(consumed_at);
        expires_at.is_some_and(|expires_at| expires_at > consumed_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex;

    #[test]
    fn a_fresh_ticket_is_consumable_exactly_once() {
        let mut store = HostCapabilityStore::default();
        let ticket = store.issue();
        assert!(store.consume(Some(&ticket.capability)));
        assert!(!store.consume(Some(&ticket.capability)));
    }

    #[test]
    fn an_expired_ticket_is_rejected_and_removed() {
        let now = Arc::new(Mutex::new(1_000u64));
        let clock = Arc::clone(&now);
        let mut store = HostCapabilityStore::with_clock(
            100,
            Box::new(move || *clock.lock().unwrap()),
        );
        let ticket = store.issue();
        *now.lock().unwrap() = 1_101;
        assert!(!store.consume(Some(&ticket.capability)));
        assert!(!store.consume(Some(&ticket.capability)));
    }

    #[test]
    fn empty_and_unknown_tickets_are_rejected() {
        let mut store = HostCapabilityStore::default();
        assert!(!store.consume(None));
        assert!(!store.consume(Some("")));
        assert!(!store.consume(Some("does-not-exist")));
    }
}
