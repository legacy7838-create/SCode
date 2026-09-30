use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};

#[derive(Debug)]
pub enum CoalesceError {
    Json(serde_json::Error),
}

impl std::fmt::Display for CoalesceError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Json(e) => write!(f, "json: {e}"),
        }
    }
}

impl std::error::Error for CoalesceError {}

impl From<serde_json::Error> for CoalesceError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

// ── helpers ──

fn get_op(delta: &JsonValue) -> &str {
    delta["op"].as_str().unwrap_or("")
}

/// Rule 4: `row.removed` is a barrier that no rule can cross.
fn is_barrier(delta: &JsonValue) -> bool {
    get_op(delta) == "row.removed"
}

/// The barriers for rule 6: wherever `workflowRuns` is replaced wholesale
/// (`state.updated` carrying that key), plus `workflowRun.removed` for the **same** run.
fn is_workflow_run_barrier(delta: &JsonValue, run_id: &str) -> bool {
    if get_op(delta) == "state.updated" {
        return delta["patch"]["workflowRuns"].is_object();
    }
    get_op(delta) == "workflowRun.removed" && delta["runId"].as_str() == Some(run_id)
}

/// Default wire bounds matching `WORKFLOW_RUNS_LIMITS` from workflow-runs.ts.
const DEFAULT_MAX_ACTORS: usize = 1024;
const DEFAULT_MAX_NODES: usize = 1024;

/// Check whether a `workflowRun.updated` payload is within wire bounds.
/// Merging is an optimization; refusing to merge is always safe.
fn workflow_run_update_within_wire_bounds(delta: &JsonValue) -> bool {
    let actor_len = delta["actors"]
        .as_array()
        .map_or(0, |a| a.len());
    let removed_actors_len = delta["removedActors"]
        .as_array()
        .map_or(0, |a| a.len());
    let node_len = delta["nodes"]
        .as_array()
        .map_or(0, |a| a.len());
    let removed_nodes_len = delta["removedNodes"]
        .as_array()
        .map_or(0, |a| a.len());
    actor_len <= DEFAULT_MAX_ACTORS
        && removed_actors_len <= DEFAULT_MAX_ACTORS
        && node_len <= DEFAULT_MAX_NODES
        && removed_nodes_len <= DEFAULT_MAX_NODES
}

/// Dedup key for an entry ref: `(siteId, ordinal)`.
fn entry_key(entry: &JsonValue) -> String {
    format!(
        "{}\0{}",
        entry["siteId"].as_str().unwrap_or(""),
        entry["ordinal"].as_i64().unwrap_or(0)
    )
}

// ── core function ──

/// Semantics-preserving conflation of a delta sequence within one flush window.
/// Input and output are both in authoritative log order; pure function, does not mutate its arguments.
pub fn coalesce_conversation_deltas(
    deltas: &[JsonValue],
) -> Result<Vec<JsonValue>, CoalesceError> {
    let mut result: Vec<JsonValue> = Vec::new();

    for delta in deltas {
        let op = get_op(delta);

        // ── Rule 3: row.upserted swallows earlier row.delta with the same rowId ──
        // Backtrack to the nearest barrier; do not cross a previous upserted/appended
        // with the same rowId (crossing it would swallow the "previous generation").
        if op == "row.upserted" {
            let row_id = delta["row"]["rowId"].as_i64();
            if let Some(rid) = row_id {
                let mut i = result.len();
                while i > 0 {
                    i -= 1;
                    let prev = &result[i];
                    if is_barrier(prev) {
                        break;
                    }
                    if get_op(prev) == "row.delta" && prev["rowId"].as_i64() == Some(rid) {
                        result.remove(i);
                        continue;
                    }
                    let prev_op = get_op(prev);
                    if (prev_op == "row.upserted" || prev_op == "row.appended")
                        && prev["row"]["rowId"].as_i64() == Some(rid)
                    {
                        break;
                    }
                }
            }
        }

        // ── Rule 5: workflowRun.removed swallows earlier workflowRun.updated with same runId ──
        // Equivalent to birth + elimination in the same window = client has never seen this run.
        if op == "workflowRun.removed" {
            let run_id = delta["runId"].as_str().unwrap_or("");
            let mut i = result.len();
            while i > 0 {
                i -= 1;
                let prev = &result[i];
                if is_workflow_run_barrier(prev, run_id) {
                    break;
                }
                if get_op(prev) == "workflowRun.updated"
                    && prev["runId"].as_str() == Some(run_id)
                {
                    result.remove(i);
                }
            }
        }

        // ── Rule 6: workflowRun.updated merges into last same-runId update ──
        if op == "workflowRun.updated" {
            if merge_workflow_run_update(&mut result, delta) {
                continue;
            }
        }

        let last = result.last();

        // ── Rule 1: Adjacent row.delta with same (rowId, path) → merge append ──
        if op == "row.delta" {
            if let Some(prev) = last {
                if get_op(prev) == "row.delta"
                    && prev["rowId"].as_i64() == delta["rowId"].as_i64()
                    && prev["path"].as_str() == delta["path"].as_str()
                {
                    let prev_append = prev["append"].as_str().unwrap_or("");
                    let cur_append = delta["append"].as_str().unwrap_or("");
                    let mut merged = prev.clone();
                    if let Some(obj) = merged.as_object_mut() {
                        obj.insert(
                            "append".to_string(),
                            JsonValue::String(format!("{prev_append}{cur_append}")),
                        );
                    }
                    *result.last_mut().unwrap() = merged;
                    continue;
                }
            }
        }

        // ── Rule 2: Adjacent state.updated → merge patch keys (later overwrites former) ──
        if op == "state.updated" {
            if let Some(prev) = last {
                if get_op(prev) == "state.updated" {
                    let mut merged = prev.clone();
                    if let (Some(merged_obj), Some(patch)) =
                        (merged.as_object_mut(), delta["patch"].as_object())
                    {
                        if let Some(merged_patch) =
                            merged_obj.get_mut("patch").and_then(|p| p.as_object_mut())
                        {
                            for (key, value) in patch {
                                merged_patch.insert(key.clone(), value.clone());
                            }
                        }
                    }
                    *result.last_mut().unwrap() = merged;
                    continue;
                }
            }
        }

        // ── Adjacent row.upserted with same rowId → keep last (transitive of whole row replacement) ──
        if op == "row.upserted" {
            if let Some(prev) = last {
                if get_op(prev) == "row.upserted"
                    && prev["row"]["rowId"].as_i64() == delta["row"]["rowId"].as_i64()
                {
                    *result.last_mut().unwrap() = delta.clone();
                    continue;
                }
            }
        }

        result.push(delta.clone());
    }

    Ok(result)
}

// ── Rule 6 helpers ──

/// Rule 6: fold a `workflowRun.updated` into the **last** delta with the same runId in the window.
/// Returns true when the delta was merged (the caller should skip pushing it).
fn merge_workflow_run_update(result: &mut Vec<JsonValue>, delta: &JsonValue) -> bool {
    let run_id = delta["runId"].as_str().unwrap_or("");

    // Find the last matching workflowRun.updated (nearest to end, same runId), stopping at barriers.
    let mut target_idx: Option<usize> = None;
    let mut i = result.len();
    while i > 0 {
        i -= 1;
        let prev = &result[i];
        if is_workflow_run_barrier(prev, run_id) {
            break;
        }
        if get_op(prev) == "workflowRun.updated" && prev["runId"].as_str() == Some(run_id) {
            target_idx = Some(i);
            break;
        }
    }

    let idx = match target_idx {
        Some(i) => i,
        None => return false,
    };

    let merged = merge_workflow_run_updates(&result[idx], delta);
    // When rejected (over wire bounds), don't try the earlier line again:
    // that would delete the line in the middle.
    if !workflow_run_update_within_wire_bounds(&merged) {
        return false;
    }
    result[idx] = merged;
    true
}

/// Merges two `workflowRun.updated` ops for the same run.
/// (The payload half of coalesce rule 6; the rule itself lives above.)
fn merge_workflow_run_updates(earlier: &JsonValue, later: &JsonValue) -> JsonValue {
    // Merge header keys: later overwrites earlier.
    let mut run: serde_json::Map<String, JsonValue> = if let Some(earlier_run) =
        earlier["run"].as_object()
    {
        earlier_run.clone()
    } else {
        serde_json::Map::new()
    };
    if let Some(later_run) = later["run"].as_object() {
        for (key, value) in later_run {
            run.insert(key.clone(), value.clone());
        }
    }

    // The header key and `cleared` cancel each other: the post-set value key is no longer
    // "cleared", keys cleared later no longer have a value.
    let later_cleared: Vec<String> = later["cleared"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    for key in &later_cleared {
        run.remove(key);
    }

    // Build merged cleared list.
    let mut cleared: Vec<String> = Vec::new();
    for key in earlier["cleared"]
        .as_array()
        .map(|a| a.iter())
        .into_iter()
        .flatten()
    {
        if let Some(k) = key.as_str() {
            if run.get(k).is_none() && !cleared.contains(&k.to_string()) {
                cleared.push(k.to_string());
            }
        }
    }
    for key in &later_cleared {
        if !cleared.contains(key) {
            cleared.push(key.clone());
        }
    }

    // Merge removedActors/removedNodes (union, dedup by first occurrence).
    let removed_actors = merge_removed_refs(
        earlier["removedActors"].as_array(),
        later["removedActors"].as_array(),
    );
    let removed_nodes = merge_removed_refs(
        earlier["removedNodes"].as_array(),
        later["removedNodes"].as_array(),
    );

    // Merge actors/nodes entry lists: later wins per key, order preserved by first occurrence.
    let actors = merge_entry_lists(
        earlier["actors"].as_array(),
        later["actors"].as_array(),
        later["removedActors"].as_array(),
    );
    let nodes = merge_entry_lists(
        earlier["nodes"].as_array(),
        later["nodes"].as_array(),
        later["removedNodes"].as_array(),
    );

    // Build result.
    let mut result = serde_json::Map::new();
    result.insert(
        "op".to_string(),
        JsonValue::String("workflowRun.updated".to_string()),
    );
    result.insert("runId".to_string(), later["runId"].clone());
    result.insert(
        "revision".to_string(),
        JsonValue::Number(
            std::cmp::max(
                earlier["revision"].as_i64().unwrap_or(0),
                later["revision"].as_i64().unwrap_or(0),
            )
            .into(),
        ),
    );
    if !run.is_empty() {
        result.insert("run".to_string(), JsonValue::Object(run));
    }
    if !cleared.is_empty() {
        result.insert(
            "cleared".to_string(),
            JsonValue::Array(cleared.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(arr) = removed_actors {
        result.insert("removedActors".to_string(), JsonValue::Array(arr));
    }
    if let Some(arr) = removed_nodes {
        result.insert("removedNodes".to_string(), JsonValue::Array(arr));
    }
    if let Some(arr) = actors {
        result.insert("actors".to_string(), JsonValue::Array(arr));
    }
    if let Some(arr) = nodes {
        result.insert("nodes".to_string(), JsonValue::Array(arr));
    }

    JsonValue::Object(result)
}

/// The removals of both sides are unioned and deduped by first occurrence.
fn merge_removed_refs(
    earlier: Option<&Vec<JsonValue>>,
    later: Option<&Vec<JsonValue>>,
) -> Option<Vec<JsonValue>> {
    let empty = Vec::new();
    let earlier_refs = earlier.unwrap_or(&empty);
    let later_refs = later.unwrap_or(&empty);
    if earlier_refs.is_empty() && later_refs.is_empty() {
        return None;
    }
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for ref_val in earlier_refs.iter().chain(later_refs.iter()) {
        let k = entry_key(ref_val);
        if seen.insert(k) {
            merged.push(ref_val.clone());
        }
    }
    Some(merged)
}

/// Entry tables: later wins per key, order preserved by first occurrence; when neither side has
/// entries it returns None (the key is not created).
///
/// Every key the earlier side upserts that the later side removed is dropped: when applied
/// in order it enters the table and is then taken away again, so the merged op should not
/// contain it at all.
fn merge_entry_lists(
    earlier: Option<&Vec<JsonValue>>,
    later: Option<&Vec<JsonValue>>,
    later_removed: Option<&Vec<JsonValue>>,
) -> Option<Vec<JsonValue>> {
    let empty = Vec::new();
    let earlier_entries = earlier.unwrap_or(&empty);
    let later_entries = later.unwrap_or(&empty);
    if earlier_entries.is_empty() && later_entries.is_empty() {
        return None;
    }

    let dropped: HashSet<String> = later_removed
        .unwrap_or(&empty)
        .iter()
        .map(|r| entry_key(r))
        .collect();

    let kept: Vec<JsonValue> = earlier_entries
        .iter()
        .filter(|e| !dropped.contains(&entry_key(e)))
        .cloned()
        .collect();

    // Upsert: later entries overwrite by key, new entries append.
    let mut result = kept;
    let mut index_by_key: HashMap<String, usize> = result
        .iter()
        .enumerate()
        .map(|(i, e)| (entry_key(e), i))
        .collect();

    for entry in later_entries {
        let k = entry_key(entry);
        if let Some(&idx) = index_by_key.get(&k) {
            result[idx] = entry.clone();
        } else {
            index_by_key.insert(k, result.len());
            result.push(entry.clone());
        }
    }

    Some(result)
}

// ── conflateByKey ──

/// Conflation helper: per key, keep only the last update of each object.
/// Order-preserving: the kept entries are emitted in the relative order of their "last occurrence".
pub fn conflate_by_key(items: &[JsonValue], key: &str) -> Vec<JsonValue> {
    let mut last_index_by_key: HashMap<String, usize> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let k = item[key].as_str().unwrap_or("");
        last_index_by_key.insert(k.to_string(), index);
    }
    items
        .iter()
        .enumerate()
        .filter(|(index, item)| {
            let k = item[key].as_str().unwrap_or("");
            last_index_by_key.get(k) == Some(index)
        })
        .map(|(_, item)| item.clone())
        .collect()
}

// ── tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Rule 1: Splicing ──

    #[test]
    fn rule1_splice_adjacent_row_delta_same_rowid_path() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": "hello"}),
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": " world"}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["append"].as_str().unwrap(), "hello world");
    }

    #[test]
    fn rule1_no_splice_different_rowid() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": "a"}),
            json!({"op": "row.delta", "rowId": 2, "path": "content", "append": "b"}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn rule1_no_splice_different_path() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "a", "append": "x"}),
            json!({"op": "row.delta", "rowId": 1, "path": "b", "append": "y"}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 2);
    }

    // ── Rule 2: Shallow merge ──

    #[test]
    fn rule2_shallow_merge_adjacent_state_updated() {
        let deltas = vec![
            json!({"op": "state.updated", "patch": {"meta": {"a": 1}}}),
            json!({"op": "state.updated", "patch": {"config": {"b": 2}}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["patch"]["meta"]["a"], 1);
        assert_eq!(result[0]["patch"]["config"]["b"], 2);
    }

    #[test]
    fn rule2_later_key_overwrites_former() {
        // Shallow merge: later patch keys overwrite former patch keys at the top level.
        // Within a key, the value is replaced wholesale (not deep-merged).
        let deltas = vec![
            json!({"op": "state.updated", "patch": {"meta": {"a": 1}, "config": {"x": true}}}),
            json!({"op": "state.updated", "patch": {"meta": {"b": 2}, "usage": {"tok": 5}}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        // meta was completely replaced by the later patch
        assert_eq!(result[0]["patch"]["meta"]["b"], 2);
        assert!(result[0]["patch"]["meta"]["a"].is_null());
        // config survived (not overwritten)
        assert_eq!(result[0]["patch"]["config"]["x"], true);
        // usage was added
        assert_eq!(result[0]["patch"]["usage"]["tok"], 5);
    }

    #[test]
    fn rule2_no_merge_different_op() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "a", "append": "x"}),
            json!({"op": "state.updated", "patch": {"meta": {"a": 1}}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 2);
    }

    // ── Rule 3: row.upserted swallows row.delta ──

    #[test]
    fn rule3_upserted_swallows_delta_same_rowid() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": "abc"}),
            json!({"op": "row.upserted", "row": {"rowId": 1, "content": "full"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["op"].as_str().unwrap(), "row.upserted");
    }

    #[test]
    fn rule3_does_not_cross_barrier() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "a", "append": "x"}),
            json!({"op": "row.removed", "rowId": 2}),
            json!({"op": "row.delta", "rowId": 1, "path": "b", "append": "y"}),
            json!({"op": "row.upserted", "row": {"rowId": 1, "content": "full"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        // The first row.delta (before barrier) is NOT swallowed.
        // The second row.delta (after barrier, same rowId) IS swallowed.
        assert_eq!(result.len(), 3);
        assert_eq!(result[0]["op"].as_str().unwrap(), "row.delta");
        assert_eq!(result[0]["rowId"], 1);
        assert_eq!(result[1]["op"].as_str().unwrap(), "row.removed");
        assert_eq!(result[2]["op"].as_str().unwrap(), "row.upserted");
    }

    #[test]
    fn rule3_does_not_cross_previous_upserted() {
        let deltas = vec![
            json!({"op": "row.upserted", "row": {"rowId": 1, "content": "first"}}),
            json!({"op": "row.delta", "rowId": 1, "path": "a", "append": "x"}),
            json!({"op": "row.upserted", "row": {"rowId": 1, "content": "second"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        // row.delta swallowed by the second upsert. Then the two upserteds are adjacent with
        // same rowId → adjacent upserted rule keeps the last one.
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["op"].as_str().unwrap(), "row.upserted");
        assert_eq!(result[0]["row"]["content"].as_str().unwrap(), "second");
    }

    #[test]
    fn rule3_does_not_swallow_different_rowid() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "a", "append": "x"}),
            json!({"op": "row.upserted", "row": {"rowId": 2, "content": "full"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["op"].as_str().unwrap(), "row.delta");
        assert_eq!(result[1]["op"].as_str().unwrap(), "row.upserted");
    }

    // ── Rule 4: row.removed is a barrier ──

    #[test]
    fn rule4_barrier_blocks_splicing() {
        let deltas = vec![
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": "hello"}),
            json!({"op": "row.removed", "rowId": 2}),
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": " world"}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0]["append"].as_str().unwrap(), "hello");
        assert_eq!(result[2]["append"].as_str().unwrap(), " world");
    }

    #[test]
    fn rule4_barrier_blocks_state_merge() {
        let deltas = vec![
            json!({"op": "state.updated", "patch": {"meta": {"a": 1}}}),
            json!({"op": "row.removed", "rowId": 1}),
            json!({"op": "state.updated", "patch": {"meta": {"b": 2}}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 3);
    }

    // ── Rule 5: workflowRun.removed swallows workflowRun.updated ──

    #[test]
    fn rule5_removed_swallows_updated_same_runid() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1, "run": {"status": "running"}}),
            json!({"op": "workflowRun.removed", "runId": "r1", "revision": 2}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["op"].as_str().unwrap(), "workflowRun.removed");
    }

    #[test]
    fn rule5_does_not_swallow_different_runid() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1}),
            json!({"op": "workflowRun.removed", "runId": "r2", "revision": 2}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn rule5_stops_at_workflow_run_barrier() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1}),
            json!({"op": "state.updated", "patch": {"workflowRuns": {"runs": []}}}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2}),
            json!({"op": "workflowRun.removed", "runId": "r1", "revision": 3}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        // The removed swallows the second updated (after the barrier), but not the first.
        // Result: [wr-updated(r1,rev1), state-updated(barrier), wr-removed(r1,rev3)]
        assert_eq!(result.len(), 3);
        assert_eq!(result[0]["op"].as_str().unwrap(), "workflowRun.updated");
        assert_eq!(result[1]["op"].as_str().unwrap(), "state.updated");
        assert_eq!(result[2]["op"].as_str().unwrap(), "workflowRun.removed");
    }

    // ── Rule 6: workflowRun.updated merge ──

    #[test]
    fn rule6_merge_adjacent_workflow_run_updated_same_runid() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1, "run": {"status": "running"}}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2, "run": {"error": "oops"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["runId"].as_str().unwrap(), "r1");
        assert_eq!(result[0]["revision"], 2);
        assert_eq!(result[0]["run"]["status"].as_str().unwrap(), "running");
        assert_eq!(result[0]["run"]["error"].as_str().unwrap(), "oops");
    }

    #[test]
    fn rule6_does_not_merge_different_runid() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1}),
            json!({"op": "workflowRun.updated", "runId": "r2", "revision": 2}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn rule6_stops_at_workflow_run_barrier() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1}),
            json!({"op": "state.updated", "patch": {"workflowRuns": {"runs": []}}}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        // The two workflowRun.updated are separated by a barrier, so no merge.
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn rule6_revision_takes_max() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 5, "run": {"status": "running"}}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 3, "run": {"error": "oops"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["revision"], 5);
    }

    #[test]
    fn rule6_merge_cleared_removes_run_keys() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1, "run": {"status": "running", "error": "oops"}}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2, "run": {"status": "done"}, "cleared": ["error"]}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["run"]["status"].as_str().unwrap(), "done");
        assert!(result[0]["run"]["error"].is_null());
    }

    #[test]
    fn rule6_merge_cleared_cancellation() {
        // If later sets a key that earlier cleared, the key should have the value and not be cleared.
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1, "cleared": ["error"]}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2, "run": {"error": "new"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["run"]["error"].as_str().unwrap(), "new");
    }

    #[test]
    fn rule6_merge_removed_refs_union() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1,
                "removedActors": [{"siteId": "s1", "ordinal": 0}]}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2,
                "removedActors": [{"siteId": "s2", "ordinal": 1}, {"siteId": "s1", "ordinal": 0}]}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        let removed = result[0]["removedActors"].as_array().unwrap();
        assert_eq!(removed.len(), 2);
    }

    #[test]
    fn rule6_merge_entry_lists_upsert() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1,
                "actors": [{"siteId": "s1", "ordinal": 0, "name": "old"}]}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2,
                "actors": [{"siteId": "s1", "ordinal": 0, "name": "new"}]}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        let actors = result[0]["actors"].as_array().unwrap();
        assert_eq!(actors.len(), 1);
        assert_eq!(actors[0]["name"].as_str().unwrap(), "new");
    }

    #[test]
    fn rule6_merge_entry_lists_removed() {
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1,
                "actors": [{"siteId": "s1", "ordinal": 0}, {"siteId": "s2", "ordinal": 1}]}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2,
                "removedActors": [{"siteId": "s1", "ordinal": 0}],
                "actors": [{"siteId": "s3", "ordinal": 2}]}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        let actors = result[0]["actors"].as_array().unwrap();
        assert_eq!(actors.len(), 2);
        // s1 was removed, s2 kept, s3 added.
        assert_eq!(actors[0]["siteId"].as_str().unwrap(), "s2");
        assert_eq!(actors[1]["siteId"].as_str().unwrap(), "s3");
    }

    #[test]
    fn rule6_no_merge_when_out_of_bounds() {
        let mut big_actors = Vec::new();
        for i in 0..=1024 {
            big_actors.push(json!({"siteId": "s", "ordinal": i}));
        }
        let deltas = vec![
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 1}),
            json!({"op": "workflowRun.updated", "runId": "r1", "revision": 2, "actors": big_actors}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        // Second has > maxActors actors, so merge is rejected.
        assert_eq!(result.len(), 2);
    }

    // ── Adjacent row.upserted keep last ──

    #[test]
    fn adjacent_upserted_same_rowid_keeps_last() {
        let deltas = vec![
            json!({"op": "row.upserted", "row": {"rowId": 1, "content": "first"}}),
            json!({"op": "row.upserted", "row": {"rowId": 1, "content": "second"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["row"]["content"].as_str().unwrap(), "second");
    }

    #[test]
    fn adjacent_upserted_different_rowid_keeps_both() {
        let deltas = vec![
            json!({"op": "row.upserted", "row": {"rowId": 1, "content": "a"}}),
            json!({"op": "row.upserted", "row": {"rowId": 2, "content": "b"}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 2);
    }

    // ── conflateByKey ──

    #[test]
    fn conflate_by_key_keeps_last_occurrence() {
        let items = vec![
            json!({"id": "a", "val": 1}),
            json!({"id": "b", "val": 2}),
            json!({"id": "a", "val": 3}),
        ];
        let result = conflate_by_key(&items, "id");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["id"].as_str().unwrap(), "b");
        assert_eq!(result[0]["val"], 2);
        assert_eq!(result[1]["id"].as_str().unwrap(), "a");
        assert_eq!(result[1]["val"], 3);
    }

    #[test]
    fn conflate_by_key_all_unique() {
        let items = vec![
            json!({"id": "a", "val": 1}),
            json!({"id": "b", "val": 2}),
            json!({"id": "c", "val": 3}),
        ];
        let result = conflate_by_key(&items, "id");
        assert_eq!(result.len(), 3);
    }

    // ── Integration / mixed rules ──

    #[test]
    fn mixed_rules_complex_sequence() {
        let deltas = vec![
            json!({"op": "state.updated", "patch": {"meta": {"a": 1}}}),
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": "hello"}),
            json!({"op": "row.delta", "rowId": 1, "path": "content", "append": " world"}),
            json!({"op": "row.removed", "rowId": 2}),
            json!({"op": "row.delta", "rowId": 3, "path": "content", "append": "new"}),
            json!({"op": "row.upserted", "row": {"rowId": 3, "content": "replaced"}}),
            json!({"op": "state.updated", "patch": {"config": {"x": true}}}),
        ];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        // state1, delta1(spliced), removed, upserted3, state2
        // (state1 and state2 are NOT adjacent so they don't merge)
        assert_eq!(result.len(), 5);
        // state.updated (first)
        assert_eq!(result[0]["op"].as_str().unwrap(), "state.updated");
        assert_eq!(result[0]["patch"]["meta"]["a"], 1);
        // row.delta spliced
        assert_eq!(result[1]["op"].as_str().unwrap(), "row.delta");
        assert_eq!(result[1]["append"].as_str().unwrap(), "hello world");
        // row.removed barrier
        assert_eq!(result[2]["op"].as_str().unwrap(), "row.removed");
        // row.upserted swallows the preceding row.delta (rowId=3)
        assert_eq!(result[3]["op"].as_str().unwrap(), "row.upserted");
        // state.updated (second, not merged with first)
        assert_eq!(result[4]["op"].as_str().unwrap(), "state.updated");
        assert_eq!(result[4]["patch"]["config"]["x"], true);
    }

    #[test]
    fn empty_input() {
        let result = coalesce_conversation_deltas(&[]).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn single_delta() {
        let deltas = vec![json!({"op": "row.delta", "rowId": 1, "path": "a", "append": "x"})];
        let result = coalesce_conversation_deltas(&deltas).unwrap();
        assert_eq!(result.len(), 1);
    }
}
