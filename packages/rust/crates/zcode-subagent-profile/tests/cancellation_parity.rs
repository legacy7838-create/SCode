//! Golden parity for the subagent cancellation policy.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 2).

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::cancellation::{
    select_tasks_to_cancel, should_seal_background_task_notifications,
};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/subagent-cancel-golden.json");
    path
}

fn tasks_for(name: &str) -> Vec<Value> {
    let task = |task_id: &str, kind: &str, backgrounded: Option<bool>, status: &str| {
        let mut value = serde_json::json!({ "taskId": task_id, "type": kind, "status": status });
        if let Some(flag) = backgrounded {
            value["isBackgrounded"] = Value::Bool(flag);
        }
        value
    };
    match name {
        "empty_registry" => vec![],
        "running_backgrounded_bash_is_selected" => vec![task("t1", "local_bash", Some(true), "running")],
        "foreground_bash_is_kept" => vec![task("t1", "local_bash", Some(false), "running")],
        "finished_bash_is_kept" => vec![task("t1", "local_bash", Some(true), "completed")],
        "failed_bash_is_kept" => vec![task("t1", "local_bash", Some(true), "failed")],
        "missing_is_backgrounded_is_kept" => vec![task("t1", "local_bash", None, "running")],
        "other_task_types_are_kept" => vec![
            task("t1", "workflow_run", Some(true), "running"),
            task("t2", "subagent", Some(true), "running"),
            task("t3", "local_bash", Some(true), "running"),
        ],
        "mixed_selects_only_the_match" => vec![
            task("keep_fg", "local_bash", Some(false), "running"),
            task("keep_done", "local_bash", Some(true), "completed"),
            task("keep_other", "workflow_run", Some(true), "running"),
            task("kill_1", "local_bash", Some(true), "running"),
            task("keep_pending", "local_bash", Some(true), "pending"),
            task("kill_2", "local_bash", Some(true), "running"),
        ],
        // The golden uses the STRING "true"; a loose comparison would cancel this.
        "is_backgrounded_truthy_but_not_true_is_kept" => vec![
            serde_json::json!({ "taskId": "t1", "type": "local_bash", "isBackgrounded": "true", "status": "running" })
        ],
        "extra_fields_do_not_matter" => vec![serde_json::json!({
            "taskId": "t1", "type": "local_bash", "isBackgrounded": true, "status": "running",
            "exitCode": null, "stopInitiator": "user", "prompt": "sleep 100"
        })],
        other => panic!("golden case {other} has no fixture"),
    }
}

#[test]
fn cancellation_policy_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> =
        serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "cancellation golden corpus is empty");

    let mut failures = Vec::new();
    for (name, expected) in &corpus {
        let expected_ids: Vec<String> = expected
            .as_array()
            .expect("array of ids")
            .iter()
            .map(|id| id.as_str().expect("id string").to_string())
            .collect();
        let actual = select_tasks_to_cancel(&tasks_for(name));
        if actual != expected_ids {
            failures.push(format!("[{name}] rust={actual:?} ts={expected_ids:?}"));
        }
    }
    assert!(failures.is_empty(), "cancellation policy diverged:\n{}", failures.join("\n"));
}

#[test]
fn only_a_subagent_child_seals_notifications() {
    assert!(should_seal_background_task_notifications("subagent_child"));
    for task_type in ["main", "workflow_child", "workflow_actor", "", "subagent"] {
        assert!(
            !should_seal_background_task_notifications(task_type),
            "{task_type} must keep notifying"
        );
    }
}
