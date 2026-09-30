//! zcode-codec — binary serialization for RPC messages.
//!
//! Port of `packages/rpc/src/serialization.ts` to Rust.
//!
//! Format: `[1 byte type tag] [VQL-encoded length] [data]`
//!
//! VQL (Variable-Length Quantity) stores 7 bits per byte, with the high bit
//! marking whether more bytes follow. Small numbers take just 1 byte, large
//! ones grow on demand.

pub mod serialization;
pub mod vql;
pub mod wire;

// The NAPI binding layer is a thin adapter over the pure-Rust modules above.
// It is optional so a native host (the Tauri app's in-process RPC server) can
// reuse the exact same codec without linking the Node ABI.
#[cfg(feature = "napi")]
use napi::bindgen_prelude::Buffer;
#[cfg(feature = "napi")]
use napi_derive::napi;
#[cfg(feature = "napi")]
use serde_json::Value as JsonValue;

// ============================================================================
// Error type
// ============================================================================

#[derive(Debug)]
pub enum CodecError {
    /// Reader exhausted before the expected data was fully read.
    UnexpectedEof,
    /// VQL stream ended without a terminating byte (high bit = 0).
    #[allow(dead_code)]
    InvalidVqlContinuation,
    /// An unrecognized DataType tag was encountered during deserialization.
    InvalidDataType(u8),
    /// JSON serialization/deserialization failed.
    JsonError(serde_json::Error),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::UnexpectedEof => write!(f, "unexpected end of data"),
            CodecError::InvalidVqlContinuation => write!(f, "invalid VQL continuation"),
            CodecError::InvalidDataType(t) => write!(f, "invalid data type tag: {t}"),
            CodecError::JsonError(e) => write!(f, "JSON error: {e}"),
        }
    }
}

impl std::error::Error for CodecError {}

impl From<serde_json::Error> for CodecError {
    fn from(e: serde_json::Error) -> Self {
        CodecError::JsonError(e)
    }
}

#[cfg(feature = "napi")]
impl From<CodecError> for napi::Error {
    fn from(e: CodecError) -> Self {
        napi::Error::from_reason(format!("{e}"))
    }
}

// ============================================================================
// VQL napi exports
// ============================================================================

/// Read a VQL-encoded integer from a byte buffer starting at offset.
/// Returns (value, bytes_consumed).
#[cfg(feature = "napi")]
#[napi]
pub fn vql_read(data: Buffer, offset: u32) -> napi::Result<(u32, u32)> {
    let mut reader = vql::VqlReader::new(&data);
    let _skipped = reader
        .read_bytes(offset as usize)
        .map_err(|_| napi::Error::from_reason("offset out of bounds"))?;
    let value = reader.read_vql()?;
    let consumed = (reader.position() - offset as usize) as u32;
    Ok((value, consumed))
}

/// Encode an integer as VQL into bytes.
#[cfg(feature = "napi")]
#[napi]
pub fn vql_write(value: u32) -> Buffer {
    let mut writer = vql::VqlWriter::new();
    writer.write_vql(value);
    Buffer::from(writer.into_bytes())
}

/// How many bytes does this integer occupy when VQL-encoded?
#[cfg(feature = "napi")]
#[napi]
pub fn vql_byte_length(value: u32) -> u32 {
    let mut writer = vql::VqlWriter::new();
    writer.write_vql(value);
    writer.len() as u32
}

// ============================================================================
// Serialization napi exports
// ============================================================================

/// Serialize a JSON value into VQL binary format.
#[cfg(feature = "napi")]
#[napi]
pub fn rpc_serialize(data: JsonValue) -> napi::Result<Buffer> {
    let mut writer = vql::VqlWriter::new();
    serialization::serialize(&mut writer, &data)?;
    Ok(Buffer::from(writer.into_bytes()))
}

/// Deserialize VQL binary format back to a JSON value.
#[cfg(feature = "napi")]
#[napi]
pub fn rpc_deserialize(data: Buffer) -> napi::Result<JsonValue> {
    let mut reader = vql::VqlReader::new(&data);
    Ok(serialization::deserialize(&mut reader)?)
}

/// Serialize multiple JSON values (for RPC message arrays).
#[cfg(feature = "napi")]
#[napi]
pub fn rpc_serialize_batch(items: Vec<JsonValue>) -> napi::Result<Buffer> {
    let mut writer = vql::VqlWriter::new();
    serialization::serialize_batch(&mut writer, &items)?;
    Ok(Buffer::from(writer.into_bytes()))
}

/// Deserialize multiple JSON values.
#[cfg(feature = "napi")]
#[napi]
pub fn rpc_deserialize_batch(data: Buffer, count: u32) -> napi::Result<Vec<JsonValue>> {
    let mut reader = vql::VqlReader::new(&data);
    Ok(serialization::deserialize_batch(&mut reader, count as usize)?)
}

// ============================================================================
// Wire codec napi exports (delegated to wire module)
// ============================================================================

/// CRC32 checksum returning 8-char lowercase hex string.
#[cfg(feature = "napi")]
#[napi]
pub fn crc32_hex(data: Buffer) -> String {
    wire::crc32_hex(&data)
}

/// Standard base64 encode.
#[cfg(feature = "napi")]
#[napi]
pub fn base64_encode(data: Buffer) -> String {
    wire::base64_encode(&data)
}

/// Standard base64 decode.
#[cfg(feature = "napi")]
#[napi]
pub fn base64_decode(encoded: String) -> napi::Result<Buffer> {
    wire::base64_decode(&encoded)
        .map(Buffer::from)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Batch CRC32 in parallel.
#[cfg(feature = "napi")]
#[napi]
pub fn crc32_batch(inputs: Vec<Buffer>) -> Vec<String> {
    wire::crc32_batch_parallel(inputs.iter().map(|b| b.to_vec()).collect())
}

/// Batch base64 encode in parallel.
#[cfg(feature = "napi")]
#[napi]
pub fn base64_encode_batch(inputs: Vec<Buffer>) -> Vec<String> {
    wire::base64_encode_parallel(inputs.iter().map(|b| b.to_vec()).collect())
}

/// Measure envelope sizes across 3 layers.
#[cfg(feature = "napi")]
#[napi]
pub fn measure_envelope_bytes(
    wire_json: Buffer,
    channel_event_response_type: u32,
    socket_protocol_header_bytes: u32,
) -> EnvelopeMeasurementJs {
    let m = wire::measure_envelope_bytes(
        &wire_json,
        channel_event_response_type,
        socket_protocol_header_bytes,
    );
    EnvelopeMeasurementJs {
        cli_ndjson_bytes: m.cli_ndjson_bytes as u32,
        channel_socket_bytes: m.channel_socket_bytes as u32,
        mobile_relay_bytes: m.mobile_relay_bytes as u32,
        max_bytes: m.max_bytes as u32,
    }
}

#[cfg(feature = "napi")]
#[napi(object)]
pub struct EnvelopeMeasurementJs {
    pub cli_ndjson_bytes: u32,
    pub channel_socket_bytes: u32,
    pub mobile_relay_bytes: u32,
    pub max_bytes: u32,
}

/// Batch base64 decode in parallel.
#[cfg(feature = "napi")]
#[napi]
pub fn base64_decode_batch(inputs: Vec<String>) -> napi::Result<Vec<Buffer>> {
    wire::base64_decode_parallel(inputs)
        .map(|decoded| decoded.into_iter().map(Buffer::from).collect())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Measure topic notification envelope sizes across 3 layers.
///
/// Convenience wrapper using the hardcoded constants from wire-codec.ts
/// (`CHANNEL_EVENT_RESPONSE_TYPE = 204`, `SOCKET_PROTOCOL_HEADER_BYTES = 13`).
#[cfg(feature = "napi")]
#[napi]
pub fn measure_topic_envelope_bytes(wire_json: Buffer) -> EnvelopeMeasurementJs {
    let m = wire::measure_topic_notification_envelope_bytes(&wire_json);
    EnvelopeMeasurementJs {
        cli_ndjson_bytes: m.cli_ndjson_bytes as u32,
        channel_socket_bytes: m.channel_socket_bytes as u32,
        mobile_relay_bytes: m.mobile_relay_bytes as u32,
        max_bytes: m.max_bytes as u32,
    }
}

/// Encode a logical frame into wire frames.
///
/// Returns a JSON array of wire frame objects (complete or fragment).
#[cfg(feature = "napi")]
#[napi]
pub fn encode_wire_frames(
    frame_json: Buffer,
    delivery_kind: String,
    logical_frame_id: String,
    logical_frame_ordinal: u32,
    topic: String,
    subscription_id: String,
    max_physical_frame_bytes: u32,
    max_assembly_bytes: u32,
) -> napi::Result<Vec<serde_json::Value>> {
    let frames = wire::encode_wire_frames(
        &frame_json,
        &delivery_kind,
        &logical_frame_id,
        logical_frame_ordinal,
        &topic,
        &subscription_id,
        max_physical_frame_bytes as usize,
        max_assembly_bytes as usize,
        |wire| wire.len(),
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    frames
        .iter()
        .map(|f| serde_json::to_value(f).map_err(|e| napi::Error::from_reason(e.to_string())))
        .collect()
}
