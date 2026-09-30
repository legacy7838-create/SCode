//! zcode-reassembly — V4 wire frame reassembly (Rust port).
//!
//! Port of `packages/shared/src/zcode-protocol-v4/wire-reassembly.ts` to Rust.
//!
//! Handles the heavy lifting: base64 decode, CRC32 verification, byte assembly,
//! UTF-8 decode, and JSON parse. Zod schema validation remains in TypeScript.

use std::collections::HashMap;

use napi_derive::napi;
use serde_json::Value as JsonValue;

// ============================================================================
// Constants
// ============================================================================

/// Maximum number of fragments per logical frame (PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments).
const MAX_FRAGMENTS: usize = 1024;

/// Maximum logical frame assembly size (PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes = 16 MiB).
const MAX_ASSEMBLY_BYTES: usize = 16 * 1024 * 1024;

// ============================================================================
// NAPI result type
// ============================================================================

/// Result of reassembling wire frames into a logical frame.
///
/// `kind` discriminates the variant:
/// - `"complete"` — `frame_json` contains the assembled JSON string.
/// - `"incomplete"` — `missing_indexes` lists the fragment indices still needed.
/// - `"rejected"` — `reason_code` identifies the fault.
#[napi(object)]
pub struct ReassemblyResult {
    /// `"complete"` | `"incomplete"` | `"rejected"`
    pub kind: String,
    /// JSON string of the assembled frame (complete only).
    pub frame_json: Option<String>,
    /// Delivery kind from the wire envelope (complete only).
    pub delivery_kind: Option<String>,
    /// Logical frame ID (incomplete only).
    pub logical_frame_id: Option<String>,
    /// Fragment indices still needed (incomplete only).
    pub missing_indexes: Option<Vec<u32>>,
    /// Rejection reason code (rejected only).
    pub reason_code: Option<String>,
}

// ============================================================================
// NAPI exports
// ============================================================================

/// Reassemble wire frames into a logical frame.
///
/// `wires` — array of wire frame JSON objects (complete or fragment).
/// `max_assembly_bytes` — caller's requested cap (clamped to 16 MiB).
///
/// Returns a `ReassemblyResult` describing the outcome.
#[napi]
pub fn reassemble_wire_frames(
    wires: Vec<JsonValue>,
    max_assembly_bytes: Option<u32>,
) -> ReassemblyResult {
    let requested = max_assembly_bytes.unwrap_or(MAX_ASSEMBLY_BYTES as u32) as usize;
    let capped = requested.min(MAX_ASSEMBLY_BYTES);

    if capped == 0 {
        return rejected("proto.invalidLimit.maxAssemblyBytes");
    }

    if wires.is_empty() {
        return rejected("proto.frameAssemblyEmpty");
    }

    let first = &wires[0];
    let first_kind = first["kind"].as_str().unwrap_or("");

    if first_kind == "complete" {
        return handle_complete(first, &wires, capped);
    }

    handle_fragments(first, &wires, capped)
}

// ============================================================================
// Complete wire handling
// ============================================================================

fn handle_complete(first: &JsonValue, wires: &[JsonValue], max_assembly_bytes: usize) -> ReassemblyResult {
    // A complete wire must be the sole wire.
    if wires.len() != 1 {
        return rejected("proto.frameAssemblyMetadataMismatch");
    }

    let frame = &first["frame"];

    // Frame must be an object with topic/subscriptionId matching the envelope.
    if !frame_matches_envelope(frame, first) {
        return rejected("proto.frameAssemblyMetadataMismatch");
    }

    // Serialized JSON size check.
    let frame_json = match serde_json::to_string(frame) {
        Ok(s) => s,
        Err(_) => return rejected("proto.frameAssemblyInvalidJson"),
    };
    if frame_json.len() > max_assembly_bytes {
        return rejected("proto.frameAssemblyTooLarge");
    }

    ReassemblyResult {
        kind: "complete".into(),
        frame_json: Some(frame_json),
        delivery_kind: str_opt(first, "deliveryKind"),
        logical_frame_id: None,
        missing_indexes: None,
        reason_code: None,
    }
}

// ============================================================================
// Fragment assembly
// ============================================================================

fn handle_fragments(
    first: &JsonValue,
    wires: &[JsonValue],
    max_assembly_bytes: usize,
) -> ReassemblyResult {
    let fragment_count = first["fragmentCount"].as_u64().unwrap_or(0) as usize;
    let logical_bytes = first["logicalBytes"].as_u64().unwrap_or(0) as usize;

    // Guard against pathological fragment counts.
    if fragment_count > MAX_FRAGMENTS {
        return rejected("proto.frameFragmentCountExceeded");
    }
    if logical_bytes > max_assembly_bytes {
        return rejected("proto.frameAssemblyTooLarge");
    }

    let mut fragments: HashMap<usize, Vec<u8>> = HashMap::new();
    let mut decoded_byte_total: usize = 0;

    for wire in wires {
        // Validate that every wire is a fragment and its metadata matches the first wire.
        if !fragment_metadata_matches(wire, first) {
            return rejected("proto.frameAssemblyMetadataMismatch");
        }

        let data_base64 = wire["dataBase64"].as_str().unwrap_or("");
        let decoded = match base64_decode(data_base64) {
            Ok(bytes) => bytes,
            Err(_) => return rejected("proto.frameAssemblyInvalidBase64"),
        };

        let fragment_index = wire["fragmentIndex"].as_u64().unwrap_or(0) as usize;

        // Duplicate check — identical bytes are tolerated, conflicting bytes are rejected.
        if let Some(existing) = fragments.get(&fragment_index) {
            if existing != &decoded {
                return rejected("proto.frameAssemblyFragmentConflict");
            }
            continue;
        }

        let next_total = decoded_byte_total + decoded.len();
        if next_total > max_assembly_bytes {
            return rejected("proto.frameAssemblyTooLarge");
        }
        if next_total > logical_bytes {
            return rejected("proto.frameAssemblyLengthMismatch");
        }

        decoded_byte_total = next_total;
        fragments.insert(fragment_index, decoded);
    }

    // Find missing indexes.
    let mut missing = Vec::new();
    for i in 0..fragment_count {
        if !fragments.contains_key(&i) {
            missing.push(i as u32);
        }
    }
    if !missing.is_empty() {
        return ReassemblyResult {
            kind: "incomplete".into(),
            frame_json: None,
            delivery_kind: None,
            logical_frame_id: str_opt(first, "logicalFrameId"),
            missing_indexes: Some(missing),
            reason_code: None,
        };
    }

    if decoded_byte_total != logical_bytes {
        return rejected("proto.frameAssemblyLengthMismatch");
    }

    // Assemble fragments in order.
    let mut logical = Vec::with_capacity(decoded_byte_total);
    for i in 0..fragment_count {
        logical.extend_from_slice(fragments.get(&i).unwrap());
    }

    // CRC32 checksum verification.
    let expected_checksum = first
        .pointer("/checksum/value")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let actual_crc = crc32_hex(&logical);
    if actual_crc != expected_checksum {
        return rejected("proto.frameAssemblyChecksumMismatch");
    }

    // UTF-8 decode (fatal).
    let decoded_str = match std::str::from_utf8(&logical) {
        Ok(s) => s,
        Err(_) => return rejected("proto.frameAssemblyInvalidUtf8"),
    };

    // JSON parse.
    let value: JsonValue = match serde_json::from_str(decoded_str) {
        Ok(v) => v,
        Err(_) => return rejected("proto.frameAssemblyInvalidJson"),
    };

    // Frame-envelope consistency check.
    if !frame_matches_envelope(&value, first) {
        return rejected("proto.frameAssemblyMetadataMismatch");
    }

    // Note: Zod schema validation is left to the TypeScript caller.
    ReassemblyResult {
        kind: "complete".into(),
        frame_json: Some(serde_json::to_string(&value).unwrap_or_default()),
        delivery_kind: str_opt(first, "deliveryKind"),
        logical_frame_id: None,
        missing_indexes: None,
        reason_code: None,
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn rejected(reason: &str) -> ReassemblyResult {
    ReassemblyResult {
        kind: "rejected".into(),
        frame_json: None,
        delivery_kind: None,
        logical_frame_id: None,
        missing_indexes: None,
        reason_code: Some(reason.into()),
    }
}

fn str_opt(value: &JsonValue, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Check that the assembled frame's `topic` and `subscriptionId` match the wire envelope.
fn frame_matches_envelope(frame: &JsonValue, wire: &JsonValue) -> bool {
    let frame_topic = frame.get("topic").and_then(|v| v.as_str());
    let frame_sub = frame.get("subscriptionId").and_then(|v| v.as_str());
    let wire_topic = wire.get("topic").and_then(|v| v.as_str());
    let wire_sub = wire.get("subscriptionId").and_then(|v| v.as_str());
    frame_topic == wire_topic && frame_sub == wire_sub
}

/// Validate that a fragment wire's metadata matches the first wire's metadata.
fn fragment_metadata_matches(wire: &JsonValue, first: &JsonValue) -> bool {
    // Must be a fragment.
    if wire["kind"].as_str() != Some("fragment") {
        return false;
    }

    // Core identity fields.
    wire["logicalFrameId"] == first["logicalFrameId"]
        && wire["logicalFrameOrdinal"] == first["logicalFrameOrdinal"]
        && wire["deliveryKind"] == first["deliveryKind"]
        && wire["topic"] == first["topic"]
        && wire["subscriptionId"] == first["subscriptionId"]
        && wire["fragmentCount"] == first["fragmentCount"]
        && wire["logicalBytes"] == first["logicalBytes"]
        && wire["checksum"] == first["checksum"]
        // Structural invariants.
        && first["fragmentCount"].as_u64().unwrap_or(0) <= first["logicalBytes"].as_u64().unwrap_or(0)
        // Index bounds (use i64 to match TS number semantics).
        && wire["fragmentIndex"].as_i64().map_or(false, |i| i >= 0)
        && wire["fragmentIndex"].as_i64().unwrap_or(0) < wire["fragmentCount"].as_i64().unwrap_or(0)
}

// ============================================================================
// CRC32 — polynomial 0xEDB88320 (reflected), ISO 3309
// ============================================================================

/// Compile-time CRC32 lookup table.
const CRC32_TABLE: [u32; 256] = build_crc32_table();

const fn build_crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i: u32 = 0;
    while i < 256 {
        let mut crc = i;
        let mut bit = 0u32;
        while bit < 8 {
            crc = (crc >> 1) ^ (if crc & 1 != 0 { 0xEDB88320 } else { 0 });
            bit += 1;
        }
        table[i as usize] = crc;
        i += 1;
    }
    table
}

/// Compute CRC32 and return the 8-char lowercase hex string.
fn crc32_hex(bytes: &[u8]) -> String {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in bytes {
        crc = (crc >> 8) ^ CRC32_TABLE[((crc ^ byte as u32) & 0xFF) as usize];
    }
    let final_crc = crc ^ 0xFFFF_FFFF;

    let hex_chars = b"0123456789abcdef";
    let mut buf = [0u8; 8];
    let mut val = final_crc;
    let mut i = 8usize;
    while i > 0 {
        i -= 1;
        buf[i] = hex_chars[(val & 0xF) as usize];
        val >>= 4;
    }
    // SAFETY: hex chars are all valid ASCII/UTF-8.
    unsafe { std::str::from_utf8_unchecked(&buf) }.to_string()
}

// ============================================================================
// Base64 decode (standard alphabet, no external dependencies)
// ============================================================================

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Decode standard base64.  Returns `Err(())` on invalid input.
fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    // Must be a multiple of 4.
    if s.len() % 4 != 0 {
        return Err(());
    }

    let bytes = s.as_bytes();
    let padding = if s.ends_with("==") {
        2
    } else if s.ends_with('=') {
        1
    } else {
        0
    };
    let output_len = (s.len() / 4) * 3 - padding;
    let mut output = Vec::with_capacity(output_len);

    for chunk in bytes.chunks(4) {
        let a = BASE64_ALPHABET
            .iter()
            .position(|&c| c == chunk[0])
            .ok_or(())?;
        let b = BASE64_ALPHABET
            .iter()
            .position(|&c| c == chunk[1])
            .ok_or(())?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            BASE64_ALPHABET
                .iter()
                .position(|&cc| cc == chunk[2])
                .ok_or(())?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            BASE64_ALPHABET
                .iter()
                .position(|&cc| cc == chunk[3])
                .ok_or(())?
        };
        let combined = (a << 18) | (b << 12) | (c << 6) | d;

        if output.len() < output_len {
            output.push((combined >> 16) as u8);
        }
        if output.len() < output_len {
            output.push(((combined >> 8) & 0xFF) as u8);
        }
        if output.len() < output_len {
            output.push((combined & 0xFF) as u8);
        }
    }

    Ok(output)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -- helpers to build wire JSON objects -----------------------------------

    fn complete_wire(topic: &str, sub: &str, frame: &JsonValue) -> JsonValue {
        serde_json::json!({
            "kind": "complete",
            "wireVersion": 3,
            "deliveryKind": "initial",
            "logicalFrameId": "frame-1",
            "logicalFrameOrdinal": 0,
            "topic": topic,
            "subscriptionId": sub,
            "frame": frame,
        })
    }

    fn fragment_wire(
        topic: &str,
        sub: &str,
        fragment_index: u32,
        fragment_count: u32,
        logical_bytes: usize,
        data_base64: &str,
        checksum_hex: &str,
    ) -> JsonValue {
        serde_json::json!({
            "kind": "fragment",
            "wireVersion": 3,
            "deliveryKind": "initial",
            "logicalFrameId": "frame-1",
            "logicalFrameOrdinal": 0,
            "topic": topic,
            "subscriptionId": sub,
            "fragmentIndex": fragment_index,
            "fragmentCount": fragment_count,
            "logicalBytes": logical_bytes,
            "checksum": { "algorithm": "crc32", "value": checksum_hex },
            "dataBase64": data_base64,
        })
    }

    fn encode_and_checksum(payload: &str) -> (String, String) {
        let bytes = payload.as_bytes();
        let encoded = base64_encode(bytes);
        let checksum = crc32_hex(bytes);
        (encoded, checksum)
    }

    fn base64_encode(bytes: &[u8]) -> String {
        const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
            let triple = (b0 << 16) | (b1 << 8) | b2;
            out.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
            out.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
            if chunk.len() > 1 {
                out.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                out.push(CHARS[(triple & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
        }
        out
    }

    // -- complete frame tests ------------------------------------------------

    #[test]
    fn complete_single_wire() {
        let frame = serde_json::json!({"topic": "t", "subscriptionId": "s", "data": 42});
        let wire = complete_wire("t", "s", &frame);
        let result = reassemble_wire_frames(vec![wire], None);
        assert_eq!(result.kind, "complete");
        let parsed: JsonValue = serde_json::from_str(&result.frame_json.unwrap()).unwrap();
        assert_eq!(parsed["data"], 42);
        assert_eq!(result.delivery_kind.as_deref(), Some("initial"));
    }

    #[test]
    fn complete_rejected_multiple_wires() {
        let frame = serde_json::json!({"topic": "t", "subscriptionId": "s"});
        let w1 = complete_wire("t", "s", &frame);
        let w2 = complete_wire("t", "s", &frame);
        let result = reassemble_wire_frames(vec![w1, w2], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn complete_rejected_envelope_mismatch() {
        let frame = serde_json::json!({"topic": "other", "subscriptionId": "s"});
        let wire = complete_wire("t", "s", &frame);
        let result = reassemble_wire_frames(vec![wire], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn complete_rejected_too_large() {
        let big_frame = serde_json::json!({"topic": "t", "subscriptionId": "s", "data": "x".repeat(20_000_000)});
        let wire = complete_wire("t", "s", &big_frame);
        let result = reassemble_wire_frames(vec![wire], Some(1000));
        assert_eq!(result.kind, "rejected");
        assert_eq!(result.reason_code.as_deref(), Some("proto.frameAssemblyTooLarge"));
    }

    // -- fragment assembly tests ---------------------------------------------

    #[test]
    fn fragment_assembly_two_fragments() {
        let payload = r#"{"topic":"t","subscriptionId":"s","data":"hello"}"#;
        let (_encoded, checksum) = encode_and_checksum(payload);
        let mid = payload.len() / 2;
        let enc0 = base64_encode(payload.as_bytes()[..mid].as_ref());
        let enc1 = base64_encode(payload.as_bytes()[mid..].as_ref());

        let w0 = fragment_wire("t", "s", 0, 2, payload.len(), &enc0, &checksum);
        let w1 = fragment_wire("t", "s", 1, 2, payload.len(), &enc1, &checksum);

        let result = reassemble_wire_frames(vec![w0, w1], None);
        assert_eq!(result.kind, "complete");
        let parsed: JsonValue = serde_json::from_str(&result.frame_json.unwrap()).unwrap();
        assert_eq!(parsed["data"], "hello");
    }

    #[test]
    fn fragment_assembly_single_fragment() {
        let payload = r#"{"topic":"t","subscriptionId":"s","val":1}"#;
        let (encoded, checksum) = encode_and_checksum(payload);

        let w = fragment_wire("t", "s", 0, 1, payload.len(), &encoded, &checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "complete");
    }

    #[test]
    fn missing_fragments() {
        let payload = r#"{"topic":"t","subscriptionId":"s","val":2}"#;
        let (encoded, checksum) = encode_and_checksum(payload);

        // Only fragment 0 provided, fragment 1 missing.
        let w = fragment_wire("t", "s", 0, 2, payload.len(), &encoded, &checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "incomplete");
        assert_eq!(result.missing_indexes.as_ref().unwrap(), &vec![1]);
        assert_eq!(result.logical_frame_id.as_deref(), Some("frame-1"));
    }

    #[test]
    fn crc32_mismatch_rejected() {
        let payload = r#"{"topic":"t","subscriptionId":"s","val":3}"#;
        let encoded = base64_encode(payload.as_bytes());
        let bad_checksum = "00000000";

        let w = fragment_wire("t", "s", 0, 1, payload.len(), &encoded, bad_checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyChecksumMismatch")
        );
    }

    #[test]
    fn invalid_base64_rejected() {
        let payload = r#"{"topic":"t","subscriptionId":"s","val":4}"#;
        let (_, checksum) = encode_and_checksum(payload);

        let w = fragment_wire("t", "s", 0, 1, payload.len(), "not-valid-base64!!!", &checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyInvalidBase64")
        );
    }

    #[test]
    fn invalid_utf8_rejected() {
        // Build raw bytes that are invalid UTF-8, then CRC32 and base64-encode them.
        let invalid_utf8: &[u8] = &[0xFF, 0xFE, 0xFD];
        let encoded = base64_encode(invalid_utf8);
        let checksum = crc32_hex(invalid_utf8);

        // The wire's topic/subscriptionId fields are in the envelope, not the payload.
        let w = fragment_wire("t", "s", 0, 1, invalid_utf8.len(), &encoded, &checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyInvalidUtf8")
        );
    }

    #[test]
    fn invalid_json_rejected() {
        // Valid UTF-8 but not valid JSON.
        let payload = "this is not json at all {{{";
        let encoded = base64_encode(payload.as_bytes());
        let checksum = crc32_hex(payload.as_bytes());

        let w = fragment_wire("t", "s", 0, 1, payload.len(), &encoded, &checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyInvalidJson")
        );
    }

    #[test]
    fn frame_envelope_mismatch_after_assembly_rejected() {
        // Payload JSON has mismatched topic/subscriptionId.
        let payload = r#"{"topic":"WRONG","subscriptionId":"WRONG","data":"x"}"#;
        let encoded = base64_encode(payload.as_bytes());
        let checksum = crc32_hex(payload.as_bytes());

        let w = fragment_wire("t", "s", 0, 1, payload.len(), &encoded, &checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn empty_wires_rejected() {
        let result = reassemble_wire_frames(vec![], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyEmpty")
        );
    }

    #[test]
    fn metadata_mismatch_between_fragments_rejected() {
        let payload = r#"{"topic":"t","subscriptionId":"s"}"#;
        let (enc0, chk) = encode_and_checksum(payload);
        let enc1 = enc0.clone();

        let w0 = fragment_wire("t", "s", 0, 2, payload.len(), &enc0, &chk);
        let mut w1 = fragment_wire("t", "s", 1, 2, payload.len(), &enc1, &chk);

        // Mutate w1 to have a different logicalFrameId.
        w1["logicalFrameId"] = JsonValue::String("different-id".into());

        let result = reassemble_wire_frames(vec![w0, w1], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn duplicate_identical_fragment_ok() {
        let payload = r#"{"topic":"t","subscriptionId":"s","d":1}"#;
        let (encoded, checksum) = encode_and_checksum(payload);

        let w = fragment_wire("t", "s", 0, 1, payload.len(), &encoded, &checksum);
        // Send the same wire twice — should be fine.
        let result = reassemble_wire_frames(vec![w.clone(), w], None);
        assert_eq!(result.kind, "complete");
    }

    #[test]
    fn conflicting_duplicate_fragment_rejected() {
        let payload0 = r#"{"topic":"t","subscriptionId":"s","d":1}"#;
        let payload1 = r#"{"topic":"t","subscriptionId":"s","d":2}"#;
        // Use a shared logical-frame checksum (the checksum of the *assembled* frame).
        // Both fragments claim the same frame identity — only the data differs.
        let shared_checksum = "aaaaaaaa";

        let enc0 = base64_encode(payload0.as_bytes());
        let enc1 = base64_encode(payload1.as_bytes());

        let w0 = fragment_wire("t", "s", 0, 1, payload0.len(), &enc0, shared_checksum);
        let w1 = fragment_wire("t", "s", 0, 1, payload0.len(), &enc1, shared_checksum);

        let result = reassemble_wire_frames(vec![w0, w1], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyFragmentConflict")
        );
    }

    // -- base64 encode/roundtrip tests ---------------------------------------

    #[test]
    fn base64_roundtrip() {
        let original = b"Hello, world! This is a test of base64 encoding.";
        let encoded = base64_encode(original);
        let decoded = base64_decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn base64_empty() {
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn base64_invalid_length() {
        assert!(base64_decode("abc").is_err());
    }

    #[test]
    fn base64_invalid_chars() {
        assert!(base64_decode("====").is_err());
    }

    // -- CRC32 tests ---------------------------------------------------------

    #[test]
    fn crc32_known_value() {
        // CRC32 of "123456789" = 0xCBF43926
        let crc = crc32_hex(b"123456789");
        assert_eq!(crc, "cbf43926");
    }

    #[test]
    fn crc32_empty() {
        let crc = crc32_hex(b"");
        assert_eq!(crc, "00000000");
    }

    // -- fragment index bounds ------------------------------------------------

    #[test]
    fn fragment_index_out_of_bounds_rejected() {
        let payload = r#"{"topic":"t","subscriptionId":"s","d":1}"#;
        let encoded = base64_encode(payload.as_bytes());
        let checksum = crc32_hex(payload.as_bytes());

        // fragmentIndex=5 but fragmentCount=2 → out of bounds
        let w = fragment_wire("t", "s", 5, 2, payload.len(), &encoded, &checksum);
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "rejected");
        assert_eq!(
            result.reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn wrong_kind_wire_rejected() {
        let w = serde_json::json!({
            "kind": "something_else",
            "wireVersion": 3,
            "deliveryKind": "initial",
            "logicalFrameId": "frame-1",
            "logicalFrameOrdinal": 0,
            "topic": "t",
            "subscriptionId": "s",
            "fragmentIndex": 0,
            "fragmentCount": 1,
            "logicalBytes": 10,
            "checksum": { "algorithm": "crc32", "value": "00000000" },
            "dataBase64": "AAAA",
        });
        let result = reassemble_wire_frames(vec![w], None);
        assert_eq!(result.kind, "rejected");
    }
}
