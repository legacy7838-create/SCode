// Port of packages/shared/src/zcode-protocol-v4/apply.ts
// Canonical delta-application engine: applies conversation deltas to snapshots.
// All functions are pure (immutable path) except the mutable accumulator variants.

use serde_json::{Map, Value as JsonValue};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum ProjectionError {
    MissingField(&'static str),
    InvalidOp(String),
    Json(serde_json::Error),
}

impl std::fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::MissingField(field) => write!(f, "missing field: {field}"),
            Self::InvalidOp(op) => write!(f, "invalid op: {op}"),
            Self::Json(e) => write!(f, "json error: {e}"),
        }
    }
}

impl std::error::Error for ProjectionError {}

impl From<serde_json::Error> for ProjectionError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

impl From<ProjectionError> for String {
    fn from(e: ProjectionError) -> Self {
        e.to_string()
    }
}

// ---------------------------------------------------------------------------
// Canonical workflow-run key order (mirrors workflowRunSchema.shape in TS).
// Keys outside this set are appended at the end in their original order.
// ---------------------------------------------------------------------------

const WORKFLOW_RUN_KEYS: &[&str] = &[
    "runId",
    "toolCallId",
    "status",
    "stopReason",
    "resumedFrom",
    "supersededBy",
    "usage",
    "error",
    "resumable",
    "resultPreview",
    "actors",
    "nodes",
    "reports",
    "pendingQuestions",
    "concurrency",
    "concurrencyCeiling",
    "subagentModel",
    "artifacts",
    "phases",
    "currentPhase",
    "phaseNames",
    "phaseAlongside",
    "unlistedByPhase",
    "truncated",
    "lastEventSequence",
];

/// Required header keys for birth qualification (those that are NOT optional in the schema).
const WORKFLOW_RUN_REQUIRED_HEADER_KEYS: &[&str] = &[
    "runId",
    "status",
    "usage",
    "actors",
    "nodes",
    "lastEventSequence",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Apply a single delta to a snapshot (immutable). Returns new snapshot.
pub fn apply_conversation_delta(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let op = delta["op"]
        .as_str()
        .ok_or(ProjectionError::MissingField("op"))?;
    match op {
        "row.appended" => apply_row_appended(snapshot, delta),
        "row.upserted" => apply_row_upserted(snapshot, delta),
        "row.removed" => apply_row_removed(snapshot, delta),
        "row.delta" => apply_row_delta(snapshot, delta),
        "state.updated" => apply_state_updated(snapshot, delta),
        "workflowRun.updated" => apply_workflow_run_updated(snapshot, delta),
        "workflowRun.removed" => apply_workflow_run_removed(snapshot, delta),
        _ => Err(ProjectionError::InvalidOp(op.to_string())),
    }
}

/// Apply multiple deltas sequentially to a snapshot.
pub fn apply_conversation_deltas(
    snapshot: &JsonValue,
    deltas: &[JsonValue],
) -> Result<JsonValue, ProjectionError> {
    let mut current = snapshot.clone();
    for delta in deltas {
        current = apply_conversation_delta(&current, delta)?;
    }
    Ok(current)
}

/// Batch apply deltas: takes a snapshot + array of delta arrays (one per frame),
/// returns array of resulting snapshots.
pub fn apply_deltas_batch(
    snapshot: &JsonValue,
    delta_batches: &[Vec<JsonValue>],
) -> Result<Vec<JsonValue>, ProjectionError> {
    let mut results = Vec::with_capacity(delta_batches.len());
    let mut current = snapshot.clone();
    for batch in delta_batches {
        current = apply_conversation_deltas(&current, batch)?;
        results.push(current.clone());
    }
    Ok(results)
}

/// Append text to a row's streaming path. Returns new row.
pub fn append_to_row(
    row: &JsonValue,
    path: &str,
    append: &str,
) -> Result<JsonValue, ProjectionError> {
    let mut result = row.clone();
    append_to_row_in_place(&mut result, path, append);
    Ok(result)
}

/// Merge older rows into a window. Returns merged array or None if no merge needed.
pub fn merge_older_rows(
    window: &[JsonValue],
    fetched: &[JsonValue],
) -> Result<Option<Vec<JsonValue>>, ProjectionError> {
    let first_row_id = window
        .first()
        .and_then(|r| r["rowId"].as_i64())
        .unwrap_or(i64::MAX);

    let mut older: Vec<JsonValue> = fetched
        .iter()
        .filter(|r| r["rowId"].as_i64().map_or(false, |id| id < first_row_id))
        .cloned()
        .collect();

    if older.is_empty() {
        return Ok(None);
    }

    older.extend_from_slice(window);
    Ok(Some(older))
}

// ---------------------------------------------------------------------------
// row.appended
// ---------------------------------------------------------------------------

fn apply_row_appended(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let row = delta["row"].clone();
    let row_id = row["rowId"].as_i64().unwrap_or(0);

    let mut result = snapshot.clone();
    let rows = result
        .as_object_mut()
        .ok_or(ProjectionError::MissingField("snapshot"))?
        .get_mut("rows")
        .and_then(|v| v.as_object_mut())
        .ok_or(ProjectionError::MissingField("rows"))?;

    // Append to window
    if let Some(window) = rows.get_mut("window").and_then(|w| w.as_array_mut()) {
        window.push(row);
    } else {
        // No window array yet — create one
        rows.insert(
            "window".to_string(),
            JsonValue::Array(vec![row]),
        );
    }

    // Increment totalCount
    let tc = rows
        .get("totalCount")
        .and_then(|t| t.as_i64())
        .unwrap_or(0);
    rows.insert(
        "totalCount".to_string(),
        JsonValue::Number((tc + 1).into()),
    );

    // Set firstRowId if null
    let first_row_id = rows.get("firstRowId");
    if first_row_id.map_or(true, |v| v.is_null()) {
        rows.insert(
            "firstRowId".to_string(),
            JsonValue::Number(row_id.into()),
        );
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// row.upserted
// ---------------------------------------------------------------------------

fn apply_row_upserted(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let row = delta["row"].clone();
    let row_id = row["rowId"].as_i64().unwrap_or(0);

    let mut result = snapshot.clone();
    let rows = result
        .as_object_mut()
        .ok_or(ProjectionError::MissingField("snapshot"))?
        .get_mut("rows")
        .and_then(|v| v.as_object_mut())
        .ok_or(ProjectionError::MissingField("rows"))?;

    if let Some(window) = rows.get_mut("window").and_then(|w| w.as_array_mut()) {
        if let Some(existing) = window
            .iter_mut()
            .find(|r| r["rowId"].as_i64() == Some(row_id))
        {
            *existing = row;
        }
        // Not found → no-op (evicted rows can only be retrieved via rows/range)
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// row.removed
// ---------------------------------------------------------------------------

fn apply_row_removed(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let from_row_id = delta["fromRowId"].as_i64().unwrap_or(0);

    let mut result = snapshot.clone();
    let rows = result
        .as_object_mut()
        .ok_or(ProjectionError::MissingField("snapshot"))?
        .get_mut("rows")
        .and_then(|v| v.as_object_mut())
        .ok_or(ProjectionError::MissingField("rows"))?;

    let current_first_row_id = rows.get("firstRowId").and_then(|v| v.as_i64());

    // "removesEntireActiveBranch": firstRowId is not null AND fromRowId <= firstRowId
    let removes_entire_active_branch = current_first_row_id
        .map(|fid| from_row_id <= fid)
        .unwrap_or(false);

    let removed = if let Some(window) = rows.get_mut("window").and_then(|w| w.as_array_mut()) {
        let original_len = window.len();
        window.retain(|r| r["rowId"].as_i64().map_or(true, |id| id < from_row_id));
        original_len - window.len()
    } else {
        0
    };

    if removes_entire_active_branch {
        rows.insert("totalCount".to_string(), JsonValue::Number(0.into()));
        rows.insert("firstRowId".to_string(), JsonValue::Null);
    } else {
        let tc = rows
            .get("totalCount")
            .and_then(|t| t.as_i64())
            .unwrap_or(0);
        rows.insert(
            "totalCount".to_string(),
            JsonValue::Number((tc - removed as i64).max(0).into()),
        );
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// row.delta (streaming text append)
// ---------------------------------------------------------------------------

fn apply_row_delta(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let row_id = delta["rowId"].as_i64().unwrap_or(0);
    let path = delta["path"]
        .as_str()
        .ok_or(ProjectionError::MissingField("path"))?;
    let append = delta["append"].as_str().unwrap_or("");

    let mut result = snapshot.clone();
    let rows = result
        .as_object_mut()
        .ok_or(ProjectionError::MissingField("snapshot"))?
        .get_mut("rows")
        .and_then(|v| v.as_object_mut())
        .ok_or(ProjectionError::MissingField("rows"))?;

    if let Some(window) = rows.get_mut("window").and_then(|w| w.as_array_mut()) {
        if let Some(row) = window
            .iter_mut()
            .find(|r| r["rowId"].as_i64() == Some(row_id))
        {
            append_to_row_in_place(row, path, append);
        }
        // Not found → no-op
    }

    Ok(result)
}

/// In-place streaming text append on a row object. Matches TS appendToRow semantics:
/// no-op when the path/row-kind combination does not exist.
///
/// serde_json::Value::String is immutable, so we take ownership of the string value,
/// push_str, and put it back. This is still zero-copy for the rest of the row.
fn append_to_row_in_place(row: &mut JsonValue, path: &str, append: &str) {
    match path {
        "text" => {
            let kind = row.get("kind").and_then(|k| k.as_str());
            if kind == Some("assistantText") || kind == Some("reasoning") {
                if let Some(JsonValue::String(text)) = row.get_mut("text") {
                    text.push_str(append);
                }
            }
        }
        "inputText" => {
            let kind = row.get("kind").and_then(|k| k.as_str());
            if kind == Some("toolCall") {
                if let Some(JsonValue::String(it)) = row.get_mut("inputText") {
                    it.push_str(append);
                }
            }
        }
        "output.text" => {
            let kind = row.get("kind").and_then(|k| k.as_str());
            if kind == Some("toolCall") {
                if let Some(output) = row.get_mut("output") {
                    if let Some(JsonValue::String(text)) = output.get_mut("text") {
                        text.push_str(append);
                    }
                }
            }
        }
        "summaryText" => {
            let kind = row.get("kind").and_then(|k| k.as_str());
            if kind == Some("subagent") {
                if let Some(JsonValue::String(st)) = row.get_mut("summaryText") {
                    st.push_str(append);
                }
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// state.updated
// ---------------------------------------------------------------------------

fn apply_state_updated(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let patch = delta["patch"]
        .as_object()
        .ok_or(ProjectionError::MissingField("patch"))?;

    let mut result = snapshot.clone();
    if let Some(obj) = result.as_object_mut() {
        for (key, value) in patch {
            obj.insert(key.clone(), value.clone());
        }
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// workflowRun.updated — full implementation matching TS applyWorkflowRunUpdated
// ---------------------------------------------------------------------------

pub fn apply_workflow_run_updated(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let run_id = delta["runId"]
        .as_str()
        .ok_or(ProjectionError::MissingField("runId"))?;
    let delta_revision = delta["revision"].as_i64().unwrap_or(0);

    let mut result = snapshot.clone();

    // Get or create workflowRuns state
    let workflow_runs = result
        .as_object_mut()
        .and_then(|s| s.get_mut("workflowRuns"))
        .and_then(|wr| wr.as_object_mut());

    let (runs_array, current_revision) = if let Some(wr) = workflow_runs {
        let revision = wr.get("revision").and_then(|r| r.as_i64()).unwrap_or(0);
        let runs = wr
            .get_mut("runs")
            .and_then(|r| r.as_array_mut())
            .cloned()
            .unwrap_or_default();
        (runs, revision)
    } else {
        (Vec::new(), 0i64)
    };

    let revision = current_revision.max(delta_revision);

    // Find existing run by runId
    let index = runs_array.iter().position(|r| {
        r.get("runId")
            .and_then(|id| id.as_str())
            .map_or(false, |id| id == run_id)
    });

    let mut next_runs = runs_array;

    match index {
        Some(idx) => {
            // Merge: header + delete cleared + remove entries + upsert entries
            let existing = &next_runs[idx];
            let delta_run = delta.get("run").cloned().unwrap_or(JsonValue::Object(Map::new()));

            // Shallow merge existing + delta.run
            let mut merged = if let Some(obj) = existing.as_object() {
                obj.clone()
            } else {
                Map::new()
            };
            if let Some(run_obj) = delta_run.as_object() {
                for (k, v) in run_obj {
                    merged.insert(k.clone(), v.clone());
                }
            }

            // Delete cleared keys
            if let Some(cleared) = delta.get("cleared").and_then(|c| c.as_array()) {
                for key in cleared {
                    if let Some(k) = key.as_str() {
                        merged.remove(k);
                    }
                }
            }

            // Remove actors
            let mut actors = merged
                .get("actors")
                .and_then(|a| a.as_array())
                .cloned()
                .unwrap_or_default();
            if let Some(removed_actors) = delta.get("removedActors").and_then(|r| r.as_array()) {
                actors = remove_workflow_run_entries(&actors, removed_actors);
                merged.insert("actors".to_string(), JsonValue::Array(actors.clone()));
            }

            // Remove nodes
            let mut nodes = merged
                .get("nodes")
                .and_then(|n| n.as_array())
                .cloned()
                .unwrap_or_default();
            if let Some(removed_nodes) = delta.get("removedNodes").and_then(|r| r.as_array()) {
                nodes = remove_workflow_run_entries(&nodes, removed_nodes);
                merged.insert("nodes".to_string(), JsonValue::Array(nodes.clone()));
            }

            // Upsert actors
            if let Some(incoming_actors) = delta.get("actors").and_then(|a| a.as_array()) {
                if !incoming_actors.is_empty() {
                    actors = upsert_workflow_run_entries(&actors, incoming_actors);
                    merged.insert("actors".to_string(), JsonValue::Array(actors));
                }
            }

            // Upsert nodes
            if let Some(incoming_nodes) = delta.get("nodes").and_then(|n| n.as_array()) {
                if !incoming_nodes.is_empty() {
                    nodes = upsert_workflow_run_entries(&nodes, incoming_nodes);
                    merged.insert("nodes".to_string(), JsonValue::Array(nodes));
                }
            }

            // Canonical key order
            next_runs[idx] = canonical_workflow_run_from_map(&merged);
        }
        None => {
            // Unknown run: check if header is complete enough for birth
            let delta_run = delta.get("run").cloned().unwrap_or(JsonValue::Object(Map::new()));
            if !is_complete_workflow_run_header(&delta_run) {
                // Incomplete header → no-op, just let revision catch up
                let result_runs = result
                    .as_object_mut()
                    .and_then(|s| s.get_mut("workflowRuns"))
                    .and_then(|wr| wr.as_object_mut());
                if let Some(wr) = result_runs {
                    wr.insert("revision".to_string(), JsonValue::Number(revision.into()));
                }
                return Ok(result);
            }

            // Birth: build complete run from delta.run header + actors + nodes
            let mut born_map = if let Some(obj) = delta_run.as_object() {
                obj.clone()
            } else {
                Map::new()
            };

            let actors = delta
                .get("actors")
                .and_then(|a| a.as_array())
                .cloned()
                .unwrap_or_default();
            let nodes = delta
                .get("nodes")
                .and_then(|n| n.as_array())
                .cloned()
                .unwrap_or_default();

            born_map.insert("actors".to_string(), JsonValue::Array(actors));
            born_map.insert("nodes".to_string(), JsonValue::Array(nodes));

            let born = canonical_workflow_run_from_map(&born_map);
            next_runs.push(born);
        }
    }

    // Write back to snapshot
    if let Some(wr) = result
        .as_object_mut()
        .and_then(|s| s.get_mut("workflowRuns"))
        .and_then(|wr| wr.as_object_mut())
    {
        wr.insert(
            "revision".to_string(),
            JsonValue::Number(revision.into()),
        );
        wr.insert("runs".to_string(), JsonValue::Array(next_runs));
    } else {
        let mut wr_map = Map::new();
        wr_map.insert(
            "revision".to_string(),
            JsonValue::Number(revision.into()),
        );
        wr_map.insert("runs".to_string(), JsonValue::Array(next_runs));
        result.as_object_mut().unwrap().insert(
            "workflowRuns".to_string(),
            JsonValue::Object(wr_map),
        );
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// workflowRun.removed
// ---------------------------------------------------------------------------

pub fn apply_workflow_run_removed(
    snapshot: &JsonValue,
    delta: &JsonValue,
) -> Result<JsonValue, ProjectionError> {
    let run_id = delta["runId"]
        .as_str()
        .ok_or(ProjectionError::MissingField("runId"))?;
    let delta_revision = delta["revision"].as_i64().unwrap_or(0);

    let mut result = snapshot.clone();

    let workflow_runs = result
        .as_object_mut()
        .and_then(|s| s.get_mut("workflowRuns"))
        .and_then(|wr| wr.as_object_mut());

    if let Some(wr) = workflow_runs {
        let current_revision = wr.get("revision").and_then(|r| r.as_i64()).unwrap_or(0);
        let revision = current_revision.max(delta_revision);

        if let Some(runs) = wr.get_mut("runs").and_then(|r| r.as_array_mut()) {
            let original_len = runs.len();
            runs.retain(|r| {
                r.get("runId")
                    .and_then(|id| id.as_str())
                    .map_or(true, |id| id != run_id)
            });
            // Unknown runId: only bump revision, don't rebuild runs
            if runs.len() == original_len {
                wr.insert("revision".to_string(), JsonValue::Number(revision.into()));
                return Ok(result);
            }
        }

        wr.insert("revision".to_string(), JsonValue::Number(revision.into()));
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Workflow run helpers
// ---------------------------------------------------------------------------

/// Canonical key order for a workflow run object.
fn canonical_workflow_run_from_map(run: &Map<String, JsonValue>) -> JsonValue {
    let mut canonical = Map::with_capacity(run.len());

    // First: schema-defined keys in declaration order
    for &key in WORKFLOW_RUN_KEYS {
        if let Some(value) = run.get(key) {
            canonical.insert(key.to_string(), value.clone());
        }
    }

    // Then: any extra keys not in the schema, in their original order
    for (key, value) in run {
        if !WORKFLOW_RUN_KEYS.contains(&key.as_str()) {
            canonical.insert(key.clone(), value.clone());
        }
    }

    JsonValue::Object(canonical)
}

/// Whether a header qualifies to let an unknown run be born: all required keys present.
fn is_complete_workflow_run_header(header: &JsonValue) -> bool {
    let obj = match header.as_object() {
        Some(o) => o,
        None => return false,
    };
    WORKFLOW_RUN_REQUIRED_HEADER_KEYS
        .iter()
        .all(|&key| obj.contains_key(key))
}

/// Workflow run entry dedup key: `{siteId}\0{ordinal}`.
fn workflow_run_entry_key(entry: &JsonValue) -> String {
    let site_id = entry
        .get("siteId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let ordinal = entry
        .get("ordinal")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    format!("{site_id}\0{ordinal}")
}

/// Remove entries by (siteId, ordinal) key.
fn remove_workflow_run_entries(
    current: &[JsonValue],
    removed: &[JsonValue],
) -> Vec<JsonValue> {
    if removed.is_empty() {
        return current.to_vec();
    }
    let dropped: std::collections::HashSet<String> =
        removed.iter().map(workflow_run_entry_key).collect();
    current
        .iter()
        .filter(|entry| !dropped.contains(&workflow_run_entry_key(entry)))
        .cloned()
        .collect()
}

/// Upsert entries by (siteId, ordinal): existing replaced, new appended.
fn upsert_workflow_run_entries(
    current: &[JsonValue],
    incoming: &[JsonValue],
) -> Vec<JsonValue> {
    let mut next: Vec<JsonValue> = current.to_vec();
    let index_by_key: std::collections::HashMap<String, usize> = next
        .iter()
        .enumerate()
        .map(|(i, e)| (workflow_run_entry_key(e), i))
        .collect();

    let mut index_by_key = index_by_key;
    for entry in incoming {
        let key = workflow_run_entry_key(entry);
        if let Some(&idx) = index_by_key.get(&key) {
            next[idx] = entry.clone();
        } else {
            index_by_key.insert(key, next.len());
            next.push(entry.clone());
        }
    }
    next
}

// ---------------------------------------------------------------------------
// jsonValueEqual — structural equality for JSON values
// ---------------------------------------------------------------------------

/// Structural equality for JSON values. Key order is irrelevant; `undefined`-valued keys
/// are treated as absent (matching `JSON.stringify` semantics on the wire).
#[allow(dead_code)]
pub fn json_value_equal(a: &JsonValue, b: &JsonValue) -> bool {
    match (a, b) {
        (JsonValue::Array(arr_a), JsonValue::Array(arr_b)) => {
            if arr_a.len() != arr_b.len() {
                return false;
            }
            arr_a
                .iter()
                .zip(arr_b.iter())
                .all(|(ea, eb)| json_value_equal(ea, eb))
        }
        (JsonValue::Object(obj_a), JsonValue::Object(obj_b)) => {
            let mut present = 0usize;
            for (key, val_a) in obj_a {
                if val_a.is_null() || val_a.is_string() && val_a.as_str() == Some("") {
                    // not absent — count
                }
                // A key present with value counts (even null; null is a wire value).
                present += 1;
                match obj_b.get(key) {
                    Some(val_b) => {
                        if !json_value_equal(val_a, val_b) {
                            return false;
                        }
                    }
                    None => return false,
                }
            }
            // b must not have extra non-absent keys
            let mut expected = 0usize;
            for _val_b in obj_b.values() {
                expected += 1;
            }
            present == expected
        }
        (JsonValue::Number(na), JsonValue::Number(nb)) => na == nb,
        _ => a == b,
    }
}

// ---------------------------------------------------------------------------
// canonical_workflow_run — public convenience wrapper
// ---------------------------------------------------------------------------

/// Rebuild a run object in canonical key order (schema declaration order first, extras appended).
#[allow(dead_code)]
pub fn canonical_workflow_run(run: &JsonValue) -> JsonValue {
    match run.as_object() {
        Some(map) => canonical_workflow_run_from_map(map),
        None => run.clone(),
    }
}

// ---------------------------------------------------------------------------
// merge_workflow_run_updates — merges two workflowRun.updated deltas for the same run
// ---------------------------------------------------------------------------

/// Merges two `workflowRun.updated` deltas for the same run. Later delta overwrites earlier
/// on header keys; cleared keys are unioned; entry tables are merged by key.
pub fn merge_workflow_run_updates(
    earlier: &JsonValue,
    later: &JsonValue,
) -> JsonValue {
    let earlier_run = earlier.get("run").cloned().unwrap_or(JsonValue::Object(Map::new()));
    let later_run = later.get("run").cloned().unwrap_or(JsonValue::Object(Map::new()));

    // Header: later.run overwrites earlier.run
    let mut run_map: Map<String, JsonValue> = if let Some(obj) = earlier_run.as_object() {
        obj.clone()
    } else {
        Map::new()
    };
    if let Some(later_obj) = later_run.as_object() {
        for (k, v) in later_obj {
            run_map.insert(k.clone(), v.clone());
        }
    }

    // Apply later.cleared: delete keys from merged run
    let later_cleared: Vec<String> = later
        .get("cleared")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    for key in &later_cleared {
        run_map.remove(key);
    }

    // Build cleared list: earlier.cleared keys that are still absent stay cleared;
    // then add later.cleared keys.
    let earlier_cleared: Vec<String> = earlier
        .get("cleared")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let mut cleared: Vec<String> = Vec::new();
    for key in &earlier_cleared {
        if !run_map.contains_key(key) && !cleared.contains(key) {
            cleared.push(key.clone());
        }
    }
    for key in &later_cleared {
        if !cleared.contains(key) {
            cleared.push(key.clone());
        }
    }

    // Merge removedActors/removedNodes: union, dedup by key
    let removed_actors = merge_removed_refs(
        earlier.get("removedActors"),
        later.get("removedActors"),
    );
    let removed_nodes = merge_removed_refs(
        earlier.get("removedNodes"),
        later.get("removedNodes"),
    );

    // Merge entry tables: later entries overwrite by key, new entries append
    let actors = merge_entry_lists(
        earlier.get("actors"),
        later.get("actors"),
        later.get("removedActors"),
    );
    let nodes = merge_entry_lists(
        earlier.get("nodes"),
        later.get("nodes"),
        later.get("removedNodes"),
    );

    let run_id = later.get("runId").cloned().unwrap_or(JsonValue::Null);
    let revision = std::cmp::max(
        earlier.get("revision").and_then(|r| r.as_i64()).unwrap_or(0),
        later.get("revision").and_then(|r| r.as_i64()).unwrap_or(0),
    );

    // Build result
    let mut result = Map::new();
    result.insert("op".to_string(), JsonValue::String("workflowRun.updated".to_string()));
    result.insert("runId".to_string(), run_id);
    result.insert("revision".to_string(), JsonValue::Number(revision.into()));

    if !run_map.is_empty() {
        result.insert("run".to_string(), JsonValue::Object(run_map));
    }
    if !cleared.is_empty() {
        result.insert(
            "cleared".to_string(),
            JsonValue::Array(cleared.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(ra) = removed_actors {
        result.insert("removedActors".to_string(), ra);
    }
    if let Some(rn) = removed_nodes {
        result.insert("removedNodes".to_string(), rn);
    }
    if let Some(a) = actors {
        result.insert("actors".to_string(), a);
    }
    if let Some(n) = nodes {
        result.insert("nodes".to_string(), n);
    }

    JsonValue::Object(result)
}

/// Union and dedup two sets of entry refs by (siteId, ordinal) key. Preserves first-occurrence order.
fn merge_removed_refs(
    earlier: Option<&JsonValue>,
    later: Option<&JsonValue>,
) -> Option<JsonValue> {
    let earlier_arr = earlier.and_then(|v| v.as_array()).map(|a| a.as_slice());
    let later_arr = later.and_then(|v| v.as_array()).map(|a| a.as_slice());

    match (earlier_arr, later_arr) {
        (None, None) => None,
        _ => {
            let mut merged: Vec<JsonValue> = Vec::new();
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for arr in [earlier_arr.unwrap_or(&[]), later_arr.unwrap_or(&[])] {
                for ref_entry in arr {
                    let key = workflow_run_entry_key(ref_entry);
                    if seen.insert(key) {
                        merged.push(ref_entry.clone());
                    }
                }
            }
            if merged.is_empty() {
                None
            } else {
                Some(JsonValue::Array(merged))
            }
        }
    }
}

/// Merge two entry lists by (siteId, ordinal) key. Later entries overwrite; order preserved by
/// first occurrence. Entries upserted by `earlier` that appear in `laterRemoved` are dropped.
fn merge_entry_lists(
    earlier: Option<&JsonValue>,
    later: Option<&JsonValue>,
    later_removed: Option<&JsonValue>,
) -> Option<JsonValue> {
    match (earlier, later) {
        (None, None) => None,
        _ => {
            let earlier_arr = earlier
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let later_arr = later
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            // Drop entries from earlier that appear in laterRemoved
            let dropped_keys: std::collections::HashSet<String> = later_removed
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().map(workflow_run_entry_key).collect())
                .unwrap_or_default();

            let kept: Vec<JsonValue> = if dropped_keys.is_empty() {
                earlier_arr
            } else {
                earlier_arr
                    .into_iter()
                    .filter(|e| !dropped_keys.contains(&workflow_run_entry_key(e)))
                    .collect()
            };

            let merged = upsert_workflow_run_entries(&kept, &later_arr);
            if merged.is_empty() {
                None
            } else {
                Some(JsonValue::Array(merged))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- appendToRow ----

    #[test]
    fn append_to_row_text_assistant() {
        let row = json!({"rowId": 1, "kind": "assistantText", "text": "Hello"});
        let result = append_to_row(&row, "text", " world").unwrap();
        assert_eq!(result["text"], "Hello world");
    }

    #[test]
    fn append_to_row_text_reasoning() {
        let row = json!({"rowId": 1, "kind": "reasoning", "text": "Think"});
        let result = append_to_row(&row, "text", " more").unwrap();
        assert_eq!(result["text"], "Think more");
    }

    #[test]
    fn append_to_row_text_wrong_kind_noop() {
        let row = json!({"rowId": 1, "kind": "userInput", "text": "Hello"});
        let result = append_to_row(&row, "text", " world").unwrap();
        assert_eq!(result["text"], "Hello");
    }

    #[test]
    fn append_to_row_input_text_tool_call() {
        let row = json!({"rowId": 1, "kind": "toolCall", "inputText": "cmd"});
        let result = append_to_row(&row, "inputText", " arg").unwrap();
        assert_eq!(result["inputText"], "cmd arg");
    }

    #[test]
    fn append_to_row_output_text_tool_call() {
        let row = json!({"rowId": 1, "kind": "toolCall", "output": {"text": "out"}});
        let result = append_to_row(&row, "output.text", " more").unwrap();
        assert_eq!(result["output"]["text"], "out more");
    }

    #[test]
    fn append_to_row_summary_text_subagent() {
        let row = json!({"rowId": 1, "kind": "subagent", "summaryText": "sum"});
        let result = append_to_row(&row, "summaryText", " mary").unwrap();
        assert_eq!(result["summaryText"], "sum mary");
    }

    // ---- row.appended ----

    #[test]
    fn row_appended_basic() {
        let snapshot = json!({
            "rows": {
                "window": [],
                "totalCount": 0,
                "firstRowId": null
            }
        });
        let delta = json!({
            "op": "row.appended",
            "row": {"rowId": 42, "kind": "userInput"}
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"][0]["rowId"], 42);
        assert_eq!(result["rows"]["totalCount"], 1);
        assert_eq!(result["rows"]["firstRowId"], 42);
    }

    #[test]
    fn row_appended_preserves_existing_first_row_id() {
        let snapshot = json!({
            "rows": {
                "window": [{"rowId": 10}],
                "totalCount": 1,
                "firstRowId": 10
            }
        });
        let delta = json!({
            "op": "row.appended",
            "row": {"rowId": 20, "kind": "assistantText"}
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"].as_array().unwrap().len(), 2);
        assert_eq!(result["rows"]["totalCount"], 2);
        assert_eq!(result["rows"]["firstRowId"], 10);
    }

    // ---- row.upserted ----

    #[test]
    fn row_upserted_found() {
        let snapshot = json!({
            "rows": {
                "window": [
                    {"rowId": 1, "kind": "userInput", "text": "old"},
                    {"rowId": 2, "kind": "assistantText", "text": "resp"}
                ],
                "totalCount": 2,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.upserted",
            "row": {"rowId": 1, "kind": "userInput", "text": "new"}
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"][0]["text"], "new");
        assert_eq!(result["rows"]["window"][1]["rowId"], 2);
    }

    #[test]
    fn row_upserted_not_found_noop() {
        let snapshot = json!({
            "rows": {
                "window": [{"rowId": 1}],
                "totalCount": 1,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.upserted",
            "row": {"rowId": 99, "kind": "assistantText"}
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        // No change
        assert_eq!(result["rows"]["window"][0]["rowId"], 1);
    }

    // ---- row.removed ----

    #[test]
    fn row_removed_partial() {
        let snapshot = json!({
            "rows": {
                "window": [
                    {"rowId": 1},
                    {"rowId": 2},
                    {"rowId": 3},
                    {"rowId": 4}
                ],
                "totalCount": 10,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.removed",
            "fromRowId": 3
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        let window = result["rows"]["window"].as_array().unwrap();
        assert_eq!(window.len(), 2);
        assert_eq!(window[0]["rowId"], 1);
        assert_eq!(window[1]["rowId"], 2);
        assert_eq!(result["rows"]["totalCount"], 8);
        assert_eq!(result["rows"]["firstRowId"], 1);
    }

    #[test]
    fn row_removed_entire_active_branch() {
        let snapshot = json!({
            "rows": {
                "window": [
                    {"rowId": 5},
                    {"rowId": 6}
                ],
                "totalCount": 10,
                "firstRowId": 5
            }
        });
        let delta = json!({
            "op": "row.removed",
            "fromRowId": 5
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"].as_array().unwrap().len(), 0);
        assert_eq!(result["rows"]["totalCount"], 0);
        assert!(result["rows"]["firstRowId"].is_null());
    }

    // ---- row.delta ----

    #[test]
    fn row_delta_streaming_text() {
        let snapshot = json!({
            "rows": {
                "window": [
                    {"rowId": 1, "kind": "assistantText", "text": "Hello"}
                ],
                "totalCount": 1,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.delta",
            "rowId": 1,
            "path": "text",
            "append": " world"
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"][0]["text"], "Hello world");
    }

    #[test]
    fn row_delta_streaming_input_text() {
        let snapshot = json!({
            "rows": {
                "window": [
                    {"rowId": 1, "kind": "toolCall", "inputText": "cmd"}
                ],
                "totalCount": 1,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.delta",
            "rowId": 1,
            "path": "inputText",
            "append": " arg"
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"][0]["inputText"], "cmd arg");
    }

    #[test]
    fn row_delta_streaming_output_text() {
        let snapshot = json!({
            "rows": {
                "window": [
                    {"rowId": 1, "kind": "toolCall", "output": {"text": "out"}}
                ],
                "totalCount": 1,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.delta",
            "rowId": 1,
            "path": "output.text",
            "append": " put"
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"][0]["output"]["text"], "out put");
    }

    #[test]
    fn row_delta_not_found_noop() {
        let snapshot = json!({
            "rows": {
                "window": [{"rowId": 1, "kind": "assistantText", "text": "old"}],
                "totalCount": 1,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.delta",
            "rowId": 99,
            "path": "text",
            "append": " new"
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"][0]["text"], "old");
    }

    // ---- state.updated ----

    #[test]
    fn state_updated_key_replacement() {
        let snapshot = json!({
            "rows": {"window": [], "totalCount": 0, "firstRowId": null},
            "control": {"mode": "idle"}
        });
        let delta = json!({
            "op": "state.updated",
            "patch": {
                "control": {"mode": "active"},
                "usage": {"tokens": 100}
            }
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["control"]["mode"], "active");
        assert_eq!(result["usage"]["tokens"], 100);
        // rows untouched
        assert_eq!(result["rows"]["totalCount"], 0);
    }

    // ---- applyConversationDeltas ----

    #[test]
    fn apply_deltas_sequential() {
        let snapshot = json!({
            "rows": {"window": [], "totalCount": 0, "firstRowId": null}
        });
        let deltas = vec![
            json!({"op": "row.appended", "row": {"rowId": 1, "kind": "userInput"}}),
            json!({"op": "row.appended", "row": {"rowId": 2, "kind": "assistantText", "text": ""}}),
            json!({"op": "row.delta", "rowId": 2, "path": "text", "append": "Hi"}),
        ];
        let result = apply_conversation_deltas(&snapshot, &deltas).unwrap();
        assert_eq!(result["rows"]["window"].as_array().unwrap().len(), 2);
        assert_eq!(result["rows"]["totalCount"], 2);
        assert_eq!(result["rows"]["window"][1]["text"], "Hi");
    }

    // ---- Invalid op ----

    #[test]
    fn invalid_op_returns_error() {
        let snapshot = json!({"rows": {"window": [], "totalCount": 0, "firstRowId": null}});
        let delta = json!({"op": "bogus"});
        let result = apply_conversation_delta(&snapshot, &delta);
        assert!(result.is_err());
    }

    // ---- merge_older_rows ----

    #[test]
    fn merge_older_rows_basic() {
        let window = vec![json!({"rowId": 5}), json!({"rowId": 6})];
        let fetched = vec![
            json!({"rowId": 1}),
            json!({"rowId": 3}),
            json!({"rowId": 7}),
        ];
        let merged = merge_older_rows(&window, &fetched).unwrap().unwrap();
        assert_eq!(merged.len(), 4);
        assert_eq!(merged[0]["rowId"], 1);
        assert_eq!(merged[1]["rowId"], 3);
        assert_eq!(merged[2]["rowId"], 5);
        assert_eq!(merged[3]["rowId"], 6);
    }

    #[test]
    fn merge_older_rows_none_when_empty() {
        let window = vec![json!({"rowId": 1})];
        let fetched = vec![json!({"rowId": 2}), json!({"rowId": 3})];
        let result = merge_older_rows(&window, &fetched).unwrap();
        assert!(result.is_none());
    }

    // ---- workflowRun.removed ----

    #[test]
    fn workflow_run_removed_basic() {
        let snapshot = json!({
            "workflowRuns": {
                "revision": 5,
                "runs": [
                    {"runId": "a", "status": "running"},
                    {"runId": "b", "status": "completed"},
                    {"runId": "c", "status": "running"}
                ]
            }
        });
        let delta = json!({
            "op": "workflowRun.removed",
            "runId": "b",
            "revision": 6
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        let runs = result["workflowRuns"]["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["runId"], "a");
        assert_eq!(runs[1]["runId"], "c");
        assert_eq!(result["workflowRuns"]["revision"], 6);
    }

    #[test]
    fn workflow_run_removed_unknown_noop_revision_bumps() {
        let snapshot = json!({
            "workflowRuns": {
                "revision": 5,
                "runs": [{"runId": "a"}]
            }
        });
        let delta = json!({
            "op": "workflowRun.removed",
            "runId": "nonexistent",
            "revision": 10
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["workflowRuns"]["runs"].as_array().unwrap().len(), 1);
        assert_eq!(result["workflowRuns"]["revision"], 10);
    }

    // ---- workflowRun.updated ----

    #[test]
    fn workflow_run_updated_existing_run() {
        let snapshot = json!({
            "workflowRuns": {
                "revision": 3,
                "runs": [
                    {"runId": "a", "status": "running", "actors": [], "nodes": [], "lastEventSequence": 0}
                ]
            }
        });
        let delta = json!({
            "op": "workflowRun.updated",
            "runId": "a",
            "revision": 4,
            "run": {"status": "completed"},
            "actors": [],
            "nodes": []
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        let run = &result["workflowRuns"]["runs"][0];
        assert_eq!(run["status"], "completed");
        assert_eq!(run["runId"], "a");
        assert_eq!(result["workflowRuns"]["revision"], 4);
    }

    #[test]
    fn workflow_run_updated_birth() {
        let snapshot = json!({
            "workflowRuns": {
                "revision": 1,
                "runs": []
            }
        });
        let delta = json!({
            "op": "workflowRun.updated",
            "runId": "new-run",
            "revision": 2,
            "run": {
                "runId": "new-run",
                "status": "running",
                "usage": {},
                "actors": [],
                "nodes": [],
                "lastEventSequence": 0
            },
            "actors": [],
            "nodes": []
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        let runs = result["workflowRuns"]["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["runId"], "new-run");
        assert_eq!(runs[0]["status"], "running");
    }

    #[test]
    fn workflow_run_updated_incomplete_header_noop() {
        let snapshot = json!({
            "workflowRuns": {
                "revision": 1,
                "runs": []
            }
        });
        // Missing required keys (status, usage, actors, nodes, lastEventSequence)
        let delta = json!({
            "op": "workflowRun.updated",
            "runId": "partial",
            "revision": 2,
            "run": {"runId": "partial"}
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        // Runs unchanged, only revision bumped
        assert_eq!(result["workflowRuns"]["runs"].as_array().unwrap().len(), 0);
        assert_eq!(result["workflowRuns"]["revision"], 2);
    }

    // ---- Canonical key ordering ----

    #[test]
    fn canonical_workflow_run_preserves_all_keys() {
        let run = json!({
            "lastEventSequence": 10,
            "status": "running",
            "nodes": [],
            "actors": [],
            "runId": "r1",
            "usage": {},
            "extraField": "preserved"
        });
        let result = canonical_workflow_run_from_map(run.as_object().unwrap());
        // All keys from input must be present in output with correct values
        let obj = result.as_object().unwrap();
        assert_eq!(obj["runId"], "r1");
        assert_eq!(obj["status"], "running");
        assert_eq!(obj["actors"], json!([]));
        assert_eq!(obj["nodes"], json!([]));
        assert_eq!(obj["usage"], json!({}));
        assert_eq!(obj["lastEventSequence"], 10);
        assert_eq!(obj["extraField"], "preserved");
        assert_eq!(obj.len(), 7);
    }

    #[test]
    fn canonical_workflow_run_schema_keys_first() {
        // Verify that schema-defined keys appear before unknown keys when serialized
        // via a custom serializer that respects insertion order.
        let run = json!({
            "z_extra": "after",
            "runId": "r1",
            "status": "running",
            "usage": {},
            "actors": [],
            "nodes": [],
            "lastEventSequence": 0
        });
        let result = canonical_workflow_run_from_map(run.as_object().unwrap());
        // Schema keys that are present should all exist
        let obj = result.as_object().unwrap();
        assert!(obj.contains_key("runId"));
        assert!(obj.contains_key("status"));
        assert!(obj.contains_key("usage"));
        assert!(obj.contains_key("actors"));
        assert!(obj.contains_key("nodes"));
        assert!(obj.contains_key("lastEventSequence"));
        // Extra key preserved
        assert_eq!(obj["z_extra"], "after");
    }

    // ---- row.delta on summaryText (subagent) ----

    #[test]
    fn row_delta_summary_text_subagent() {
        let snapshot = json!({
            "rows": {
                "window": [
                    {"rowId": 1, "kind": "subagent", "summaryText": "Initial"}
                ],
                "totalCount": 1,
                "firstRowId": 1
            }
        });
        let delta = json!({
            "op": "row.delta",
            "rowId": 1,
            "path": "summaryText",
            "append": " summary"
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        assert_eq!(result["rows"]["window"][0]["summaryText"], "Initial summary");
    }

    // ---- state.updated does not deeply merge ----

    #[test]
    fn state_updated_replaces_not_deep_merges() {
        let snapshot = json!({
            "control": {"mode": "idle", "nested": {"a": 1}}
        });
        let delta = json!({
            "op": "state.updated",
            "patch": {"control": {"mode": "active"}}
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        // control is replaced entirely (no "nested" preserved)
        assert_eq!(result["control"]["mode"], "active");
        assert!(result["control"]["nested"].is_null());
    }

    // ---- jsonValueEqual ----

    #[test]
    fn json_value_equal_primitives() {
        assert!(json_value_equal(&json!("hello"), &json!("hello")));
        assert!(!json_value_equal(&json!("hello"), &json!("world")));
        assert!(json_value_equal(&json!(42), &json!(42)));
        assert!(!json_value_equal(&json!(42), &json!(43)));
        assert!(json_value_equal(&json!(null), &json!(null)));
        assert!(!json_value_equal(&json!(null), &json!(42)));
    }

    #[test]
    fn json_value_equal_arrays() {
        assert!(json_value_equal(&json!([1, 2, 3]), &json!([1, 2, 3])));
        assert!(!json_value_equal(&json!([1, 2, 3]), &json!([1, 2])));
        assert!(!json_value_equal(&json!([1, 2, 3]), &json!([1, 2, 4])));
        assert!(json_value_equal(&json!([]), &json!([])));
    }

    #[test]
    fn json_value_equal_objects_key_order_irrelevant() {
        assert!(json_value_equal(
            &json!({"a": 1, "b": 2}),
            &json!({"b": 2, "a": 1})
        ));
        assert!(!json_value_equal(
            &json!({"a": 1, "b": 2}),
            &json!({"a": 1, "b": 3})
        ));
        assert!(!json_value_equal(
            &json!({"a": 1}),
            &json!({"a": 1, "b": 2})
        ));
    }

    #[test]
    fn json_value_equal_nested() {
        assert!(json_value_equal(
            &json!({"a": [1, {"x": true}], "b": null}),
            &json!({"b": null, "a": [1, {"x": true}]})
        ));
    }

    // ---- canonical_workflow_run ----

    #[test]
    fn canonical_workflow_run_reorders_keys() {
        let run = json!({
            "lastEventSequence": 10,
            "status": "running",
            "nodes": [],
            "actors": [],
            "runId": "r1",
            "usage": {},
            "extraField": "preserved"
        });
        let result = canonical_workflow_run(&run);
        // All schema-defined keys present
        let obj = result.as_object().unwrap();
        assert!(obj.contains_key("runId"));
        assert!(obj.contains_key("status"));
        assert!(obj.contains_key("actors"));
        assert!(obj.contains_key("nodes"));
        assert!(obj.contains_key("usage"));
        assert!(obj.contains_key("lastEventSequence"));
        // Extra key preserved
        assert!(obj.contains_key("extraField"));
        // All values preserved
        assert_eq!(obj["runId"], "r1");
        assert_eq!(obj["status"], "running");
        assert_eq!(obj["extraField"], "preserved");
        // Total count correct
        assert_eq!(obj.len(), 7);
    }

    #[test]
    fn canonical_workflow_run_non_object_passthrough() {
        let val = json!("not an object");
        assert_eq!(canonical_workflow_run(&val), val);
    }

    // ---- merge_workflow_run_updates ----

    #[test]
    fn merge_workflow_run_updates_later_overwrites_header() {
        let earlier = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 3,
            "run": {"status": "running", "stopReason": null}
        });
        let later = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 5,
            "run": {"status": "completed"}
        });
        let merged = merge_workflow_run_updates(&earlier, &later);
        assert_eq!(merged["runId"], "r1");
        assert_eq!(merged["revision"], 5);
        assert_eq!(merged["run"]["status"], "completed");
        // stopReason from earlier is preserved (later didn't set it)
        assert!(merged["run"]["stopReason"].is_null());
    }

    #[test]
    fn merge_workflow_run_updates_cleared_keys() {
        let earlier = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 1,
            "run": {"status": "running", "error": "oops"},
            "cleared": ["resumable"]
        });
        let later = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 2,
            "run": {"status": "completed"},
            "cleared": ["error"]
        });
        let merged = merge_workflow_run_updates(&earlier, &later);
        let run = merged["run"].as_object().unwrap();
        assert_eq!(run["status"], "completed");
        // "error" was cleared by later
        assert!(!run.contains_key("error"));
        // "resumable" was cleared by earlier and not re-set by later, so stays cleared
        let cleared = merged["cleared"].as_array().unwrap();
        let cleared_keys: Vec<&str> = cleared.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(cleared_keys.contains(&"resumable"));
        assert!(cleared_keys.contains(&"error"));
    }

    #[test]
    fn merge_workflow_run_updates_cleared_overrides_earlier_set() {
        // Earlier sets a key, later clears it — the cleared should win
        let earlier = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 1,
            "run": {"status": "running"}
        });
        let later = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 2,
            "cleared": ["status"]
        });
        let merged = merge_workflow_run_updates(&earlier, &later);
        // status was set by earlier.run, but cleared by later.cleared → removed from run
        let run_obj = merged.get("run").and_then(|v| v.as_object());
        match run_obj {
            Some(obj) => assert!(!obj.contains_key("status")),
            None => {} // "run" key omitted entirely when empty — correct
        }
        // "status" should appear in the cleared list
        let cleared = merged["cleared"].as_array().unwrap();
        let cleared_keys: Vec<&str> = cleared.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(cleared_keys.contains(&"status"));
    }

    #[test]
    fn merge_workflow_run_updates_entry_tables() {
        let earlier = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 1,
            "actors": [
                {"siteId": "s1", "ordinal": 1, "role": "user"},
                {"siteId": "s1", "ordinal": 2, "role": "agent"}
            ]
        });
        let later = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 2,
            "actors": [
                {"siteId": "s1", "ordinal": 2, "role": "agent-updated"},
                {"siteId": "s2", "ordinal": 1, "role": "user"}
            ]
        });
        let merged = merge_workflow_run_updates(&earlier, &later);
        let actors = merged["actors"].as_array().unwrap();
        // s1:1 from earlier preserved, s1:2 overwritten by later, s2:1 appended
        assert_eq!(actors.len(), 3);
        assert_eq!(actors[0]["siteId"], "s1");
        assert_eq!(actors[0]["ordinal"], 1);
        assert_eq!(actors[0]["role"], "user");
        assert_eq!(actors[1]["siteId"], "s1");
        assert_eq!(actors[1]["ordinal"], 2);
        assert_eq!(actors[1]["role"], "agent-updated");
        assert_eq!(actors[2]["siteId"], "s2");
        assert_eq!(actors[2]["ordinal"], 1);
    }

    #[test]
    fn merge_workflow_run_updates_removed_entries() {
        let earlier = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 1,
            "actors": [
                {"siteId": "s1", "ordinal": 1, "role": "user"},
                {"siteId": "s1", "ordinal": 2, "role": "agent"}
            ],
            "removedActors": [{"siteId": "s1", "ordinal": 3}]
        });
        let later = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 2,
            "removedActors": [{"siteId": "s1", "ordinal": 1}]
        });
        let merged = merge_workflow_run_updates(&earlier, &later);
        // removedActors should be unioned
        let removed = merged["removedActors"].as_array().unwrap();
        let keys: Vec<&str> = removed.iter().map(|v| {
            v["siteId"].as_str().unwrap()
        }).collect();
        assert!(keys.contains(&"s1"));
        assert_eq!(removed.len(), 2); // s1:3 + s1:1

        // actors: s1:1 removed by later, s1:2 kept
        let actors = merged["actors"].as_array().unwrap();
        assert_eq!(actors.len(), 1);
        assert_eq!(actors[0]["ordinal"], 2);
    }

    #[test]
    fn merge_workflow_run_updates_revision_is_max() {
        let earlier = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 10,
            "run": {"status": "running"}
        });
        let later = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 5,
            "run": {"status": "completed"}
        });
        let merged = merge_workflow_run_updates(&earlier, &later);
        assert_eq!(merged["revision"], 10);
    }

    #[test]
    fn merge_workflow_run_updates_no_entry_tables_returns_none() {
        let earlier = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 1,
            "run": {"status": "running"}
        });
        let later = json!({
            "op": "workflowRun.updated",
            "runId": "r1",
            "revision": 2,
            "run": {"status": "completed"}
        });
        let merged = merge_workflow_run_updates(&earlier, &later);
        // No actors/nodes → key should be absent
        assert!(merged.get("actors").is_none());
        assert!(merged.get("nodes").is_none());
    }

    // ---- merge_removed_refs ----

    #[test]
    fn merge_removed_refs_both_none() {
        assert!(merge_removed_refs(None, None).is_none());
    }

    #[test]
    fn merge_removed_refs_dedup() {
        let earlier = json!([{"siteId": "s1", "ordinal": 1}]);
        let later = json!([{"siteId": "s1", "ordinal": 1}, {"siteId": "s2", "ordinal": 2}]);
        let merged = merge_removed_refs(Some(&earlier), Some(&later)).unwrap();
        let arr = merged.as_array().unwrap();
        assert_eq!(arr.len(), 2); // deduped by key
    }

    // ---- merge_entry_lists ----

    #[test]
    fn merge_entry_lists_both_none() {
        assert!(merge_entry_lists(None, None, None).is_none());
    }

    #[test]
    fn merge_entry_lists_later_wins() {
        let earlier = json!([
            {"siteId": "s1", "ordinal": 1, "v": "old"},
            {"siteId": "s1", "ordinal": 2, "v": "keep"}
        ]);
        let later = json!([
            {"siteId": "s1", "ordinal": 1, "v": "new"}
        ]);
        let merged = merge_entry_lists(Some(&earlier), Some(&later), None).unwrap();
        let arr = merged.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["v"], "new"); // overwritten
        assert_eq!(arr[1]["v"], "keep"); // preserved from earlier
    }

    #[test]
    fn merge_entry_lists_drops_earlier_when_later_removed() {
        let earlier = json!([
            {"siteId": "s1", "ordinal": 1, "v": "old"},
            {"siteId": "s1", "ordinal": 2, "v": "keep"}
        ]);
        let later_removed = json!([{"siteId": "s1", "ordinal": 1}]);
        let merged = merge_entry_lists(Some(&earlier), None, Some(&later_removed)).unwrap();
        let arr = merged.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["ordinal"], 2);
    }

    #[test]
    fn merge_entry_lists_later_re_adds_dropped_key() {
        // earlier has s1:1, later removes s1:1 then re-adds it
        let earlier = json!([
            {"siteId": "s1", "ordinal": 1, "v": "old"}
        ]);
        let later = json!([
            {"siteId": "s1", "ordinal": 1, "v": "reborn"}
        ]);
        let later_removed = json!([{"siteId": "s1", "ordinal": 1}]);
        let merged = merge_entry_lists(Some(&earlier), Some(&later), Some(&later_removed)).unwrap();
        let arr = merged.as_array().unwrap();
        // s1:1 is dropped from earlier, then re-added by later → appears at tail
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["v"], "reborn");
    }

    // ---- workflow_run_entry_key (entry-based) ----

    #[test]
    fn workflow_run_entry_key_from_entry() {
        let entry = json!({"siteId": "abc", "ordinal": 42});
        assert_eq!(workflow_run_entry_key(&entry), "abc\042");
    }

    #[test]
    fn workflow_run_entry_key_no_site_id() {
        let entry = json!({"ordinal": 1});
        assert_eq!(workflow_run_entry_key(&entry), "\01");
    }

    // ---- apply_workflow_run_updated: edge cases ----

    #[test]
    fn workflow_run_updated_cleared_keys() {
        let snapshot = json!({
            "workflowRuns": {
                "revision": 3,
                "runs": [
                    {"runId": "a", "status": "running", "error": "oops", "actors": [], "nodes": [], "lastEventSequence": 0}
                ]
            }
        });
        let delta = json!({
            "op": "workflowRun.updated",
            "runId": "a",
            "revision": 4,
            "run": {"status": "completed"},
            "cleared": ["error"]
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        let run = &result["workflowRuns"]["runs"][0];
        assert_eq!(run["status"], "completed");
        assert!(!run.as_object().unwrap().contains_key("error"));
    }

    #[test]
    fn workflow_run_updated_remove_and_upsert_actors() {
        let snapshot = json!({
            "workflowRuns": {
                "revision": 1,
                "runs": [
                    {
                        "runId": "a",
                        "status": "running",
                        "actors": [
                            {"siteId": "s1", "ordinal": 1, "role": "user"},
                            {"siteId": "s1", "ordinal": 2, "role": "agent"}
                        ],
                        "nodes": [],
                        "lastEventSequence": 0
                    }
                ]
            }
        });
        let delta = json!({
            "op": "workflowRun.updated",
            "runId": "a",
            "revision": 2,
            "removedActors": [{"siteId": "s1", "ordinal": 1}],
            "actors": [{"siteId": "s2", "ordinal": 1, "role": "observer"}]
        });
        let result = apply_conversation_delta(&snapshot, &delta).unwrap();
        let actors = result["workflowRuns"]["runs"][0]["actors"].as_array().unwrap();
        // s1:1 removed, s1:2 kept, s2:1 upserted (appended)
        assert_eq!(actors.len(), 2);
        assert_eq!(actors[0]["siteId"], "s1");
        assert_eq!(actors[0]["ordinal"], 2);
        assert_eq!(actors[1]["siteId"], "s2");
        assert_eq!(actors[1]["ordinal"], 1);
    }
}
