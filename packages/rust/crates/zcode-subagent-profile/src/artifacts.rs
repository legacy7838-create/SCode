//! Subagent artifact documents, ported from `core/src/subagent/runner.ts`.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 2).
//!
//! ## Why this is byte-sensitive
//!
//! The metadata file is read by humans and by other tools, and it is written with
//! `JSON.stringify(value, null, 2)` plus a trailing newline. Three details are
//! load-bearing and all three are reproduced here:
//!
//! 1. **Key order.** The document is a fixed key sequence, and a reader that sorts
//!    keys produces a different file than the one written before the port.
//! 2. **Spread semantics.** `...extra` is applied *after* the base keys: an `extra`
//!    key that already exists keeps its original position and takes the new value.
//!    `serde_json::Map` is an `IndexMap` in this workspace (`preserve_order`), whose
//!    `insert` has exactly that behaviour.
//! 3. **Absent is absent.** A field the caller does not supply is *omitted*, not
//!    written as `null` — that is what `JSON.stringify` does with `undefined`.

use serde_json::{Map, Value};

use crate::nodepath::{node_dirname, node_join};
use crate::DEFAULT_OUTPUT_ROOT;

/// One write to the metadata document.
///
/// Optional fields are omitted when `None`; they are never emitted as `null`.
/// Deserialised from the caller's JSON, so the wire shape is the contract. Absent
/// fields default to `None`, which is how "omit this key" is expressed.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataInput {
    pub agent_id: String,
    pub child_session_id: String,
    pub created_at: String,
    pub cwd: Option<String>,
    pub description: Option<String>,
    pub metadata_file: String,
    pub output_file: String,
    pub parent_session_id: Option<String>,
    pub parent_tool_use_id: Option<String>,
    pub profile_id: Option<String>,
    pub profile_snapshot: Option<Value>,
    pub prompt: Option<String>,
    pub status: String,
    pub task_output_file: String,
    pub updated_at: String,
    pub workspace_root: Option<String>,
    /// Merged after the base keys; see the spread note above.
    #[serde(default)]
    pub extra: Map<String, Value>,
}

/// Build the metadata document: 2-space indent, trailing newline.
///
/// `to_string_pretty` is serde's equivalent of `JSON.stringify(value, null, 2)`.
/// Rust's `serde_json` escapes the same control characters the same way, which the
/// golden corpus checks with a `\u0007` case.
pub fn build_metadata_document(input: &MetadataInput) -> String {
    let mut doc = Map::new();
    // Insertion order IS the document order.
    put(&mut doc, "agentId", &input.agent_id);
    put(&mut doc, "childSessionId", &input.child_session_id);
    put(&mut doc, "createdAt", &input.created_at);
    put_opt(&mut doc, "cwd", &input.cwd);
    put_opt(&mut doc, "description", &input.description);
    put(&mut doc, "metadataFile", &input.metadata_file);
    put(&mut doc, "outputFile", &input.output_file);
    put_opt(&mut doc, "parentSessionId", &input.parent_session_id);
    put_opt(&mut doc, "parentToolUseId", &input.parent_tool_use_id);
    put_opt(&mut doc, "profileId", &input.profile_id);
    put_opt_value(&mut doc, "profileSnapshot", &input.profile_snapshot);
    put_opt(&mut doc, "prompt", &input.prompt);
    put(&mut doc, "status", &input.status);
    put(&mut doc, "taskOutputFile", &input.task_output_file);
    put(&mut doc, "updatedAt", &input.updated_at);
    put_opt(&mut doc, "workspaceRoot", &input.workspace_root);
    for (key, value) in &input.extra {
        // IndexMap::insert keeps the first position and takes the later value, which
        // is precisely JavaScript's `{...base, ...extra}`.
        doc.insert(key.clone(), value.clone());
    }
    let mut text = serde_json::to_string_pretty(&Value::Object(doc))
        .expect("a serde_json::Value is always serialisable");
    text.push('\n');
    text
}

fn put(doc: &mut Map<String, Value>, key: &str, value: &str) {
    doc.insert(key.to_string(), Value::String(value.to_string()));
}

fn put_opt(doc: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(inner) = value {
        put(doc, key, inner);
    }
}

fn put_opt_value(doc: &mut Map<String, Value>, key: &str, value: &Option<Value>) {
    if let Some(inner) = value {
        doc.insert(key.to_string(), inner.clone());
    }
}

/// The structured-result artifact written next to `output.txt`.
///
/// Spec `subagent-result-contract.md` §13: the parent-facing envelope bounds a yield
/// result to a preview, so the complete payload has to be readable from disk.
pub fn build_structured_result_document(structured: &Value) -> String {
    let mut text = serde_json::to_string_pretty(structured)
        .expect("a serde_json::Value is always serialisable");
    text.push('\n');
    text
}

/// One artifact write: the text outputs plus the metadata document.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactWrite {
    pub metadata_file: String,
    pub output_file: String,
    pub task_output_file: String,
    /// Written verbatim to both text outputs.
    pub output_text: String,
    pub metadata: MetadataInput,
    /// When present, also written to `<output_file>.structured.json`.
    pub structured: Option<Value>,
}

/// Write the subagent artifacts and return the paths written, in write order.
///
/// Mirrors `writeCompletedAgentArtifacts`: the two text outputs first, then the metadata
/// document, then the structured sidecar. Creating parent directories is part of the
/// contract — the first write of a run must not fail because the directory is missing.
pub fn write_agent_artifacts(write: &ArtifactWrite) -> std::io::Result<Vec<String>> {
    let mut written = Vec::new();

    write_text_file(&write.output_file, &write.output_text)?;
    written.push(write.output_file.clone());
    write_text_file(&write.task_output_file, &write.output_text)?;
    written.push(write.task_output_file.clone());

    write_text_file(&write.metadata_file, &build_metadata_document(&write.metadata))?;
    written.push(write.metadata_file.clone());

    if let Some(structured) = &write.structured {
        let sidecar = format!("{}.structured.json", write.output_file);
        write_text_file(&sidecar, &build_structured_result_document(structured))?;
        written.push(sidecar);
    }

    Ok(written)
}

fn write_text_file(path: &str, content: &str) -> std::io::Result<()> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)
}

/// The three artifact paths a subagent run writes, plus its output directory.
/// Serialised camelCase for the napi boundary, like every other wire struct here.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecyclePaths {
    pub agent_output_dir: String,
    pub metadata_file: String,
    pub output_file: String,
    pub task_output_file: String,
}

/// Derive the lifecycle paths for a new run.
///
/// Mirrors `createSubagentLifecycle`: `outputRoot/sessionId/agentId`, then the three
/// file names. `output_root_dir` is the caller's `outputRootDir`, or the default
/// `<tmp>/zcode-agents` when it is not configured.
pub fn derive_lifecycle_paths(
    output_root_dir: Option<&str>,
    session_id: &str,
    agent_id: &str,
) -> LifecyclePaths {
    let root = match output_root_dir {
        Some(dir) => dir.to_string(),
        None => DEFAULT_OUTPUT_ROOT.to_string(),
    };
    derive_lifecycle_paths_in(&root, session_id, agent_id)
}

/// Same, but under an explicit root that already includes the default or the
/// configured directory.
pub(crate) fn derive_lifecycle_paths_in(root: &str, session_id: &str, agent_id: &str) -> LifecyclePaths {
    let dir = node_join(&[root, session_id, agent_id]);
    LifecyclePaths {
        metadata_file: node_join(&[&dir, "metadata.json"]),
        output_file: node_join(&[&dir, "output.txt"]),
        task_output_file: node_join(&[&dir, "task.output"]),
        agent_output_dir: dir,
    }
}

/// Derive the lifecycle paths when resuming from a task snapshot.
///
/// Mirrors `createSubagentLifecycleFromTask`: the recorded `outputFile` wins, because a
/// resumed run must keep writing into the directory the first run used. Its parent is
/// taken literally — `dirname` does not normalize, so a recorded path containing `..`
/// resolves to the same directory the previous run used.
pub fn derive_lifecycle_paths_from_task(recorded_output_file: Option<&str>, root: &str, session_id: &str, agent_id: &str) -> LifecyclePaths {
    let dir = match recorded_output_file {
        Some(file) if !file.is_empty() => node_dirname(file),
        _ => derive_lifecycle_paths_in(root, session_id, agent_id).agent_output_dir,
    };
    LifecyclePaths {
        metadata_file: node_join(&[&dir, "metadata.json"]),
        output_file: node_join(&[&dir, "output.txt"]),
        task_output_file: node_join(&[&dir, "task.output"]),
        agent_output_dir: dir,
    }
}
