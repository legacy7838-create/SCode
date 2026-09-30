//! Channel message envelopes — the Rust port of the request/response framing in
//! `packages/rpc/src/channels.shared.ts`, `channelClient.ts` and
//! `channelServer.ts`.
//!
//! Every channel message is two consecutive serialized values:
//!
//! ```text
//! header := serialize([type, id, channelName, methodName])   // or [type, id]
//! body   := serialize(arg)
//! ```
//!
//! The header is an array, so it is encoded with the `Array` type tag and each
//! element is encoded in turn (VQL for the small integers, length-prefixed UTF-8
//! for the names). `zcode-codec::serialization` already implements that byte
//! format, so this module only deals with envelope shape and never re-implements
//! serialization.

use serde_json::Value as JsonValue;
use zcode_codec::serialization::{deserialize_option, serialize_option};
use zcode_codec::vql::{VqlReader, VqlWriter};

/// Mirrors `RequestType` in `packages/rpc/src/channels.shared.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum RequestType {
    Promise = 100,
    PromiseCancel = 101,
    EventListen = 102,
    EventDispose = 103,
}

/// Mirrors `ResponseType` in `packages/rpc/src/channels.shared.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ResponseType {
    Initialize = 200,
    PromiseSuccess = 201,
    PromiseError = 202,
    PromiseErrorObj = 203,
    EventFire = 204,
}

/// Failure while building or parsing an envelope.
#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("codec error: {0}")]
    Codec(#[from] zcode_codec::CodecError),
    #[error("header is not an array")]
    HeaderNotArray,
    #[error("header is too short: expected at least {expected} elements, got {actual}")]
    HeaderTooShort { expected: usize, actual: usize },
    #[error("header element {index} is not a {expected}")]
    HeaderElement { index: usize, expected: &'static str },
    #[error("header element {index} is not a valid 32-bit integer")]
    HeaderId { index: usize },
    #[error("unknown request type: {0}")]
    UnknownRequestType(u32),
    #[error("unknown response type: {0}")]
    UnknownResponseType(u32),
    #[error("failed to encode a {0} into JSON")]
    #[allow(dead_code)]
    EncodeJson(&'static str),
}

/// A decoded client→server request.
#[derive(Debug, Clone)]
pub struct Request {
    pub request_type: RequestType,
    pub id: u32,
    /// Absent for `PromiseCancel` / `EventDispose`, whose header is only `[type, id]`.
    pub channel_name: Option<String>,
    pub method_name: Option<String>,
    /// `None` when the peer sent `undefined`.
    pub arg: Option<JsonValue>,
}

impl Request {
    pub fn channel(&self) -> &str {
        self.channel_name.as_deref().unwrap_or("")
    }

    pub fn method(&self) -> &str {
        self.method_name.as_deref().unwrap_or("")
    }
}

/// A response to be written back to a client.
#[derive(Debug, Clone)]
pub struct Response {
    pub response_type: ResponseType,
    /// `None` for `Initialize`, which carries no id.
    pub id: Option<u32>,
    pub data: Option<JsonValue>,
}

impl Response {
    pub fn initialize() -> Self {
        Self {
            response_type: ResponseType::Initialize,
            id: None,
            data: None,
        }
    }

    pub fn success(id: u32, data: JsonValue) -> Self {
        Self {
            response_type: ResponseType::PromiseSuccess,
            id: Some(id),
            data: Some(data),
        }
    }

    /// `PromiseError`: the client rebuilds an `Error` from these fields and also
    /// copies the passthrough keys onto it, so they must survive the round trip.
    pub fn error(id: u32, data: JsonValue) -> Self {
        Self {
            response_type: ResponseType::PromiseError,
            id: Some(id),
            data: Some(data),
        }
    }

    /// `PromiseErrorObj`: the client rejects with the value as-is.
    pub fn error_obj(id: u32, data: JsonValue) -> Self {
        Self {
            response_type: ResponseType::PromiseErrorObj,
            id: Some(id),
            data: Some(data),
        }
    }

    pub fn event_fire(id: u32, data: JsonValue) -> Self {
        Self {
            response_type: ResponseType::EventFire,
            id: Some(id),
            data: Some(data),
        }
    }
}

fn u32_at(array: &[JsonValue], index: usize) -> Result<u32, EnvelopeError> {
    array[index]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or(EnvelopeError::HeaderId { index })
}

fn string_at(array: &[JsonValue], index: usize) -> Result<String, EnvelopeError> {
    array[index]
        .as_str()
        .map(str::to_owned)
        .ok_or(EnvelopeError::HeaderElement {
            index,
            expected: "string",
        })
}

/// Build a client→server request payload. Mirrors `ChannelClient.sendRequest`
/// and `ChannelClient.sendCancelOrDispose`.
pub fn encode_request(
    request_type: RequestType,
    id: u32,
    channel_name: Option<&str>,
    method_name: Option<&str>,
    arg: Option<&JsonValue>,
) -> Result<Vec<u8>, EnvelopeError> {
    let mut writer = VqlWriter::new();
    match (channel_name, method_name) {
        (Some(channel), Some(method)) => {
            let header = json_array(&[
                JsonValue::from(request_type as u64),
                JsonValue::from(id as u64),
                JsonValue::from(channel),
                JsonValue::from(method),
            ])?;
            serialize_option(&mut writer, Some(&header))?;
        }
        _ => {
            // Cancel/dispose carry only `[type, id]`.
            let header = json_array(&[
                JsonValue::from(request_type as u64),
                JsonValue::from(id as u64),
            ])?;
            serialize_option(&mut writer, Some(&header))?;
        }
    }
    serialize_option(&mut writer, arg)?;
    Ok(writer.into_bytes())
}

/// Build a server→client response payload. Mirrors `ChannelServer.send`.
pub fn encode_response(response: &Response) -> Result<Vec<u8>, EnvelopeError> {
    let mut writer = VqlWriter::new();
    let header = match response.id {
        None => json_array(&[JsonValue::from(response.response_type as u64)])?,
        Some(id) => json_array(&[
            JsonValue::from(response.response_type as u64),
            JsonValue::from(id as u64),
        ])?,
    };
    serialize_option(&mut writer, Some(&header))?;
    serialize_option(&mut writer, response.data.as_ref())?;
    Ok(writer.into_bytes())
}

/// Parse a client→server request payload. Mirrors `ChannelServer.onRawMessage`.
pub fn decode_request(bytes: &[u8]) -> Result<Request, EnvelopeError> {
    let mut reader = VqlReader::new(bytes);
    let header = deserialize_option(&mut reader)?.ok_or(EnvelopeError::HeaderNotArray)?;
    let array = header
        .as_array()
        .ok_or(EnvelopeError::HeaderNotArray)?
        .clone();
    if array.is_empty() {
        return Err(EnvelopeError::HeaderTooShort {
            expected: 1,
            actual: 0,
        });
    }

    let raw_type = u32_at(&array, 0)?;
    let request_type = match raw_type {
        100 => RequestType::Promise,
        101 => RequestType::PromiseCancel,
        102 => RequestType::EventListen,
        103 => RequestType::EventDispose,
        other => return Err(EnvelopeError::UnknownRequestType(other)),
    };

    let id = u32_at(&array, 1)?;
    // Cancel/dispose have no channel or method.
    let (channel_name, method_name) = if array.len() >= 4 {
        (Some(string_at(&array, 2)?), Some(string_at(&array, 3)?))
    } else {
        (None, None)
    };

    // The body is optional: `serialize(undefined)` still writes a tag, but a
    // peer may legitimately stop after the header.
    let arg = if reader.remaining() > 0 {
        deserialize_option(&mut reader)?
    } else {
        None
    };

    Ok(Request {
        request_type,
        id,
        channel_name,
        method_name,
        arg,
    })
}

/// Parse a server→client response payload. Mirrors `ChannelClient.onBuffer`.
pub fn decode_response(bytes: &[u8]) -> Result<Response, EnvelopeError> {
    let mut reader = VqlReader::new(bytes);
    let header = deserialize_option(&mut reader)?.ok_or(EnvelopeError::HeaderNotArray)?;
    let array = header
        .as_array()
        .ok_or(EnvelopeError::HeaderNotArray)?
        .clone();
    if array.is_empty() {
        return Err(EnvelopeError::HeaderTooShort {
            expected: 1,
            actual: 0,
        });
    }

    let raw_type = u32_at(&array, 0)?;
    let response_type = match raw_type {
        200 => ResponseType::Initialize,
        201 => ResponseType::PromiseSuccess,
        202 => ResponseType::PromiseError,
        203 => ResponseType::PromiseErrorObj,
        204 => ResponseType::EventFire,
        other => return Err(EnvelopeError::UnknownResponseType(other)),
    };

    let id = if array.len() >= 2 { Some(u32_at(&array, 1)?) } else { None };
    let data = if reader.remaining() > 0 {
        deserialize_option(&mut reader)?
    } else {
        None
    };

    Ok(Response {
        response_type,
        id,
        data,
    })
}

fn json_array(parts: &[JsonValue]) -> Result<JsonValue, EnvelopeError> {
    Ok(JsonValue::Array(parts.to_vec()))
}
