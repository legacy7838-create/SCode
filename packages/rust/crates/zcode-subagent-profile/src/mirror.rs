//! The subagent tool-event mirror, ported from `core/src/subagent/tool-event-mirror.ts`.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 2).
//!
//! This is what puts a child's tool activity into the PARENT session's timeline. It is
//! correctness rather than cosmetics: a child's permission request is answered through
//! the parent, so if the mirror drops it the child blocks until the run is cancelled.
//!
//! ## The tool-name cache is owned by the caller, not by this function
//!
//! A `tool_call_started` event often carries no `toolName`; the name was learned from the
//! matching `tool_call_scheduled`. TypeScript threads a `Map` through the context and
//! mutates it. Rust takes the map **by value and returns the updated one**, so there is
//! one owner and no shared mutable state across the boundary.

use serde_json::{Map, Value};

const SUBAGENT_TOOL_CALL_ID_PREFIX: &str = "tool_subagent";
const SUBAGENT_EVENT_SOURCE: &str = "subagent";

/// The tool lifecycle events that reach the parent timeline.
const MIRRORED_TOOL_EVENT_TYPES: [&str; 5] = [
    "tool_call_scheduled",
    "tool_call_started",
    "tool_call_progress",
    "tool_call_result",
    "tool_call_error",
];

/// Blocking interactions. Forwarded so the parent can answer them on the child's behalf.
const MIRRORED_INTERACTION_EVENT_TYPES: [&str; 3] = [
    "permission_requested",
    "permission_resolved",
    "permission_denied",
];

/// `SubagentInteractionOriginContext` plus the mirror's own fields.
#[derive(Debug, Default, Clone)]
pub struct MirrorContext {
    pub agent_id: String,
    pub agent_type: String,
    pub child_session_id: String,
    pub parent_session_id: String,
    pub parent_tool_call_id: Option<String>,
    pub parent_turn_id: Option<String>,
    pub description: Option<String>,
    pub background: bool,
}

/// The mirrored event plus the updated tool-name cache.
#[derive(Debug, Clone)]
pub struct MirrorOutcome {
    /// `None` when the event is not mirrored (wrong type, or no child tool call id).
    pub event: Option<Value>,
    /// The cache after this call, so the caller can carry it to the next event.
    pub tool_names: Map<String, Value>,
}

/// `mirrorSubagentToolEvent`.
pub fn mirror_subagent_tool_event(
    event: &Value,
    context: &MirrorContext,
    tool_names: &Map<String, Value>,
) -> MirrorOutcome {
    let mut names = tool_names.clone();
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();
    let is_tool = MIRRORED_TOOL_EVENT_TYPES.contains(&event_type);
    let is_interaction = MIRRORED_INTERACTION_EVENT_TYPES.contains(&event_type);
    if !is_tool && !is_interaction {
        return MirrorOutcome { event: None, tool_names: names };
    }

    let payload = as_record(event.get("payload"));
    let Some(child_tool_call_id) = string_field(&payload, "toolCallId") else {
        return MirrorOutcome { event: None, tool_names: names };
    };

    let tool_call_id = mirrored_tool_call_id(&context.agent_id, &child_tool_call_id);
    // The name is learned from whichever event carries it and reused afterwards.
    let tool_name = string_field(&payload, "toolName")
        .or_else(|| names.get(&child_tool_call_id).and_then(Value::as_str).map(str::to_string));
    if let Some(name) = &tool_name {
        names.insert(child_tool_call_id.clone(), Value::String(name.clone()));
    }

    let mut mirrored = payload.clone();
    mirrored.insert("toolCallId".into(), Value::String(tool_call_id));
    if let Some(name) = &tool_name {
        mirrored.insert("toolName".into(), Value::String(name.clone()));
    }

    if is_interaction {
        mirrored.insert(
            "childSessionId".into(),
            Value::String(context.child_session_id.clone()),
        );
        if context.background {
            mirrored.insert("background".into(), Value::Bool(true));
        }
        if event_type == "permission_requested" {
            let child_turn_id = event.get("turnId").and_then(Value::as_str);
            mirrored.insert(
                "origin".into(),
                build_interaction_origin(context, child_turn_id),
            );
        }
        return MirrorOutcome {
            event: Some(wrap_event(event, event_type, context, mirrored)),
            tool_names: names,
        };
    }

    for (key, value) in mirror_schedule_fields(&payload, &context.agent_id) {
        mirrored.insert(key, value);
    }
    mirrored.insert("agentId".into(), Value::String(context.agent_id.clone()));
    mirrored.insert("agentType".into(), Value::String(context.agent_type.clone()));
    if context.background {
        mirrored.insert("background".into(), Value::Bool(true));
    }
    mirrored.insert(
        "childSessionId".into(),
        Value::String(context.child_session_id.clone()),
    );
    mirrored.insert(
        "childToolCallId".into(),
        Value::String(child_tool_call_id),
    );
    if let Some(description) = &context.description {
        mirrored.insert("description".into(), Value::String(description.clone()));
    }
    if let Some(parent_tool_call_id) = &context.parent_tool_call_id {
        mirrored.insert(
            "parentToolCallId".into(),
            Value::String(parent_tool_call_id.clone()),
        );
    }
    mirrored.insert(
        "source".into(),
        Value::String(SUBAGENT_EVENT_SOURCE.to_string()),
    );

    MirrorOutcome {
        event: Some(wrap_event(event, event_type, context, mirrored)),
        tool_names: names,
    }
}

/// `createSessionEvent(type, parentSessionId, payload, { traceId, turnId })`.
///
/// The child event's `traceId` is preserved — the parent's timeline has to join the same
/// trace — while the session and turn become the parent's.
fn wrap_event(
    source_event: &Value,
    event_type: &str,
    context: &MirrorContext,
    payload: Map<String, Value>,
) -> Value {
    let mut out = Map::new();
    if let Some(id) = source_event.get("id") {
        out.insert("id".into(), id.clone());
    }
    out.insert(
        "sessionId".into(),
        Value::String(context.parent_session_id.clone()),
    );
    if let Some(parent_turn_id) = &context.parent_turn_id {
        out.insert("turnId".into(), Value::String(parent_turn_id.clone()));
    }
    out.insert("type".into(), Value::String(event_type.to_string()));
    out.insert("payload".into(), Value::Object(payload));
    if let Some(trace_id) = source_event.get("traceId") {
        out.insert("traceId".into(), trace_id.clone());
    }
    Value::Object(out)
}

/// Port of `buildSubagentInteractionOrigin`.
///
/// Public because the interaction broker builds the SAME origin object when it forwards
/// a child's permission request. One owner, two call sites — two implementations of one
/// concept would drift, and a drifted origin makes the parent's permission dialog point
/// at the wrong agent.
pub fn build_interaction_origin(context: &MirrorContext, child_turn_id: Option<&str>) -> Value {
    let mut origin = Map::new();
    origin.insert("kind".into(), Value::String("subagent".into()));
    origin.insert("agentId".into(), Value::String(context.agent_id.clone()));
    origin.insert("agentType".into(), Value::String(context.agent_type.clone()));
    origin.insert(
        "childSessionId".into(),
        Value::String(context.child_session_id.clone()),
    );
    if let Some(turn_id) = child_turn_id.filter(|id| !id.is_empty()) {
        origin.insert("childTurnId".into(), Value::String(turn_id.to_string()));
    }
    if let Some(description) = &context.description {
        origin.insert("description".into(), Value::String(description.clone()));
    }
    origin.insert(
        "parentSessionId".into(),
        Value::String(context.parent_session_id.clone()),
    );
    if let Some(parent_tool_call_id) = &context.parent_tool_call_id {
        origin.insert(
            "parentToolCallId".into(),
            Value::String(parent_tool_call_id.clone()),
        );
    }
    if let Some(parent_turn_id) = &context.parent_turn_id {
        origin.insert("parentTurnId".into(), Value::String(parent_turn_id.clone()));
    }
    Value::Object(origin)
}

/// Port of `mirrorScheduleFields`: rewrite every nested child tool call id.
fn mirror_schedule_fields(payload: &Map<String, Value>, agent_id: &str) -> Vec<(String, Value)> {
    let mut fields: Vec<(String, Value)> = Vec::new();

    if let Some(Value::Array(dependencies)) = payload.get("dependencies") {
        let mapped: Vec<Value> = dependencies
            .iter()
            .filter_map(|value| value.as_str())
            .map(|id| Value::String(mirrored_tool_call_id(agent_id, id)))
            .collect();
        fields.push(("dependencies".into(), Value::Array(mapped)));
    }

    let schedule = as_record(payload.get("schedule"));
    if !schedule.is_empty() {
        let mut rewritten = schedule.clone();
        let execution_order: Vec<Value> = schedule
            .get("executionOrder")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|value| value.as_str())
                    .map(|id| Value::String(mirrored_tool_call_id(agent_id, id)))
                    .collect()
            })
            .unwrap_or_default();
        rewritten.insert("executionOrder".into(), Value::Array(execution_order));

        let parallel_groups: Vec<Value> = schedule
            .get("parallelGroups")
            .and_then(Value::as_array)
            .map(|groups| {
                groups
                    .iter()
                    .map(|group| match group {
                        Value::Array(items) => Value::Array(
                            items
                                .iter()
                                .filter_map(|value| value.as_str())
                                .map(|id| Value::String(mirrored_tool_call_id(agent_id, id)))
                                .collect(),
                        ),
                        other => other.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        rewritten.insert("parallelGroups".into(), Value::Array(parallel_groups));
        fields.push(("schedule".into(), Value::Object(rewritten)));
    }

    fields
}

fn mirrored_tool_call_id(agent_id: &str, child_tool_call_id: &str) -> String {
    format!("{SUBAGENT_TOOL_CALL_ID_PREFIX}_{agent_id}_{child_tool_call_id}")
}

fn as_record(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn string_field(record: &Map<String, Value>, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::to_string)
}
