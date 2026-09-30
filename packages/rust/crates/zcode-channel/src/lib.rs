use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use serde_json::Value as JsonValue;

// ============================================================================
// VQL (Variable-Length Quantity) decoding — mirrors native vqlRead in zcode-codec
// ============================================================================

struct VqlReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> VqlReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn read_vql_int(&mut self) -> Option<u32> {
        let mut result: u32 = 0;
        let mut shift: u32 = 0;
        loop {
            if self.pos >= self.data.len() {
                return None;
            }
            let byte = self.data[self.pos];
            self.pos += 1;
            result |= ((byte & 0x7F) as u32) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        Some(result)
    }

    fn read_bytes(&mut self, count: usize) -> Option<&'a [u8]> {
        if self.pos + count > self.data.len() {
            return None;
        }
        let slice = &self.data[self.pos..self.pos + count];
        self.pos += count;
        Some(slice)
    }

    fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }
}

/// Data type tags — must match DataType enum in serialization.ts
const TYPE_UNDEFINED: u8 = 0;
const TYPE_STRING: u8 = 1;
const TYPE_BUFFER: u8 = 2;
// const TYPE_VSBUFFER: u8 = 3;
const TYPE_ARRAY: u8 = 4;
const TYPE_OBJECT: u8 = 5;
const TYPE_INT: u8 = 6;

fn deserialize_value(reader: &mut VqlReader) -> Option<JsonValue> {
    if reader.remaining() == 0 {
        return None;
    }
    let type_tag = reader.data[reader.pos];
    reader.pos += 1;

    match type_tag {
        TYPE_UNDEFINED => Some(JsonValue::Null),
        TYPE_STRING => {
            let len = reader.read_vql_int()? as usize;
            let bytes = reader.read_bytes(len)?;
            let s = std::str::from_utf8(bytes).ok()?;
            Some(JsonValue::String(s.to_string()))
        }
        TYPE_BUFFER | /* TYPE_VSBUFFER */ 3 => {
            let len = reader.read_vql_int()? as usize;
            reader.pos += len; // skip raw bytes, channel layer doesn't need them
            Some(JsonValue::Null)
        }
        TYPE_ARRAY => {
            let count = reader.read_vql_int()? as usize;
            let mut arr = Vec::with_capacity(count);
            for _ in 0..count {
                arr.push(deserialize_value(reader)?);
            }
            Some(JsonValue::Array(arr))
        }
        TYPE_OBJECT => {
            let len = reader.read_vql_int()? as usize;
            let bytes = reader.read_bytes(len)?;
            let s = std::str::from_utf8(bytes).ok()?;
            serde_json::from_str(s).ok()
        }
        TYPE_INT => {
            let val = reader.read_vql_int()?;
            Some(JsonValue::Number(val.into()))
        }
        _ => None,
    }
}

// ============================================================================
// VQL encoding — mirrors native vqlWrite in zcode-codec
// ============================================================================

fn vql_encode_int(value: u32, out: &mut Vec<u8>) {
    let mut val = value;
    loop {
        let mut byte = (val & 0x7F) as u8;
        val >>= 7;
        if val != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if val == 0 {
            break;
        }
    }
}

fn serialize_value(data: &JsonValue, out: &mut Vec<u8>) {
    match data {
        JsonValue::Null => out.push(TYPE_UNDEFINED),
        JsonValue::String(s) => {
            out.push(TYPE_STRING);
            let bytes = s.as_bytes();
            vql_encode_int(bytes.len() as u32, out);
            out.extend_from_slice(bytes);
        }
        JsonValue::Number(n) => {
            if let Some(v) = n.as_u64() {
                out.push(TYPE_INT);
                vql_encode_int(v as u32, out);
            } else {
                // Fallback: JSON-encode the number as an object
                let s = n.to_string();
                out.push(TYPE_OBJECT);
                let bytes = s.as_bytes();
                vql_encode_int(bytes.len() as u32, out);
                out.extend_from_slice(bytes);
            }
        }
        JsonValue::Array(arr) => {
            out.push(TYPE_ARRAY);
            vql_encode_int(arr.len() as u32, out);
            for el in arr {
                serialize_value(el, out);
            }
        }
        JsonValue::Object(_) => {
            out.push(TYPE_OBJECT);
            let s = data.to_string();
            let bytes = s.as_bytes();
            vql_encode_int(bytes.len() as u32, out);
            out.extend_from_slice(bytes);
        }
        JsonValue::Bool(b) => {
            out.push(TYPE_INT);
            vql_encode_int(if *b { 1 } else { 0 }, out);
        }
    }
}

// ============================================================================
// Channel message parsing
// ============================================================================

/// Parse a channel client response from raw bytes.
///
/// Client responses wire format (from channelClient.ts onBuffer):
///   header = deserialize → [responseType, id]
///   body   = deserialize → data
///
/// Returns the parsed response or None if the data is invalid.
#[napi]
pub fn parse_client_response(data: Buffer) -> Option<ClientResponse> {
    let mut reader = VqlReader::new(&data);

    // Header: [responseType, id]
    let header = deserialize_value(&mut reader)?;
    let header_arr = header.as_array()?;
    if header_arr.len() < 2 {
        return None;
    }
    let response_type = header_arr[0].as_u64()? as u32;
    let id = header_arr[1].as_u64()? as u32;

    // Body: data
    let body = if reader.remaining() > 0 {
        deserialize_value(&mut reader)
    } else {
        None
    };

    let data_json = body.map(|v| v.to_string());

    Some(ClientResponse {
        response_type,
        id,
        data_json,
    })
}

#[napi(object)]
pub struct ClientResponse {
    pub response_type: u32,
    pub id: u32,
    pub data_json: Option<String>,
}

/// Parse a channel server request from raw bytes.
///
/// Server request wire format (from channelServer.ts onRawMessage):
///   header = deserialize → [requestType, id, channelName, methodName]
///   body   = deserialize → arg
///
/// Returns the parsed request or None if the data is invalid.
#[napi]
pub fn parse_server_request(data: Buffer) -> Option<ServerRequest> {
    let mut reader = VqlReader::new(&data);

    // Header: [requestType, id, channelName, methodName]
    let header = deserialize_value(&mut reader)?;
    let header_arr = header.as_array()?;
    if header_arr.len() < 4 {
        return None;
    }
    let request_type = header_arr[0].as_u64()? as u32;
    let id = header_arr[1].as_u64()? as u32;
    let channel_name = header_arr[2].as_str()?.to_string();
    let method_name = header_arr[3].as_str()?.to_string();

    // Body: arg
    let body = if reader.remaining() > 0 {
        deserialize_value(&mut reader)
    } else {
        None
    };

    let arg_json = body.map(|v| v.to_string());

    Some(ServerRequest {
        request_type,
        id,
        channel_name,
        method_name,
        arg_json,
    })
}

#[napi(object)]
pub struct ServerRequest {
    pub request_type: u32,
    pub id: u32,
    pub channel_name: String,
    pub method_name: String,
    pub arg_json: Option<String>,
}

// ============================================================================
// Channel message building
// ============================================================================

/// Build a channel response message.
///
/// Response wire format (from channelServer.ts sendResponse/send):
///   serialize([responseType, id]) + serialize(data)
#[napi]
pub fn build_response(
    response_type: u32,
    id: u32,
    data_json: Option<String>,
) -> Buffer {
    let mut out = Vec::with_capacity(64);

    // Header: [responseType, id]
    let header = serde_json::json!([response_type, id]);
    serialize_value(&header, &mut out);

    // Body: data
    if let Some(json_str) = &data_json {
        if let Ok(val) = serde_json::from_str::<JsonValue>(json_str) {
            serialize_value(&val, &mut out);
        } else {
            serialize_value(&JsonValue::String(json_str.clone()), &mut out);
        }
    } else {
        serialize_value(&JsonValue::Null, &mut out);
    }

    Buffer::from(out)
}

/// Build a channel request message.
///
/// Request wire format (from channelClient.ts sendRequest/send):
///   serialize([requestType, id, channelName, methodName]) + serialize(arg)
#[napi]
pub fn build_request(
    request_type: u32,
    id: u32,
    channel_name: String,
    method_name: String,
    arg_json: Option<String>,
) -> Buffer {
    let mut out = Vec::with_capacity(64);

    // Header: [requestType, id, channelName, methodName]
    let header = serde_json::json!([request_type, id, channel_name, method_name]);
    serialize_value(&header, &mut out);

    // Body: arg
    if let Some(json_str) = &arg_json {
        if let Ok(val) = serde_json::from_str::<JsonValue>(json_str) {
            serialize_value(&val, &mut out);
        } else {
            serialize_value(&JsonValue::String(json_str.clone()), &mut out);
        }
    } else {
        serialize_value(&JsonValue::Null, &mut out);
    }

    Buffer::from(out)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_parse_client_response_roundtrip() {
        let data = build_response(2, 42, Some(r#"{"ok":true}"#.to_string()));
        let resp = parse_client_response(data).unwrap();
        assert_eq!(resp.response_type, 2);
        assert_eq!(resp.id, 42);
        assert!(resp.data_json.is_some());
    }

    #[test]
    fn build_parse_server_request_roundtrip() {
        let data = build_request(0, 1, "file".to_string(), "read".to_string(), Some(r#"{"path":"/tmp"}"#.to_string()));
        let req = parse_server_request(data).unwrap();
        assert_eq!(req.request_type, 0);
        assert_eq!(req.id, 1);
        assert_eq!(req.channel_name, "file");
        assert_eq!(req.method_name, "read");
        assert!(req.arg_json.is_some());
    }

    #[test]
    fn build_request_no_arg() {
        let data = build_request(1, 5, "git".to_string(), "status".to_string(), None);
        let req = parse_server_request(data).unwrap();
        assert_eq!(req.request_type, 1);
        assert_eq!(req.channel_name, "git");
    }
}
