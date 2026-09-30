//! zcode-assembler — V4 wire frame assembler via NAPI.
//!
//! Port of `packages/shared/src/zcode-protocol-v4/wire-assembler.ts` to Rust.
//!
//! The core stateful assembler handles fragment reassembly, ordinal tracking,
//! timeout expiry, supersession, and recovery filtering. Zod schema validation
//! remains on the TypeScript side; Rust validates envelope keys, measures
//! envelope sizes, performs base64 decode + CRC32 check, UTF-8 decode, and
//! JSON parse.

pub mod assembler;

use napi_derive::napi;
use serde_json::Value as JsonValue;

/// Create a new assembler instance.
///
/// Limits are clamped to the protocol defaults if they exceed them.
#[napi]
pub fn create_assembler(
    max_assembly_bytes: u32,
    max_fragments: u32,
    max_concurrent: u32,
    max_staged_bytes: u32,
    timeout_ms: u32,
    max_physical_frame_bytes: u32,
) -> AssemblerHandle {
    let limits = assembler::AssemblerLimits {
        max_assembly_bytes: max_assembly_bytes as usize,
        max_fragments: max_fragments as usize,
        max_concurrent_assemblies: max_concurrent as usize,
        max_staged_decoded_bytes: max_staged_bytes as usize,
        timeout_ms,
        max_physical_frame_bytes: max_physical_frame_bytes as usize,
    };
    AssemblerHandle {
        inner: assembler::Assembler::new(limits),
    }
}

/// NAPI handle wrapping the core assembler.
#[napi]
pub struct AssemblerHandle {
    inner: assembler::Assembler,
}

#[napi]
impl AssemblerHandle {
    /// Process a wire frame candidate and return any events (complete or fault).
    #[napi]
    pub fn accept(&mut self, wire: JsonValue, now: u32) -> Vec<AssemblerEventJs> {
        self.inner
            .accept(&wire, now)
            .into_iter()
            .map(|e| AssemblerEventJs {
                kind: e.kind.to_string(),
                frame_json: e.frame_json,
                delivery_kind: e.delivery_kind,
                reason_code: e.reason_code,
                logical_frame_id: e.logical_frame_id,
                logical_frame_ordinal: e.logical_frame_ordinal,
                topic: e.topic,
                subscription_id: e.subscription_id,
            })
            .collect()
    }

    /// Discard a route's active assembly and settled tombstone.
    #[napi]
    pub fn discard(&mut self, topic: String, subscription_id: String) {
        self.inner.discard(&topic, &subscription_id);
    }

    /// Abort a route's active assembly (releases bytes, keeps tombstone).
    #[napi]
    pub fn abort(&mut self, topic: String, subscription_id: String) {
        self.inner.abort(&topic, &subscription_id);
    }

    /// Clear all assembler state.
    #[napi]
    pub fn dispose(&mut self) {
        self.inner.clear();
    }

    /// Get current assembler stats.
    #[napi]
    pub fn get_stats(&self) -> AssemblerStatsJs {
        let stats = self.inner.get_stats();
        AssemblerStatsJs {
            assemblies: stats.assemblies as u32,
            staged_decoded_bytes: stats.staged_decoded_bytes as u32,
        }
    }

    /// Get the timestamp of the next assembly expiry, or -1 if none.
    #[napi]
    pub fn next_expiry_at(&self) -> i64 {
        self.inner.next_expiry_at().map(|v| v as i64).unwrap_or(-1)
    }
}

/// NAPI-serializable assembler event.
#[napi(object)]
pub struct AssemblerEventJs {
    pub kind: String,
    #[napi(js_name = "frameJson")]
    pub frame_json: Option<String>,
    #[napi(js_name = "deliveryKind")]
    pub delivery_kind: Option<String>,
    #[napi(js_name = "reasonCode")]
    pub reason_code: Option<String>,
    #[napi(js_name = "logicalFrameId")]
    pub logical_frame_id: String,
    #[napi(js_name = "logicalFrameOrdinal")]
    pub logical_frame_ordinal: u32,
    pub topic: String,
    #[napi(js_name = "subscriptionId")]
    pub subscription_id: String,
}

/// NAPI-serializable assembler stats.
#[napi(object)]
pub struct AssemblerStatsJs {
    pub assemblies: u32,
    #[napi(js_name = "stagedDecodedBytes")]
    pub staged_decoded_bytes: u32,
}
