//! Binary serialization ported from `packages/rpc/src/serialization.ts`.
//!
//! Format: `[1 byte type tag] [VQL-encoded length] [data]`
//!
//! Each RPC message = `serialize(header)` + `serialize(body)`.
//! The header is usually `[RequestType, id, channelName, methodName]`.
//! The body is the method arguments or the return value.

use serde_json::Value as JsonValue;

use crate::vql::{VqlReader, VqlWriter};
use crate::CodecError;

// ============================================================================
// Data type tags (must match the TS enum exactly)
// ============================================================================

#[repr(u8)]
#[allow(dead_code)]
enum DataType {
    Undefined = 0,
    String = 1,
    Buffer = 2,
    VsBuffer = 3,
    Array = 4,
    Object = 5,
    Int = 6,
}

const RPC_NESTED_UINT8_ARRAY_MARKER: &str = "__zcode_rpc_nested_uint8array_v1";
const RPC_NESTED_UINT8_ARRAY_BASE64_KEY: &str = "base64";

// ============================================================================
// serialize
// ============================================================================

/// Serialize an optional value, keeping JS's `undefined`/`null` distinction.
///
/// `serde_json` has a single null value, but the RPC protocol has two:
/// `serialize(undefined)` writes the `Undefined` tag (0) while `serialize(null)`
/// goes through the JSON fallback and writes `Object` + `"null"`. A Rust caller
/// that uses `Option<JsonValue>` can express both, which `serialize` alone
/// cannot: it would collapse `None` and `Some(Null)` into the same byte.
///
/// This matters on the wire, not just semantically — the client decodes the tag
/// and sees `undefined` vs `null`, so collapsing them changes what the UI
/// receives for a service that legitimately returns `null`.
pub fn serialize_option(
    writer: &mut VqlWriter,
    value: Option<&JsonValue>,
) -> Result<(), CodecError> {
    match value {
        None => {
            writer.write_u8(DataType::Undefined as u8);
            Ok(())
        }
        Some(inner) if inner.is_null() => {
            // Explicit JSON null, matching TS `serialize(null)`.
            writer.write_u8(DataType::Object as u8);
            let body = b"null";
            writer.write_vql(body.len() as u32);
            writer.write_bytes(body);
            Ok(())
        }
        Some(inner) => serialize(writer, inner),
    }
}

/// Deserialize an optional value, keeping JS's `undefined`/`null` distinction.
///
/// The inverse of [`serialize_option`]. The `Undefined` tag yields `None`;
/// everything else — including a JSON `null` payload — yields `Some(...)`. Both
/// arrive as `JsonValue::Null` from plain [`deserialize`], so the type tag has
/// to be inspected to tell them apart.
pub fn deserialize_option(reader: &mut VqlReader) -> Result<Option<JsonValue>, CodecError> {
    let type_tag = reader.read_u8()?;
    if type_tag == DataType::Undefined as u8 {
        return Ok(None);
    }
    // Re-dispatch on the tag already consumed; `deserialize` expects to read it.
    reader.rewind_one();
    deserialize(reader).map(Some)
}

/// Serialize a `serde_json::Value` into the VQL binary format.
///
/// Type dispatch mirrors the TS `serialize()`:
/// - `null` → `DataType::Undefined`
/// - string → tag + VQL length + UTF-8
/// - array → tag + VQL count + recursive serialize each element
/// - integer (i64 that fits i32) → tag + VQL value
/// - float / object / bool → `DataType::Object` + VQL length + JSON bytes
///
/// Note: The TS distinction between `VSBuffer`/`Uint8Array` (types 3/2) is a JS
/// runtime concern. On the Rust side we operate on `serde_json::Value`, which has
/// no native byte array type. Raw binary types are only produced by the TS side;
/// the Rust serialize path handles JSON values exclusively.
pub fn serialize(writer: &mut VqlWriter, data: &JsonValue) -> Result<(), CodecError> {
    match data {
        JsonValue::Null => {
            writer.write_u8(DataType::Undefined as u8);
        }
        JsonValue::String(s) => {
            writer.write_u8(DataType::String as u8);
            let utf8 = s.as_bytes();
            writer.write_vql(utf8.len() as u32);
            writer.write_bytes(utf8);
        }
        JsonValue::Array(arr) => {
            writer.write_u8(DataType::Array as u8);
            writer.write_vql(arr.len() as u32);
            for el in arr {
                serialize(writer, el)?;
            }
        }
        JsonValue::Number(num) => {
            // Match TS: `(data | 0) === data` — only encode values that fit i32.
            // The TS uses unsigned right-shift (>>> 7), so negative i32 values
            // are encoded through their u32 bit pattern.
            if let Some(i) = num.as_i64() {
                if i >= i32::MIN as i64 && i <= i32::MAX as i64 {
                    writer.write_u8(DataType::Int as u8);
                    writer.write_vql(i as u32);
                    return Ok(());
                }
            }
            // Float or out-of-range integer → JSON fallback
            let json_bytes = serde_json::to_vec(data).map_err(CodecError::JsonError)?;
            writer.write_u8(DataType::Object as u8);
            writer.write_vql(json_bytes.len() as u32);
            writer.write_bytes(&json_bytes);
        }
        JsonValue::Bool(_) | JsonValue::Object(_) => {
            // Booleans and objects fall through to the Object/JSON path,
            // matching the TS behavior where non-integer numbers, booleans,
            // and objects use `JSON.stringify`.
            let json_bytes = serde_json::to_vec(data).map_err(CodecError::JsonError)?;
            writer.write_u8(DataType::Object as u8);
            writer.write_vql(json_bytes.len() as u32);
            writer.write_bytes(&json_bytes);
        }
    }
    Ok(())
}

// ============================================================================
// deserialize
// ============================================================================

/// Deserialize a `serde_json::Value` from the VQL binary format.
///
/// Reverse of `serialize`. Handles all DataType tags that the TS side can produce:
/// - Undefined → `null`
/// - String → string
/// - Buffer / VSBuffer → JSON array of byte values (0–255). The TS side returns
///   `Uint8Array` / `VSBuffer`; we represent the raw bytes as a JSON array since
///   `serde_json::Value` has no native binary type.
/// - Array → recursive array
/// - Object → parsed from JSON bytes; nested `Uint8Array` markers from TS are
///   decoded back to their base64 string representation via `decode_rpc_json_value`.
/// - Int → number (VQL-decoded u32)
pub fn deserialize(reader: &mut VqlReader) -> Result<JsonValue, CodecError> {
    let type_tag = reader.read_u8()?;

    match type_tag {
        t if t == DataType::Undefined as u8 => Ok(JsonValue::Null),

        t if t == DataType::String as u8 => {
            let len = reader.read_vql()? as usize;
            let bytes = reader.read_bytes(len)?;
            let s = std::str::from_utf8(bytes).map_err(|_| CodecError::UnexpectedEof)?;
            Ok(JsonValue::String(s.to_owned()))
        }

        t if t == DataType::Buffer as u8 || t == DataType::VsBuffer as u8 => {
            // Raw binary buffers: decode into a JSON array of byte values.
            // The TS side returns `Uint8Array` / `VSBuffer` for these types;
            // we represent the bytes as `[u8; N]` → `JsonValue::Array` of numbers.
            let len = reader.read_vql()? as usize;
            let bytes = reader.read_bytes(len)?;
            Ok(JsonValue::Array(
                bytes.iter().map(|&b| JsonValue::Number((b as u64).into())).collect(),
            ))
        }

        t if t == DataType::Array as u8 => {
            let length = reader.read_vql()? as usize;
            let mut result = Vec::with_capacity(length);
            for _ in 0..length {
                result.push(deserialize(reader)?);
            }
            Ok(JsonValue::Array(result))
        }

        t if t == DataType::Object as u8 => {
            let len = reader.read_vql()? as usize;
            let bytes = reader.read_bytes(len)?;
            // TS uses `JSON.parse(str, decodeRpcJsonValue)` reviver here.
            // We parse the JSON faithfully, then apply `decode_rpc_json_value`
            // to recursively decode nested Uint8Array markers back to base64 strings.
            let value: JsonValue =
                serde_json::from_slice(bytes).map_err(CodecError::JsonError)?;
            Ok(decode_rpc_json_value(value))
        }

        t if t == DataType::Int as u8 => {
            let value = reader.read_vql()?;
            Ok(JsonValue::Number(value.into()))
        }

        _ => Err(CodecError::InvalidDataType(type_tag)),
    }
}

// ============================================================================
// Batch helpers
// ============================================================================

/// Serialize a slice of values (for RPC message arrays).
pub fn serialize_batch(writer: &mut VqlWriter, items: &[JsonValue]) -> Result<(), CodecError> {
    for item in items {
        serialize(writer, item)?;
    }
    Ok(())
}

/// Deserialize `count` values from the reader (for RPC message arrays).
pub fn deserialize_batch(
    reader: &mut VqlReader,
    count: usize,
) -> Result<Vec<JsonValue>, CodecError> {
    let mut result = Vec::with_capacity(count);
    for _ in 0..count {
        result.push(deserialize(reader)?);
    }
    Ok(result)
}

// ============================================================================
// Internal helpers
// ============================================================================

/// Recursively decode the TS `decodeRpcJsonValue` reviver.
///
/// In the TS code, `JSON.parse(str, decodeRpcJsonValue)` walks every parsed
/// value and transforms objects that match the nested Uint8Array marker:
/// `{"__zcode_rpc_nested_uint8array_v1": true, "base64": "<b64>"}` →
/// the base64 string itself (since we represent binary as a plain JSON string
/// on the Rust side).
fn decode_rpc_json_value(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(map) => {
            // Check if this object is the RPC nested Uint8Array marker
            if map.len() == 2 {
                if let (Some(JsonValue::Bool(true)), Some(JsonValue::String(b64))) = (
                    map.get(RPC_NESTED_UINT8_ARRAY_MARKER),
                    map.get(RPC_NESTED_UINT8_ARRAY_BASE64_KEY),
                ) {
                    // The TS reviver returns `base64ToBytes(value.base64)` which
                    // produces a Uint8Array. On the Rust JSON side we keep the
                    // base64 string as-is since the consumer expects JsonValue.
                    return JsonValue::String(b64.clone());
                }
            }
            // Recurse into object values
            let decoded: serde_json::Map<String, JsonValue> = map
                .into_iter()
                .map(|(k, v)| (k, decode_rpc_json_value(v)))
                .collect();
            JsonValue::Object(decoded)
        }
        JsonValue::Array(arr) => JsonValue::Array(arr.into_iter().map(decode_rpc_json_value).collect()),
        other => other,
    }
}

/// Check if a JSON value matches the RPC nested Uint8Array marker shape.
#[allow(dead_code)]
fn is_rpc_encoded_uint8_array(value: &JsonValue) -> bool {
    if let JsonValue::Object(map) = value {
        if map.len() == 2 {
            return matches!(
                (
                    map.get(RPC_NESTED_UINT8_ARRAY_MARKER),
                    map.get(RPC_NESTED_UINT8_ARRAY_BASE64_KEY),
                ),
                (Some(JsonValue::Bool(true)), Some(JsonValue::String(_)))
            );
        }
    }
    false
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: round-trip a value through serialize → deserialize.
    fn round_trip(value: &JsonValue) -> JsonValue {
        let mut w = VqlWriter::new();
        serialize(&mut w, value).unwrap();
        let mut r = VqlReader::new(w.bytes());
        deserialize(&mut r).unwrap()
    }

    // --- Primitive types ---

    #[test]
    fn null_undefined() {
        let result = round_trip(&JsonValue::Null);
        assert_eq!(result, JsonValue::Null);
    }

    #[test]
    fn string_hello() {
        let val = JsonValue::String("hello world".into());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn string_empty() {
        let val = JsonValue::String("".into());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn string_unicode() {
        let val = JsonValue::String("hello 🌍".into());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn integer_zero() {
        let val = JsonValue::Number(0.into());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn integer_127() {
        let val = JsonValue::Number(127.into());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn integer_128() {
        let val = JsonValue::Number(128.into());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn integer_negative() {
        // TS uses unsigned right-shift (>>>), so -42 encodes as its uint32
        // representation (4294967254). The round-trip preserves the bit pattern
        // but the value comes back unsigned — this matches the TS behavior.
        let input = JsonValue::Number((-42).into());
        let mut w = VqlWriter::new();
        serialize(&mut w, &input).unwrap();
        let mut r = VqlReader::new(w.bytes());
        let result = deserialize(&mut r).unwrap();
        // The uint32 representation of -42 is 4294967254
        assert_eq!(result, JsonValue::Number(4294967254u32.into()));
    }

    #[test]
    fn integer_max_i32() {
        let val = JsonValue::Number(i32::MAX.into());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn integer_min_i32() {
        // i32::MIN (-2147483648) encodes as uint32 2147483648 via unsigned shift.
        let input = JsonValue::Number(i32::MIN.into());
        let mut w = VqlWriter::new();
        serialize(&mut w, &input).unwrap();
        let mut r = VqlReader::new(w.bytes());
        let result = deserialize(&mut r).unwrap();
        assert_eq!(result, JsonValue::Number(2147483648u32.into()));
    }

    #[test]
    fn float_value() {
        // Floats don't fit i32 → Object/JSON path
        let val = JsonValue::Number(serde_json::Number::from_f64(3.14).unwrap());
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    // --- Composite types ---

    #[test]
    fn empty_array() {
        let val = JsonValue::Array(vec![]);
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn nested_array() {
        let val = JsonValue::Array(vec![
            JsonValue::Number(1.into()),
            JsonValue::String("two".into()),
            JsonValue::Null,
            JsonValue::Array(vec![JsonValue::Bool(true)]),
        ]);
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn object_fallback() {
        let val = serde_json::json!({"key": "value", "num": 42});
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn object_with_nested_array() {
        let val = serde_json::json!({
            "items": [1, 2, 3],
            "name": "test"
        });
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    #[test]
    fn bool_value() {
        // Booleans fall through to Object/JSON path
        let val = JsonValue::Bool(true);
        let result = round_trip(&val);
        assert_eq!(result, val);
    }

    // --- Batch ---

    #[test]
    fn batch_round_trip() {
        let items = vec![
            JsonValue::Null,
            JsonValue::String("hello".into()),
            JsonValue::Number(42.into()),
            JsonValue::Array(vec![JsonValue::Bool(true), JsonValue::Number(99.into())]),
        ];

        let mut w = VqlWriter::new();
        serialize_batch(&mut w, &items).unwrap();

        let mut r = VqlReader::new(w.bytes());
        let result = deserialize_batch(&mut r, items.len()).unwrap();
        assert_eq!(result, items);
        assert_eq!(r.remaining(), 0);
    }

    // --- Wire format verification ---

    #[test]
    fn int_wire_format() {
        // 0 should be [DataType::Int, VQL(0)]
        let mut w = VqlWriter::new();
        serialize(&mut w, &JsonValue::Number(0.into())).unwrap();
        let bytes = w.bytes();
        assert_eq!(bytes[0], DataType::Int as u8);
        assert_eq!(bytes[1], 0x00); // VQL(0)
        assert_eq!(bytes.len(), 2);
    }

    #[test]
    fn string_wire_format() {
        // "A" → [DataType::String, VQL(1), 0x41]
        let mut w = VqlWriter::new();
        serialize(&mut w, &JsonValue::String("A".into())).unwrap();
        let bytes = w.bytes();
        assert_eq!(bytes[0], DataType::String as u8);
        assert_eq!(bytes[1], 0x01); // VQL length = 1
        assert_eq!(bytes[2], 0x41); // 'A'
        assert_eq!(bytes.len(), 3);
    }

    #[test]
    fn null_wire_format() {
        let mut w = VqlWriter::new();
        serialize(&mut w, &JsonValue::Null).unwrap();
        let bytes = w.bytes();
        assert_eq!(bytes, &[DataType::Undefined as u8]);
    }

    // --- Error cases ---

    #[test]
    fn invalid_type_tag() {
        let data = [0xFF]; // Not a valid DataType
        let mut r = VqlReader::new(&data);
        assert!(deserialize(&mut r).is_err());
    }

    #[test]
    fn truncated_string() {
        // String tag + VQL(10) but no data follows
        let data = [DataType::String as u8, 0x0A];
        let mut r = VqlReader::new(&data);
        assert!(deserialize(&mut r).is_err());
    }

    #[test]
    fn truncated_array() {
        // Array tag + VQL(2) but only 1 element follows
        let data = [
            DataType::Array as u8,
            0x02,       // length = 2
            DataType::Int as u8,
            0x00,       // element 1: int 0
            // missing element 2
        ];
        let mut r = VqlReader::new(&data);
        assert!(deserialize(&mut r).is_err());
    }

    // --- TS wire compatibility ---

    #[test]
    fn ts_vql_format_compatibility() {
        // Verify our VQL encoding matches the TS examples exactly:
        // 0 → [0x00], 127 → [0x7F], 128 → [0x80, 0x01]
        let mut w = VqlWriter::new();
        serialize(&mut w, &JsonValue::Number(0.into())).unwrap();
        assert_eq!(w.bytes(), &[DataType::Int as u8, 0x00]);

        let mut w = VqlWriter::new();
        serialize(&mut w, &JsonValue::Number(127.into())).unwrap();
        assert_eq!(w.bytes(), &[DataType::Int as u8, 0x7F]);

        let mut w = VqlWriter::new();
        serialize(&mut w, &JsonValue::Number(128.into())).unwrap();
        assert_eq!(w.bytes(), &[DataType::Int as u8, 0x80, 0x01]);
    }

    // --- decode_rpc_json_value ---

    #[test]
    fn decode_rpc_nested_uint8array_marker() {
        let marker = serde_json::json!({
            "__zcode_rpc_nested_uint8array_v1": true,
            "base64": "AQID"
        });
        let decoded = decode_rpc_json_value(marker);
        assert_eq!(decoded, JsonValue::String("AQID".into()));
    }

    #[test]
    fn decode_rpc_nested_in_object() {
        let val = serde_json::json!({
            "data": {
                "__zcode_rpc_nested_uint8array_v1": true,
                "base64": "AQID"
            },
            "name": "test"
        });
        let decoded = decode_rpc_json_value(val);
        assert_eq!(
            decoded,
            serde_json::json!({
                "data": "AQID",
                "name": "test"
            })
        );
    }

    #[test]
    fn is_rpc_encoded_uint8_array_positive() {
        let val = serde_json::json!({
            "__zcode_rpc_nested_uint8array_v1": true,
            "base64": "AQID"
        });
        assert!(is_rpc_encoded_uint8_array(&val));
    }

    #[test]
    fn is_rpc_encoded_uint8_array_wrong_shape() {
        let val = serde_json::json!({"key": "value"});
        assert!(!is_rpc_encoded_uint8_array(&val));
    }

    // --- Buffer/VSBuffer decode ---

    #[test]
    fn buffer_decode_as_byte_array() {
        // Manually construct a Buffer type tag + VQL(3) + [0xDE, 0xAD, 0xBE]
        let data = [
            DataType::Buffer as u8,
            0x03, // VQL length = 3
            0xDE, 0xAD, 0xBE,
        ];
        let mut r = VqlReader::new(&data);
        let result = deserialize(&mut r).unwrap();
        assert_eq!(
            result,
            JsonValue::Array(vec![
                JsonValue::Number(0xDE.into()),
                JsonValue::Number(0xAD.into()),
                JsonValue::Number(0xBE.into()),
            ])
        );
    }

    #[test]
    fn vsbuffer_decode_as_byte_array() {
        let data = [
            DataType::VsBuffer as u8,
            0x02, // VQL length = 2
            0xCA, 0xFE,
        ];
        let mut r = VqlReader::new(&data);
        let result = deserialize(&mut r).unwrap();
        assert_eq!(
            result,
            JsonValue::Array(vec![
                JsonValue::Number(0xCA.into()),
                JsonValue::Number(0xFE.into()),
            ])
        );
    }
}
