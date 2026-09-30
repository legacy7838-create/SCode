mod coalesce;

use napi_derive::napi;
use serde_json::Value as JsonValue;

/// Coalesce a sequence of conversation deltas.
/// Returns the reduced delta array.
#[napi]
pub fn coalesce_deltas(deltas: Vec<JsonValue>) -> napi::Result<Vec<JsonValue>> {
    coalesce::coalesce_conversation_deltas(&deltas)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Conflation helper: per key, keep only the last update of each object.
/// Order-preserving: the kept entries are emitted in the relative order of their "last occurrence".
#[napi]
pub fn conflate_by_key(
    items: Vec<JsonValue>,
    key: String,
) -> napi::Result<Vec<JsonValue>> {
    Ok(coalesce::conflate_by_key(&items, &key))
}
