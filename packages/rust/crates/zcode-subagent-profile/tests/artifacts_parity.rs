//! Golden parity for the subagent artifact documents.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 2).
//!
//! `metadata-golden.json` is captured from the live TypeScript implementation by
//! `scripts/capture-agent-metadata-golden.ts`. Comparison is on the exact string:
//! these are bytes on disk, so "close enough" is not a category that exists here.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::artifacts::{build_metadata_document, MetadataInput};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push(
        "../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/metadata-golden.json",
    );
    path
}

fn base_input() -> MetadataInput {
    MetadataInput {
        agent_id: "agent_11111111-2222-3333-4444-555555555555".into(),
        child_session_id: "sess_subagent_agent_11111111".into(),
        created_at: "2023-11-14T22:13:20.000Z".into(),
        cwd: Some("/home/dev/project".into()),
        description: Some("Review the diff".into()),
        metadata_file: "/data/agents/sess_1/agent_x/metadata.json".into(),
        output_file: "/data/agents/sess_1/agent_x/output.txt".into(),
        parent_session_id: Some("sess_parent".into()),
        parent_tool_use_id: Some("call_abc123".into()),
        profile_id: Some("general-purpose".into()),
        profile_snapshot: Some(serde_json::json!({ "name": "general-purpose", "source": "built-in" })),
        prompt: Some("Review the changes and report findings.".into()),
        status: "completed".into(),
        task_output_file: "/data/agents/sess_1/agent_x/task.output".into(),
        updated_at: "2026-10-03T07:15:13.662Z".into(),
        workspace_root: None,
        extra: serde_json::Map::new(),
    }
}

fn extra(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn input_for(name: &str) -> MetadataInput {
    let mut input = base_input();
    match name {
        "running" => input.status = "running".into(),
        "failed_with_error" => {
            input.status = "failed".into();
            input.extra = extra(&[("error", Value::String("boom".into()))]);
        }
        "structured_contract" => input.extra = extra(&[
            ("completedAt", Value::String("2026-10-03T07:15:20.000Z".into())),
            ("totalDurationMs", serde_json::json!(4210)),
            ("totalTokens", serde_json::json!(1234)),
            ("totalToolUseCount", serde_json::json!(7)),
            (
                "structured",
                serde_json::json!({ "ok": true, "data": { "verdict": "ok" } }),
            ),
        ]),
        "unicode_and_quotes" => {
            input.description = Some("Hindi \"quoted\" — dash".into());
            input.prompt = Some("line1\nline2\ttab".into());
        }
        "control_characters" => {
            input.prompt = Some("bell:\u{7} null-ish:\\ end".into());
        }
        // The spread case: an `extra` key that already exists keeps its ORIGINAL
        // position and takes the new value, exactly like JavaScript's object spread.
        "extra_overrides_status" => {
            input.extra = extra(&[("status", Value::String("overridden-by-extra".into()))]);
        }
        "profile_snapshot_with_schema" => {
            input.profile_snapshot = Some(serde_json::json!({
                "name": "reviewer",
                "source": "user",
                "yield": { "mode": "structured", "schema": { "type": "object", "required": ["verdict"] } },
                "tools": ["Read", "Grep"],
            }));
        }
        "completed" => {}
        other => panic!("golden case {other} has no fixture in this test"),
    }
    input
}

#[test]
fn metadata_documents_are_byte_identical() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> =
        serde_json::from_str(&raw).expect("golden corpus is valid JSON");
    assert!(!corpus.is_empty(), "metadata golden corpus is empty");

    let mut failures = Vec::new();
    for (name, expected) in &corpus {
        let expected_text = expected.as_str().unwrap_or_else(|| panic!("{name} is not a string"));
        let actual = build_metadata_document(&input_for(name));
        if actual != expected_text {
            failures.push(format!(
                "[{name}] bytes differ\n  rust: {} bytes\n  ts:   {} bytes\n  rust head: {}\n  ts head:   {}",
                actual.len(),
                expected_text.len(),
                actual.lines().take(3).collect::<Vec<_>>().join(" | "),
                expected_text.lines().take(3).collect::<Vec<_>>().join(" | "),
            ));
        }
    }
    assert!(failures.is_empty(), "artifact parity broke:\n{}", failures.join("\n"));
}

/// The document must end with a newline, because the previous implementation wrote one
/// and tooling that concatenates these files would otherwise produce `}{`.
#[test]
fn document_ends_with_a_single_newline() {
    let text = build_metadata_document(&base_input());
    assert!(text.ends_with("}\n"));
    assert!(!text.ends_with("\n\n"));
}
