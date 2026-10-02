//! The zcode-protocol message union: decode + validation.
//!
//! Rust port of `packages/shared/src/zcode-protocol`'s
//! `zcodeProtocolMessageSchema` (Request | Notification | Response | Error).
//! The session runtime sends these over the agent's stdio transport, so every
//! inbound line is validated here before anything acts on it. The strict
//! schemas (deny unknown keys) make the union discrimination exact: a message
//! is matched in the schema's order, first match wins, and an unknown key on a
//! candidate rejects it so a later schema can claim it.

use serde_json::Value as JsonValue;

/// A decoded protocol message. Mirrors the four union arms.
#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolMessage {
    Request {
        id: ProtocolId,
        method: String,
        params: Option<JsonValue>,
    },
    Notification {
        method: String,
        params: Option<JsonValue>,
    },
    Response {
        id: ProtocolId,
        result: JsonValue,
    },
    Error {
        id: ProtocolId,
        code: i64,
        message: String,
        data: Option<JsonValue>,
    },
}

/// A request/response id: a non-empty string (≤64) or an integer.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ProtocolId {
    Text(String),
    Number(i64),
}

fn decode_id(value: &JsonValue) -> Option<ProtocolId> {
    match value {
        JsonValue::String(s) if !s.trim().is_empty() && s.len() <= 64 => {
            Some(ProtocolId::Text(s.clone()))
        }
        JsonValue::Number(n) => n.as_i64().map(ProtocolId::Number),
        _ => None,
    }
}

fn non_empty_string(value: &JsonValue) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
}

/// Is this object strictly one of the four schemas (no unknown keys)?
fn strictly_has_only(value: &serde_json::Map<String, JsonValue>, allowed: &[&str]) -> bool {
    value.keys().all(|key| allowed.contains(&key.as_str()))
}

fn valid_trace(value: &JsonValue) -> bool {
    match value {
        JsonValue::Object(map) => {
            strictly_has_only(map, &["traceparent", "traceId", "parentId", "spanId"])
                && map.values().all(|v| v.is_null() || non_empty_string(v).is_some())
        }
        _ => false,
    }
}

/// Decode a raw JSON line into a protocol message, validating the union in the
/// schema's order (Request → Notification → Response → Error, first match).
pub fn decode_protocol_message(value: &JsonValue) -> Result<ProtocolMessage, String> {
    let Some(map) = value.as_object() else {
        return Err("protocol message must be an object".into());
    };
    let id = map.get("id").and_then(decode_id);
    let method = map.get("method").and_then(non_empty_string);
    // `params` is present only when the key exists (an explicit null is kept).
    let params = if map.contains_key("params") { map.get("params").cloned() } else { None };
    let trace_ok = map.get("trace").map_or(true, valid_trace);

    // Request: { id, method, params?, trace? } strict.
    if let (Some(id), Some(method)) = (id.clone(), method) {
        if strictly_has_only(map, &["id", "method", "params", "trace"]) && trace_ok {
            return Ok(ProtocolMessage::Request {
                id,
                method: method.to_string(),
                params: params.clone(),
            });
        }
    }
    // Notification: { method, params?, trace? } strict (no id).
    if let Some(method) = method {
        if !map.contains_key("id") && strictly_has_only(map, &["method", "params", "trace"]) && trace_ok {
            return Ok(ProtocolMessage::Notification {
                method: method.to_string(),
                params: params.clone(),
            });
        }
    }
    // Response: { id, result } strict.
    if let Some(id) = id.clone() {
        if strictly_has_only(map, &["id", "result"]) {
            let result = map.get("result").cloned().unwrap_or(JsonValue::Null);
            return Ok(ProtocolMessage::Response { id, result });
        }
    }
    // Error: { id, error: { code, message, data? } } strict.
    if let Some(id) = id {
        if strictly_has_only(map, &["id", "error"]) {
            if let Some(JsonValue::Object(error)) = map.get("error") {
                if strictly_has_only(error, &["code", "message", "data"]) {
                    let code = error.get("code").and_then(JsonValue::as_i64);
                    let message = error.get("message").and_then(non_empty_string);
                    if let (Some(code), Some(message)) = (code, message) {
                        return Ok(ProtocolMessage::Error {
                            id,
                            code,
                            message: message.to_string(),
                            data: error.get("data").cloned(),
                        });
                    }
                }
            }
        }
    }
    Err(format!("not a valid zcode-protocol message: {value}"))
}

/// Build a request frame (newline-terminated JSON) for the agent stdio
/// transport.
pub fn encode_request(id: ProtocolId, method: &str, params: Option<&JsonValue>) -> Result<String, String> {
    let mut map = serde_json::Map::new();
    match id {
        ProtocolId::Text(text) => map.insert("id".into(), JsonValue::String(text)),
        ProtocolId::Number(number) => map.insert("id".into(), JsonValue::Number(number.into())),
    };
    map.insert("method".into(), JsonValue::String(method.to_string()));
    if let Some(params) = params {
        map.insert("params".into(), params.clone());
    }
    serde_json::to_string(&JsonValue::Object(map)).map_err(|error| error.to_string())
}

/// `method` of a message (Requests/Notifications); `None` for a response/error.
pub fn message_method(message: &ProtocolMessage) -> Option<&str> {
    match message {
        ProtocolMessage::Request { method, .. } | ProtocolMessage::Notification { method, .. } => {
            Some(method)
        }
        _ => None,
    }
}

/// `id` of a message (Request/Response/Error); `None` for a notification.
pub fn message_id(message: &ProtocolMessage) -> Option<&ProtocolId> {
    match message {
        ProtocolMessage::Request { id, .. }
        | ProtocolMessage::Response { id, .. }
        | ProtocolMessage::Error { id, .. } => Some(id),
        ProtocolMessage::Notification { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_message_decodes() {
        let value = serde_json::json!({ "id": "abc", "method": "initialize", "params": { "a": 1 } });
        let message = decode_protocol_message(&value).expect("decode");
        assert_eq!(
            message,
            ProtocolMessage::Request {
                id: ProtocolId::Text("abc".into()),
                method: "initialize".into(),
                params: Some(serde_json::json!({ "a": 1 })),
            }
        );
    }

    #[test]
    fn a_response_is_not_mistaken_for_a_request() {
        // id + result (no method) → Response, matching the union order.
        let value = serde_json::json!({ "id": 7, "result": { "ok": true } });
        let message = decode_protocol_message(&value).expect("decode");
        assert_eq!(
            message,
            ProtocolMessage::Response { id: ProtocolId::Number(7), result: serde_json::json!({ "ok": true }) }
        );
    }

    #[test]
    fn a_notification_has_no_id() {
        let value = serde_json::json!({ "method": "task/updated", "params": {} });
        let message = decode_protocol_message(&value).expect("decode");
        assert_eq!(message_method(&message), Some("task/updated"));
        assert!(message_id(&message).is_none());
    }

    #[test]
    fn an_error_message_decodes_its_code_and_message() {
        let value = serde_json::json!({ "id": "x", "error": { "code": 42, "message": "boom" } });
        let message = decode_protocol_message(&value).expect("decode");
        assert_eq!(
            message,
            ProtocolMessage::Error { id: ProtocolId::Text("x".into()), code: 42, message: "boom".into(), data: None }
        );
    }

    #[test]
    fn unknown_keys_and_blank_methods_are_rejected() {
        // Strict schemas: an unknown key on a candidate rejects the message.
        assert!(decode_protocol_message(&serde_json::json!({ "id": 1, "method": "m", "bogus": 1 })).is_err());
        // A blank method is not a non-empty string.
        assert!(decode_protocol_message(&serde_json::json!({ "id": 1, "method": "   " })).is_err());
        // An empty id string is invalid.
        assert!(decode_protocol_message(&serde_json::json!({ "id": "", "method": "m" })).is_err());
        // Not an object.
        assert!(decode_protocol_message(&serde_json::json!("nope")).is_err());
    }

    #[test]
    fn a_request_round_trips_through_encode() {
        let encoded = encode_request(ProtocolId::Text("id1".into()), "createSession", Some(&serde_json::json!({ "x": 1 })))
            .expect("encode");
        let decoded = decode_protocol_message(&serde_json::from_str::<JsonValue>(&encoded).unwrap()).expect("decode");
        assert_eq!(message_method(&decoded), Some("createSession"));
    }
}