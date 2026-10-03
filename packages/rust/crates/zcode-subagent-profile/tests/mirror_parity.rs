//! Golden parity for the subagent tool-event mirror.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 2). The corpus is the live TypeScript
//! output, captured by `scripts/capture-subagent-mirror-golden.ts`.

use std::path::PathBuf;

use serde_json::{json, Map, Value};
use zcode_subagent_profile::mirror::{mirror_subagent_tool_event, MirrorContext};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/subagent-mirror-golden.json");
    path
}

fn context() -> MirrorContext {
    MirrorContext {
        agent_id: "agent_abc".into(),
        agent_type: "general-purpose".into(),
        child_session_id: "sess_subagent_agent_abc".into(),
        parent_session_id: "sess_parent".into(),
        parent_tool_call_id: Some("call_parent_1".into()),
        parent_turn_id: Some("turn_parent_1".into()),
        description: Some("Review the diff".into()),
        background: false,
    }
}

fn event(event_type: &str, payload: Value) -> Value {
    json!({
        "id": "evt_child_1",
        "sessionId": "sess_subagent_agent_abc",
        "turnId": "turn_child_1",
        "type": event_type,
        "payload": payload,
        "traceId": "trace_abc",
    })
}

/// The event fields the mirror actually decides.
fn mirror_owned(event: &Value) -> Value {
    let mut value = event.clone();
    if let Some(map) = value.as_object_mut() {
        map.remove("id");
        map.remove("timestamp");
        map.remove("sequenceNumber");
    }
    value
}

#[test]
fn mirror_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "mirror golden corpus is empty");

    let mut failures = Vec::new();
    for (name, expected) in &corpus {
        // Cases whose name says how they are produced.
        let ctx = if name.contains("origin_without_parent_tool_use_id") {
            MirrorContext { parent_tool_call_id: None, ..context() }
        } else if name.contains("background") {
            MirrorContext { background: true, ..context() }
        } else {
            context()
        };

        let child_event = match name.as_str() {
            "tool_scheduled" => event("tool_call_scheduled", json!({ "toolCallId": "child_tc_1", "toolName": "Bash" })),
            // Two events: the first teaches the cache, the second reads it.
            "tool_started_without_name_learns_from_cache" => event("tool_call_started", json!({ "toolCallId": "child_tc_1" })),
            "tool_result" => event("tool_call_result", json!({ "toolCallId": "child_tc_2", "toolName": "Grep", "ok": true, "output": "3 matches" })),
            "tool_error_background" => event("tool_call_error", json!({ "toolCallId": "child_tc_3", "toolName": "Bash", "error": "boom" })),
            "schedule_with_dependencies_and_groups" => event("tool_call_scheduled", json!({
                "toolCallId": "child_tc_4", "toolName": "Bash",
                "dependencies": ["child_tc_1", "child_tc_2", 7],
                "schedule": {
                    "executionOrder": ["child_tc_1", "child_tc_2", 9],
                    "parallelGroups": [["child_tc_3", "child_tc_4"], ["child_tc_5"]],
                    "note": "kept"
                }
            })),
            "schedule_empty_object_ignored" => event("tool_call_scheduled", json!({ "toolCallId": "child_tc_5", "toolName": "Read", "schedule": {} })),
            "permission_requested_with_origin" => event("permission_requested", json!({ "toolCallId": "child_tc_6", "toolName": "Bash" })),
            "permission_resolved" => event("permission_resolved", json!({ "toolCallId": "child_tc_6", "decision": "allow" })),
            "permission_denied_background" => event("permission_denied", json!({ "toolCallId": "child_tc_7", "reason": "policy" })),
            "unmirrored_type_returns_nothing" => event("assistant_message", json!({ "toolCallId": "child_tc_8", "text": "hi" })),
            "missing_tool_call_id_returns_nothing" => event("tool_call_started", json!({ "toolName": "Bash" })),
            "non_string_tool_call_id_returns_nothing" => event("tool_call_started", json!({ "toolCallId": 42 })),
            "origin_without_parent_tool_use_id" => event("permission_requested", json!({ "toolCallId": "child_tc_9" })),
            other => panic!("golden case {other} has no fixture"),
        };

        let mut names = Map::new();
        let mut outcome = mirror_subagent_tool_event(&child_event, &ctx, &names);
        if name == "tool_started_without_name_learns_from_cache" {
            // Prime the cache exactly as TypeScript does.
            let scheduled = event("tool_call_scheduled", json!({ "toolCallId": "child_tc_1", "toolName": "Read" }));
            names = mirror_subagent_tool_event(&scheduled, &ctx, &Map::new()).tool_names;
            outcome = mirror_subagent_tool_event(&child_event, &ctx, &names);
        }

        let actual = outcome.event.unwrap_or(Value::Null);
        // `id`, `timestamp` and `sequenceNumber` are assigned by `createSessionEvent`
        // when the event is constructed — a fresh UUID, the wall clock and a sequence
        // counter. They are not mirror-owned and cannot be reproduced, so the
        // comparison covers exactly what the mirror decides: the routing fields and the
        // whole payload.
        if mirror_owned(&actual) != mirror_owned(expected) {
            failures.push(format!(
                "[{name}]\n  rust: {}\n  ts:   {}",
                mirror_owned(&actual),
                mirror_owned(expected)
            ));
        }
    }
    assert!(failures.is_empty(), "mirror diverged in {} case(s):\n{}", failures.len(), failures.join("\n"));
}

/// The cache is the caller's to own: it must survive across events without a shared map.
#[test]
fn tool_name_cache_carries_across_events() {
    let ctx = context();
    let scheduled = event("tool_call_scheduled", json!({ "toolCallId": "tc_9", "toolName": "Edit" }));
    let first = mirror_subagent_tool_event(&scheduled, &ctx, &Map::new());
    assert_eq!(first.tool_names.get("tc_9"), Some(&json!("Edit")));

    let started = event("tool_call_started", json!({ "toolCallId": "tc_9" }));
    let second = mirror_subagent_tool_event(&started, &ctx, &first.tool_names);
    assert_eq!(
        second.event.unwrap()["payload"]["toolName"],
        json!("Edit"),
        "a started event with no toolName must reuse the learned name"
    );
}
