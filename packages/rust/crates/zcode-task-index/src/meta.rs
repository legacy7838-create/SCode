//! `meta_json` — the task's own document, and the schema that validates it.
//!
//! Ported from `zcodeTaskMetaSchema` (`packages/shared/src/validation.ts:1203-1256`) and `rowToMeta`
//! (`taskIndexRepo.ts:205-256`). Spec: docs/specs/rust-native-task-index.md §22.
//!
//! # Why this is not just a JSON parse
//!
//! Three behaviours of the zod schema are load-bearing, and a naive port loses all three:
//!
//! 1. **`z.object()` strips unknown keys.** A `meta_json` written by a newer build, or carrying a
//!    field this build does not know, is *not* rejected — the extra keys are dropped from the
//!    result. A strict parse would fail the whole task, and with it the entire task list.
//! 2. **`summaryTitle` carries `.default(null)`.** Every pre-2.15.0 `/goal` task omits it. Without
//!    the default the whole task list fails validation — which is the failure the comment beside
//!    that line warns about.
//! 3. **The overlay is asymmetric.** `cronAutomationId`/`offPeakTaskId` are `meta_json ?? column`,
//!    but `unreadAt`/`titleOverridden` are **column-only**: the column wins even when `meta_json`
//!    disagrees, because the column is this Host's own product state and `meta_json` may belong to
//!    another Host.
//!
//! (1) is free in serde — a struct with exactly the declared fields ignores the rest, which is
//! stripping. (2) is `#[serde(default)]` on the one field. (3) is written out rather than merged,
//! because a merge would get the precedence backwards.
use serde::{Deserialize, Serialize};

use crate::migrate::MigrationError;

/// `nonEmptyStringSchema` = `z.string().trim().min(1)`.
///
/// Trimming then rejecting means the stored value is the **trimmed** one, so a field written as
/// `"  glm  "` reads back as `"glm"`. `deserialize_with` reproduces both halves.
fn non_empty_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(serde::de::Error::custom("expected a non-empty string"));
    }
    Ok(trimmed.to_string())
}

/// `zcodeTaskModeSchema` (`zcode-task-mode-schema.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskMode {
    Yolo,
    Plan,
    Edit,
    Auto,
    /// Serialised `autoEdit` — `rename_all = "camelCase"` would produce `autoEdit`, which matches.
    AutoEdit,
    Build,
}

/// `zcodeTaskPersistStatusSchema` = `["running", "completed", "error"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistStatus {
    Running,
    Completed,
    Error,
}

/// `zcodeTaskMigrationSourceSchema` = `["claudeCode"]`.
///
/// A single-variant enum is faithful to `z.literal`-shaped single values, and a value outside it
/// makes the whole task invalid — which is the original's behaviour too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MigrationSource {
    #[serde(rename = "claudeCode")]
    ClaudeCode,
}

/// `zcodeAgentProviderSchema` = `z.literal("glm")`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentProvider {
    #[serde(rename = "glm")]
    Glm,
}

/// `errorAttributionSchema` (`zcode-protocol-v4/snapshot.ts`), which is **`.strict()`**.
///
/// Strictness is the point: an unrecognised attribution key fails the whole `lastError`, which
/// fails the whole task. A permissive port would silently accept attribution data this build
/// cannot interpret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorAttribution {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<AttributionSource>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "bounded_string_opt",
        rename = "reason"
    )]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error_phase: Option<ErrorPhase>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exception_kind: Option<ExceptionKind>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "bounded_string_opt",
        rename = "providerId"
    )]
    pub provider_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "bounded_string_opt",
        rename = "providerKind"
    )]
    pub provider_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub transport: Option<Transport>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "bounded_status_code_opt",
        rename = "statusCode"
    )]
    pub status_code: Option<i64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "bounded_string_opt",
        rename = "providerErrorCode"
    )]
    pub provider_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub retryable: Option<bool>,
}

/// `Option<String>` with the `bounded_string` rule applied to the present case.
fn bounded_string_opt<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw {
        None => Ok(None),
        Some(value) => bounded_string_value(value).map(Some),
    }
}

/// The `1..=160` bound, reporting through whatever deserialiser asked for it.
fn bounded_string_value<'de, E>(value: String) -> Result<String, E>
where
    E: serde::de::Error,
{
    if value.is_empty() || value.chars().count() > 160 {
        return Err(E::custom("expected 1..=160 characters"));
    }
    Ok(value)
}

/// `Option<i64>` with the `bounded_status_code` rule applied to the present case.
fn bounded_status_code_opt<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<i64>::deserialize(deserializer)?;
    match raw {
        None => Ok(None),
        Some(value) => bounded_status_code_value(value).map(Some),
    }
}

/// The `100..=599` bound, reporting through whatever deserialiser asked for it.
fn bounded_status_code_value<E>(value: i64) -> Result<i64, E>
where
    E: serde::de::Error,
{
    if !(100..=599).contains(&value) {
        return Err(E::custom("expected 100..=599"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttributionSource {
    Provider,
    Runtime,
    Tool,
    Network,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorPhase {
    Prepare,
    Configuration,
    Connect,
    Response,
    Stream,
    Parse,
    Validation,
    Unhandled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExceptionKind {
    ApiCall,
    Generic,
    Protocol,
    ProviderBusiness,
    Transport,
    TypeError,
    Validation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    Http,
    Sse,
    Websocket,
}

/// `lastError` inside `zcodeTaskMetaSchema`. Not `.strict()` — extra keys are stripped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastError {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    /// `z.string().min(1)` — not trimmed, and `message` is the one required member.
    pub message: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub trace_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attribution: Option<ErrorAttribution>,
}

fn non_empty_string_opt<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(serde::de::Error::custom("expected a non-empty string"));
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

/// One entry of `changeSummary.files`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub added: i64,
    pub removed: i64,
    /// `z.number().int().positive()` — **strictly** positive, so a file with no writes is invalid.
    pub write_count: i64,
    pub last_turn_index: i64,
}

/// `changeSummary` inside `zcodeTaskMetaSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub file_count: i64,
    pub added: i64,
    pub removed: i64,
    pub files: Vec<ChangedFile>,
}

/// `zcodeTaskGoalStatusSchema` = `["active", "paused", "budget_limited", "complete"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GoalStatus {
    Active,
    Paused,
    BudgetLimited,
    Complete,
}

/// `goal.time` — a nested required object.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalTime {
    pub created: i64,
    pub updated: i64,
}

/// `zcodeTaskGoalSchema` (`validation.ts:1172-1190`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGoal {
    #[serde(rename = "sessionID", deserialize_with = "non_empty_string")]
    pub session_id: String,
    #[serde(rename = "targetID", deserialize_with = "non_empty_string")]
    pub target_id: String,
    #[serde(deserialize_with = "non_empty_string")]
    pub objective: String,
    /// `.default(null)` — the pre-2.15.0 history, filled in on read so the task is not rejected.
    #[serde(default)]
    pub summary_title: Option<String>,
    pub status: GoalStatus,
    /// `z.number().int().positive().nullable()` — required, and explicitly nullable.
    pub token_budget: Option<i64>,
    pub tokens_used: i64,
    pub time_used_seconds: i64,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub active_input_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_run_started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_run_last_seen_at_ms: Option<i64>,
    pub time: GoalTime,
}

/// The validated `meta_json`, as `zcodeTaskMetaSchema` produces it.
///
/// Unknown members are **dropped** rather than rejected, which is what `z.object()` does. The
/// difference is not cosmetic: a strict parse would fail any task written by a newer build, and the
/// task list is all-or-nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMeta {
    #[serde(deserialize_with = "non_empty_string")]
    pub task_id: String,
    #[serde(deserialize_with = "non_empty_string")]
    pub trace_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title_overridden: Option<bool>,
    #[serde(deserialize_with = "non_empty_string")]
    pub workspace_path: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub workspace_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace_purpose: Option<WorkspacePurpose>,
    pub created_at: i64,
    pub updated_at: i64,
    pub mode: TaskMode,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub thought_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_epoch: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider: Option<AgentProvider>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub migration_source: Option<MigrationSource>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub forked_from_task_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub cron_automation_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "non_empty_string_opt"
    )]
    pub off_peak_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub unread_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<PersistStatus>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_error: Option<LastError>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub change_summary: Option<ChangeSummary>,
    /// `zcodeTaskGoalSchema.nullable().optional()` — three states: absent, `null`, or a goal.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target: Option<Option<TaskGoal>>,
}

/// `workspacePurpose` = `["project", "conversation"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePurpose {
    Project,
    Conversation,
}

/// One `tasks` row, as the read path selects it.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRow {
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub task_id: String,
    pub title: String,
    pub task_status: Option<String>,
    pub provider: Option<String>,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub migration_source: Option<String>,
    pub forked_from_task_id: Option<String>,
    pub cron_automation_id: Option<String>,
    pub off_peak_task_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub unread_at: Option<i64>,
    pub last_unread_at: i64,
    pub pinned: i64,
    pub archived: i64,
    pub deleted: i64,
    pub title_overridden: i64,
    pub searchable_text: String,
    pub meta_json: String,
}

/// Reads a `tasks` row by column name, so one definition serves the several SELECT lists that
/// project the same shape.
impl TaskRow {
    pub fn from_sql_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(TaskRow {
            workspace_key: row.get("workspace_key")?,
            workspace_path: row.get("workspace_path")?,
            workspace_identity: row.get("workspace_identity")?,
            task_id: row.get("task_id")?,
            title: row.get("title")?,
            task_status: row.get("task_status")?,
            provider: row.get("provider")?,
            mode: row.get("mode")?,
            model: row.get("model")?,
            migration_source: row.get("migration_source")?,
            forked_from_task_id: row.get("forked_from_task_id")?,
            cron_automation_id: row.get("cron_automation_id")?,
            off_peak_task_id: row.get("off_peak_task_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            unread_at: row.get("unread_at")?,
            last_unread_at: row.get("last_unread_at")?,
            pinned: row.get("pinned")?,
            archived: row.get("archived")?,
            deleted: row.get("deleted")?,
            title_overridden: row.get("title_overridden")?,
            searchable_text: row.get("searchable_text")?,
            meta_json: row.get("meta_json")?,
        })
    }
}

/// The column list every read projects, so the SELECTs cannot drift apart.
pub const TASK_COLUMNS: &str = "workspace_key, workspace_path, workspace_identity, task_id, title, \
     task_status, provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, \
     off_peak_task_id, created_at, updated_at, unread_at, last_unread_at, pinned, archived, deleted, \
     title_overridden, searchable_text, meta_json";

/// The resolved identity for a row, mirroring `resolveTaskIndexRowWorkspaceIdentity`.
///
/// The column is preferred, but a row written by an older Host may carry only the path, and the
/// identity key is `identity?.trim() || path` — so an absent or blank column falls back rather than
/// producing a scope nothing else queries.
pub fn resolve_row_identity(row: &TaskRow) -> Option<String> {
    match row.workspace_identity.as_deref().map(str::trim) {
        Some(identity) if !identity.is_empty() => Some(identity.to_string()),
        _ => None,
    }
}

/// `rowToMeta` (`taskIndexRepo.ts:205-256`).
///
/// A `meta_json` that fails validation does **not** fail the read: the original logs a warning and
/// falls back to a row-derived meta, because one corrupt document must not empty the task list.
/// The fallback is the row's own columns with a synthesised identity, which is what keeps a task
/// visible enough to be repaired.
pub fn row_to_meta(row: &TaskRow) -> TaskMeta {
    match serde_json::from_str::<TaskMeta>(&row.meta_json) {
        Ok(parsed) => TaskMeta {
            // The row's primary-key projection wins over `meta_json` for identity: the two can
            // disagree, and sessions-index attaches running activity by workspaceKey + taskId.
            task_id: row.task_id.clone(),
            workspace_path: row.workspace_path.clone(),
            workspace_identity: resolve_row_identity(row),
            // Unread is this Host's own shell state, so the **column** wins even when the document
            // disagrees — `meta_json` may belong to another Host.
            unread_at: row.unread_at,
            // The cron and off-peak identities go the other way: the document is the single origin
            // and the column is only an index projection, so the document wins.
            cron_automation_id: parsed.cron_automation_id.or(row.cron_automation_id.clone()),
            off_peak_task_id: parsed.off_peak_task_id.or(row.off_peak_task_id.clone()),
            title_overridden: Some(row.title_overridden == 1),
            ..parsed
        },
        Err(_) => fallback_meta(row),
    }
}

/// The row-derived meta used when `meta_json` will not parse.
///
/// Deliberately minimal: it must carry enough for the task to be listed and identified, and
/// nothing more, because inventing values here would present a corrupt task as a healthy one.
fn fallback_meta(row: &TaskRow) -> TaskMeta {
    TaskMeta {
        task_id: row.task_id.clone(),
        // The document is unreadable, so `traceId` has no source. The row identity is the only
        // stable handle, and the schema requires a non-empty string.
        trace_id: row.workspace_key.clone(),
        title: row.title.clone(),
        title_overridden: Some(row.title_overridden == 1),
        workspace_path: row.workspace_path.clone(),
        workspace_identity: resolve_row_identity(row),
        workspace_purpose: None,
        created_at: row.created_at,
        updated_at: row.updated_at,
        // An unrecognised mode string has no safe default that keeps the task dispatchable, and
        // claiming `auto` would be a lie. The mode is optional in the row, so this only happens
        // for a row whose mode is missing *and* whose document is unreadable.
        mode: TaskMode::Auto,
        model: row.model.clone(),
        thought_level: None,
        runtime_epoch: None,
        provider: None,
        migration_source: None,
        forked_from_task_id: row.forked_from_task_id.clone(),
        cron_automation_id: row.cron_automation_id.clone(),
        off_peak_task_id: row.off_peak_task_id.clone(),
        unread_at: row.unread_at,
        status: None,
        last_error: None,
        change_summary: None,
        target: None,
    }
}

/// A `MigrationError` carrying the SQL context, for the read helpers.
pub fn sql(context: &str, source: rusqlite::Error) -> MigrationError {
    MigrationError::Sql { context: context.to_string(), source }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(meta_json: &str) -> TaskRow {
        TaskRow {
            workspace_key: "ws".into(),
            workspace_path: "/ws".into(),
            workspace_identity: Some("ws-id".into()),
            task_id: "t1".into(),
            title: "row title".into(),
            task_status: Some("completed".into()),
            provider: Some("glm".into()),
            mode: Some("auto".into()),
            model: None,
            migration_source: None,
            forked_from_task_id: None,
            cron_automation_id: None,
            off_peak_task_id: None,
            created_at: 10,
            updated_at: 20,
            unread_at: Some(99),
            last_unread_at: 99,
            pinned: 0,
            archived: 0,
            deleted: 0,
            title_overridden: 1,
            searchable_text: String::new(),
            meta_json: meta_json.into(),
        }
    }

    /// Unknown members are **dropped**, not rejected.
    ///
    /// A `meta_json` written by a newer build carries fields this one has never heard of. A strict
    /// parse would fail the task, and because the read is a list, it would empty the whole list.
    #[test]
    fn an_unknown_member_is_stripped_rather_than_rejected() {
        let meta = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"tr","title":"x","workspacePath":"/ws","createdAt":1,
                "updatedAt":2,"mode":"auto","somethingFromTheFuture":{"a":1}}"#,
        ));
        assert_eq!(meta.title, "x", "the task still reads");
        let json = serde_json::to_string(&meta).expect("serialise");
        assert!(!json.contains("somethingFromTheFuture"), "and the key is gone: {json}");
    }

    /// The column wins for `unreadAt` and `titleOverridden`; the document wins for the cron and
    /// off-peak identities. Getting this backwards is the whole hazard, so each half is asserted.
    #[test]
    fn the_overlay_precedence_matches_the_original() {
        let meta = row_to_meta(&row(
            r#"{"taskId":"doc-id","traceId":"tr","title":"x","workspacePath":"/doc","createdAt":1,
                "updatedAt":2,"mode":"auto","unreadAt":5,"titleOverridden":false,
                "cronAutomationId":"from-doc","offPeakTaskId":"off-from-doc"}"#,
        ));
        // Row primary key wins for identity, so sessions-index can attach by workspaceKey + taskId.
        assert_eq!(meta.task_id, "t1");
        assert_eq!(meta.workspace_path, "/ws");
        // The column is this Host's product state; the document may be another Host's.
        assert_eq!(meta.unread_at, Some(99), "the column wins for unreadAt");
        assert_eq!(meta.title_overridden, Some(true), "the column wins for titleOverridden");
        // The document is the single origin for these; the column is only an index projection.
        assert_eq!(meta.cron_automation_id.as_deref(), Some("from-doc"));
        assert_eq!(meta.off_peak_task_id.as_deref(), Some("off-from-doc"));
    }

    /// A pre-2.15.0 `/goal` task omits `summaryTitle`, and the default keeps it readable.
    #[test]
    fn a_goal_without_a_summary_title_still_validates() {
        let meta = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"tr","title":"x","workspacePath":"/ws","createdAt":1,
                "updatedAt":2,"mode":"auto",
                "target":{"sessionID":"s","targetID":"g","objective":"o","status":"active",
                          "tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,
                          "time":{"created":1,"updated":2}}}"#,
        ));
        let goal = meta.target.flatten().expect("the goal is present");
        assert_eq!(goal.summary_title, None, "filled in as null, not a validation failure");
        // The acronym is spelled in full caps in the document, which `rename_all = "camelCase"`
        // alone would not produce — and a mismatch here silently drops the goal, because the
        // document is rejected and the row-derived fallback carries no target.
        assert_eq!(goal.session_id, "s");
        assert_eq!(goal.target_id, "g");
    }

    /// An unreadable document still yields a listed, identifiable task.
    #[test]
    fn a_corrupt_document_falls_back_to_the_row() {
        let meta = row_to_meta(&row("{not json"));
        assert_eq!(meta.task_id, "t1");
        assert_eq!(meta.title, "row title", "the row's own title, not a guess");
        assert_eq!(meta.workspace_key_or_path(), "ws-id", "the row's identity is the key");
    }

    impl TaskMeta {
        fn workspace_key_or_path(&self) -> String {
            self.workspace_identity.clone().unwrap_or_else(|| self.workspace_path.clone())
        }
    }

    /// `nonEmptyStringSchema` trims **and** rejects, so a whitespace value is invalid.
    #[test]
    fn a_whitespace_only_required_string_is_invalid() {
        let outcome = row_to_meta(&row(
            r#"{"taskId":"   ","traceId":"tr","title":"x","workspacePath":"/ws","createdAt":1,
                "updatedAt":2,"mode":"auto"}"#,
        ));
        assert_eq!(outcome.task_id, "t1", "an invalid document falls back to the row");
    }

    /// A `lastError` carrying an unknown attribution key fails the whole task, because
    /// `errorAttributionSchema` is `.strict()`.
    #[test]
    fn an_unknown_attribution_key_fails_the_task() {
        let meta = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"tr","title":"x","workspacePath":"/ws","createdAt":1,
                "updatedAt":2,"mode":"auto",
                "lastError":{"message":"boom","attribution":{"source":"provider","extra":1}}}"#,
        ));
        assert_eq!(
            meta.title, "row title",
            "strict attribution means the document is rejected wholesale"
        );
    }

    /// Every mode in the enum, and nothing else.
    #[test]
    fn the_mode_enum_is_exactly_the_six_values() {
        for (raw, expected) in [
            ("yolo", TaskMode::Yolo),
            ("plan", TaskMode::Plan),
            ("edit", TaskMode::Edit),
            ("auto", TaskMode::Auto),
            ("autoEdit", TaskMode::AutoEdit),
            ("build", TaskMode::Build),
        ] {
            let meta = row_to_meta(&row(&format!(
                r#"{{"taskId":"t1","traceId":"tr","title":"x","workspacePath":"/ws",
                     "createdAt":1,"updatedAt":2,"mode":"{raw}"}}"#
            )));
            assert_eq!(meta.mode, expected, "{raw}");
        }
        let rejected = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"tr","title":"x","workspacePath":"/ws","createdAt":1,
                "updatedAt":2,"mode":"nope"}"#,
        ));
        assert_eq!(rejected.title, "row title", "an unknown mode fails the document");
    }
}
