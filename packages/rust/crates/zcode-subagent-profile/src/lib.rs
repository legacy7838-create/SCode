//! `zcode-subagent-profile` — the Rust owner of the agent-profile contract.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 1).
//!
//! Ported from `apps/zcode-cli/packages/core/src/subagent/profile.ts` +
//! `profile-frontmatter.ts`.
//!
//! ## Why this crate exists before the turn loop is ported
//!
//! Profile parsing is the first seam of the child runtime and it is a *pure* function:
//! markdown in, profile out. Porting it first is safe only because parity is
//! testable — which is why `tests/parity.rs` replays the golden corpus captured
//! from the live TypeScript parser (`testdata/agent-profiles/golden.json`).
//!
//! ## Why the cdylib is not optional
//!
//! The consumer is still Node for now. If this crate were rlib-only, Node could not
//! `require()` it, `profile.ts` would have to stay alive as a second implementation,
//! and the two would drift — the precise "one JS fallback" the port forbids. See
//! `zcode-mcp-config/Cargo.toml` §18, where the same trap is documented.
//!
//! That delete has happened: `core/src/subagent/profile.ts` now delegates here and
//! `core/src/subagent/profile-frontmatter.ts` no longer exists. There is exactly one reader.

pub mod artifacts;

/// The default subagent output root, matching `join(tmpdir(), "zcode-agents")`.
const DEFAULT_OUTPUT_ROOT: &str = "/tmp/zcode-agents";
pub mod argvpolicy;
pub mod callbacks;
pub mod cancellation;
pub mod frontmatter;
pub mod gitcallbacks;
pub mod gitflags;
pub mod gitruntimesafety;
pub mod mirror;
pub mod nodepath;
pub mod readonlypolicy;
pub mod resultbudget;
pub mod rulematcher;
pub mod tables;
pub mod profile;

pub use profile::{
    parse_agent_profile_from_markdown, AgentProfile, Diagnostic, ParseOutcome,
    DIAGNOSTIC_INVALID_YIELD_SCHEMA, DIAGNOSTIC_MISSING_FRONTMATTER,
};

/// Parse one profile and return the wire-shaped outcome as a JSON string.
///
/// A JSON string (rather than a typed napi object) is deliberate and matches
/// `zcode-events` §3.3 and `zcode-task-index`: the request/result types are declared
/// once in `@zcode/shared`, and redeclaring them here would be a second source of
/// truth for the same contract.
#[napi_derive::napi]
pub fn parse_profile_json(content: String, source: String, path: Option<String>) -> String {
    let outcome = parse_agent_profile_from_markdown(&content, &source, path.as_deref());
    outcome.to_json().to_string()
}

/// napi boundary for the artifact writers.
mod napi_surface {
    use super::artifacts::{write_agent_artifacts, ArtifactWrite, MetadataInput};
    use napi_derive::napi;
    use serde_json::Value;

    /// Build the metadata document without writing anything.
    ///
    /// JSON in, JSON out, for the same reason as `parse_profile_json`: the shapes live
    /// in one place, not redeclared on both sides of the boundary.
    #[napi]
    pub fn build_metadata_document_json(metadata_json: String) -> napi::Result<String> {
        let input: MetadataInput = serde_json::from_str(&metadata_json)
            .map_err(|error| napi::Error::from_reason(format!("invalid metadata input: {error}")))?;
        Ok(super::artifacts::build_metadata_document(&input))
    }

    /// Write the subagent artifacts; returns the paths written, in order.
    #[napi]
    pub fn write_agent_artifacts_json(request_json: String) -> napi::Result<String> {
        let request: Value = serde_json::from_str(&request_json)
            .map_err(|error| napi::Error::from_reason(format!("invalid request: {error}")))?;
        let text = |key: &str| {
            request
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let write = ArtifactWrite {
            metadata_file: text("metadataFile"),
            output_file: text("outputFile"),
            task_output_file: text("taskOutputFile"),
            output_text: text("outputText"),
            metadata: serde_json::from_value(
                request.get("metadata").cloned().unwrap_or(Value::Null),
            )
            .map_err(|error| napi::Error::from_reason(format!("invalid metadata: {error}")))?,
            structured: request.get("structured").cloned().filter(|v| !v.is_null()),
        };
        let written = write_agent_artifacts(&write)
            .map_err(|error| napi::Error::from_reason(format!("artifact write failed: {error}")))?;
        Ok(serde_json::to_string(&written).unwrap_or_else(|_| "[]".to_string()))
    }
}

pub use napi_surface::{build_metadata_document_json, write_agent_artifacts_json};

/// napi boundary for the lifecycle path derivation.
#[napi_derive::napi]
pub fn derive_lifecycle_paths_json(request_json: String) -> napi::Result<String> {
    let request: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid request: {error}")))?;
    let text = |key: &str| {
        request
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let root = text("outputRootDir");
    let session_id = text("sessionId").unwrap_or_default();
    let agent_id = text("agentId").unwrap_or_default();
    let paths = match text("recordedOutputFile").filter(|file| !file.is_empty()) {
        // A resumed run keeps the directory its first run used.
        Some(recorded) => {
            let resolved = root.unwrap_or_else(|| DEFAULT_OUTPUT_ROOT.to_string());
            artifacts::derive_lifecycle_paths_from_task(Some(&recorded), &resolved, &session_id, &agent_id)
        }
        None => artifacts::derive_lifecycle_paths(root.as_deref(), &session_id, &agent_id),
    };
    serde_json::to_string(&paths)
        .map_err(|error| napi::Error::from_reason(format!("cannot encode paths: {error}")))
}

/// napi boundary for the tool-event mirror.
///
/// Takes the whole request (event + context + current cache) and returns the mirrored
/// event together with the updated cache, so the caller owns the cache and Rust never
/// holds a reference into TypeScript memory.
#[napi_derive::napi]
pub fn mirror_subagent_tool_event_json(request_json: String) -> napi::Result<String> {
    use mirror::{mirror_subagent_tool_event, MirrorContext, MirrorOutcome};
    use serde_json::Value;

    let request: Value = serde_json::from_str(&request_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid request: {error}")))?;
    let context_value = request.get("context").cloned().unwrap_or(Value::Null);
    let text = |key: &str| {
        context_value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let context = MirrorContext {
        agent_id: text("agentId").unwrap_or_default(),
        agent_type: text("agentType").unwrap_or_default(),
        child_session_id: text("childSessionId").unwrap_or_default(),
        parent_session_id: text("parentSessionId").unwrap_or_default(),
        parent_tool_call_id: text("parentToolCallId"),
        parent_turn_id: text("parentTurnId"),
        description: text("description"),
        background: context_value
            .get("background")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    let names = request
        .get("toolNames")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let event = request.get("event").cloned().unwrap_or(Value::Null);

    let MirrorOutcome { event, tool_names } = mirror_subagent_tool_event(&event, &context, &names);
    serde_json::to_string(&serde_json::json!({
        "event": event.unwrap_or(Value::Null),
        "toolNames": tool_names,
    }))
    .map_err(|error| napi::Error::from_reason(format!("cannot encode outcome: {error}")))
}

/// Build the subagent interaction origin on its own.
///
/// The broker needs it when forwarding a request that carried no origin of its own; the
/// mirror needs the identical object when it forwards `permission_requested`.
#[napi_derive::napi]
pub fn build_interaction_origin_json(context_json: String, child_turn_id: Option<String>) -> napi::Result<String> {
    use mirror::{build_interaction_origin, MirrorContext};
    use serde_json::Value;

    let value: Value = serde_json::from_str(&context_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid context: {error}")))?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let context = MirrorContext {
        agent_id: text("agentId").unwrap_or_default(),
        agent_type: text("agentType").unwrap_or_default(),
        child_session_id: text("childSessionId").unwrap_or_default(),
        parent_session_id: text("parentSessionId").unwrap_or_default(),
        parent_tool_call_id: text("parentToolCallId"),
        parent_turn_id: text("parentTurnId"),
        description: text("description"),
        background: value.get("background").and_then(Value::as_bool).unwrap_or(false),
    };
    serde_json::to_string(&build_interaction_origin(&context, child_turn_id.as_deref()))
        .map_err(|error| napi::Error::from_reason(format!("cannot encode origin: {error}")))
}

/// The cancellation policy at the napi boundary: given the registry snapshots, which
/// tasks must be stopped on teardown. Stopping them stays in TypeScript — it goes
/// through the scheduler and the task index.
#[napi_derive::napi]
pub fn select_tasks_to_cancel_json(tasks_json: String) -> napi::Result<String> {
    use cancellation::select_tasks_to_cancel;
    let tasks: Vec<serde_json::Value> = serde_json::from_str(&tasks_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid tasks: {error}")))?;
    serde_json::to_string(&select_tasks_to_cancel(&tasks))
        .map_err(|error| napi::Error::from_reason(format!("cannot encode ids: {error}")))
}

/// Whether a runtime of this task type seals background-task notifications.
#[napi_derive::napi]
pub fn should_seal_background_task_notifications_json(task_type: String) -> bool {
    cancellation::should_seal_background_task_notifications(&task_type)
}

/// The git global-option safety gate at the napi boundary.
///
/// Returns true when any word names an option that redirects git elsewhere — a
/// configuration or path override that would let a later policy check see only
/// `git <subcommand>` while an arbitrary command runs.
#[napi_derive::napi]
pub fn has_dangerous_git_global_option_json(argv_json: String) -> napi::Result<bool> {
    use gitflags::has_dangerous_git_global_option;
    let argv: Vec<String> = serde_json::from_str(&argv_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid argv: {error}")))?;
    Ok(has_dangerous_git_global_option(&argv))
}

/// The single-word form of the same gate, for `normalizeGitArgv`.
#[napi_derive::napi]
pub fn has_dangerous_git_global_option_word_json(word: String) -> bool {
    gitflags::has_dangerous_git_global_option_word(&word)
}

/// The read-only argv flag policy at the napi boundary.
///
/// Returns whether the flags on a known command are all safe. A rejection here is the
/// safe default: an unrecognised flag is never "probably fine".
#[napi_derive::napi]
pub fn is_argv_allowed_by_policy_json(request_json: String) -> napi::Result<bool> {
    use argvpolicy::{is_argv_allowed_by_policy, policy_from_json};
    let request: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid request: {error}")))?;
    let argv: Vec<String> = serde_json::from_value(request.get("argv").cloned().unwrap_or_default())
        .map_err(|error| napi::Error::from_reason(format!("invalid argv: {error}")))?;
    let policy = request
        .get("policy")
        .and_then(policy_from_json)
        .ok_or_else(|| napi::Error::from_reason("invalid policy"))?;
    let command_name = request.get("commandName").and_then(serde_json::Value::as_str).unwrap_or("");
    let start_index = request.get("startIndex").and_then(serde_json::Value::as_u64).unwrap_or(1) as usize;
    Ok(is_argv_allowed_by_policy(&argv, &policy, command_name, start_index))
}

/// Evaluate a read-only danger callback by name.
///
/// The policy tables hold function references; passing the NAME keeps the wire contract a
/// plain string instead of a function pointer that cannot cross the boundary.
#[napi_derive::napi]
pub fn readonly_callback_is_dangerous_json(name: String, args_json: String) -> napi::Result<bool> {
    use callbacks::*;
    let args: Vec<String> = serde_json::from_str(&args_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid args: {error}")))?;
    Ok(match name.as_str() {
        "jq" => jq_command_is_dangerous(&args),
        "sed" => sed_command_is_dangerous(&args),
        "date" => date_command_is_dangerous(&args),
        "lsof" => lsof_command_is_dangerous(&args),
        "ps" => ps_command_is_dangerous(&args),
        "pyright" => pyright_command_is_dangerous(&args),
        "test" => test_command_is_dangerous(&args),
        "gh" => gh_command_is_dangerous(&args),
        "man" => man_command_is_dangerous(&args),
        "tput" => tput_command_is_dangerous(&args),
        "ss" => ss_command_is_dangerous(&args),
        "xargs" => xargs_command_is_dangerous(&args),
        "gitRevisionFormat" => gitcallbacks::git_revision_format_command_is_dangerous(&args),
        "gitReflog" => gitcallbacks::git_reflog_command_is_dangerous(&args),
        "gitLsRemote" => gitcallbacks::git_ls_remote_command_is_dangerous(&args),
        "gitRemoteShow" => gitcallbacks::git_remote_show_command_is_dangerous(&args),
        "gitTag" => gitcallbacks::git_tag_command_is_dangerous(&args),
        "gitBranch" => gitcallbacks::git_branch_command_is_dangerous(&args),
        "gitRemote" => gitcallbacks::git_remote_command_is_dangerous(&args),
        other => {
            return Err(napi::Error::from_reason(format!(
                "no dangerous-callback named {other} in the Rust owner"
            )))
        }
    })
}

/// `-i`, `--in-place`, or `--in-place=SUFFIX`.
#[napi_derive::napi]
pub fn is_sed_in_place_option_json(word: String) -> bool {
    callbacks::is_sed_in_place_option(&word)
}

/// The bash permission rule matcher at the napi boundary.
#[napi_derive::napi]
pub fn evaluate_bash_rules_json(request_json: String) -> napi::Result<bool> {
    use rulematcher::{evaluate_bash_rules, BashRuleEvaluationInput};
    use serde_json::Value;

    let request: Value = serde_json::from_str(&request_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid request: {error}")))?;
    let text_lists = |key: &str| -> Vec<Vec<String>> {
        request
            .get(key)
            .and_then(Value::as_array)
            .map(|groups| {
                groups
                    .iter()
                    .filter_map(Value::as_array)
                    .map(|group| {
                        group
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let text_list = |key: &str| -> Vec<String> {
        request
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    // The original reads `rule.ruleContent ?? ""` in every branch, so an absent content is
    // the empty string here rather than a separate state.
    let rules = request
        .get("rules")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|rule| {
                    rule.get("ruleContent")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(evaluate_bash_rules(&BashRuleEvaluationInput {
        all_subject_groups: text_lists("allSubjectGroups"),
        behavior: request
            .get("behavior")
            .and_then(Value::as_str)
            .unwrap_or("allow")
            .to_string(),
        exact_commands: text_list("exactCommands"),
        required_subject_groups: text_lists("requiredSubjectGroups"),
        rules,
        safe: request.get("safe").and_then(Value::as_bool).unwrap_or(false),
    }))
}

/// Look up a read-only policy by command prefix, at the napi boundary.
///
/// Returns `null` when the prefix is not on the read-only list. The policy is returned as
/// JSON so the consumer sees the same shape the captured table has, with the callback as a
/// NAME rather than a function reference.
#[napi_derive::napi]
pub fn lookup_readonly_policy_json(prefix: String) -> napi::Result<Option<String>> {
    use tables::PolicyTables;
    let tables = PolicyTables::load()
        .map_err(|error| napi::Error::from_reason(format!("policy table unreadable: {error}")))?;
    let Some(policy) = tables.lookup(&prefix) else {
        return Ok(None);
    };
    let mut out = serde_json::Map::new();
    out.insert("allowAnyArgs".into(), serde_json::Value::Bool(policy.allow_any_args));
    out.insert("commandOnly".into(), serde_json::Value::Bool(policy.command_only));
    out.insert(
        "allowCompactNumericCountFlag".into(),
        serde_json::Value::Bool(policy.allow_compact_numeric_count_flag),
    );
    // Absent stays absent: the consumer distinguishes it from `false`.
    if let Some(respects) = policy.respects_double_dash {
        out.insert("respectsDoubleDash".into(), serde_json::Value::Bool(respects));
    }
    let mut flags = serde_json::Map::new();
    for (name, kind) in policy.safe_flags.iter().flatten() {
        flags.insert(
            name.clone(),
            serde_json::Value::String(format!("{kind:?}").to_lowercase()),
        );
    }
    out.insert("safeFlags".into(), serde_json::Value::Object(flags));
    if let Some(callback) = &policy.additional_dangerous_callback {
        out.insert(
            "additionalCommandIsDangerousCallback".into(),
            serde_json::Value::String(callback.clone()),
        );
    }
    Ok(Some(serde_json::to_string(&serde_json::Value::Object(out)).unwrap_or_default()))
}

/// Does this text match the table's single `hostname` pattern?
#[napi_derive::napi]
pub fn matches_hostname_json(text: String) -> bool {
    tables::matches_hostname(&text)
}

/// The one place a policy table's callback NAME is turned into a call.
///
/// Both the napi boundary and the in-crate evaluator go through this, so a table entry and a
/// direct dispatch can never name the same callback differently.
pub fn run_danger_callback(name: &str, args: &[String]) -> Option<bool> {
    use callbacks::*;
    Some(match name {
        "jq" => jq_command_is_dangerous(args),
        "sed" => sed_command_is_dangerous(args),
        "date" => date_command_is_dangerous(args),
        "ps" => ps_command_is_dangerous(args),
        "pyright" => pyright_command_is_dangerous(args),
        "man" => man_command_is_dangerous(args),
        "lsof" => lsof_command_is_dangerous(args),
        "tput" => tput_command_is_dangerous(args),
        "ss" => ss_command_is_dangerous(args),
        "test" => test_command_is_dangerous(args),
        "xargs" => xargs_command_is_dangerous(args),
        "gh" => gh_command_is_dangerous(args),
        "gitRevisionFormat" => gitcallbacks::git_revision_format_command_is_dangerous(args),
        "gitReflog" => gitcallbacks::git_reflog_command_is_dangerous(args),
        "gitLsRemote" => gitcallbacks::git_ls_remote_command_is_dangerous(args),
        "gitRemoteShow" => gitcallbacks::git_remote_show_command_is_dangerous(args),
        "gitTag" => gitcallbacks::git_tag_command_is_dangerous(args),
        "gitBranch" => gitcallbacks::git_branch_command_is_dangerous(args),
        "gitRemote" => gitcallbacks::git_remote_command_is_dangerous(args),
        _ => return None,
    })
}

/// The read-only policy decision for one parsed invocation.
///
/// Returns `"true"`, `"false"` or `"null"` — the three-way result matters, because "no
/// opinion" is not a denial and must not collapse into one.
#[napi_derive::napi]
pub fn evaluate_bash_readonly_policy_json(request_json: String) -> napi::Result<String> {
    use readonlypolicy::{evaluate_bash_readonly_policy, Invocation, Redirect};
    use serde_json::Value;

    let request: Value = serde_json::from_str(&request_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid request: {error}")))?;
    let invocation = Invocation {
        argv: request
            .get("argv")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        command_text: request.get("commandText").and_then(Value::as_str).unwrap_or("").to_string(),
        env_assignments: request
            .get("envAssignments")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.get("name").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        redirects: request
            .get("redirects")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| Redirect {
                        operator: item
                            .get("operator")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        target: item.get("target").and_then(Value::as_str).unwrap_or("").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };
    Ok(match evaluate_bash_readonly_policy(&invocation) {
        Some(true) => "true",
        Some(false) => "false",
        None => "null",
    }
    .to_string())
}

/// Does this argv contain a KNOWN write option? Distinct from "not read-only": this is the
/// question the permission flow asks before consulting the policy tables.
#[napi_derive::napi]
pub fn has_known_bash_write_option_json(argv_json: String) -> napi::Result<bool> {
    use readonlypolicy::has_known_bash_write_option;
    let argv: Vec<String> = serde_json::from_str(&argv_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid argv: {error}")))?;
    Ok(has_known_bash_write_option(&argv))
}

/// Is this working directory safe to run a read-only git command in?
///
/// LOOUD on failure: an unresolvable path is reported unsafe rather than trusted, because the
/// check exists to stop git running somewhere the policy did not expect.
#[napi_derive::napi]
pub fn is_git_runtime_context_unsafe_json(working_directory: Option<String>) -> bool {
    gitruntimesafety::is_git_runtime_context_unsafe(working_directory.as_deref())
}

/// The two pure predicates the read-only flow asks about a parsed command line.
#[napi_derive::napi]
pub fn analysis_git_predicates_json(argvs_json: String) -> napi::Result<String> {
    use gitruntimesafety::{
        analysis_contains_git_and_directory_change, analysis_contains_git_command,
        normalized_simple_command_name,
    };
    // Take the argv, not the reported name: the grammar reports `command`/`builtin`/`noglob`
    // as the name, and Rust owns the unwrapping so it cannot be done twice or skipped.
    let argvs: Vec<Vec<String>> = serde_json::from_str(&argvs_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid argv list: {error}")))?;
    let names: Vec<Option<String>> = argvs.iter().map(|argv| normalized_simple_command_name(argv)).collect();
    serde_json::to_string(&serde_json::json!({
        "hasGit": analysis_contains_git_command(&names),
        "hasGitAndDirectoryChange": analysis_contains_git_and_directory_change(&names),
    }))
    .map_err(|error| napi::Error::from_reason(format!("cannot encode: {error}")))
}

/// Convert a captured analysis (the grammar's output) into the Rust model.
fn analysis_from_json(value: &serde_json::Value) -> Result<gitruntimesafety::Analysis, String> {
    use gitruntimesafety::{Analysis, ParsedCommand};
    use readonlypolicy::Redirect;
    let strings = |items: Option<&serde_json::Value>| -> Vec<String> {
        items
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().filter_map(serde_json::Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let commands = value
        .get("commands")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| ParsedCommand {
                    name: item.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
                    argv: strings(item.get("argv")),
                    command_text: item
                        .get("commandText")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    env_assignments: item
                        .get("envAssignments")
                        .and_then(serde_json::Value::as_array)
                        .map(|assignments| {
                            assignments
                                .iter()
                                .map(|a| {
                                    a.get("name").and_then(serde_json::Value::as_str).map(str::to_string)
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    redirects: item
                        .get("redirects")
                        .and_then(serde_json::Value::as_array)
                        .map(|redirects| {
                            redirects
                                .iter()
                                .map(|r| Redirect {
                                    operator: r
                                        .get("operator")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or("")
                                        .to_string(),
                                    target: r
                                        .get("target")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or("")
                                        .to_string(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    operator_before: item
                        .get("operatorBefore")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Analysis {
        commands,
        has_parse_errors: value.get("hasParseErrors").and_then(serde_json::Value::as_bool).unwrap_or(false),
        has_redirects: value.get("hasRedirects").and_then(serde_json::Value::as_bool).unwrap_or(false),
        has_dynamic_words: value.get("hasDynamicWords").and_then(serde_json::Value::as_bool).unwrap_or(false),
        has_unsupported_syntax: value
            .get("hasUnsupportedSyntax")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

/// The whole post-parse bash permission policy, at the napi boundary.
///
/// Returns `permissionSafe` / `readOnly` / `silent` together: they are read from ONE analysis,
/// so asking Rust once keeps them consistent with each other.
#[napi_derive::napi]
pub fn evaluate_bash_semantics_json(request_json: String) -> napi::Result<String> {
    use gitruntimesafety::{is_bash_command_permission_safe, is_runtime_read_only_bash_command, is_silent_bash_command};
    let request: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid request: {error}")))?;
    let analysis = analysis_from_json(
        request.get("analysis").unwrap_or(&serde_json::Value::Null),
    )
    .map_err(napi::Error::from_reason)?;
    let working_directory = request.get("workingDirectory").and_then(serde_json::Value::as_str);
    serde_json::to_string(&serde_json::json!({
        "permissionSafe": is_bash_command_permission_safe(&analysis),
        "readOnly": is_runtime_read_only_bash_command(&analysis, working_directory),
        "silent": is_silent_bash_command(&analysis),
    }))
    .map_err(|error| napi::Error::from_reason(format!("cannot encode: {error}")))
}

/// Fit a tool result to a UTF-8 byte budget at code-point boundaries.
#[napi_derive::napi]
pub fn fit_string_to_bytes_json(value: String, max_bytes: f64, direction: String) -> String {
    use resultbudget::{fit_string_to_bytes, Direction};
    let dir = if direction == "tail" { Direction::Tail } else { Direction::Head };
    fit_string_to_bytes(&value, max_bytes.max(0.0) as usize, dir)
}

/// Fit a tool result to a byte budget, reserving the truncation notice first.
#[napi_derive::napi]
pub fn fit_content_with_suffix_json(
    content: String,
    max_bytes: f64,
    suffix: String,
    direction: String,
) -> String {
    use resultbudget::{fit_content_with_suffix, Direction};
    let dir = if direction == "tail" { Direction::Tail } else { Direction::Head };
    fit_content_with_suffix(&content, max_bytes.max(0.0) as usize, &suffix, dir)
}
