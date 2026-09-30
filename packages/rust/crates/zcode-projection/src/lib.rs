mod delta_apply;

use napi_derive::napi;
use serde_json::Value as JsonValue;

/// Apply a single delta to a snapshot (immutable). Returns new snapshot.
#[napi]
pub fn apply_delta(snapshot: JsonValue, delta: JsonValue) -> napi::Result<JsonValue> {
    delta_apply::apply_conversation_delta(&snapshot, &delta)
        .map_err(|e| napi::Error::from_reason(e))
}

/// Apply multiple deltas sequentially to a snapshot.
#[napi]
pub fn apply_deltas(snapshot: JsonValue, deltas: Vec<JsonValue>) -> napi::Result<JsonValue> {
    delta_apply::apply_conversation_deltas(&snapshot, &deltas)
        .map_err(|e| napi::Error::from_reason(e))
}

/// Batch apply deltas: takes a snapshot + array of delta arrays (one per frame),
/// returns array of resulting snapshots.
#[napi]
pub fn apply_deltas_batch(
    snapshot: JsonValue,
    delta_batches: Vec<Vec<JsonValue>>,
) -> napi::Result<Vec<JsonValue>> {
    delta_apply::apply_deltas_batch(&snapshot, &delta_batches)
        .map_err(|e| napi::Error::from_reason(e))
}

/// Append text to a row's streaming path. Returns new row.
#[napi]
pub fn append_to_row(row: JsonValue, path: String, append: String) -> napi::Result<JsonValue> {
    delta_apply::append_to_row(&row, &path, &append)
        .map_err(|e| napi::Error::from_reason(e))
}

/// Merge older rows into a window. Returns merged array or null if no merge needed.
#[napi]
pub fn merge_older_rows(
    window: Vec<JsonValue>,
    fetched: Vec<JsonValue>,
) -> napi::Result<Option<Vec<JsonValue>>> {
    delta_apply::merge_older_rows(&window, &fetched)
        .map_err(|e| napi::Error::from_reason(e))
}

/// Apply workflowRun.updated delta.
#[napi]
pub fn apply_workflow_run_updated(
    state: JsonValue,
    delta: JsonValue,
) -> napi::Result<JsonValue> {
    delta_apply::apply_workflow_run_updated(&state, &delta)
        .map_err(|e| napi::Error::from_reason(e))
}

/// Apply workflowRun.removed delta.
#[napi]
pub fn apply_workflow_run_removed(
    state: JsonValue,
    delta: JsonValue,
) -> napi::Result<JsonValue> {
    delta_apply::apply_workflow_run_removed(&state, &delta)
        .map_err(|e| napi::Error::from_reason(e))
}

/// Merge two workflowRun.updated deltas for the same run.
#[napi]
pub fn merge_workflow_run_updates(
    earlier: JsonValue,
    later: JsonValue,
) -> JsonValue {
    delta_apply::merge_workflow_run_updates(&earlier, &later)
}
