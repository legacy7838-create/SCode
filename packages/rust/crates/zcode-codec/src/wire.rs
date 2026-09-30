//! V4 physical wire encoder — Rust port of `wire-binary.ts` and `wire-codec.ts`.
//!
//! CRC32 checksum, base64 codec, and logical→physical wire frame encoding with
//! automatic fragmentation.  All functions are pure (no IO).

use rayon::prelude::*;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// V4 physical wire protocol version (matches `V4_WIRE_PROTOCOL_VERSION` in core.ts).
pub const V4_WIRE_PROTOCOL_VERSION: u32 = 3;

/// Maximum physical frame size (PROTOCOL_V4_LIMITS.maxFrameBytes).
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Maximum logical frame assembly size (PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes).
pub const MAX_ASSEMBLY_BYTES: usize = 16 * 1024 * 1024;

/// Maximum number of fragments per logical frame.
pub const MAX_FRAGMENTS: usize = 1024;

/// transportEnvelopeIdMaxChars from PROTOCOL_V4_LIMITS.
pub const TRANSPORT_ENVELOPE_ID_MAX_CHARS: usize = 256;

// Base64 encode/decode and CRC32 are delegated to the `base64` / `crc32fast` crates (SIMD and
// hardware CRC32 respectively), so the previous hand-rolled alphabet and CRC table are gone.

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Codec-level error for wire operations.
#[derive(Debug, Clone)]
pub struct WireCodecError {
    pub kind: WireCodecErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireCodecErrorKind {
    InvalidBase64,
    FrameAssemblyTooLarge,
    FrameEnvelopeTooLarge,
    FrameFragmentCountExceeded,
    InvalidLimit(String),
}

impl std::fmt::Display for WireCodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for WireCodecError {}

impl From<WireCodecError> for String {
    fn from(e: WireCodecError) -> Self {
        e.to_string()
    }
}

impl WireCodecError {
    fn invalid_base64() -> Self {
        WireCodecError { kind: WireCodecErrorKind::InvalidBase64, message: "invalid base64".into() }
    }
    fn frame_assembly_too_large() -> Self {
        WireCodecError {
            kind: WireCodecErrorKind::FrameAssemblyTooLarge,
            message: "proto.frameAssemblyTooLarge".into(),
        }
    }
    fn frame_envelope_too_large() -> Self {
        WireCodecError {
            kind: WireCodecErrorKind::FrameEnvelopeTooLarge,
            message: "proto.frameEnvelopeTooLarge".into(),
        }
    }
    fn frame_fragment_count_exceeded() -> Self {
        WireCodecError {
            kind: WireCodecErrorKind::FrameFragmentCountExceeded,
            message: "proto.frameFragmentCountExceeded".into(),
        }
    }
    fn invalid_limit(name: &str) -> Self {
        WireCodecError {
            kind: WireCodecErrorKind::InvalidLimit(name.to_string()),
            message: format!("proto.invalidLimit.{name}"),
        }
    }
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------


/// CRC32 checksum returning an 8-char lowercase hex string (ISO 3309).
///
/// `crc32fast` is bit-identical to the previous table-driven loop (same ISO 3309 reflected
/// polynomial 0xEDB88320, same final xor) but uses the x86-64 CRC32 instruction with a
/// slicing-by-8 fallback, which is what makes it beat the old byte-at-a-time loop by a wide
/// margin on large frames.
pub fn crc32_hex(bytes: &[u8]) -> String {
    let final_crc = crc32fast::hash(bytes);
    let mut buf = [0u8; 8];
    let hex_chars = b"0123456789abcdef";
    let mut val = final_crc;
    let mut i = 8;
    while i > 0 {
        i -= 1;
        buf[i] = hex_chars[(val & 0xF) as usize];
        val >>= 4;
    }
    // SAFETY: buf contains only ASCII hex chars
    unsafe { std::str::from_utf8_unchecked(&buf) }.to_string()
}

/// Compute CRC32 for multiple byte slices in parallel using rayon.
pub fn crc32_batch_parallel(inputs: Vec<Vec<u8>>) -> Vec<String> {
    inputs.into_par_iter().map(|bytes| crc32_hex(&bytes)).collect()
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

/// Standard base64 encode (matches `encodeWireBytesBase64`).
///
/// Delegates to the `base64` crate, whose x86-64 `simd-unsafe` path (default-on in 0.23) is a
/// vectorised encode. Output stays the same standard alphabet with padding, i.e. byte-identical
/// to the previous hand-rolled loop and to Node's `Buffer.toString("base64")`.
pub fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    avx2_engine().encode(bytes)
}

/// Standard base64 decode with validation (matches `decodeWireBase64`).
///
/// The length / padding rules the previous validator enforced are unchanged; the decode itself is
/// the SIMD `base64` crate, which also rejects out-of-alphabet bytes and bad padding.
pub fn base64_decode(s: &str) -> Result<Vec<u8>, WireCodecError> {
    use base64::Engine as _;

    if s.len() % 4 != 0 {
        return Err(WireCodecError::invalid_base64());
    }
    if s.is_empty() {
        return Ok(Vec::new());
    }

    avx2_engine()
        .decode(s)
        .map_err(|_| WireCodecError::invalid_base64())
}

/// The SIMD (AVX2) base64 engine, resolved once.
///
/// `general_purpose::STANDARD` is the **scalar** engine — its `simd-unsafe` feature only unlocks
/// the `Avx2` / `Neon` engines, which live on a separate type behind a runtime CPU check. Using
/// `STANDARD` therefore silently ran the scalar loop (measured 1.7 GB/s, slower than Node's built-in
/// C++ codec). This picks the AVX2 engine once at first use; the result is a plain enum branch
/// outside the hot loop, not a per-call feature test.
fn avx2_engine() -> &'static base64::engine::Avx2 {
    static ENGINE: std::sync::OnceLock<base64::engine::Avx2> =
        std::sync::OnceLock::new();
    ENGINE.get_or_init(|| {
        base64::engine::Avx2::standard(
            base64::engine::GeneralPurposeConfig::new(),
        )
        // SAFETY: the constructor above already verified the running CPU supports AVX2.
        .unwrap_or_else(|| unsafe {
            base64::engine::Avx2::standard_unchecked(
                base64::engine::GeneralPurposeConfig::new(),
            )
        })
    })
}

/// Batch base64 encode in parallel using rayon.
pub fn base64_encode_parallel(inputs: Vec<Vec<u8>>) -> Vec<String> {
    inputs.into_par_iter().map(|bytes| base64_encode(&bytes)).collect()
}

/// Batch base64 decode in parallel using rayon.
pub fn base64_decode_parallel(inputs: Vec<String>) -> Result<Vec<Vec<u8>>, WireCodecError> {
    inputs
        .into_par_iter()
        .map(|s| base64_decode(&s))
        .collect::<Result<Vec<Vec<u8>>, WireCodecError>>()
}

// ---------------------------------------------------------------------------
// VQL byte length
// ---------------------------------------------------------------------------

/// How many bytes this integer would occupy when VQL-encoded (variable-length
/// quantity, 7 bits per byte).
pub fn vql_byte_length(value: u32) -> usize {
    let mut bytes: usize = 1;
    let mut remaining = value >> 7;
    while remaining > 0 {
        bytes += 1;
        remaining >>= 7;
    }
    bytes
}

// ---------------------------------------------------------------------------
// Topic notification envelope constants (from wire-codec.ts)
// ---------------------------------------------------------------------------

/// CHANNEL_EVENT_RESPONSE_TYPE from wire-codec.ts.
const CHANNEL_EVENT_RESPONSE_TYPE: u32 = 204;

/// SOCKET_PROTOCOL_HEADER_BYTES from wire-codec.ts.
const SOCKET_PROTOCOL_HEADER_BYTES: u32 = 13;

// ---------------------------------------------------------------------------
// Envelope measurement
// ---------------------------------------------------------------------------

/// Result of measuring a candidate wire frame across all three production layers.
#[derive(Debug, Clone)]
pub struct EnvelopeMeasurement {
    pub cli_ndjson_bytes: usize,
    pub channel_socket_bytes: usize,
    pub mobile_relay_bytes: usize,
    pub max_bytes: usize,
}

/// Compute the UTF-8 byte length of serializing `value` as JSON.
fn utf8_json_byte_length(value: &serde_json::Value) -> usize {
    serde_json::to_vec(value).map(|v| v.len()).unwrap_or(0)
}

/// Measure the 3-layer envelope size for a wire frame candidate.
///
/// Layers:
/// 1. CLI NDJSON: `{method:"v4/conversation/frame", params:<wire>}` + newline
/// 2. Channel+Socket: RPC binary envelope + SocketProtocol fixed header
/// 3. Mobile relay: relay JSON envelope + base64 of channel payload
pub fn measure_envelope_bytes(
    wire_json: &[u8],
    channel_event_response_type: u32,
    socket_protocol_header_bytes: u32,
) -> EnvelopeMeasurement {
    let wire_value: serde_json::Value = serde_json::from_slice(wire_json).unwrap_or(serde_json::Value::Null);
    let wire_json_len = wire_json.len();

    // Layer 1: CLI NDJSON
    let mut cli_method = serde_json::Map::new();
    cli_method.insert("method".into(), serde_json::Value::String("v4/conversation/frame".into()));
    cli_method.insert("params".into(), wire_value.clone());
    let cli_ndjson_bytes = utf8_json_byte_length(&serde_json::Value::Object(cli_method)) + 1; // +1 for newline

    // Layer 2: Channel+Socket
    // @zcode/rpc serialization: Array tag+length+[EventFire,id], plus Object tag+length+JSON
    let max_event_id_json_bytes = format!("{}", i64::MAX).len(); // 16 for Number.MAX_SAFE_INTEGER
    let max_event_id_serialized_bytes = 1 + vql_byte_length(max_event_id_json_bytes as u32) + max_event_id_json_bytes;
    let channel_header_bytes = 1 + vql_byte_length(2) + 1 + vql_byte_length(channel_event_response_type) + max_event_id_serialized_bytes;
    let channel_payload_bytes = channel_header_bytes + 1 + vql_byte_length(wire_json_len as u32) + wire_json_len;
    let channel_socket_bytes = channel_payload_bytes + socket_protocol_header_bytes as usize;

    // Layer 3: Mobile relay
    let data_base64_bytes = 4 * ((channel_payload_bytes + 2) / 3); // ceil(channelPayloadBytes / 3) * 4
    let transport_id = "x".repeat(TRANSPORT_ENVELOPE_ID_MAX_CHARS);
    let mut relay_obj = serde_json::Map::new();
    relay_obj.insert("type".into(), serde_json::Value::String("data".into()));
    let mut payload_obj = serde_json::Map::new();
    payload_obj.insert("zcode_type".into(), serde_json::Value::String("rpc-frame".into()));
    payload_obj.insert("bridgeSessionId".into(), serde_json::Value::String(transport_id.clone()));
    payload_obj.insert("bridgeGeneration".into(), serde_json::Value::Number(serde_json::Number::from(i64::MAX)));
    payload_obj.insert("recoveryId".into(), serde_json::Value::String(transport_id.clone()));
    payload_obj.insert("seq".into(), serde_json::Value::Number(serde_json::Number::from(i64::MAX)));
    payload_obj.insert("dataBase64".into(), serde_json::Value::String(String::new()));
    relay_obj.insert("payload".into(), serde_json::Value::Object(payload_obj));
    relay_obj.insert("client_ts".into(), serde_json::Value::Number(serde_json::Number::from(i64::MAX)));
    relay_obj.insert("server_ts".into(), serde_json::Value::Number(serde_json::Number::from(i64::MAX)));
    let mobile_relay_fixed_bytes = utf8_json_byte_length(&serde_json::Value::Object(relay_obj));
    let mobile_relay_bytes = mobile_relay_fixed_bytes + data_base64_bytes;

    let max_bytes = cli_ndjson_bytes.max(channel_socket_bytes).max(mobile_relay_bytes);

    EnvelopeMeasurement { cli_ndjson_bytes, channel_socket_bytes, mobile_relay_bytes, max_bytes }
}

/// Measure the 3-layer envelope size for a topic notification wire frame candidate.
///
/// Convenience wrapper around [`measure_envelope_bytes`] using the hardcoded
/// constants from `wire-codec.ts` (`CHANNEL_EVENT_RESPONSE_TYPE = 204`,
/// `SOCKET_PROTOCOL_HEADER_BYTES = 13`).
///
/// The `wire_json` parameter must be the UTF-8 JSON bytes of the wire frame
/// object (complete or fragment).
pub fn measure_topic_notification_envelope_bytes(
    wire_json: &[u8],
) -> EnvelopeMeasurement {
    measure_envelope_bytes(
        wire_json,
        CHANNEL_EVENT_RESPONSE_TYPE,
        SOCKET_PROTOCOL_HEADER_BYTES,
    )
}

// ---------------------------------------------------------------------------
// Wire frame encoding
// ---------------------------------------------------------------------------

/// A complete or fragment wire frame for transmission.
#[derive(Debug, Clone, Serialize)]
pub struct WireFrame {
    pub wire_version: u32,
    pub kind: String,
    pub delivery_kind: String,
    pub logical_frame_id: String,
    pub logical_frame_ordinal: u32,
    pub topic: String,
    pub subscription_id: String,
    // Fragment-specific
    pub fragment_index: Option<u32>,
    pub fragment_count: Option<u32>,
    pub logical_bytes: Option<usize>,
    pub checksum: Option<String>,
    pub data_base64: Option<String>,
    // Complete-specific
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_json: Option<Vec<u8>>,
}

/// Encode a logical JSON frame into wire frames.
///
/// If the frame fits in `max_physical_frame_bytes` (measured by `measure_fn`),
/// returns a single complete frame.  Otherwise, fragments it using CRC32
/// checksum and base64 encoding.
///
/// When the fragment count exceeds 4, fragment encoding is parallelised via rayon.
pub fn encode_wire_frames(
    frame_json: &[u8],
    delivery_kind: &str,
    logical_frame_id: &str,
    logical_frame_ordinal: u32,
    topic: &str,
    subscription_id: &str,
    max_physical_frame_bytes: usize,
    max_assembly_bytes: usize,
    measure_fn: impl Fn(&[u8]) -> usize, // caller's envelope measurement (returns max bytes)
) -> Result<Vec<WireFrame>, WireCodecError> {
    let max_physical = max_physical_frame_bytes.min(MAX_FRAME_BYTES);
    let max_assembly = max_assembly_bytes.min(MAX_ASSEMBLY_BYTES);

    if max_physical == 0 {
        return Err(WireCodecError::invalid_limit("maxPhysicalFrameBytes"));
    }
    if max_assembly == 0 {
        return Err(WireCodecError::invalid_limit("maxAssemblyBytes"));
    }

    let logical_bytes = frame_json.len();
    if logical_bytes > max_assembly {
        return Err(WireCodecError::frame_assembly_too_large());
    }

    // --- Try complete frame first ---
    let complete_frame = make_complete_frame(
        delivery_kind,
        logical_frame_id,
        logical_frame_ordinal,
        topic,
        subscription_id,
        frame_json,
    );
    let complete_wire = serialize_wire_frame(&complete_frame);
    if measure_fn(complete_wire.as_bytes()) <= max_physical {
        return Ok(vec![complete_frame]);
    }

    // --- Fragment path ---
    let checksum_hex = crc32_hex(frame_json);

    // Binary search for chunk byte budget
    let chunk_bytes = find_fragment_byte_budget(
        frame_json,
        delivery_kind,
        logical_frame_id,
        logical_frame_ordinal,
        topic,
        subscription_id,
        &checksum_hex,
        max_physical,
        &measure_fn,
    )?;

    if chunk_bytes < 1 {
        return Err(WireCodecError::frame_envelope_too_large());
    }

    let fragment_count = (logical_bytes + chunk_bytes - 1) / chunk_bytes;
    if fragment_count > MAX_FRAGMENTS {
        return Err(WireCodecError::frame_fragment_count_exceeded());
    }

    // Build fragments — parallelise with rayon when fragment count > 4
    let fragments: Vec<WireFrame> = if fragment_count > 4 {
        let indices: Vec<usize> = (0..fragment_count).collect();
        indices
            .into_par_iter()
            .map(|fragment_index| {
                let start = fragment_index * chunk_bytes;
                let end = (start + chunk_bytes).min(logical_bytes);
                let chunk = &frame_json[start..end];
                let data_base64 = base64_encode(chunk);
                let wire = make_fragment_frame(
                    delivery_kind,
                    logical_frame_id,
                    logical_frame_ordinal,
                    topic,
                    subscription_id,
                    fragment_index as u32,
                    fragment_count as u32,
                    logical_bytes,
                    &checksum_hex,
                    &data_base64,
                );
                wire
            })
            .collect()
    } else {
        let mut frames = Vec::with_capacity(fragment_count);
        for fragment_index in 0..fragment_count {
            let start = fragment_index * chunk_bytes;
            let end = (start + chunk_bytes).min(logical_bytes);
            let chunk = &frame_json[start..end];
            let data_base64 = base64_encode(chunk);
            let wire = make_fragment_frame(
                delivery_kind,
                logical_frame_id,
                logical_frame_ordinal,
                topic,
                subscription_id,
                fragment_index as u32,
                fragment_count as u32,
                logical_bytes,
                &checksum_hex,
                &data_base64,
            );
            frames.push(wire);
        }
        frames
    };

    // Verify all fragments fit
    for frame in &fragments {
        let wire = serialize_wire_frame(frame);
        if measure_fn(wire.as_bytes()) > max_physical {
            return Err(WireCodecError::frame_envelope_too_large());
        }
    }

    Ok(fragments)
}

/// Encode a logical JSON frame into topic wire frames.
///
/// Alias for [`encode_wire_frames`] matching the TypeScript
/// `encodeTopicWireFrames` naming convention.
pub fn encode_topic_wire_frames(
    frame_json: &[u8],
    delivery_kind: &str,
    logical_frame_id: &str,
    logical_frame_ordinal: u32,
    topic: &str,
    subscription_id: &str,
    max_physical_frame_bytes: usize,
    max_assembly_bytes: usize,
    measure_fn: impl Fn(&[u8]) -> usize,
) -> Result<Vec<WireFrame>, WireCodecError> {
    encode_wire_frames(
        frame_json,
        delivery_kind,
        logical_frame_id,
        logical_frame_ordinal,
        topic,
        subscription_id,
        max_physical_frame_bytes,
        max_assembly_bytes,
        measure_fn,
    )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn make_complete_frame(
    delivery_kind: &str,
    logical_frame_id: &str,
    logical_frame_ordinal: u32,
    topic: &str,
    subscription_id: &str,
    frame_json: &[u8],
) -> WireFrame {
    WireFrame {
        wire_version: V4_WIRE_PROTOCOL_VERSION,
        kind: "complete".into(),
        delivery_kind: delivery_kind.into(),
        logical_frame_id: logical_frame_id.into(),
        logical_frame_ordinal,
        topic: topic.into(),
        subscription_id: subscription_id.into(),
        fragment_index: None,
        fragment_count: None,
        logical_bytes: None,
        checksum: None,
        data_base64: None,
        frame_json: Some(frame_json.to_vec()),
    }
}

fn make_fragment_frame(
    delivery_kind: &str,
    logical_frame_id: &str,
    logical_frame_ordinal: u32,
    topic: &str,
    subscription_id: &str,
    fragment_index: u32,
    fragment_count: u32,
    logical_bytes: usize,
    checksum_hex: &str,
    data_base64: &str,
) -> WireFrame {
    WireFrame {
        wire_version: V4_WIRE_PROTOCOL_VERSION,
        kind: "fragment".into(),
        delivery_kind: delivery_kind.into(),
        logical_frame_id: logical_frame_id.into(),
        logical_frame_ordinal,
        topic: topic.into(),
        subscription_id: subscription_id.into(),
        fragment_index: Some(fragment_index),
        fragment_count: Some(fragment_count),
        logical_bytes: Some(logical_bytes),
        checksum: Some(format!("{{\"algorithm\":\"crc32\",\"value\":\"{checksum_hex}\"}}")),
        data_base64: Some(data_base64.into()),
        frame_json: None,
    }
}

/// Serialize a WireFrame to its JSON wire representation for measurement.
fn serialize_wire_frame(frame: &WireFrame) -> String {
    // Build JSON manually to match the TS shape exactly
    let mut s = String::with_capacity(256);
    s.push('{');

    push_json_kv(&mut s, "wireVersion", &frame.wire_version.to_string());
    s.push(',');
    push_json_str(&mut s, "kind", &frame.kind);
    s.push(',');
    push_json_str(&mut s, "deliveryKind", &frame.delivery_kind);
    s.push(',');
    push_json_str(&mut s, "logicalFrameId", &frame.logical_frame_id);
    s.push(',');
    push_json_kv(&mut s, "logicalFrameOrdinal", &frame.logical_frame_ordinal.to_string());
    s.push(',');
    push_json_str(&mut s, "topic", &frame.topic);
    s.push(',');
    push_json_str(&mut s, "subscriptionId", &frame.subscription_id);

    if let Some(idx) = frame.fragment_index {
        s.push(',');
        push_json_kv(&mut s, "fragmentIndex", &idx.to_string());
    }
    if let Some(count) = frame.fragment_count {
        s.push(',');
        push_json_kv(&mut s, "fragmentCount", &count.to_string());
    }
    if let Some(lb) = frame.logical_bytes {
        s.push(',');
        push_json_kv(&mut s, "logicalBytes", &lb.to_string());
    }
    if let Some(cs) = &frame.checksum {
        s.push(',');
        s.push_str("\"checksum\":");
        s.push_str(cs); // already JSON
    }
    if let Some(db) = &frame.data_base64 {
        s.push(',');
        push_json_str(&mut s, "dataBase64", db);
    }
    if let Some(fj) = &frame.frame_json {
        s.push(',');
        s.push_str("\"frame\":");
        // frame_json is already UTF-8 JSON bytes
        s.push_str(std::str::from_utf8(fj).unwrap_or("{}"));
    }

    s.push('}');
    s
}

fn push_json_str(out: &mut String, key: &str, value: &str) {
    out.push('"');
    out.push_str(key);
    out.push('"');
    out.push(':');
    out.push('"');
    // Escape special chars
    for ch in value.bytes() {
        match ch {
            b'\\' => out.push_str("\\\\"),
            b'"' => out.push_str("\\\""),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7E => out.push(ch as char),
            other => {
                out.push_str("\\u00");
                out.push_str(&format!("{:02x}", other));
            }
        }
    }
    out.push('"');
}

fn push_json_kv(out: &mut String, key: &str, value: &str) {
    push_json_str(out, key, value);
}

/// Binary search for the maximum chunk byte budget that fits within the
/// physical frame limit (mirrors `findFragmentByteBudget` in wire-codec.ts).
fn find_fragment_byte_budget(
    frame_json: &[u8],
    delivery_kind: &str,
    logical_frame_id: &str,
    logical_frame_ordinal: u32,
    topic: &str,
    subscription_id: &str,
    checksum_hex: &str,
    max_physical_frame_bytes: usize,
    measure_fn: &impl Fn(&[u8]) -> usize,
) -> Result<usize, WireCodecError> {
    let logical_bytes = frame_json.len();
    let mut low: usize = 1;
    let mut high = logical_bytes.min(max_physical_frame_bytes);
    let mut best: usize = 0;

    // Worst-case fragment index is the last one (highest index digits)
    let worst_count = logical_bytes;

    while low <= high {
        let candidate = (low + high) / 2;

        // Build a dummy base64 of the right length (4 * ceil(candidate/3) chars)
        let dummy_b64_len = 4 * ((candidate + 2) / 3);
        let dummy_b64: String = std::iter::repeat('A').take(dummy_b64_len).collect();

        let wire = make_fragment_frame(
            delivery_kind,
            logical_frame_id,
            logical_frame_ordinal,
            topic,
            subscription_id,
            (worst_count - 1) as u32,
            worst_count as u32,
            logical_bytes,
            checksum_hex,
            &dummy_b64,
        );

        let wire_json = serialize_wire_frame(&wire);
        if measure_fn(wire_json.as_bytes()) <= max_physical_frame_bytes {
            best = candidate;
            low = candidate + 1;
        } else {
            if candidate == 0 {
                break;
            }
            high = candidate - 1;
        }
    }

    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_empty() {
        assert_eq!(crc32_hex(b""), "00000000");
    }

    #[test]
    fn crc32_known_value() {
        // "123456789" → standard CRC32 = 0xCBF43926
        assert_eq!(crc32_hex(b"123456789"), "cbf43926");
    }

    #[test]
    fn crc32_single_byte() {
        // byte 0x00: should produce deterministic result
        let result = crc32_hex(&[0x00]);
        assert_eq!(result.len(), 8);
    }

    #[test]
    fn base64_encode_empty() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_encode_f() {
        assert_eq!(base64_encode(b"f"), "Zg==");
    }

    #[test]
    fn base64_encode_fo() {
        assert_eq!(base64_encode(b"fo"), "Zm8=");
    }

    #[test]
    fn base64_encode_foo() {
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }

    #[test]
    fn base64_encode_foob() {
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn base64_encode_fooba() {
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    }

    #[test]
    fn base64_encode_foobar() {
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_roundtrip() {
        let original = b"Hello, World! This is a test of base64 encoding and decoding.";
        let encoded = base64_encode(original);
        let decoded = base64_decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn base64_decode_invalid() {
        assert!(base64_decode("!!!").is_err());
        assert!(base64_decode("abc").is_err()); // not multiple of 4
    }

    #[test]
    fn vql_byte_length_values() {
        assert_eq!(vql_byte_length(0), 1);
        assert_eq!(vql_byte_length(1), 1);
        assert_eq!(vql_byte_length(127), 1);
        assert_eq!(vql_byte_length(128), 2);
        assert_eq!(vql_byte_length(16383), 2);
        assert_eq!(vql_byte_length(16384), 3);
    }

    #[test]
    fn base64_parallel_roundtrip() {
        let inputs: Vec<Vec<u8>> = (0..100).map(|i| format!("test-{i:04}").into_bytes()).collect();
        let encoded = base64_encode_parallel(inputs.clone());
        let decoded = base64_decode_parallel(encoded).unwrap();
        assert_eq!(decoded, inputs);
    }

    #[test]
    fn crc32_parallel_consistency() {
        let inputs: Vec<Vec<u8>> = (0..50).map(|i| format!("data-{i}").into_bytes()).collect();
        let parallel_results = crc32_batch_parallel(inputs.clone());
        let serial_results: Vec<String> = inputs.iter().map(|b| crc32_hex(b)).collect();
        assert_eq!(parallel_results, serial_results);
    }

    #[test]
    fn encode_wire_frames_small_frame() {
        let frame = br#"{"test":"data"}"#;
        let frames = encode_wire_frames(
            frame,
            "initial",
            "test-id",
            1,
            "test-topic",
            "sub-1",
            1024 * 1024,
            16 * 1024 * 1024,
            |_wire| 100, // always fits
        )
        .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].kind, "complete");
        assert!(frames[0].frame_json.is_some());
    }

    #[test]
    fn encode_wire_frames_needs_fragmentation() {
        // Frame is 300 bytes of binary data. Complete frame wire JSON is ~495 bytes,
        // exceeding the 400-byte physical limit. Binary search finds ~150-byte chunks
        // that fit within the limit, producing 2 fragments.
        let frame = vec![b'X'; 300];
        let frames = encode_wire_frames(
            &frame,
            "initial",
            "test-id",
            1,
            "test-topic",
            "sub-1",
            400, // physical limit below complete frame size
            16 * 1024 * 1024,
            |wire| wire.len() + 5, // envelope overhead
        )
        .unwrap();
        assert!(frames.len() > 1);
        for f in &frames {
            assert_eq!(f.kind, "fragment");
            assert!(f.fragment_index.is_some());
            assert!(f.fragment_count.is_some());
            assert!(f.checksum.is_some());
            assert!(f.data_base64.is_some());
        }
    }

    #[test]
    fn measure_topic_notification_envelope_bytes_returns_nonzero() {
        let wire = br#"{"wireVersion":3,"kind":"complete","topic":"t","subscriptionId":"s"}"#;
        let m = measure_topic_notification_envelope_bytes(wire);
        assert!(m.cli_ndjson_bytes > 0);
        assert!(m.channel_socket_bytes > 0);
        assert!(m.mobile_relay_bytes > 0);
        assert_eq!(m.max_bytes, m.cli_ndjson_bytes.max(m.channel_socket_bytes).max(m.mobile_relay_bytes));
    }

    #[test]
    fn measure_topic_notification_envelope_bytes_matches_general() {
        let wire = br#"{"wireVersion":3,"kind":"complete","topic":"t","subscriptionId":"s"}"#;
        let topic = measure_topic_notification_envelope_bytes(wire);
        let general = measure_envelope_bytes(wire, 204, 13);
        assert_eq!(topic.cli_ndjson_bytes, general.cli_ndjson_bytes);
        assert_eq!(topic.channel_socket_bytes, general.channel_socket_bytes);
        assert_eq!(topic.mobile_relay_bytes, general.mobile_relay_bytes);
        assert_eq!(topic.max_bytes, general.max_bytes);
    }

    #[test]
    fn encode_topic_wire_frames_matches_encode_wire_frames() {
        let frame = vec![b'Y'; 500];
        let measure = |wire: &[u8]| wire.len() + 10;
        let a = encode_wire_frames(
            &frame, "initial", "id-1", 1, "topic", "sub", 300, 16 * 1024 * 1024, &measure,
        ).unwrap();
        let b = encode_topic_wire_frames(
            &frame, "initial", "id-1", 1, "topic", "sub", 300, 16 * 1024 * 1024, &measure,
        ).unwrap();
        assert_eq!(a.len(), b.len());
        for (fa, fb) in a.iter().zip(b.iter()) {
            assert_eq!(fa.kind, fb.kind);
            assert_eq!(fa.fragment_index, fb.fragment_index);
            assert_eq!(fa.fragment_count, fb.fragment_count);
            assert_eq!(fa.data_base64, fb.data_base64);
        }
    }

    #[test]
    fn encode_topic_wire_frames_assembly_too_large() {
        let frame = vec![b'Z'; 20 * 1024 * 1024]; // exceeds 16 MiB
        let result = encode_topic_wire_frames(
            &frame, "initial", "id", 1, "t", "s",
            1024 * 1024, 16 * 1024 * 1024, |w| w.len(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn encode_topic_wire_frames_complete_frame() {
        let frame = br#"{"hello":"world"}"#;
        let frames = encode_topic_wire_frames(
            frame, "online", "frame-abc", 42, "my-topic", "sub-99",
            1024 * 1024, 16 * 1024 * 1024, |_| 100,
        ).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].kind, "complete");
        assert_eq!(frames[0].wire_version, V4_WIRE_PROTOCOL_VERSION);
        assert_eq!(frames[0].delivery_kind, "online");
        assert_eq!(frames[0].logical_frame_id, "frame-abc");
        assert_eq!(frames[0].logical_frame_ordinal, 42);
        assert_eq!(frames[0].topic, "my-topic");
        assert_eq!(frames[0].subscription_id, "sub-99");
    }
}

#[cfg(test)]
mod bench_mod {
    use super::*;
    use std::time::Instant;

    /// Diagnostic only: separates pure compute from the napi boundary cost, which the JS-side
    /// benchmark cannot see. Not an assertion — prints numbers.
    #[test]
    fn bench_compute_only() {
        for size in [4 * 1024usize, 64 * 1024, 1_000_000] {
            let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();

            let t = Instant::now();
            for _ in 0..200 {
                std::hint::black_box(base64_encode(&data));
            }
            let enc = t.elapsed().as_nanos() as f64 / 200.0 / 1000.0;

            let text = base64_encode(&data);
            let t = Instant::now();
            for _ in 0..200 {
                std::hint::black_box(base64_decode(&text).unwrap());
            }
            let dec = t.elapsed().as_nanos() as f64 / 200.0 / 1000.0;

            let t = Instant::now();
            for _ in 0..200 {
                std::hint::black_box(crc32_hex(&data));
            }
            let crc = t.elapsed().as_nanos() as f64 / 200.0 / 1000.0;

            println!(
                "  size={:>8}  base64_encode {:>8.2}us  base64_decode {:>8.2}us  crc32 {:>7.2}us",
                size, enc, dec, crc
            );
        }
    }
}
