use napi_derive::napi;
use serde_json::Value as JsonValue;

const COALESCIBLE_KINDS: &[&str] = &["text_delta", "reasoning_delta", "tool_input_delta"];
const SEPARATOR: &str = "\u{0000}";

/// Generate a coalesce key for a session event.
/// Returns null if the event is not coalesceable.
#[napi]
pub fn get_coalesce_key(event: JsonValue) -> Option<String> {
    let event_type = event["type"].as_str()?;
    let payload = event.get("payload").and_then(|p| p.as_object())?;
    let session_id = event["sessionId"].as_str()?;
    let turn_id = event["turnId"].as_str().unwrap_or("");

    if event_type == "model.streaming" {
        let kind = payload.get("kind").and_then(|k| k.as_str())?;
        if !COALESCIBLE_KINDS.contains(&kind) {
            return None;
        }
        if payload.get("delta").is_none() {
            return None;
        }
        let parts = vec![
            event_type,
            session_id,
            turn_id,
            kind,
            payload
                .get("inputId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            payload
                .get("assistantMessageId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            payload
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            payload
                .get("parentToolUseId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            payload
                .get("parentToolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ];
        return Some(parts.join(SEPARATOR));
    }

    if event_type == "tool.updated"
        && payload.get("kind").and_then(|k| k.as_str()) == Some("progress")
    {
        let parts = vec![
            event_type,
            session_id,
            turn_id,
            payload
                .get("inputId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            payload
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ];
        return Some(parts.join(SEPARATOR));
    }

    if event_type == "streamRecovery.updated" {
        let parts = vec![
            event_type,
            session_id,
            turn_id,
            payload
                .get("inputId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            event
                .get("traceId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ];
        return Some(parts.join(SEPARATOR));
    }

    None
}

/// Merge two coalesceable session events.
/// For model.streaming: concatenates delta strings.
/// For others: returns next (latest wins).
#[napi]
pub fn merge_session_events(current: JsonValue, next: JsonValue) -> JsonValue {
    let current_type = current["type"].as_str().unwrap_or("");
    let next_type = next["type"].as_str().unwrap_or("");

    if current_type == "model.streaming" && next_type == "model.streaming" {
        let current_delta = current
            .get("payload")
            .and_then(|p| p.get("delta"))
            .and_then(|d| d.as_str())
            .unwrap_or("");
        let next_delta = next
            .get("payload")
            .and_then(|p| p.get("delta"))
            .and_then(|d| d.as_str())
            .unwrap_or("");

        let mut result = next.clone();
        if let Some(payload) = result
            .get_mut("payload")
            .and_then(|p| p.as_object_mut())
        {
            payload.insert(
                "delta".to_string(),
                JsonValue::String(format!("{}{}", current_delta, next_delta)),
            );
        }
        return result;
    }

    next
}
