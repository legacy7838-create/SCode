//! V4 wire frame assembler — Rust port of `wire-assembler.ts`.
//!
//! Stateful fragment reassembly with ordinal tracking, timeout expiry,
//! supersession handling, and recovery filtering. All frame validation
//! is pure in-memory; Zod schema validation stays on the TypeScript side.

use std::collections::HashMap;
use serde_json::Value as JsonValue;

// ============================================================================
// Protocol limits (mirrors PROTOCOL_V4_LIMITS in core.ts)
// ============================================================================

pub const DEFAULT_MAX_ASSEMBLY_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_FRAGMENTS: usize = 1024;
pub const DEFAULT_MAX_CONCURRENT_ASSEMBLIES: usize = 32;
pub const DEFAULT_MAX_STAGED_DECODED_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u32 = 30_000;
pub const DEFAULT_MAX_PHYSICAL_FRAME_BYTES: usize = 1024 * 1024;

// ============================================================================
// Constants
// ============================================================================

/// Channel event response type (wire-codec.ts).
const CHANNEL_EVENT_RESPONSE_TYPE: u32 = 204;

/// Socket protocol header bytes (wire-codec.ts).
const SOCKET_PROTOCOL_HEADER_BYTES: u32 = 13;

/// Transport envelope ID max chars (PROTOCOL_V4_LIMITS).
const TRANSPORT_ENVELOPE_ID_MAX_CHARS: usize = 256;

/// Allowed keys for complete wire frames.
const COMPLETE_WIRE_KEYS: &[&str] = &[
    "wireVersion",
    "kind",
    "deliveryKind",
    "logicalFrameId",
    "logicalFrameOrdinal",
    "topic",
    "subscriptionId",
    "frame",
];

/// Allowed keys for fragment wire frames.
const FRAGMENT_WIRE_KEYS: &[&str] = &[
    "wireVersion",
    "kind",
    "deliveryKind",
    "logicalFrameId",
    "logicalFrameOrdinal",
    "topic",
    "subscriptionId",
    "fragmentIndex",
    "fragmentCount",
    "logicalBytes",
    "checksum",
    "dataBase64",
];

/// Allowed keys for checksum objects.
const CHECKSUM_KEYS: &[&str] = &["algorithm", "value"];

/// Fault reason codes (matches wire-fault.ts).
pub const WIRE_FAULT_INVALID_PAYLOAD: &str = "proto.frameAssemblyInvalidPayload";

// ============================================================================
// CRC32 (ISO 3309, polynomial 0xEDB88320 reflected)
// ============================================================================

/// CRC32 lookup table.
const CRC32_TABLE: [u32; 256] = build_crc32_table();

const fn build_crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0u32;
    while i < 256 {
        let mut crc = i;
        let mut j = 0;
        while j < 8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
            j += 1;
        }
        table[i as usize] = crc;
        i += 1;
    }
    table
}

/// CRC32 checksum returning 8-char lowercase hex string.
fn crc32_hex(bytes: &[u8]) -> String {
    let mut crc: u32 = 0xFFFFFFFF;
    for &byte in bytes {
        crc = CRC32_TABLE[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    format!("{:08x}", crc ^ 0xFFFFFFFF)
}

// ============================================================================
// Base64
// ============================================================================

/// Base64 alphabet.
const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Validate and decode standard base64.
/// Matches the TS regex: `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`
fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return Some(Vec::new());
    }

    // Validate characters and padding structure
    let mut valid_chars = 0;
    for &b in bytes {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => valid_chars += 1,
            b'=' => {
                // After '=' only '=' allowed
                for &b2 in &bytes[valid_chars + 1..] {
                    if b2 != b'=' {
                        return None;
                    }
                }
                break;
            }
            _ => return None,
        }
    }

    // Validate length constraints — total length must be a multiple of 4
    let total = bytes.len();
    if total % 4 != 0 {
        return None;
    }
    let pad_count = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if pad_count > 2 {
        return None;
    }

    // Decode — total is a multiple of 4; each 4-char group decodes to ≤3 bytes
    let mut output = Vec::with_capacity((total * 3) / 4);
    let chunks = total / 4;

    for i in 0..chunks {
        let base = i * 4;
        let b0 = BASE64_ALPHABET.iter().position(|&c| c == bytes[base])? as u32;
        let b1 = BASE64_ALPHABET.iter().position(|&c| c == bytes[base + 1])? as u32;
        let b2 = if base + 2 < total && bytes[base + 2] != b'=' {
            BASE64_ALPHABET.iter().position(|&c| c == bytes[base + 2])? as u32
        } else {
            0
        };
        let b3 = if base + 3 < total && bytes[base + 3] != b'=' {
            BASE64_ALPHABET.iter().position(|&c| c == bytes[base + 3])? as u32
        } else {
            0
        };

        let triplet = (b0 << 18) | (b1 << 12) | (b2 << 6) | b3;
        output.push((triplet >> 16) as u8);
        if base + 2 < total && bytes[base + 2] != b'=' {
            output.push((triplet >> 8) as u8);
        }
        if base + 3 < total && bytes[base + 3] != b'=' {
            output.push(triplet as u8);
        }
    }

    Some(output)
}

// ============================================================================
// VQL byte length (variable-length quantity, 7 bits per byte)
// ============================================================================

fn vql_byte_length(value: u32) -> usize {
    let mut bytes: usize = 1;
    let mut remaining = value >> 7;
    while remaining > 0 {
        bytes += 1;
        remaining >>= 7;
    }
    bytes
}

// ============================================================================
// Envelope measurement (3-layer)
// ============================================================================

/// Result of measuring a candidate wire frame across all three production layers.
#[derive(Debug, Clone)]
pub struct EnvelopeMeasurement {
    pub cli_ndjson_bytes: usize,
    pub channel_socket_bytes: usize,
    pub mobile_relay_bytes: usize,
    pub max_bytes: usize,
}

/// Measure a wire frame across the 3-layer production envelope.
fn measure_envelope_bytes(wire_json: &[u8]) -> EnvelopeMeasurement {
    let wire_value: JsonValue = serde_json::from_slice(wire_json).unwrap_or(JsonValue::Null);
    let wire_json_len = wire_json.len();

    // Layer 1: CLI NDJSON
    let mut cli_method = serde_json::Map::new();
    cli_method.insert("method".into(), JsonValue::String("v4/conversation/frame".into()));
    cli_method.insert("params".into(), wire_value.clone());
    let cli_ndjson_bytes = utf8_json_byte_length(&JsonValue::Object(cli_method)) + 1; // +1 for newline

    // Layer 2: Channel+Socket
    let max_event_id_json_bytes = format!("{}", i64::MAX).len();
    let max_event_id_serialized_bytes = 1 + vql_byte_length(max_event_id_json_bytes as u32) + max_event_id_json_bytes;
    let channel_header_bytes = 1 + vql_byte_length(2) + 1 + vql_byte_length(CHANNEL_EVENT_RESPONSE_TYPE) + max_event_id_serialized_bytes;
    let channel_payload_bytes = channel_header_bytes + 1 + vql_byte_length(wire_json_len as u32) + wire_json_len;
    let channel_socket_bytes = channel_payload_bytes + SOCKET_PROTOCOL_HEADER_BYTES as usize;

    // Layer 3: Mobile relay
    let data_base64_bytes = 4 * ((channel_payload_bytes + 2) / 3);
    let transport_id = "x".repeat(TRANSPORT_ENVELOPE_ID_MAX_CHARS);
    let mut relay_obj = serde_json::Map::new();
    relay_obj.insert("type".into(), JsonValue::String("data".into()));
    let mut payload_obj = serde_json::Map::new();
    payload_obj.insert("zcode_type".into(), JsonValue::String("rpc-frame".into()));
    payload_obj.insert("bridgeSessionId".into(), JsonValue::String(transport_id.clone()));
    payload_obj.insert("bridgeGeneration".into(), JsonValue::Number(serde_json::Number::from(i64::MAX)));
    payload_obj.insert("recoveryId".into(), JsonValue::String(transport_id));
    payload_obj.insert("seq".into(), JsonValue::Number(serde_json::Number::from(i64::MAX)));
    payload_obj.insert("dataBase64".into(), JsonValue::String(String::new()));
    relay_obj.insert("payload".into(), JsonValue::Object(payload_obj));
    relay_obj.insert("client_ts".into(), JsonValue::Number(serde_json::Number::from(i64::MAX)));
    relay_obj.insert("server_ts".into(), JsonValue::Number(serde_json::Number::from(i64::MAX)));
    let mobile_relay_fixed_bytes = utf8_json_byte_length(&JsonValue::Object(relay_obj));
    let mobile_relay_bytes = mobile_relay_fixed_bytes + data_base64_bytes;

    let max_bytes = cli_ndjson_bytes.max(channel_socket_bytes).max(mobile_relay_bytes);

    EnvelopeMeasurement { cli_ndjson_bytes, channel_socket_bytes, mobile_relay_bytes, max_bytes }
}

/// UTF-8 byte length of serializing `value` as JSON.
fn utf8_json_byte_length(value: &JsonValue) -> usize {
    serde_json::to_vec(value).map(|v| v.len()).unwrap_or(0)
}

// ============================================================================
// Internal helpers
// ============================================================================

/// Build route key from topic and subscription ID.
fn route_key(topic: &str, subscription_id: &str) -> String {
    format!("{}\0{}", topic, subscription_id)
}

/// Check if a JSON object has only the allowed keys.
fn has_only_keys(obj: &serde_json::Map<String, JsonValue>, allowed: &[&str]) -> bool {
    obj.keys().all(|key| allowed.contains(&key.as_str()))
}

/// Parse a delivery kind string.
fn parse_delivery_kind_str(value: &str) -> Option<&'static str> {
    match value {
        "initial" => Some("initial"),
        "online" => Some("online"),
        "recovery" => Some("recovery"),
        _ => None,
    }
}

/// Parse a delivery kind from a JSON value.
fn parse_delivery_kind(value: &JsonValue) -> Option<&'static str> {
    value.as_str().and_then(parse_delivery_kind_str)
}

/// Validate the inner fields of a fragment wire frame.
fn has_valid_fragment_inner(obj: &serde_json::Map<String, JsonValue>) -> bool {
    if !has_only_keys(obj, FRAGMENT_WIRE_KEYS) {
        return false;
    }
    let fragment_index = match obj.get("fragmentIndex") {
        Some(JsonValue::Number(n)) => n.as_i64(),
        _ => return false,
    };
    let fragment_count = match obj.get("fragmentCount") {
        Some(JsonValue::Number(n)) => n.as_i64(),
        _ => return false,
    };
    let logical_bytes = match obj.get("logicalBytes") {
        Some(JsonValue::Number(n)) => n.as_i64(),
        _ => return false,
    };
    let data_base64 = matches!(obj.get("dataBase64"), Some(JsonValue::String(_)));
    let checksum = match obj.get("checksum") {
        Some(JsonValue::Object(o)) if !o.is_empty() && has_only_keys(o, CHECKSUM_KEYS) => o,
        _ => return false,
    };
    let checksum_algorithm = matches!(checksum.get("algorithm"), Some(JsonValue::String(_)));
    let checksum_value = matches!(checksum.get("value"), Some(JsonValue::String(_)));

    fragment_index.is_some()
        && fragment_count.is_some()
        && logical_bytes.is_some()
        && data_base64
        && checksum_algorithm
        && checksum_value
}

/// Check if a parsed JSON frame matches the envelope topic/subscriptionId.
fn frame_matches_envelope(frame: &JsonValue, topic: &str, subscription_id: &str) -> bool {
    let obj = match frame.as_object() {
        Some(o) => o,
        None => return false,
    };
    let frame_topic = obj.get("topic").and_then(|v| v.as_str());
    let frame_sub = obj.get("subscriptionId").and_then(|v| v.as_str());
    frame_topic == Some(topic) && frame_sub == Some(subscription_id)
}

/// Byte-level comparison of two slices.
fn bytes_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left == right
}

// ============================================================================
// Assembler configuration
// ============================================================================

/// Configuration limits for the assembler.
pub struct AssemblerLimits {
    pub max_assembly_bytes: usize,
    pub max_fragments: usize,
    pub max_concurrent_assemblies: usize,
    pub max_staged_decoded_bytes: usize,
    pub timeout_ms: u32,
    pub max_physical_frame_bytes: usize,
}

impl Default for AssemblerLimits {
    fn default() -> Self {
        Self {
            max_assembly_bytes: DEFAULT_MAX_ASSEMBLY_BYTES,
            max_fragments: DEFAULT_MAX_FRAGMENTS,
            max_concurrent_assemblies: DEFAULT_MAX_CONCURRENT_ASSEMBLIES,
            max_staged_decoded_bytes: DEFAULT_MAX_STAGED_DECODED_BYTES,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_physical_frame_bytes: DEFAULT_MAX_PHYSICAL_FRAME_BYTES,
        }
    }
}

// ============================================================================
// FragmentAssembly (in-flight state for one route)
// ============================================================================

struct FragmentAssembly {
    delivery_kind: String,
    logical_frame_id: String,
    logical_frame_ordinal: u32,
    topic: String,
    subscription_id: String,
    fragment_count: usize,
    logical_bytes: usize,
    checksum_algorithm: String,
    checksum_value: String,
    fragments: Vec<Option<Vec<u8>>>,
    received_count: usize,
    decoded_bytes: usize,
    first_seen_at: u32,
}

// ============================================================================
// SettledLogicalFrame (tombstone)
// ============================================================================

struct SettledLogicalFrame {
    logical_frame_id: String,
    logical_frame_ordinal: u32,
}

// ============================================================================
// AssemblerEvent (output)
// ============================================================================

/// An event emitted by the assembler: either a complete frame or a fault.
#[derive(Debug, Clone)]
pub struct AssemblerEvent {
    pub kind: &'static str,
    pub frame_json: Option<String>,
    pub delivery_kind: Option<String>,
    pub reason_code: Option<String>,
    pub logical_frame_id: String,
    pub logical_frame_ordinal: u32,
    pub topic: String,
    pub subscription_id: String,
}

// ============================================================================
// Core Assembler
// ============================================================================

/// The core stateful wire frame assembler.
pub struct Assembler {
    assemblies: HashMap<String, FragmentAssembly>,
    settled_by_route: HashMap<String, SettledLogicalFrame>,
    staged_decoded_bytes: usize,
    max_assembly_bytes: usize,
    max_fragments: usize,
    max_concurrent_assemblies: usize,
    max_staged_decoded_bytes: usize,
    timeout_ms: u32,
    max_physical_frame_bytes: usize,
}

impl Assembler {
    /// Create a new assembler with the given limits.
    pub fn new(limits: AssemblerLimits) -> Self {
        Self {
            assemblies: HashMap::new(),
            settled_by_route: HashMap::new(),
            staged_decoded_bytes: 0,
            max_assembly_bytes: limits.max_assembly_bytes,
            max_fragments: limits.max_fragments,
            max_concurrent_assemblies: limits.max_concurrent_assemblies,
            max_staged_decoded_bytes: limits.max_staged_decoded_bytes,
            timeout_ms: limits.timeout_ms,
            max_physical_frame_bytes: limits.max_physical_frame_bytes,
        }
    }

    /// Process a wire frame candidate and return any events (complete or fault).
    pub fn accept(&mut self, wire: &JsonValue, now: u32) -> Vec<AssemblerEvent> {
        let mut events = self.expire(now);

        let wire_obj = match wire.as_object() {
            Some(o) => o,
            None => {
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }
        };

        let topic = match wire_obj.get("topic").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => {
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }
        };
        let subscription_id = match wire_obj.get("subscriptionId").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => {
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }
        };
        let logical_frame_ordinal =
            match wire_obj.get("logicalFrameOrdinal").and_then(|v| v.as_i64()) {
                Some(n) if n >= 1 => n as u32,
                _ => {
                    events.push(self.build_fault_from_wire(
                        wire,
                        "proto.frameAssemblyMetadataMismatch",
                    ));
                    return events;
                }
            };
        let logical_frame_id = match wire_obj.get("logicalFrameId").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => {
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }
        };
        let wire_kind = wire_obj.get("kind").and_then(|v| v.as_str());

        let key = route_key(&topic, &subscription_id);

        // Ordinal eviction checks (must precede envelope/base64 decode)
        if let Some(settled) = self.settled_by_route.get(&key) {
            if logical_frame_ordinal < settled.logical_frame_ordinal {
                return events;
            }
            if logical_frame_ordinal == settled.logical_frame_ordinal {
                if logical_frame_id != settled.logical_frame_id {
                    events.push(self.build_fault_from_wire(
                        wire,
                        "proto.frameAssemblyOrdinalConflict",
                    ));
                }
                return events;
            }
        }

        let delivery_kind = wire_obj.get("deliveryKind").and_then(parse_delivery_kind);

        // Recovery: filter old faults for same route with lower ordinal
        if delivery_kind == Some("recovery") {
            events.retain(|event| {
                !(event.kind == "fault"
                    && event.topic == topic
                    && event.subscription_id == subscription_id
                    && event.logical_frame_ordinal < logical_frame_ordinal)
            });
        }

        // Check against current active assembly (mirrors TS wire-assembler.ts)
        let current_info = self
            .assemblies
            .get(&key)
            .map(|a| (a.logical_frame_ordinal, a.logical_frame_id.clone()));
        if let Some((current_ord, current_id)) = current_info {
            if logical_frame_ordinal < current_ord {
                return events;
            }
            if logical_frame_ordinal == current_ord {
                if logical_frame_id != current_id {
                    // Ordinal conflict: different frameId at same ordinal
                    let assembly = self.assemblies.remove(&key).unwrap();
                    self.staged_decoded_bytes -= assembly.decoded_bytes;
                    self.settle(&key, &assembly.logical_frame_id, assembly.logical_frame_ordinal);
                    events.push(self.build_fault_from_assembly(
                        &assembly,
                        "proto.frameAssemblyOrdinalConflict",
                    ));
                    return events;
                }
                // Same ordinal + same frameId = fall through to fragment handling
            } else {
                // Supersession: ordinal is higher
                let assembly = self.assemblies.remove(&key).unwrap();
                self.staged_decoded_bytes -= assembly.decoded_bytes;
                self.settle(&key, &assembly.logical_frame_id, assembly.logical_frame_ordinal);
                if delivery_kind != Some("recovery") {
                    events.push(self.build_fault_from_assembly(
                        &assembly,
                        "proto.frameAssemblySuperseded",
                    ));
                }
            }
        }

        if delivery_kind.is_none() {
            self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
            events.push(self.build_fault_from_wire(
                wire,
                "proto.frameAssemblyMetadataMismatch",
            ));
            return events;
        }

        // ---- COMPLETE frame handling ----
        if wire_kind == Some("complete") {
            if !wire_obj.contains_key("frame") || !has_only_keys(wire_obj, COMPLETE_WIRE_KEYS) {
                self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }

            // Envelope size check
            let wire_json_bytes = serde_json::to_vec(wire).unwrap_or_default();
            let envelope = measure_envelope_bytes(&wire_json_bytes);
            if envelope.max_bytes > self.max_physical_frame_bytes {
                self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameEnvelopeTooLarge",
                ));
                return events;
            }

            // Active assembly check
            if self.assemblies.contains_key(&key) {
                let assembly = self.assemblies.remove(&key).unwrap();
                self.staged_decoded_bytes -= assembly.decoded_bytes;
                self.settle(&key, &assembly.logical_frame_id, assembly.logical_frame_ordinal);
                events.push(self.build_fault_from_assembly(
                    &assembly,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }

            // Logical bytes check
            let frame_value = wire_obj.get("frame").unwrap();
            let logical_bytes = utf8_json_byte_length(frame_value);
            if logical_bytes > self.max_assembly_bytes {
                self.settle(&key, &logical_frame_id, logical_frame_ordinal);
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyTooLarge",
                ));
                return events;
            }

            // Frame matches envelope check
            if !frame_matches_envelope(frame_value, &topic, &subscription_id) {
                self.settle(&key, &logical_frame_id, logical_frame_ordinal);
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }

            // Schema validation stays on TS side; accept valid JSON
            self.settle(&key, &logical_frame_id, logical_frame_ordinal);
            let frame_json = serde_json::to_string(frame_value).unwrap_or_default();
            events.push(AssemblerEvent {
                kind: "complete",
                frame_json: Some(frame_json),
                delivery_kind: delivery_kind.map(|s| s.to_string()),
                reason_code: None,
                logical_frame_id,
                logical_frame_ordinal,
                topic,
                subscription_id,
            });
            return events;
        }

        // ---- FRAGMENT frame handling ----
        if wire_kind != Some("fragment") {
            self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
            events.push(self.build_fault_from_wire(
                wire,
                "proto.frameAssemblyMetadataMismatch",
            ));
            return events;
        }

        if !has_valid_fragment_inner(wire_obj) {
            self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
            events.push(self.build_fault_from_wire(
                wire,
                "proto.frameAssemblyMetadataMismatch",
            ));
            return events;
        }

        // Envelope size check
        let wire_json_bytes = serde_json::to_vec(wire).unwrap_or_default();
        let envelope = measure_envelope_bytes(&wire_json_bytes);
        if envelope.max_bytes > self.max_physical_frame_bytes {
            self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
            events.push(self.build_fault_from_wire(
                wire,
                "proto.frameEnvelopeTooLarge",
            ));
            return events;
        }

        let fragment_count = wire_obj
            .get("fragmentCount")
            .unwrap()
            .as_i64()
            .unwrap() as usize;
        let logical_bytes = wire_obj
            .get("logicalBytes")
            .unwrap()
            .as_i64()
            .unwrap() as usize;
        let fragment_index = wire_obj
            .get("fragmentIndex")
            .unwrap()
            .as_i64()
            .unwrap() as usize;
        let checksum_obj = wire_obj.get("checksum").unwrap().as_object().unwrap();
        let checksum_algorithm = checksum_obj.get("algorithm").unwrap().as_str().unwrap();
        let checksum_value = checksum_obj.get("value").unwrap().as_str().unwrap();

        if fragment_count > self.max_fragments {
            self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
            events.push(self.build_fault_from_wire(
                wire,
                "proto.frameFragmentCountExceeded",
            ));
            return events;
        }

        if logical_bytes > self.max_assembly_bytes {
            self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
            events.push(self.build_fault_from_wire(
                wire,
                "proto.frameAssemblyTooLarge",
            ));
            return events;
        }

        // Metadata range checks
        if fragment_count < 1
            || fragment_index >= fragment_count
            || logical_bytes < 1
            || fragment_count > logical_bytes
            || checksum_algorithm != "crc32"
            || checksum_value.len() != 8
            || !checksum_value.chars().all(|c| c.is_ascii_hexdigit())
        {
            self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
            events.push(self.build_fault_from_wire(
                wire,
                "proto.frameAssemblyMetadataMismatch",
            ));
            return events;
        }

        // Base64 decode
        let data_base64 = wire_obj.get("dataBase64").unwrap().as_str().unwrap();
        let decoded = match decode_base64(data_base64) {
            Some(d) => d,
            None => {
                self.release_and_settle(&key, &logical_frame_id, logical_frame_ordinal);
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyInvalidBase64",
                ));
                return events;
            }
        };

        // Check or create assembly
        let assembly_exists = self.assemblies.contains_key(&key);
        if assembly_exists {
            // Validate metadata consistency
            let mismatch = {
                let assembly = self.assemblies.get(&key).unwrap();
                let fc = assembly.fragment_count != fragment_count;
                let dk = assembly.delivery_kind.as_str() != delivery_kind.unwrap_or("");
                let lb = assembly.logical_bytes != logical_bytes;
                let ca = assembly.checksum_algorithm != checksum_algorithm.as_ref();
                let cv = assembly.checksum_value != checksum_value;
                fc || dk || lb || ca || cv
            };
            if mismatch {
                let assembly = self.assemblies.remove(&key).unwrap();
                self.staged_decoded_bytes -= assembly.decoded_bytes;
                self.settle(&key, &assembly.logical_frame_id, assembly.logical_frame_ordinal);
                events.push(self.build_fault_from_assembly(
                    &assembly,
                    "proto.frameAssemblyMetadataMismatch",
                ));
                return events;
            }
        } else {
            // New assembly: check limits
            if self.assemblies.len() >= self.max_concurrent_assemblies {
                self.settle(&key, &logical_frame_id, logical_frame_ordinal);
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyConcurrentLimit",
                ));
                return events;
            }
            if self.staged_decoded_bytes + decoded.len() > self.max_staged_decoded_bytes {
                self.settle(&key, &logical_frame_id, logical_frame_ordinal);
                events.push(self.build_fault_from_wire(
                    wire,
                    "proto.frameAssemblyBudgetExceeded",
                ));
                return events;
            }

            let assembly = FragmentAssembly {
                delivery_kind: delivery_kind.unwrap().to_string(),
                logical_frame_id: logical_frame_id.clone(),
                logical_frame_ordinal,
                topic: topic.clone(),
                subscription_id: subscription_id.clone(),
                fragment_count,
                logical_bytes,
                checksum_algorithm: checksum_algorithm.to_string(),
                checksum_value: checksum_value.to_string(),
                fragments: vec![None; fragment_count],
                received_count: 0,
                decoded_bytes: 0,
                first_seen_at: now,
            };
            self.assemblies.insert(key.clone(), assembly);
        }

        // Check duplicate fragment
        {
            let assembly = self.assemblies.get(&key).unwrap();
            if let Some(Some(prev)) = assembly.fragments.get(fragment_index) {
                if !bytes_equal(prev, &decoded) {
                    let assembly = self.assemblies.remove(&key).unwrap();
                    self.staged_decoded_bytes -= assembly.decoded_bytes;
                    self.settle(
                        &key,
                        &assembly.logical_frame_id,
                        assembly.logical_frame_ordinal,
                    );
                    events.push(self.build_fault_from_assembly(
                        &assembly,
                        "proto.frameAssemblyFragmentConflict",
                    ));
                    return events;
                }
                // Duplicate but identical: no-op
                return events;
            }
        }

        // Budget check (staged bytes)
        if self.staged_decoded_bytes + decoded.len() > self.max_staged_decoded_bytes {
            let assembly = self.assemblies.remove(&key).unwrap();
            self.staged_decoded_bytes -= assembly.decoded_bytes;
            self.settle(&key, &assembly.logical_frame_id, assembly.logical_frame_ordinal);
            events.push(self.build_fault_from_assembly(
                &assembly,
                "proto.frameAssemblyBudgetExceeded",
            ));
            return events;
        }

        // Logical bytes bounds check
        {
            let exceeded = {
                let assembly = self.assemblies.get(&key).unwrap();
                assembly.decoded_bytes + decoded.len() > assembly.logical_bytes
            };
            if exceeded {
                let assembly = self.assemblies.remove(&key).unwrap();
                self.staged_decoded_bytes -= assembly.decoded_bytes;
                self.settle(
                    &key,
                    &assembly.logical_frame_id,
                    assembly.logical_frame_ordinal,
                );
                events.push(self.build_fault_from_assembly(
                    &assembly,
                    "proto.frameAssemblyLengthMismatch",
                ));
                return events;
            }
        }

        // Accept fragment
        {
            let assembly = self.assemblies.get_mut(&key).unwrap();
            assembly.fragments[fragment_index] = Some(decoded.clone());
            assembly.received_count += 1;
            assembly.decoded_bytes += decoded.len();
            self.staged_decoded_bytes += decoded.len();
        }

        // Check if all fragments received
        {
            let all_received = {
                let assembly = self.assemblies.get(&key).unwrap();
                assembly.received_count == assembly.fragment_count
            };
            if !all_received {
                return events;
            }
        }

        // All fragments received: assemble
        let logical = {
            let assembly = self.assemblies.remove(&key).unwrap();
            self.staged_decoded_bytes -= assembly.decoded_bytes;
            assembly
        };

        // Length match check
        if logical.decoded_bytes != logical.logical_bytes {
            self.settle(
                &key,
                &logical.logical_frame_id,
                logical.logical_frame_ordinal,
            );
            events.push(self.build_fault_from_assembly_owned(
                &logical,
                "proto.frameAssemblyLengthMismatch",
            ));
            return events;
        }

        // Concatenate fragments
        let mut assembled = Vec::with_capacity(logical.decoded_bytes);
        for fragment in &logical.fragments {
            match fragment {
                Some(data) => assembled.extend_from_slice(data),
                None => {
                    self.settle(
                        &key,
                        &logical.logical_frame_id,
                        logical.logical_frame_ordinal,
                    );
                    events.push(self.build_fault_from_assembly_owned(
                        &logical,
                        "proto.frameAssemblyLengthMismatch",
                    ));
                    return events;
                }
            }
        }

        // CRC32 check
        let computed_crc = crc32_hex(&assembled);
        if computed_crc != logical.checksum_value {
            self.settle(
                &key,
                &logical.logical_frame_id,
                logical.logical_frame_ordinal,
            );
            events.push(self.build_fault_from_assembly_owned(
                &logical,
                "proto.frameAssemblyChecksumMismatch",
            ));
            return events;
        }

        // UTF-8 decode
        let json_str = match std::str::from_utf8(&assembled) {
            Ok(s) => s.to_string(),
            Err(_) => {
                self.settle(
                    &key,
                    &logical.logical_frame_id,
                    logical.logical_frame_ordinal,
                );
                events.push(self.build_fault_from_assembly_owned(
                    &logical,
                    "proto.frameAssemblyInvalidUtf8",
                ));
                return events;
            }
        };

        // JSON parse
        let value: JsonValue = match serde_json::from_str(&json_str) {
            Ok(v) => v,
            Err(_) => {
                self.settle(
                    &key,
                    &logical.logical_frame_id,
                    logical.logical_frame_ordinal,
                );
                events.push(self.build_fault_from_assembly_owned(
                    &logical,
                    "proto.frameAssemblyInvalidJson",
                ));
                return events;
            }
        };

        // Frame matches envelope
        if !frame_matches_envelope(&value, &logical.topic, &logical.subscription_id) {
            self.settle(
                &key,
                &logical.logical_frame_id,
                logical.logical_frame_ordinal,
            );
            events.push(self.build_fault_from_assembly_owned(
                &logical,
                "proto.frameAssemblyMetadataMismatch",
            ));
            return events;
        }

        // Schema validation stays on TS side; accept valid JSON
        self.settle(
            &key,
            &logical.logical_frame_id,
            logical.logical_frame_ordinal,
        );
        let frame_json = serde_json::to_string(&value).unwrap_or_default();
        events.push(AssemblerEvent {
            kind: "complete",
            frame_json: Some(frame_json),
            delivery_kind: Some(logical.delivery_kind),
            reason_code: None,
            logical_frame_id: logical.logical_frame_id,
            logical_frame_ordinal: logical.logical_frame_ordinal,
            topic: logical.topic,
            subscription_id: logical.subscription_id,
        });
        events
    }

    /// Discard a route's active assembly and settled tombstone.
    pub fn discard(&mut self, topic: &str, subscription_id: &str) {
        let key = route_key(topic, subscription_id);
        if let Some(assembly) = self.assemblies.remove(&key) {
            self.staged_decoded_bytes -= assembly.decoded_bytes;
        }
        self.settled_by_route.remove(&key);
    }

    /// Abort a route's active assembly (releases bytes, keeps tombstone).
    pub fn abort(&mut self, topic: &str, subscription_id: &str) {
        let key = route_key(topic, subscription_id);
        if let Some(assembly) = self.assemblies.remove(&key) {
            self.staged_decoded_bytes -= assembly.decoded_bytes;
            self.settle(
                &key,
                &assembly.logical_frame_id,
                assembly.logical_frame_ordinal,
            );
        }
    }

    /// Clear all state.
    pub fn clear(&mut self) {
        self.assemblies.clear();
        self.settled_by_route.clear();
        self.staged_decoded_bytes = 0;
    }

    /// Get current stats.
    pub fn get_stats(&self) -> AssemblerStats {
        AssemblerStats {
            assemblies: self.assemblies.len(),
            staged_decoded_bytes: self.staged_decoded_bytes,
        }
    }

    /// Get the timestamp of the next assembly expiry, or None.
    pub fn next_expiry_at(&self) -> Option<u32> {
        self.assemblies
            .values()
            .map(|a| a.first_seen_at + self.timeout_ms)
            .min()
    }

    // ---- Private helpers ----

    /// Expire timed-out assemblies.
    fn expire(&mut self, now: u32) -> Vec<AssemblerEvent> {
        let mut events = Vec::new();
        let mut expired_keys: Vec<String> = Vec::new();

        for (key, assembly) in &self.assemblies {
            let elapsed = now.wrapping_sub(assembly.first_seen_at);
            if elapsed >= self.timeout_ms {
                expired_keys.push(key.clone());
            }
        }

        for key in expired_keys {
            if let Some(assembly) = self.assemblies.remove(&key) {
                self.staged_decoded_bytes -= assembly.decoded_bytes;
                self.settle(&key, &assembly.logical_frame_id, assembly.logical_frame_ordinal);
                events.push(self.build_fault_from_assembly_owned(
                    &assembly,
                    "proto.frameAssemblyTimedOut",
                ));
            }
        }

        events
    }

    /// Settle a route's ordinal tombstone.
    fn settle(&mut self, key: &str, frame_id: &str, frame_ordinal: u32) {
        let dominated = match self.settled_by_route.get(key) {
            Some(prev) => prev.logical_frame_ordinal > frame_ordinal,
            None => false,
        };
        if !dominated {
            self.settled_by_route.insert(
                key.to_string(),
                SettledLogicalFrame {
                    logical_frame_id: frame_id.to_string(),
                    logical_frame_ordinal: frame_ordinal,
                },
            );
        }
    }

    /// Release and settle: release active assembly only if it matches the frame identity.
    fn release_and_settle(&mut self, key: &str, frame_id: &str, frame_ordinal: u32) {
        let should_release = match self.assemblies.get(key) {
            Some(a) => a.logical_frame_ordinal == frame_ordinal && a.logical_frame_id == frame_id,
            None => false,
        };
        if should_release {
            if let Some(assembly) = self.assemblies.remove(key) {
                self.staged_decoded_bytes -= assembly.decoded_bytes;
            }
        }
        self.settle(key, frame_id, frame_ordinal);
    }

    /// Build a fault event from a wire frame reference.
    fn build_fault_from_wire(&self, wire: &JsonValue, reason_code: &str) -> AssemblerEvent {
        let obj = wire.as_object().unwrap();
        let delivery_kind = obj.get("deliveryKind").and_then(parse_delivery_kind);
        AssemblerEvent {
            kind: "fault",
            frame_json: None,
            delivery_kind: delivery_kind.map(|s| s.to_string()),
            reason_code: Some(reason_code.to_string()),
            logical_frame_id: obj
                .get("logicalFrameId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            logical_frame_ordinal: obj
                .get("logicalFrameOrdinal")
                .and_then(|v| v.as_i64())
                .unwrap_or(0) as u32,
            topic: obj
                .get("topic")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            subscription_id: obj
                .get("subscriptionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        }
    }

    /// Build a fault event from a fragment assembly reference.
    fn build_fault_from_assembly(
        &self,
        assembly: &FragmentAssembly,
        reason_code: &str,
    ) -> AssemblerEvent {
        AssemblerEvent {
            kind: "fault",
            frame_json: None,
            delivery_kind: Some(assembly.delivery_kind.clone()),
            reason_code: Some(reason_code.to_string()),
            logical_frame_id: assembly.logical_frame_id.clone(),
            logical_frame_ordinal: assembly.logical_frame_ordinal,
            topic: assembly.topic.clone(),
            subscription_id: assembly.subscription_id.clone(),
        }
    }

    /// Build a fault event from an owned fragment assembly.
    fn build_fault_from_assembly_owned(
        &self,
        assembly: &FragmentAssembly,
        reason_code: &str,
    ) -> AssemblerEvent {
        self.build_fault_from_assembly(assembly, reason_code)
    }
}

// ============================================================================
// Stats
// ============================================================================

/// Current assembler statistics.
#[derive(Debug, Clone)]
pub struct AssemblerStats {
    pub assemblies: usize,
    pub staged_decoded_bytes: usize,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default_assembler() -> Assembler {
        Assembler::new(AssemblerLimits::default())
    }

    fn complete_wire(
        topic: &str,
        sub_id: &str,
        frame_id: &str,
        ordinal: u32,
        delivery_kind: &str,
        frame: JsonValue,
    ) -> JsonValue {
        json!({
            "wireVersion": 3,
            "kind": "complete",
            "deliveryKind": delivery_kind,
            "logicalFrameId": frame_id,
            "logicalFrameOrdinal": ordinal,
            "topic": topic,
            "subscriptionId": sub_id,
            "frame": frame,
        })
    }

    fn fragment_wire(
        topic: &str,
        sub_id: &str,
        frame_id: &str,
        ordinal: u32,
        delivery_kind: &str,
        index: usize,
        count: usize,
        logical_bytes: usize,
        checksum_value: &str,
        data_base64: &str,
    ) -> JsonValue {
        json!({
            "wireVersion": 3,
            "kind": "fragment",
            "deliveryKind": delivery_kind,
            "logicalFrameId": frame_id,
            "logicalFrameOrdinal": ordinal,
            "topic": topic,
            "subscriptionId": sub_id,
            "fragmentIndex": index,
            "fragmentCount": count,
            "logicalBytes": logical_bytes,
            "checksum": {
                "algorithm": "crc32",
                "value": checksum_value,
            },
            "dataBase64": data_base64,
        })
    }

    /// Helper: standard base64 encode (test only).
    fn encode_base64(data: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::with_capacity((data.len() + 2) / 3 * 4);
        for chunk in data.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
            let triplet = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[((triplet >> 18) & 0x3F) as usize]);
            out.push(ALPHABET[((triplet >> 12) & 0x3F) as usize]);
            if chunk.len() > 1 {
                out.push(ALPHABET[((triplet >> 6) & 0x3F) as usize]);
            } else {
                out.push(b'=');
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[(triplet & 0x3F) as usize]);
            } else {
                out.push(b'=');
            }
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn complete_frame_produces_complete_event() {
        let mut asm = default_assembler();
        let frame = json!({"topic": "t", "subscriptionId": "s", "data": 42});
        let wire = complete_wire("t", "s", "frame-1", 1, "initial", frame);
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        assert_eq!(events[0].delivery_kind.as_deref(), Some("initial"));
        assert_eq!(events[0].logical_frame_ordinal, 1);
        assert!(events[0].frame_json.is_some());
    }

    #[test]
    fn complete_frame_wrong_envelope_produces_fault() {
        let mut asm = default_assembler();
        let frame = json!({"topic": "other", "subscriptionId": "s"});
        let wire = complete_wire("t", "s", "frame-1", 1, "initial", frame);
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "fault");
        assert_eq!(
            events[0].reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn debug_single_fragment() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\",\"data\":\"hello\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);
        eprintln!("encoded = {}", encoded);
        eprintln!("decoded check = {:?}", decode_base64(&encoded));

        let wire = fragment_wire(
            "t", "s", "f-1", 1, "online", 0, 1, logical_bytes.len(), &checksum, &encoded,
        );
        let events = asm.accept(&wire, 1000);
        eprintln!("single fragment events: {:?}", events.iter().map(|e| (&e.kind, &e.reason_code)).collect::<Vec<_>>());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
    }

    #[test]
    fn fragment_assembly_completes() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\",\"data\":\"hello\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);

        let wire = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "online",
            0,
            1,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        assert_eq!(events[0].delivery_kind.as_deref(), Some("online"));
    }

    #[test]
    fn debug_multi_fragment() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\",\"payload\":12345}";
        let checksum = crc32_hex(logical_bytes);
        let frag0 = &logical_bytes[..10];
        let frag1 = &logical_bytes[10..];
        let enc0 = encode_base64(frag0);
        let enc1 = encode_base64(frag1);
        eprintln!("logical_bytes len = {}", logical_bytes.len());
        eprintln!("checksum = {}", checksum);
        eprintln!("enc0 = {} (len {})", enc0, enc0.len());
        eprintln!("enc1 = {} (len {})", enc1, enc1.len());
        eprintln!("dec0 = {:?}", decode_base64(&enc0).map(|d| (d.len(), crc32_hex(&d))));
        eprintln!("dec1 = {:?}", decode_base64(&enc1).map(|d| (d.len(), crc32_hex(&d))));

        // Manually simulate what the assembler does on completion
        let dec0 = decode_base64(&enc0).unwrap();
        let dec1 = decode_base64(&enc1).unwrap();
        let mut assembled = Vec::new();
        assembled.extend_from_slice(&dec0);
        assembled.extend_from_slice(&dec1);
        eprintln!("assembled len = {}", assembled.len());
        eprintln!("assembled crc = {}", crc32_hex(&assembled));
        eprintln!("matches? {}", crc32_hex(&assembled) == checksum);
        let s = std::str::from_utf8(&assembled).unwrap();
        eprintln!("utf8 = {}", s);
        let v: serde_json::Value = serde_json::from_str(s).unwrap();
        eprintln!("json = {}", v);

        let w0 = fragment_wire(
            "t", "s", "f-2", 1, "initial", 0, 2, logical_bytes.len(), &checksum, &enc0,
        );
        let w1 = fragment_wire(
            "t", "s", "f-2", 1, "initial", 1, 2, logical_bytes.len(), &checksum, &enc1,
        );

        let events0 = asm.accept(&w0, 1000);
        eprintln!("w0 events ({}): {:?}", events0.len(), events0.iter().map(|e| (&e.kind, &e.reason_code)).collect::<Vec<_>>());
        eprintln!("stats after w0: {:?}", asm.get_stats());

        let events1 = asm.accept(&w1, 1001);
        eprintln!("w1 events ({}): {:?}", events1.len(), events1.iter().map(|e| (&e.kind, &e.reason_code)).collect::<Vec<_>>());
    }

    #[test]
    fn fragment_assembly_multi_fragment() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\",\"payload\":12345}";
        let checksum = crc32_hex(logical_bytes);

        let frag0 = &logical_bytes[..10];
        let frag1 = &logical_bytes[10..];
        let enc0 = encode_base64(frag0);
        let enc1 = encode_base64(frag1);

        let w0 = fragment_wire(
            "t",
            "s",
            "f-2",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &enc0,
        );
        let w1 = fragment_wire(
            "t",
            "s",
            "f-2",
            1,
            "initial",
            1,
            2,
            logical_bytes.len(),
            &checksum,
            &enc1,
        );

        let events0 = asm.accept(&w0, 1000);
        assert_eq!(events0.len(), 0);

        let events1 = asm.accept(&w1, 1001);
        assert_eq!(events1.len(), 1);
        assert_eq!(events1[0].kind, "complete");
    }

    #[test]
    fn ordinal_conflict_fault() {
        let mut asm = default_assembler();
        let frame = json!({"topic": "t", "subscriptionId": "s"});
        let w1 = complete_wire("t", "s", "frame-A", 1, "initial", frame.clone());
        let w2 = complete_wire("t", "s", "frame-B", 1, "initial", frame);

        asm.accept(&w1, 1000);
        let events = asm.accept(&w2, 1001);
        assert!(events.iter().any(
            |e| e.kind == "fault" && e.reason_code.as_deref() == Some("proto.frameAssemblyOrdinalConflict")
        ));
    }

    #[test]
    fn old_ordinal_after_settled_is_silent() {
        let mut asm = default_assembler();
        let frame = json!({"topic": "t", "subscriptionId": "s"});
        let w1 = complete_wire("t", "s", "frame-A", 2, "initial", frame.clone());
        let w2 = complete_wire("t", "s", "frame-B", 1, "initial", frame);

        asm.accept(&w1, 1000);
        let events = asm.accept(&w2, 1001);
        assert!(events.is_empty());
    }

    #[test]
    fn timeout_expires_assembly() {
        let mut asm = Assembler::new(AssemblerLimits {
            timeout_ms: 100,
            ..Default::default()
        });
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);

        let wire = fragment_wire(
            "t",
            "s",
            "f-3",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        asm.accept(&wire, 1000);

        // Not expired yet — use a DIFFERENT route so the fragment assembly survives
        let events = asm.accept(
            &complete_wire(
                "t2",
                "s2",
                "other",
                1,
                "initial",
                json!({"topic":"t2","subscriptionId":"s2"}),
            ),
            1050,
        );
        assert!(!events.iter().any(|e| {
            e.kind == "fault" && e.reason_code.as_deref() == Some("proto.frameAssemblyTimedOut")
        }));

        // Expire it — use a DIFFERENT route so the fragment assembly survives
        let events = asm.accept(
            &complete_wire(
                "t2",
                "s2",
                "other",
                1,
                "initial",
                json!({"topic":"t2","subscriptionId":"s2"}),
            ),
            1201,
        );
        assert!(events.iter().any(|e| {
            e.kind == "fault" && e.reason_code.as_deref() == Some("proto.frameAssemblyTimedOut")
        }));
    }

    #[test]
    fn supersession_replaces_old_assembly() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);

        let w1 = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        asm.accept(&w1, 1000);

        let frame = json!({"topic": "t", "subscriptionId": "s"});
        let w2 = complete_wire("t", "s", "f-2", 2, "online", frame);
        let events = asm.accept(&w2, 1001);

        assert!(events.iter().any(|e| {
            e.kind == "fault" && e.reason_code.as_deref() == Some("proto.frameAssemblySuperseded")
        }));
        assert!(events
            .iter()
            .any(|e| e.kind == "complete" && e.logical_frame_ordinal == 2));
    }

    #[test]
    fn recovery_does_not_supersede_with_fault() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);

        let w1 = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        asm.accept(&w1, 1000);

        let frame = json!({"topic": "t", "subscriptionId": "s"});
        let w2 = complete_wire("t", "s", "f-2", 2, "recovery", frame);
        let events = asm.accept(&w2, 1001);

        assert!(!events.iter().any(|e| {
            e.kind == "fault" && e.reason_code.as_deref() == Some("proto.frameAssemblySuperseded")
        }));
        assert!(events.iter().any(|e| e.kind == "complete"));
    }

    #[test]
    fn recovery_filters_old_faults() {
        let mut asm = Assembler::new(AssemblerLimits {
            timeout_ms: 10,
            ..Default::default()
        });
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);
        let w_frag = fragment_wire(
            "t",
            "s",
            "f-old",
            1,
            "online",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        asm.accept(&w_frag, 1000);

        // Expire the old assembly
        let events = asm.accept(
            &complete_wire(
                "t",
                "s",
                "dummy",
                2,
                "online",
                json!({"topic":"t","subscriptionId":"s"}),
            ),
            2000,
        );
        assert!(events
            .iter()
            .any(|e| e.kind == "fault" && e.logical_frame_ordinal == 1));

        // Recovery with higher ordinal should filter old faults
        let frame2 = json!({"topic": "t", "subscriptionId": "s"});
        let w_recovery = complete_wire("t", "s", "f-new", 2, "recovery", frame2);
        let events = asm.accept(&w_recovery, 2001);
        assert!(!events
            .iter()
            .any(|e| e.kind == "fault" && e.logical_frame_ordinal == 1));
    }

    #[test]
    fn invalid_ordinal_produces_fault() {
        let mut asm = default_assembler();
        let wire = json!({
            "wireVersion": 3,
            "kind": "complete",
            "deliveryKind": "initial",
            "logicalFrameId": "f-1",
            "logicalFrameOrdinal": 0,
            "topic": "t",
            "subscriptionId": "s",
            "frame": {"topic": "t", "subscriptionId": "s"},
        });
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "fault");
        assert_eq!(
            events[0].reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn invalid_delivery_kind_produces_fault() {
        let mut asm = default_assembler();
        let wire = json!({
            "wireVersion": 3,
            "kind": "complete",
            "deliveryKind": "bogus",
            "logicalFrameId": "f-1",
            "logicalFrameOrdinal": 1,
            "topic": "t",
            "subscriptionId": "s",
            "frame": {"topic": "t", "subscriptionId": "s"},
        });
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "fault");
        assert_eq!(
            events[0].reason_code.as_deref(),
            Some("proto.frameAssemblyMetadataMismatch")
        );
    }

    #[test]
    fn invalid_base64_produces_fault() {
        let mut asm = default_assembler();
        let wire = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "initial",
            0,
            1,
            10,
            "00000000",
            "!!!invalid!!!",
        );
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].reason_code.as_deref(),
            Some("proto.frameAssemblyInvalidBase64")
        );
    }

    #[test]
    fn checksum_mismatch_produces_fault() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\"}";
        let bad_checksum = "deadbeef";
        let encoded = encode_base64(logical_bytes);
        let wire = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "initial",
            0,
            1,
            logical_bytes.len(),
            bad_checksum,
            &encoded,
        );
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].reason_code.as_deref(),
            Some("proto.frameAssemblyChecksumMismatch")
        );
    }

    #[test]
    fn concurrent_limit_fault() {
        let mut asm = Assembler::new(AssemblerLimits {
            max_concurrent_assemblies: 1,
            ..Default::default()
        });
        let logical_bytes = b"{\"topic\":\"t1\",\"subscriptionId\":\"s\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);

        let w1 = fragment_wire(
            "t1",
            "s",
            "f-1",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        asm.accept(&w1, 1000);

        let logical_bytes2 = b"{\"topic\":\"t2\",\"subscriptionId\":\"s\"}";
        let checksum2 = crc32_hex(logical_bytes2);
        let encoded2 = encode_base64(logical_bytes2);
        let w2 = fragment_wire(
            "t2",
            "s",
            "f-2",
            1,
            "initial",
            0,
            2,
            logical_bytes2.len(),
            &checksum2,
            &encoded2,
        );
        let events = asm.accept(&w2, 1001);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].reason_code.as_deref(),
            Some("proto.frameAssemblyConcurrentLimit")
        );
    }

    #[test]
    fn discard_removes_state() {
        let mut asm = default_assembler();
        let frame = json!({"topic": "t", "subscriptionId": "s"});
        let wire = complete_wire("t", "s", "f-1", 1, "initial", frame);
        asm.accept(&wire, 1000);
        asm.discard("t", "s");
        let stats = asm.get_stats();
        assert_eq!(stats.assemblies, 0);
    }

    #[test]
    fn get_stats_and_clear() {
        let mut asm = default_assembler();
        let stats = asm.get_stats();
        assert_eq!(stats.assemblies, 0);
        assert_eq!(stats.staged_decoded_bytes, 0);
        asm.clear();
        let stats = asm.get_stats();
        assert_eq!(stats.assemblies, 0);
    }

    #[test]
    fn next_expiry_at_empty() {
        let asm = default_assembler();
        assert_eq!(asm.next_expiry_at(), None);
    }

    #[test]
    fn next_expiry_at_with_assembly() {
        let mut asm = Assembler::new(AssemblerLimits {
            timeout_ms: 500,
            ..Default::default()
        });
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);
        let wire = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        asm.accept(&wire, 1000);
        assert_eq!(asm.next_expiry_at(), Some(1500));
    }

    #[test]
    fn crc32_known_vector() {
        assert_eq!(crc32_hex(b"123456789"), "cbf43926");
    }

    #[test]
    fn base64_roundtrip() {
        let data = b"Hello, World! This is a test of base64 encoding.";
        let encoded = encode_base64(data);
        let decoded = decode_base64(&encoded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn base64_decode_invalid() {
        assert!(decode_base64("!!!").is_none());
        assert!(decode_base64("abc").is_none());
    }

    #[test]
    fn fragment_conflict_produces_fault() {
        let mut asm = default_assembler();
        let logical_bytes = b"{\"topic\":\"t\",\"subscriptionId\":\"s\"}";
        let checksum = crc32_hex(logical_bytes);
        let encoded = encode_base64(logical_bytes);
        let different_data = b"different data here!!!1234567";
        let different_encoded = encode_base64(different_data);

        let w1 = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &encoded,
        );
        let events1 = asm.accept(&w1, 1000);
        println!("w1 events: {:?}", events1.len());

        // Same index but different data
        let w2 = fragment_wire(
            "t",
            "s",
            "f-1",
            1,
            "initial",
            0,
            2,
            logical_bytes.len(),
            &checksum,
            &different_encoded,
        );
        let events = asm.accept(&w2, 1001);
        println!("w2 events: {:?}", events.iter().map(|e| (&e.kind, &e.reason_code)).collect::<Vec<_>>());
        println!("w2 events len: {}", events.len());
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].reason_code.as_deref(),
            Some("proto.frameAssemblyFragmentConflict")
        );
    }

    #[test]
    fn missing_frame_key_produces_fault() {
        let mut asm = default_assembler();
        let wire = json!({
            "wireVersion": 3,
            "kind": "complete",
            "deliveryKind": "initial",
            "logicalFrameId": "f-1",
            "logicalFrameOrdinal": 1,
            "topic": "t",
            "subscriptionId": "s",
        });
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "fault");
    }

    #[test]
    fn unknown_wire_kind_produces_fault() {
        let mut asm = default_assembler();
        let wire = json!({
            "wireVersion": 3,
            "kind": "unknown",
            "deliveryKind": "initial",
            "logicalFrameId": "f-1",
            "logicalFrameOrdinal": 1,
            "topic": "t",
            "subscriptionId": "s",
        });
        let events = asm.accept(&wire, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "fault");
    }
}
