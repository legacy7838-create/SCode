//! The automation repository: every method of `packages/services/src/session/automationRepo.ts`.
//!
//! Ported from `automationRepo.ts` (1,489 lines). Spec:
//! docs/specs/rust-native-task-index.md §15, §27.
//!
//! # One file, one implementation
//!
//! `automationRepo.ts` used to open its own `node:sqlite` connection to
//! `~/.zcode/v2/tasks-index.sqlite` (`automationRepo.ts:283`) — the last of the three
//! repositories to own a connection. This module is the replacement: it is a facade over the
//! same connection `TaskIndexStore` owns, so one language owns the file and its migration
//! ledger.
//!
//! There is **no JavaScript fallback** (`docs/specs/rust-native-ports.md` invariant 1). The
//! TypeScript wrapper keeps exactly three things, because they are not storage: the
//! `ensureReady` handshake, the identity rule (`workspaceIdentity?.trim() || workspacePath`),
//! and the `Date.now()` defaults. Everything else — the schema, the guarded writes, the
//! scheduling state machine, the run ledger, the `rowToAutomation`/`rowToRun` projections and
//! the validation the repository performed as the final persistence boundary — lives here.
//!
//! # The subtle parts, kept intact
//!
//! * **Backoff is not bypassed.** `claim_due` retires expired rows first, reclaims zombie
//!   claims, then takes each due row with a compare-and-swap. A retry keeps `next_run_at`, so
//!   `scheduled_at` — and therefore the run id — is stable and a retry upserts its run row.
//! * **`enabled` is derived from `lifecycle_status`** on update, but only when the caller
//!   actually changes the lifecycle. The original comment records the bug: retaining
//!   `existing.enabled` on `completed`/`failed` let a terminal automation be claimed again.
//! * **`mark_run_outcome` never overwrites a settled outcome with `running`.** The `CASE`
//!   guards it, and both branches read the **old** `outcome` column because SQLite evaluates
//!   an UPDATE against the pre-update row.
//! * **`mark_manual_run_dispatched` is idempotent at `dispatched`.** A direct host, a scheduler
//!   crash recovery and a late report can all settle the same run; only the first increments
//!   the cumulative count.

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::automation::{
    AutomationStore, CLAIMED_DISPATCH_STATUS, CLAIM_STALE_MS,
};
use crate::migrate::MigrationError;
use crate::offpeak::{parse_model_selection, ModelSelection};

/// Dispatch-failure backoff constants (`automationRepo.ts:36-39`).
pub const DISPATCH_RETRY_BASE_MS: i64 = 30_000;
pub const DISPATCH_RETRY_CAP_MS: i64 = 15 * 60_000;
pub const DISPATCH_MAX_ATTEMPTS: i64 = 5;

/// The product ceiling (`automation-types.ts:11-12`).
pub const AUTOMATION_CREATE_LIMIT: i64 = 20;
pub const AUTOMATION_CREATE_LIMIT_ERROR_CODE: &str = "AUTOMATION_CREATE_LIMIT_REACHED";

/// `zcodeTaskModeSchema` (`zcode-task-mode-schema.ts:6`).
pub const TASK_MODES: [&str; 6] = ["yolo", "plan", "edit", "auto", "autoEdit", "build"];

/// `assertValidAutomationMode` and `normalizeAutomationMode` (`automationRepo.ts:118-135`).
pub fn is_valid_task_mode(mode: &str) -> bool {
    TASK_MODES.contains(&mode)
}

/// `normalizeAutomationMode` — a historical dirty value is read as "not set" rather than
/// failing the whole list.
pub fn normalize_mode(mode: Option<&str>) -> Option<String> {
    mode.filter(|value| is_valid_task_mode(value))
        .map(str::to_string)
}

/// `assertValidAutomationMode` — reading a dirty value is tolerated, writing one is not.
pub fn assert_valid_mode(mode: Option<&str>) -> Result<(), AutomationError> {
    match mode {
        Some(value) if !is_valid_task_mode(value) => {
            Err(AutomationError::InvalidMode(value.to_string()))
        }
        _ => Ok(()),
    }
}

/// `computeRetryAt` (`automationRepo.ts:150-156`) — `now + min(BASE * 2^(attempts-1), CAP)`.
///
/// The exponent is clamped so a corrupt `attempts` cannot overflow the shift; anything at or
/// above the clamp already saturates past the cap, so the result is the cap either way.
pub fn compute_retry_at(now: i64, attempts: i64) -> i64 {
    let exponent = (attempts - 1).max(0).min(62) as u32;
    let backoff = DISPATCH_RETRY_BASE_MS.saturating_mul(1_i64 << exponent);
    now + backoff.min(DISPATCH_RETRY_CAP_MS)
}

/// A repository failure. Typed so the caller can distinguish the product-level outcomes (the
/// creation ceiling, a missing pinned selection) from a storage fault rather than matching on
/// message text.
#[derive(Debug)]
pub enum AutomationError {
    /// The underlying sqlite statement failed.
    Storage(MigrationError),
    /// A write carried a mode outside the closed set.
    InvalidMode(String),
    /// The local task index is at the product ceiling.
    CreateLimit,
    /// Dispatch needs a pinned selection and the row has neither one nor the `"null"` marker.
    UnavailableSelection(String),
    /// A run with no pinned selection was asked to settle.
    MissingRunSelection(String),
    /// A malformed stored value (a `schedule_rule` that is not JSON).
    Invalid(String),
    /// The automation does not exist or does not belong to the requested workspace.
    NotFound(String),
}

impl std::fmt::Display for AutomationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AutomationError::Storage(error) => write!(f, "{error}"),
            AutomationError::InvalidMode(mode) => write!(f, "Invalid automation mode: {mode}"),
            AutomationError::CreateLimit => write!(
                f,
                "[{AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most {AUTOMATION_CREATE_LIMIT} \
                 automations may be retained. Delete an existing automation before creating \
                 another."
            ),
            AutomationError::UnavailableSelection(id) => write!(
                f,
                "Automation model selection is unavailable; pick a model and thought level again \
                 ({id})"
            ),
            AutomationError::MissingRunSelection(id) => write!(
                f,
                "Automation run does not exist or has no pinned model selection: {id}"
            ),
            AutomationError::Invalid(message) => write!(f, "{message}"),
            AutomationError::NotFound(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for AutomationError {}

impl From<MigrationError> for AutomationError {
    fn from(error: MigrationError) -> Self {
        AutomationError::Storage(error)
    }
}

fn storage(context: &str, source: rusqlite::Error) -> MigrationError {
    MigrationError::Sql {
        context: context.into(),
        source,
    }
}

/// One `automations` row, in full. The projection the repository publishes is [`Automation`].
#[derive(Debug, Clone, PartialEq)]
pub struct AutomationRecord {
    pub automation_id: String,
    pub title: String,
    pub cron_expr: String,
    pub prompt: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub mode: Option<String>,
    pub thought_level: Option<String>,
    pub model_selection: Option<String>,
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub target_task_id: Option<String>,
    pub bot_delivery_target: Option<String>,
    pub location_kind: String,
    pub recurring: i64,
    pub max_runs: Option<i64>,
    pub end_at: Option<i64>,
    pub schedule_rule: Option<String>,
    pub schedule_edited_by_user: i64,
    pub run_count: i64,
    pub scheduled_run_count: i64,
    pub enabled: i64,
    pub lifecycle_status: String,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub running: i64,
    pub claimed_at: Option<i64>,
    pub dispatch_status: String,
    pub dispatch_attempts: i64,
    pub retry_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AutomationRecord {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AutomationRecord {
            automation_id: row.get("automation_id")?,
            title: row.get("title")?,
            cron_expr: row.get("cron_expr")?,
            prompt: row.get("prompt")?,
            model: row.get("model")?,
            provider: row.get("provider")?,
            mode: row.get("mode")?,
            thought_level: row.get("thought_level")?,
            model_selection: row.get("model_selection")?,
            workspace_key: row.get("workspace_key")?,
            workspace_path: row.get("workspace_path")?,
            workspace_identity: row.get("workspace_identity")?,
            target_task_id: row.get("target_task_id")?,
            bot_delivery_target: row.get("bot_delivery_target")?,
            location_kind: row.get("location_kind")?,
            recurring: row.get("recurring")?,
            max_runs: row.get("max_runs")?,
            end_at: row.get("end_at")?,
            schedule_rule: row.get("schedule_rule")?,
            schedule_edited_by_user: row.get("schedule_edited_by_user")?,
            run_count: row.get("run_count")?,
            scheduled_run_count: row.get("scheduled_run_count")?,
            enabled: row.get("enabled")?,
            lifecycle_status: row.get("lifecycle_status")?,
            next_run_at: row.get("next_run_at")?,
            last_run_at: row.get("last_run_at")?,
            running: row.get("running")?,
            claimed_at: row.get("claimed_at")?,
            dispatch_status: row.get("dispatch_status")?,
            dispatch_attempts: row.get("dispatch_attempts")?,
            retry_at: row.get("retry_at")?,
            last_error: row.get("last_error")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

/// One `automation_runs` row, in full.
#[derive(Debug, Clone, PartialEq)]
pub struct AutomationRunRecord {
    pub run_id: String,
    pub automation_id: String,
    pub workspace_key: String,
    pub scheduled_at: Option<i64>,
    pub trigger: String,
    pub model_selection: Option<String>,
    pub dispatch_status: String,
    pub outcome: Option<String>,
    pub session_id: Option<String>,
    pub error: Option<String>,
    pub attempts: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AutomationRunRecord {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AutomationRunRecord {
            run_id: row.get("run_id")?,
            automation_id: row.get("automation_id")?,
            workspace_key: row.get("workspace_key")?,
            scheduled_at: row.get("scheduled_at")?,
            trigger: row.get("trigger")?,
            model_selection: row.get("model_selection")?,
            dispatch_status: row.get("dispatch_status")?,
            outcome: row.get("outcome")?,
            session_id: row.get("session_id")?,
            error: row.get("error")?,
            attempts: row.get("attempts")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

/// The repository's read model, mirroring `ZCodeAutomation`.
///
/// Optional members are **omitted**, never sent as `null`, because the original mapped every
/// absent column through `?? undefined` and a consumer may test `'field' in automation`. The
/// field order matches the original's object literal so a captured transcript compares
/// key-for-key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub automation_id: String,
    pub title: String,
    pub cron_expr: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ModelSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub workspace_key: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_task_id: Option<String>,
    pub location_kind: String,
    pub recurring: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_rule: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_edited_by_user: Option<bool>,
    pub run_count: i64,
    pub enabled: bool,
    pub lifecycle_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    pub dispatch_status: String,
    pub dispatch_attempts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Automation {
    /// `rowToAutomation` (`automationRepo.ts:89-125`).
    pub fn from_record(record: &AutomationRecord) -> Result<Self, AutomationError> {
        let model_selection = parse_model_selection(record.model_selection.as_deref());
        // Historical versions wrote empty strings into `mode`; the original read them as "not
        // set" rather than forcing the enumeration and failing the whole list.
        let mode = normalize_mode(record.mode.as_deref());
        // `row.schedule_rule ? JSON.parse(row.schedule_rule) : undefined` — an empty string is
        // falsy, and invalid JSON throws, which the port keeps rather than silently dropping.
        let schedule_rule = match record.schedule_rule.as_deref() {
            None | Some("") => None,
            Some(raw) => Some(serde_json::from_str(raw).map_err(|error| {
                AutomationError::Invalid(format!("invalid automation schedule_rule: {error}"))
            })?),
        };
        Ok(Automation {
            automation_id: record.automation_id.clone(),
            title: record.title.clone(),
            cron_expr: record.cron_expr.clone(),
            prompt: record.prompt.clone(),
            model_selection,
            mode,
            workspace_key: record.workspace_key.clone(),
            workspace_path: record.workspace_path.clone(),
            workspace_identity: record.workspace_identity.clone(),
            target_task_id: record.target_task_id.clone(),
            location_kind: if record.location_kind == "remote" {
                "remote".to_string()
            } else {
                "local".to_string()
            },
            recurring: record.recurring == 1,
            max_runs: record.max_runs,
            end_at: record.end_at,
            schedule_rule,
            schedule_edited_by_user: (record.schedule_edited_by_user == 1).then_some(true),
            run_count: record.run_count,
            enabled: record.enabled == 1,
            lifecycle_status: record.lifecycle_status.clone(),
            next_run_at: record.next_run_at,
            last_run_at: record.last_run_at,
            dispatch_status: record.dispatch_status.clone(),
            dispatch_attempts: record.dispatch_attempts,
            retry_at: record.retry_at,
            last_error: record.last_error.clone(),
            created_at: record.created_at,
            updated_at: record.updated_at,
        })
    }
}

/// The repository's run read model, mirroring `ZCodeAutomationRun`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub run_id: String,
    pub automation_id: String,
    pub workspace_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<i64>,
    pub trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ModelSelection>,
    pub dispatch_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub attempts: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AutomationRun {
    /// `rowToRun` (`automationRepo.ts:137-154`).
    pub fn from_record(record: &AutomationRunRecord) -> Self {
        AutomationRun {
            run_id: record.run_id.clone(),
            automation_id: record.automation_id.clone(),
            workspace_key: record.workspace_key.clone(),
            scheduled_at: record.scheduled_at,
            trigger: record.trigger.clone(),
            model_selection: parse_model_selection(record.model_selection.as_deref()),
            dispatch_status: record.dispatch_status.clone(),
            outcome: record.outcome.clone(),
            session_id: record.session_id.clone(),
            error: record.error.clone(),
            attempts: record.attempts,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

/// `ClaimedManualAutomationRun` (`automationRepo.ts:82-85`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedManualAutomationRun {
    pub automation: Automation,
    pub run: AutomationRun,
}

/// `zcodeAutomationBotDeliveryTargetSchema` (`bots.ts:41-48`).
///
/// The fields are trimmed and the two enums are closed, matching the zod schema. An invalid
/// stored target is `None`, so a corrupt source can never reach the Bot dispatcher.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotDeliveryTarget {
    pub provider: String,
    pub bot_id: String,
    pub provider_user_id: String,
    pub chat_type: String,
}

pub fn parse_bot_delivery_target(raw: Option<&str>) -> Option<BotDeliveryTarget> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed: BotDeliveryTarget = serde_json::from_str(raw).ok()?;
    let provider = parsed.provider.trim();
    let chat_type = parsed.chat_type.trim();
    let bot_id = parsed.bot_id.trim();
    let provider_user_id = parsed.provider_user_id.trim();
    if !matches!(provider, "feishu" | "lark" | "weixin") {
        return None;
    }
    if !matches!(chat_type, "private" | "group") {
        return None;
    }
    if bot_id.is_empty() || provider_user_id.is_empty() {
        return None;
    }
    Some(BotDeliveryTarget {
        provider: provider.to_string(),
        bot_id: bot_id.to_string(),
        provider_user_id: provider_user_id.to_string(),
        chat_type: chat_type.to_string(),
    })
}

/// `serializeAutomationModelSelection` (`automationRepo.ts:99-112`).
///
/// Re-serialising through [`parse_model_selection`] is deliberate: that is the one validator,
/// and running the value through it reproduces zod's `.trim()` / `.strict()` / non-empty rules
/// instead of inventing a second set.
fn serialize_selection(
    selection: Option<&ModelSelection>,
) -> Result<Option<String>, AutomationError> {
    let Some(selection) = selection else {
        return Ok(None);
    };
    let raw = serde_json::to_string(selection)
        .map_err(|error| AutomationError::Invalid(error.to_string()))?;
    let normalized = parse_model_selection(Some(&raw))
        .ok_or_else(|| AutomationError::Invalid("invalid model selection".to_string()))?;
    serde_json::to_string(&normalized)
        .map(Some)
        .map_err(|error| AutomationError::Invalid(error.to_string()))
}

/// `true` when the value is present but `null` — the tri-state "clear" arm.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

/// The parameters of [`AutomationRepository::create`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAutomationRequest {
    /// Minted by the wrapper (`automation-${randomUUID()}`), because the crate does not own
    /// randomness.
    pub automation_id: String,
    pub title: String,
    pub cron_expr: String,
    pub prompt: String,
    pub model_selection: Option<ModelSelection>,
    pub mode: Option<String>,
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub target_task_id: Option<String>,
    pub bot_delivery_target: Option<BotDeliveryTarget>,
    pub recurring: bool,
    pub max_runs: Option<i64>,
    pub end_at: Option<i64>,
    pub schedule_rule: Option<Value>,
    /// `options.lifecycleStatus`; absent means `active`.
    pub lifecycle_status: Option<String>,
    /// `options.nextRunAt`.
    pub next_run_at: Option<i64>,
    pub now: i64,
}

/// The parameters of [`AutomationRepository::update`].
///
/// The tri-state fields distinguish an absent value (`null` in the outer `Option`), an explicit
/// `null` (the inner `None`) and a value. Collapsing them is a silent data-loss bug: an absent
/// field must keep its stored value, while an explicit `null` clears it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAutomationRequest {
    pub automation_id: String,
    pub workspace_key: Option<String>,
    pub title: Option<String>,
    pub cron_expr: Option<String>,
    pub prompt: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub model_selection: Option<Option<ModelSelection>>,
    #[serde(default, deserialize_with = "double_option")]
    pub mode: Option<Option<String>>,
    pub recurring: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub max_runs: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub end_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub schedule_rule: Option<Option<Value>>,
    pub schedule_edited_by_user: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub next_run_at: Option<Option<i64>>,
    pub lifecycle_status: Option<String>,
    #[serde(default)]
    pub reset_retry: bool,
    pub now: i64,
}

/// The scoped-by-id requests, unified so the napi layer has one shape per call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationScopeRequest {
    pub automation_id: String,
    pub workspace_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationListRequest {
    pub workspace_key: Option<String>,
}

/// `getModelSelectionForDispatch` — the dispatch path always names a workspace.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchSelectionRequest {
    pub automation_id: String,
    pub workspace_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetEnabledRequest {
    pub automation_id: String,
    pub enabled: bool,
    pub workspace_key: Option<String>,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestartRequest {
    pub automation_id: String,
    pub next_run_at: Option<i64>,
    pub workspace_key: Option<String>,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PruneRunsRequest {
    pub max_age_ms: i64,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRequest {
    pub workspace_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HasTaskBindingRequest {
    pub workspace_key: String,
    pub target_task_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunNowRequest {
    pub automation_id: String,
    pub workspace_key: Option<String>,
    /// `${automationId}:manual:${randomUUID()}`.
    pub run_id: String,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkDispatchedRequest {
    pub automation_id: String,
    pub dispatched_at: i64,
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkDispatchFailedRequest {
    pub automation_id: String,
    pub failed_at: i64,
    pub error: String,
    pub kind: String,
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseClaimRequest {
    pub automation_id: String,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManualClaimRequest {
    pub automation_id: String,
    pub workspace_key: String,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TouchManualClaimRequest {
    pub automation_id: String,
    pub workspace_key: String,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkipAndRescheduleRequest {
    pub automation_id: String,
    pub run_id: String,
    pub workspace_key: String,
    pub scheduled_at: Option<i64>,
    pub reason: String,
    pub next_run_at: Option<i64>,
    #[serde(default)]
    pub finalize: bool,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnsureRunClaimedRequest {
    pub run_id: String,
    pub automation_id: String,
    pub workspace_key: String,
    pub scheduled_at: Option<i64>,
    pub trigger: String,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertRunClaimedRequest {
    pub run_id: String,
    pub automation_id: String,
    pub workspace_key: String,
    pub scheduled_at: Option<i64>,
    pub trigger: String,
    pub model_selection: Option<ModelSelection>,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixRunModelSelectionRequest {
    pub run_id: String,
    pub model_selection: ModelSelection,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkRunDispatchRequest {
    pub run_id: String,
    pub dispatch_status: String,
    pub session_id: Option<String>,
    pub error: Option<String>,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkManualRunDispatchedRequest {
    pub run_id: String,
    pub session_id: Option<String>,
    pub dispatched_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkRunOutcomeRequest {
    pub run_id: String,
    pub outcome: String,
    pub error: Option<String>,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordSkippedRunRequest {
    pub run_id: String,
    pub automation_id: String,
    pub workspace_key: String,
    pub scheduled_at: Option<i64>,
    pub trigger: String,
    pub reason: String,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRunsRequest {
    pub automation_id: String,
    pub workspace_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteRunRequest {
    pub run_id: String,
    pub workspace_key: Option<String>,
}

/// The automation repository over the store's connection.
pub struct AutomationRepository;

impl AutomationRepository {
    /// `getRow` (`automationRepo.ts:301-312`).
    ///
    /// A `workspaceKey` forces ownership; an absent one is the scheduler's cross-workspace path.
    pub fn get_record(
        conn: &Connection,
        automation_id: &str,
        workspace_key: Option<&str>,
    ) -> Result<Option<AutomationRecord>, AutomationError> {
        let mut statement = conn
            .prepare(
                "SELECT * FROM automations
                 WHERE automation_id = ?1
                   AND (?2 IS NULL OR workspace_key = ?2)",
            )
            .map_err(|source| storage("automations", source))?;
        let mut rows = statement
            .query_map(rusqlite::params![automation_id, workspace_key], AutomationRecord::from_row)
            .map_err(|source| storage("automations", source))?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|source| storage("automations", source))?)),
            None => Ok(None),
        }
    }

    /// `get` (`automationRepo.ts:472-476`) — one automation, or `null`.
    pub fn get(
        conn: &Connection,
        automation_id: &str,
        workspace_key: Option<&str>,
    ) -> Result<Option<Automation>, AutomationError> {
        Self::get_record(conn, automation_id, workspace_key)?
            .map(|record| Automation::from_record(&record))
            .transpose()
    }

    /// `create` (`automationRepo.ts:315-395`).
    ///
    /// The count guard and the insert are one `BEGIN IMMEDIATE`: two windows creating at once
    /// would otherwise both read the old count and both pass the ceiling.
    pub fn create(
        conn: &mut Connection,
        request: &CreateAutomationRequest,
    ) -> Result<Automation, AutomationError> {
        assert_valid_mode(request.mode.as_deref())?;
        let model_selection =
            serialize_selection(request.model_selection.as_ref())?.unwrap_or_else(|| "null".to_string());
        let bot_delivery_target = match request.bot_delivery_target.as_ref() {
            None => None,
            Some(target) => Some(
                serde_json::to_string(target)
                    .map_err(|error| AutomationError::Invalid(error.to_string()))?,
            ),
        };
        let schedule_rule = match request.schedule_rule.as_ref() {
            None => None,
            Some(rule) => Some(
                serde_json::to_string(rule)
                    .map_err(|error| AutomationError::Invalid(error.to_string()))?,
            ),
        };
        let enabled = if request.lifecycle_status.as_deref() == Some("completed") {
            0
        } else {
            1
        };
        let lifecycle_status = request
            .lifecycle_status
            .clone()
            .unwrap_or_else(|| "active".to_string());

        let transaction = conn
            .transaction()
            .map_err(|source| storage("automations", source))?;
        let count: i64 = transaction
            .query_row("SELECT COUNT(*) AS count FROM automations", [], |row| row.get(0))
            .map_err(|source| storage("automations", source))?;
        if count >= AUTOMATION_CREATE_LIMIT {
            return Err(AutomationError::CreateLimit);
        }
        transaction
            .execute(
                "INSERT INTO automations (
                   automation_id, title, cron_expr, prompt, model, provider, model_selection,
                   workspace_key, workspace_path, workspace_identity, target_task_id, bot_delivery_target, location_kind,
                   recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
                   run_count, enabled, lifecycle_status,
                   next_run_at, last_run_at, running, claimed_at,
                   dispatch_status, dispatch_attempts, retry_at, last_error,
                   mode, thought_level,
                   created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, NULL, NULL, ?5,
                   ?6, ?7, ?8, ?9, ?10, 'local',
                   ?11, ?12, ?13, ?14, 0,
                   0, ?15, ?16,
                   ?17, NULL, 0, NULL,
                   'idle', 0, NULL, NULL,
                   ?18, NULL,
                   ?19, ?19
                 )",
                rusqlite::params![
                    request.automation_id,
                    request.title,
                    request.cron_expr,
                    request.prompt,
                    model_selection,
                    request.workspace_key,
                    request.workspace_path,
                    request.workspace_identity,
                    request.target_task_id,
                    bot_delivery_target,
                    i64::from(request.recurring),
                    request.max_runs,
                    request.end_at,
                    schedule_rule,
                    enabled,
                    lifecycle_status,
                    request.next_run_at,
                    request.mode,
                    request.now,
                ],
            )
            .map_err(|source| storage("automations", source))?;
        transaction
            .commit()
            .map_err(|source| storage("automations", source))?;
        Self::get(conn, &request.automation_id, None)?
            .ok_or_else(|| AutomationError::Invalid("the automation vanished after insert".into()))
    }

    /// `list` (`automationRepo.ts:397-416`).
    pub fn list(
        conn: &Connection,
        workspace_key: Option<&str>,
    ) -> Result<Vec<Automation>, AutomationError> {
        let mut statement = conn
            .prepare(
                "SELECT * FROM automations
                 WHERE (?1 IS NULL OR workspace_key = ?1)
                 ORDER BY created_at DESC",
            )
            .map_err(|source| storage("automations", source))?;
        let rows = statement
            .query_map([workspace_key], AutomationRecord::from_row)
            .map_err(|source| storage("automations", source))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(Automation::from_record(
                &row.map_err(|source| storage("automations", source))?,
            )?);
        }
        Ok(out)
    }

    /// `getModelSelectionForDispatch` (`automationRepo.ts:418-439`).
    ///
    /// Three outcomes, and the middle one is the point: a valid selection is returned, the
    /// literal `"null"` marker means "follow the workspace", and anything else is an error.
    /// A dispatch must never treat a corrupt value as "follow the default".
    pub fn get_model_selection_for_dispatch(
        conn: &Connection,
        automation_id: &str,
        workspace_key: &str,
    ) -> Result<Option<ModelSelection>, AutomationError> {
        let record = Self::get_record(conn, automation_id, Some(workspace_key))?.ok_or_else(|| {
            AutomationError::NotFound(
                "Automation does not exist or does not belong to this workspace".to_string(),
            )
        })?;
        if let Some(selection) = parse_model_selection(record.model_selection.as_deref()) {
            return Ok(Some(selection));
        }
        if record.model_selection.as_deref() == Some("null") {
            return Ok(None);
        }
        Err(AutomationError::UnavailableSelection(
            automation_id.to_string(),
        ))
    }

    /// `getBotDeliveryTarget` (`automationRepo.ts:441-461`).
    pub fn get_bot_delivery_target(
        conn: &Connection,
        automation_id: &str,
        workspace_key: Option<&str>,
    ) -> Result<Option<BotDeliveryTarget>, AutomationError> {
        let Some(record) = Self::get_record(conn, automation_id, workspace_key)? else {
            return Ok(None);
        };
        Ok(parse_bot_delivery_target(record.bot_delivery_target.as_deref()))
    }

    /// `hasTaskBinding` (`automationRepo.ts:463-479`).
    ///
    /// The authorization criterion itself, scoped by workspace key. The original comment warns
    /// that serialising the whole list to answer it would let a corrupt display field break a
    /// security query.
    pub fn has_task_binding(
        conn: &Connection,
        workspace_key: &str,
        target_task_id: &str,
    ) -> Result<bool, AutomationError> {
        let mut statement = conn
            .prepare(
                "SELECT 1 AS bound FROM automations
                 WHERE workspace_key = ?1 AND target_task_id = ?2
                 LIMIT 1",
            )
            .map_err(|source| storage("automations", source))?;
        let mut rows = statement
            .query(rusqlite::params![workspace_key, target_task_id])
            .map_err(|source| storage("automations", source))?;
        Ok(rows
            .next()
            .map_err(|source| storage("automations", source))?
            .is_some())
    }

    /// `getScheduledRunCount` (`automationRepo.ts:481-486`).
    pub fn scheduled_run_count(
        conn: &Connection,
        automation_id: &str,
        workspace_key: Option<&str>,
    ) -> Result<Option<i64>, AutomationError> {
        Ok(Self::get_record(conn, automation_id, workspace_key)?.map(|row| row.scheduled_run_count))
    }

    /// `update` (`automationRepo.ts:492-573`).
    pub fn update(
        conn: &Connection,
        request: &UpdateAutomationRequest,
    ) -> Result<Option<Automation>, AutomationError> {
        if let Some(mode) = request.mode.as_ref().and_then(|mode| mode.as_deref()) {
            assert_valid_mode(Some(mode))?;
        }
        let Some(mut next) = Self::get_record(conn, &request.automation_id, request.workspace_key.as_deref())?
        else {
            return Ok(None);
        };
        if let Some(title) = &request.title {
            next.title = title.clone();
        }
        if let Some(cron_expr) = &request.cron_expr {
            next.cron_expr = cron_expr.clone();
        }
        if let Some(prompt) = &request.prompt {
            next.prompt = prompt.clone();
        }
        // The legacy `model` / `provider` / `thought_level` columns are a rollback snapshot and
        // are never touched by an ordinary edit.
        match &request.model_selection {
            None => {}
            Some(None) => next.model_selection = Some("null".to_string()),
            Some(Some(selection)) => {
                next.model_selection = serialize_selection(Some(selection))?;
            }
        }
        match &request.mode {
            None => {}
            Some(None) => next.mode = None,
            Some(Some(mode)) => next.mode = Some(mode.clone()),
        }
        if let Some(recurring) = request.recurring {
            next.recurring = i64::from(recurring);
        }
        match request.max_runs {
            None => {}
            Some(value) => next.max_runs = value,
        }
        match request.end_at {
            None => {}
            Some(value) => next.end_at = value,
        }
        match &request.schedule_rule {
            None => {}
            Some(None) => next.schedule_rule = None,
            Some(Some(rule)) => {
                next.schedule_rule = Some(
                    serde_json::to_string(rule)
                        .map_err(|error| AutomationError::Invalid(error.to_string()))?,
                );
            }
        }
        if let Some(edited) = request.schedule_edited_by_user {
            next.schedule_edited_by_user = i64::from(edited);
        }
        match request.next_run_at {
            None => {}
            Some(value) => next.next_run_at = value,
        }
        if let Some(lifecycle) = &request.lifecycle_status {
            next.lifecycle_status = lifecycle.clone();
            // `enabled` is completely derived from the lifecycle and is only touched when the
            // caller explicitly changes it. Retaining the old value on `completed`/`failed`
            // was the original bug: a terminal automation stayed claimable.
            next.enabled = i64::from(lifecycle == "active");
        }
        if request.reset_retry {
            next.dispatch_attempts = 0;
            next.retry_at = None;
            next.dispatch_status = "idle".to_string();
        }
        next.updated_at = request.now;

        Self::write_row(conn, &next)?;
        Ok(Some(Automation::from_record(&next)?))
    }

    /// `writeRow` (`automationRepo.ts:1409-1461`).
    pub fn write_row(conn: &Connection, row: &AutomationRecord) -> Result<(), AutomationError> {
        conn.execute(
            "UPDATE automations SET
               title = ?2, cron_expr = ?3, prompt = ?4, model = ?5, provider = ?6,
               model_selection = ?7,
               mode = ?8, thought_level = ?9,
               recurring = ?10, max_runs = ?11, end_at = ?12,
               schedule_rule = ?13,
               schedule_edited_by_user = ?14,
               next_run_at = ?15, lifecycle_status = ?16,
               dispatch_attempts = ?17, retry_at = ?18, dispatch_status = ?19,
               enabled = ?20, updated_at = ?21
             WHERE automation_id = ?1",
            rusqlite::params![
                row.automation_id,
                row.title,
                row.cron_expr,
                row.prompt,
                row.model,
                row.provider,
                row.model_selection,
                row.mode,
                row.thought_level,
                row.recurring,
                row.max_runs,
                row.end_at,
                row.schedule_rule,
                row.schedule_edited_by_user,
                row.next_run_at,
                row.lifecycle_status,
                row.dispatch_attempts,
                row.retry_at,
                row.dispatch_status,
                row.enabled,
                row.updated_at,
            ],
        )
        .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `delete` (`automationRepo.ts:575-586`).
    pub fn delete(
        conn: &Connection,
        automation_id: &str,
        workspace_key: Option<&str>,
    ) -> Result<bool, AutomationError> {
        let changed = conn
            .execute(
                "DELETE FROM automations
                 WHERE automation_id = ?1
                   AND (?2 IS NULL OR workspace_key = ?2)",
                rusqlite::params![automation_id, workspace_key],
            )
            .map_err(|source| storage("automations", source))?;
        Ok(changed > 0)
    }

    /// `setEnabled` (`automationRepo.ts:588-606`).
    pub fn set_enabled(
        conn: &Connection,
        automation_id: &str,
        enabled: bool,
        workspace_key: Option<&str>,
        now: i64,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "UPDATE automations
             SET enabled = ?2,
                 lifecycle_status = ?3,
                 updated_at = ?4
             WHERE automation_id = ?1
               AND (?5 IS NULL OR workspace_key = ?5)",
            rusqlite::params![
                automation_id,
                i64::from(enabled),
                if enabled { "active" } else { "paused" },
                now,
                workspace_key,
            ],
        )
        .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `restart` (`automationRepo.ts:608-638`).
    pub fn restart(
        conn: &Connection,
        automation_id: &str,
        next_run_at: Option<i64>,
        workspace_key: Option<&str>,
        now: i64,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "UPDATE automations
             SET lifecycle_status = 'active',
                 enabled = 1,
                 run_count = 0,
                 scheduled_run_count = 0,
                 dispatch_attempts = 0,
                 retry_at = NULL,
                 dispatch_status = 'idle',
                 running = 0,
                 claimed_at = NULL,
                 next_run_at = ?2,
                 last_error = NULL,
                 updated_at = ?3
             WHERE automation_id = ?1
               AND (?4 IS NULL OR workspace_key = ?4)",
            rusqlite::params![automation_id, next_run_at, now, workspace_key],
        )
        .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `runNow` (`automationRepo.ts:640-722`).
    ///
    /// Run-now briefly takes the automation's single-flight lock, so a click cannot dispatch the
    /// same target concurrently with a scheduled trigger. `attempts = 1` records that the run was
    /// already handed to the direct dispatcher; the scheduler only recovers it if the claim times
    /// out.
    pub fn run_now(
        conn: &mut Connection,
        request: &RunNowRequest,
    ) -> Result<Option<ClaimedManualAutomationRun>, AutomationError> {
        let transaction = conn
            .transaction()
            .map_err(|source| storage("automations", source))?;
        transaction
            .execute(
                "UPDATE automations
                 SET running = 0, claimed_at = NULL
                 WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?1",
                [request.now - CLAIM_STALE_MS],
            )
            .map_err(|source| storage("automations", source))?;

        let Some(record) = Self::get_record(&transaction, &request.automation_id, request.workspace_key.as_deref())?
        else {
            transaction
                .commit()
                .map_err(|source| storage("automations", source))?;
            return Ok(None);
        };

        let claimed = transaction
            .execute(
                "UPDATE automations
                 SET running = 1, claimed_at = ?2, updated_at = ?2
                 WHERE automation_id = ?1
                   AND running = 0
                   AND (?3 IS NULL OR workspace_key = ?3)",
                rusqlite::params![request.automation_id, request.now, request.workspace_key],
            )
            .map_err(|source| storage("automations", source))?;
        if claimed != 1 {
            transaction
                .commit()
                .map_err(|source| storage("automations", source))?;
            return Ok(None);
        }

        transaction
            .execute(
                "INSERT INTO automation_runs (
                   run_id, automation_id, workspace_key, scheduled_at, trigger,
                   model_selection, dispatch_status, attempts, created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, 'manual',
                   NULL, 'claimed', 1, ?5, ?5
                 )",
                rusqlite::params![
                    request.run_id,
                    request.automation_id,
                    record.workspace_key,
                    request.now,
                    request.now,
                ],
            )
            .map_err(|source| storage("automation_runs", source))?;
        transaction
            .commit()
            .map_err(|source| storage("automations", source))?;

        let mut automation = Automation::from_record(&record)?;
        automation.updated_at = request.now;
        Ok(Some(ClaimedManualAutomationRun {
            automation,
            run: AutomationRun {
                run_id: request.run_id.clone(),
                automation_id: request.automation_id.clone(),
                workspace_key: record.workspace_key,
                scheduled_at: Some(request.now),
                trigger: "manual".to_string(),
                model_selection: None,
                dispatch_status: "claimed".to_string(),
                outcome: None,
                session_id: None,
                error: None,
                attempts: 1,
                created_at: request.now,
                updated_at: request.now,
            },
        }))
    }

    /// `claimDue` (`automationRepo.ts:730-792`), returning the read model.
    ///
    /// Reuses the low-level primitives so the backoff guard has one owner. `dispatch_status` is
    /// set to `claimed` in the returned object, but `updatedAt` stays the pre-claim value — the
    /// original spread did not overwrite it, and the differential transcript would catch the
    /// difference.
    pub fn claim_due(conn: &mut Connection, now: i64) -> Result<Vec<Automation>, AutomationError> {
        let transaction = conn
            .transaction()
            .map_err(|source| storage("automations", source))?;
        AutomationStore::release_expired(&transaction, now)?;
        AutomationStore::release_zombie_claims(&transaction, now)?;
        let due = AutomationStore::list_due(&transaction, now)?;
        let mut claimed = Vec::new();
        for row in due {
            let record = Self::get_record(&transaction, &row.automation_id, None)?;
            if AutomationStore::claim(&transaction, &row.automation_id, now)? {
                if let Some(record) = record {
                    let mut automation = Automation::from_record(&record)?;
                    automation.dispatch_status = CLAIMED_DISPATCH_STATUS.to_string();
                    claimed.push(automation);
                }
            }
        }
        transaction
            .commit()
            .map_err(|source| storage("automations", source))?;
        Ok(claimed)
    }

    /// `claimManualRuns` (`automationRepo.ts:794-955`).
    pub fn claim_manual_runs(
        conn: &mut Connection,
        now: i64,
    ) -> Result<Vec<ClaimedManualAutomationRun>, AutomationError> {
        let transaction = conn
            .transaction()
            .map_err(|source| storage("automations", source))?;
        transaction
            .execute(
                "UPDATE automations
                 SET running = 0, claimed_at = NULL
                 WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?1",
                [now - CLAIM_STALE_MS],
            )
            .map_err(|source| storage("automations", source))?;

        let pairs: Vec<(String, String)> = {
            let mut statement = transaction
                .prepare(
                    "SELECT r.run_id AS run_id, r.automation_id AS automation_id
                     FROM automation_runs r
                     JOIN automations a ON a.automation_id = r.automation_id
                     WHERE r.trigger = 'manual'
                       AND r.dispatch_status = 'claimed'
                       AND a.running = 0
                       AND (r.attempts = 0 OR r.updated_at <= ?1)
                     ORDER BY r.created_at ASC",
                )
                .map_err(|source| storage("automation_runs", source))?;
            let rows = statement
                .query_map([now - CLAIM_STALE_MS], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|source| storage("automation_runs", source))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|source| storage("automation_runs", source))?);
            }
            out
        };

        let mut claimed = Vec::new();
        for (run_id, automation_id) in pairs {
            // Read both rows **before** the claim so the reported values are the ones the caller
            // acted on, not the claim's own `running` / `attempts` / `updated_at` write.
            let automation_record = Self::get_record(&transaction, &automation_id, None)?;
            let run_record = Self::get_run_record(&transaction, &run_id)?;
            let changed = transaction
                .execute(
                    "UPDATE automations
                     SET running = 1, claimed_at = ?2, updated_at = ?2
                     WHERE automation_id = ?1 AND running = 0",
                    rusqlite::params![automation_id, now],
                )
                .map_err(|source| storage("automations", source))?;
            if changed != 1 {
                continue;
            }
            transaction
                .execute(
                    "UPDATE automation_runs
                     SET attempts = attempts + 1, updated_at = ?2
                     WHERE run_id = ?1 AND trigger = 'manual' AND dispatch_status = 'claimed'",
                    rusqlite::params![run_id, now],
                )
                .map_err(|source| storage("automation_runs", source))?;
            let (Some(automation_record), Some(run_record)) = (automation_record, run_record) else {
                continue;
            };
            let mut automation = Automation::from_record(&automation_record)?;
            automation.updated_at = now;
            let mut run = AutomationRun::from_record(&run_record);
            run.attempts += 1;
            run.updated_at = now;
            claimed.push(ClaimedManualAutomationRun { automation, run });
        }
        transaction
            .commit()
            .map_err(|source| storage("automations", source))?;
        Ok(claimed)
    }

    /// `markDispatched` (`automationRepo.ts:957-1017`).
    pub fn mark_dispatched(
        conn: &Connection,
        request: &MarkDispatchedRequest,
    ) -> Result<(), AutomationError> {
        let Some(row) = Self::get_record(conn, &request.automation_id, None)? else {
            return Ok(());
        };
        let run_count = row.run_count + 1;
        let scheduled_run_count = row.scheduled_run_count + 1;
        // A finite task reaching its cap is completed. Without an explicit `max_runs` a one-shot
        // is treated as a single run; otherwise its cron would keep firing forever. The separate
        // `scheduled_run_count` exists because `run_count` also counts manual runs.
        let reached_max = row.recurring == 0 && scheduled_run_count >= row.max_runs.unwrap_or(1);
        let reached_end = row
            .end_at
            .is_some_and(|end_at| request.next_run_at.unwrap_or(i64::MAX) > end_at);
        let terminal = reached_max || reached_end;
        conn.execute(
            "UPDATE automations
             SET run_count = ?2,
                 scheduled_run_count = ?3,
                 last_run_at = ?4,
                 dispatch_status = 'dispatched',
                 dispatch_attempts = 0,
                 retry_at = NULL,
                 last_error = NULL,
                 running = 0,
                 claimed_at = NULL,
                 lifecycle_status = ?5,
                 enabled = ?6,
                 next_run_at = ?7,
                 updated_at = ?4
             WHERE automation_id = ?1",
            rusqlite::params![
                request.automation_id,
                run_count,
                scheduled_run_count,
                request.dispatched_at,
                if terminal { "completed" } else { "active" },
                i64::from(!terminal),
                if terminal { None } else { request.next_run_at },
            ],
        )
        .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `markDispatchFailed` (`automationRepo.ts:1019-1097`).
    pub fn mark_dispatch_failed(
        conn: &Connection,
        request: &MarkDispatchFailedRequest,
    ) -> Result<(), AutomationError> {
        let Some(row) = Self::get_record(conn, &request.automation_id, None)? else {
            return Ok(());
        };
        let now = request.failed_at;
        if request.kind == "permanent" {
            conn.execute(
                "UPDATE automations
                 SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
                     enabled = 0, running = 0, claimed_at = NULL,
                     last_error = ?2, updated_at = ?3
                 WHERE automation_id = ?1",
                rusqlite::params![request.automation_id, request.error, now],
            )
            .map_err(|source| storage("automations", source))?;
            return Ok(());
        }
        let attempts = row.dispatch_attempts + 1;
        if attempts >= DISPATCH_MAX_ATTEMPTS {
            if row.recurring == 1 {
                // Recurring: give up this round, skip to the next normal fire point, return idle.
                conn.execute(
                    "UPDATE automations
                     SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
                         running = 0, claimed_at = NULL, next_run_at = ?2,
                         last_error = ?3, updated_at = ?4
                     WHERE automation_id = ?1",
                    rusqlite::params![
                        request.automation_id,
                        request.next_run_at,
                        request.error,
                        now,
                    ],
                )
                .map_err(|source| storage("automations", source))?;
            } else {
                conn.execute(
                    "UPDATE automations
                     SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
                         enabled = 0, running = 0, claimed_at = NULL,
                         last_error = ?2, updated_at = ?3
                     WHERE automation_id = ?1",
                    rusqlite::params![request.automation_id, request.error, now],
                )
                .map_err(|source| storage("automations", source))?;
            }
            return Ok(());
        }
        conn.execute(
            "UPDATE automations
             SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = ?2,
                 retry_at = ?3, running = 0, claimed_at = NULL,
                 last_error = ?4, updated_at = ?5
             WHERE automation_id = ?1",
            rusqlite::params![
                request.automation_id,
                attempts,
                compute_retry_at(now, attempts),
                request.error,
                now,
            ],
        )
        .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `releaseManualClaim` (`automationRepo.ts:1105-1118`).
    pub fn release_manual_claim(
        conn: &Connection,
        request: &ReleaseManualClaimRequest,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "UPDATE automations
             SET running = 0, claimed_at = NULL, updated_at = ?3
             WHERE automation_id = ?1
               AND workspace_key = ?2
               AND running = 1",
            rusqlite::params![request.automation_id, request.workspace_key, request.now],
        )
        .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `touchManualClaim` (`automationRepo.ts:1120-1130`).
    pub fn touch_manual_claim(
        conn: &Connection,
        request: &TouchManualClaimRequest,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "UPDATE automations
             SET claimed_at = ?3, updated_at = ?3
             WHERE automation_id = ?1
               AND workspace_key = ?2
               AND running = 1",
            rusqlite::params![request.automation_id, request.workspace_key, request.now],
        )
        .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `skipAndReschedule` (`automationRepo.ts:1132-1204`).
    pub fn skip_and_reschedule(
        conn: &mut Connection,
        request: &SkipAndRescheduleRequest,
    ) -> Result<(), AutomationError> {
        let transaction = conn
            .transaction()
            .map_err(|source| storage("automations", source))?;
        transaction
            .execute(
                "INSERT INTO automation_runs (
                   run_id, automation_id, workspace_key, scheduled_at, trigger,
                   dispatch_status, error, attempts, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'schedule', 'skipped', ?5, 0, ?6, ?6)
                 ON CONFLICT(run_id) DO UPDATE SET
                   dispatch_status = 'skipped',
                   error = excluded.error,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    request.run_id,
                    request.automation_id,
                    request.workspace_key,
                    request.scheduled_at,
                    request.reason,
                    request.now,
                ],
            )
            .map_err(|source| storage("automation_runs", source))?;
        if request.finalize {
            transaction
                .execute(
                    "UPDATE automations
                     SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
                         running = 0, claimed_at = NULL,
                         dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
                         updated_at = ?2
                     WHERE automation_id = ?1",
                    rusqlite::params![request.automation_id, request.now],
                )
                .map_err(|source| storage("automations", source))?;
        } else {
            transaction
                .execute(
                    "UPDATE automations
                     SET next_run_at = ?2, running = 0, claimed_at = NULL,
                         dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
                         updated_at = ?3
                     WHERE automation_id = ?1",
                    rusqlite::params![request.automation_id, request.next_run_at, request.now],
                )
                .map_err(|source| storage("automations", source))?;
        }
        transaction
            .commit()
            .map_err(|source| storage("automations", source))?;
        Ok(())
    }

    /// `ensureRunClaimed` (`automationRepo.ts:1208-1235`).
    pub fn ensure_run_claimed(
        conn: &Connection,
        request: &EnsureRunClaimedRequest,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "INSERT INTO automation_runs (
               run_id, automation_id, workspace_key, scheduled_at, trigger,
               dispatch_status, attempts, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'claimed', 0, ?6, ?6)
             ON CONFLICT(run_id) DO NOTHING",
            rusqlite::params![
                request.run_id,
                request.automation_id,
                request.workspace_key,
                request.scheduled_at,
                request.trigger,
                request.now,
            ],
        )
        .map_err(|source| storage("automation_runs", source))?;
        Ok(())
    }

    /// `upsertRunClaimed` (`automationRepo.ts:1237-1272`).
    pub fn upsert_run_claimed(
        conn: &Connection,
        request: &UpsertRunClaimedRequest,
    ) -> Result<(), AutomationError> {
        let model_selection = serialize_selection(request.model_selection.as_ref())?;
        conn.execute(
            "INSERT INTO automation_runs (
               run_id, automation_id, workspace_key, scheduled_at, trigger,
               model_selection, dispatch_status, attempts, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'claimed', 0, ?7, ?7)
             ON CONFLICT(run_id) DO UPDATE SET
               dispatch_status = 'claimed',
               model_selection = COALESCE(automation_runs.model_selection, excluded.model_selection),
               outcome = NULL,
               error = NULL,
               attempts = attempts + 1,
               updated_at = excluded.updated_at",
            rusqlite::params![
                request.run_id,
                request.automation_id,
                request.workspace_key,
                request.scheduled_at,
                request.trigger,
                model_selection,
                request.now,
            ],
        )
        .map_err(|source| storage("automation_runs", source))?;
        Ok(())
    }

    /// `fixRunModelSelection` (`automationRepo.ts:1274-1301`).
    pub fn fix_run_model_selection(
        conn: &Connection,
        request: &FixRunModelSelectionRequest,
    ) -> Result<ModelSelection, AutomationError> {
        let Some(serialized) = serialize_selection(Some(&request.model_selection))? else {
            return Err(AutomationError::MissingRunSelection(request.run_id.clone()));
        };
        conn.execute(
            "UPDATE automation_runs
             SET model_selection = COALESCE(model_selection, ?2), updated_at = ?3
             WHERE run_id = ?1",
            rusqlite::params![request.run_id, serialized, request.now],
        )
        .map_err(|source| storage("automation_runs", source))?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT model_selection FROM automation_runs WHERE run_id = ?1",
                [&request.run_id],
                |row| row.get(0),
            )
            .map_err(|source| storage("automation_runs", source))?;
        parse_model_selection(raw.as_deref())
            .ok_or_else(|| AutomationError::MissingRunSelection(request.run_id.clone()))
    }

    /// `markRunDispatch` (`automationRepo.ts:1303-1326`).
    pub fn mark_run_dispatch(
        conn: &Connection,
        request: &MarkRunDispatchRequest,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "UPDATE automation_runs
             SET dispatch_status = ?2,
                 session_id = COALESCE(?3, session_id),
                 error = ?4,
                 updated_at = ?5
             WHERE run_id = ?1",
            rusqlite::params![
                request.run_id,
                request.dispatch_status,
                request.session_id,
                request.error,
                request.now,
            ],
        )
        .map_err(|source| storage("automation_runs", source))?;
        Ok(())
    }

    /// `markManualRunDispatched` (`automationRepo.ts:1328-1385`).
    ///
    /// The first transition into `dispatched` is the idempotency boundary: a later settlement of
    /// the same run must not increment `run_count` a second time.
    pub fn mark_manual_run_dispatched(
        conn: &mut Connection,
        request: &MarkManualRunDispatchedRequest,
    ) -> Result<bool, AutomationError> {
        let transaction = conn
            .transaction()
            .map_err(|source| storage("automations", source))?;
        let run: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT automation_id, workspace_key, dispatch_status
                 FROM automation_runs
                 WHERE run_id = ?1 AND trigger = 'manual'",
                [&request.run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(storage("automation_runs", other)),
            })?;
        let Some((automation_id, workspace_key, dispatch_status)) = run else {
            transaction
                .commit()
                .map_err(|source| storage("automations", source))?;
            return Ok(false);
        };
        if dispatch_status == "dispatched" {
            transaction
                .commit()
                .map_err(|source| storage("automations", source))?;
            return Ok(false);
        }
        transaction
            .execute(
                "UPDATE automation_runs
                 SET dispatch_status = 'dispatched',
                     session_id = COALESCE(?2, session_id),
                     error = NULL,
                     updated_at = ?3
                 WHERE run_id = ?1 AND trigger = 'manual' AND dispatch_status <> 'dispatched'",
                rusqlite::params![request.run_id, request.session_id, request.dispatched_at],
            )
            .map_err(|source| storage("automation_runs", source))?;
        let automation_update = transaction
            .execute(
                "UPDATE automations
                 SET run_count = run_count + 1,
                     last_run_at = ?3,
                     updated_at = ?3
                 WHERE automation_id = ?1 AND workspace_key = ?2",
                rusqlite::params![automation_id, workspace_key, request.dispatched_at],
            )
            .map_err(|source| storage("automations", source))?;
        transaction
            .commit()
            .map_err(|source| storage("automations", source))?;
        Ok(automation_update > 0)
    }

    /// `markRunOutcome` (`automationRepo.ts:1387-1407`).
    ///
    /// The `CASE` guard is load-bearing: both branches read the **old** `outcome` column, so a
    /// late `running` report cannot overwrite a settled `succeeded` / `failed` / `stopped`.
    pub fn mark_run_outcome(
        conn: &Connection,
        request: &MarkRunOutcomeRequest,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "UPDATE automation_runs
             SET outcome = CASE
                   WHEN ?2 = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN outcome
                   ELSE ?2
                 END,
                 error = CASE
                   WHEN ?2 = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN error
                   ELSE COALESCE(?3, error)
                 END,
                 updated_at = ?4
             WHERE run_id = ?1",
            rusqlite::params![request.run_id, request.outcome, request.error, request.now],
        )
        .map_err(|source| storage("automation_runs", source))?;
        Ok(())
    }

    /// `recordSkippedRun` (`automationRepo.ts:1409-1444`).
    pub fn record_skipped_run(
        conn: &Connection,
        request: &RecordSkippedRunRequest,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "INSERT INTO automation_runs (
               run_id, automation_id, workspace_key, scheduled_at, trigger,
               dispatch_status, error, attempts, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'skipped', ?6, 0, ?7, ?7)
             ON CONFLICT(run_id) DO UPDATE SET
               dispatch_status = 'skipped',
               error = excluded.error,
               updated_at = excluded.updated_at",
            rusqlite::params![
                request.run_id,
                request.automation_id,
                request.workspace_key,
                request.scheduled_at,
                request.trigger,
                request.reason,
                request.now,
            ],
        )
        .map_err(|source| storage("automation_runs", source))?;
        Ok(())
    }

    /// `listRuns` (`automationRepo.ts:1446-1465`).
    pub fn list_runs(
        conn: &Connection,
        automation_id: &str,
        workspace_key: Option<&str>,
    ) -> Result<Vec<AutomationRun>, AutomationError> {
        let mut statement = conn
            .prepare(
                "SELECT * FROM automation_runs
                 WHERE automation_id = ?1
                   AND (?2 IS NULL OR workspace_key = ?2)
                 ORDER BY created_at DESC",
            )
            .map_err(|source| storage("automation_runs", source))?;
        let rows = statement
            .query_map(rusqlite::params![automation_id, workspace_key], AutomationRunRecord::from_row)
            .map_err(|source| storage("automation_runs", source))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(AutomationRun::from_record(
                &row.map_err(|source| storage("automation_runs", source))?,
            ));
        }
        Ok(out)
    }

    /// `getRun` (`automationRepo.ts:1467-1474`).
    pub fn get_run(conn: &Connection, run_id: &str) -> Result<Option<AutomationRun>, AutomationError> {
        Ok(Self::get_run_record(conn, run_id)?.map(|record| AutomationRun::from_record(&record)))
    }

    pub fn get_run_record(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Option<AutomationRunRecord>, AutomationError> {
        let mut statement = conn
            .prepare("SELECT * FROM automation_runs WHERE run_id = ?1")
            .map_err(|source| storage("automation_runs", source))?;
        let mut rows = statement
            .query_map([run_id], AutomationRunRecord::from_row)
            .map_err(|source| storage("automation_runs", source))?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|source| storage("automation_runs", source))?)),
            None => Ok(None),
        }
    }

    /// `deleteRun` (`automationRepo.ts:1476-1486`).
    pub fn delete_run(
        conn: &Connection,
        run_id: &str,
        workspace_key: Option<&str>,
    ) -> Result<(), AutomationError> {
        conn.execute(
            "DELETE FROM automation_runs
             WHERE run_id = ?1
               AND (?2 IS NULL OR workspace_key = ?2)",
            rusqlite::params![run_id, workspace_key],
        )
        .map_err(|source| storage("automation_runs", source))?;
        Ok(())
    }

    /// `pruneRuns` (`automationRepo.ts:1488-1495`).
    pub fn prune_runs(conn: &Connection, max_age_ms: i64, now: i64) -> Result<i64, AutomationError> {
        let deleted = conn
            .execute(
                "DELETE FROM automation_runs WHERE created_at < ?1",
                [now - max_age_ms],
            )
            .map_err(|source| storage("automation_runs", source))?;
        Ok(deleted as i64)
    }

    /// `releaseClaim` (`automationRepo.ts:1099-1103`).
    pub fn release_claim(
        conn: &Connection,
        automation_id: &str,
        now: i64,
    ) -> Result<bool, AutomationError> {
        Ok(AutomationStore::release_claim(conn, automation_id, now)?)
    }
}

/// The shared DDL, so the unit tests and the real-database test agree with the live file.
#[cfg(test)]
pub const TEST_SCHEMA: &str = "
    CREATE TABLE automations (
      automation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT, provider TEXT, mode TEXT, thought_level TEXT, model_selection TEXT,
      workspace_key TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_identity TEXT,
      target_task_id TEXT,
      bot_delivery_target TEXT,
      location_kind TEXT NOT NULL DEFAULT 'local',
      recurring INTEGER NOT NULL DEFAULT 1,
      max_runs INTEGER,
      end_at INTEGER,
      schedule_rule TEXT,
      schedule_edited_by_user INTEGER NOT NULL DEFAULT 0,
      run_count INTEGER NOT NULL DEFAULT 0,
      scheduled_run_count INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      lifecycle_status TEXT NOT NULL DEFAULT 'active',
      next_run_at INTEGER, last_run_at INTEGER,
      running INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      dispatch_status TEXT NOT NULL DEFAULT 'idle',
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      scheduled_at INTEGER,
      trigger TEXT NOT NULL,
      model_selection TEXT,
      dispatch_status TEXT NOT NULL,
      outcome TEXT,
      session_id TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );";

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(TEST_SCHEMA).expect("schema");
        conn
    }

    fn request(id: &str) -> CreateAutomationRequest {
        CreateAutomationRequest {
            automation_id: id.to_string(),
            title: "t".to_string(),
            cron_expr: "0 9 * * *".to_string(),
            prompt: "p".to_string(),
            model_selection: None,
            mode: None,
            workspace_key: "/ws".to_string(),
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            target_task_id: None,
            bot_delivery_target: None,
            recurring: true,
            max_runs: None,
            end_at: None,
            schedule_rule: None,
            lifecycle_status: None,
            next_run_at: Some(1_000),
            now: 0,
        }
    }

    #[test]
    fn an_absent_selection_is_persisted_as_the_null_marker() {
        let mut conn = memory();
        let automation = AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        assert_eq!(
            AutomationRepository::get_record(&conn, "a1", None)
                .expect("read")
                .expect("present")
                .model_selection
                .as_deref(),
            Some("null"),
            "the explicit \"null\" marker is what separates 'follow the workspace' from a corrupt cell"
        );
        assert!(automation.model_selection.is_none());
    }

    #[test]
    fn the_create_ceiling_is_enforced_transactionally() {
        let mut conn = memory();
        for index in 0..AUTOMATION_CREATE_LIMIT {
            AutomationRepository::create(&mut conn, &request(&format!("a{index}"))).expect("create");
        }
        let error = AutomationRepository::create(&mut conn, &request("overflow")).expect_err("ceiling");
        assert!(matches!(error, AutomationError::CreateLimit));
        assert!(error
            .to_string()
            .contains(AUTOMATION_CREATE_LIMIT_ERROR_CODE));
    }

    #[test]
    fn an_invalid_mode_is_refused_on_write_and_normalised_on_read() {
        // A dirty stored value reads as "not set" rather than failing the list.
        let mut conn = memory();
        let mut dirty = request("dirty");
        dirty.mode = Some("legacy-garbage".to_string());
        // Writing it is refused.
        let error = AutomationRepository::create(&mut conn, &dirty).expect_err("invalid mode");
        assert!(matches!(error, AutomationError::InvalidMode(_)));
        // If it is already in the table, the read normalises it away.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, mode, created_at, updated_at)
             VALUES ('dirty', '0 9 * * *', 'p', '/ws', '/ws', 'legacy-garbage', 0, 0)",
            [],
        )
        .expect("insert");
        let listed = AutomationRepository::list(&conn, None).expect("list");
        assert!(listed[0].mode.is_none());
    }

    #[test]
    fn get_model_selection_for_dispatch_distinguishes_the_three_cases() {
        let mut conn = memory();
        // Valid selection -> returned.
        let mut valid = request("valid");
        valid.model_selection = Some(ModelSelection {
            provider_id: "zai".to_string(),
            model_id: "glm-4.6".to_string(),
            options: None,
        });
        AutomationRepository::create(&mut conn, &valid).expect("create valid");
        let selection =
            AutomationRepository::get_model_selection_for_dispatch(&conn, "valid", "/ws").expect("read");
        assert_eq!(selection.expect("selection").model_id, "glm-4.6");

        // The "null" marker -> follow the workspace.
        AutomationRepository::create(&mut conn, &request("follows")).expect("create follows");
        let follows =
            AutomationRepository::get_model_selection_for_dispatch(&conn, "follows", "/ws").expect("read");
        assert!(follows.is_none());

        // Anything else -> an error, never treated as "follow the default".
        conn.execute(
            "UPDATE automations SET model_selection = '{\"providerId\":\"\"}' WHERE automation_id = 'follows'",
            [],
        )
        .expect("corrupt");
        let error = AutomationRepository::get_model_selection_for_dispatch(&conn, "follows", "/ws")
            .expect_err("corrupt selection");
        assert!(matches!(error, AutomationError::UnavailableSelection(_)));
    }

    #[test]
    fn has_task_binding_is_scoped_by_workspace_and_target() {
        let mut conn = memory();
        let mut bound = request("bound");
        bound.target_task_id = Some("task-1".to_string());
        AutomationRepository::create(&mut conn, &bound).expect("create");
        assert!(AutomationRepository::has_task_binding(&conn, "/ws", "task-1").expect("probe"));
        assert!(!AutomationRepository::has_task_binding(&conn, "/ws", "task-2").expect("probe"));
        assert!(!AutomationRepository::has_task_binding(&conn, "/other", "task-1").expect("probe"));
    }

    #[test]
    fn update_clears_and_keeps_fields_by_tri_state() {
        let mut conn = memory();
        AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        let update = UpdateAutomationRequest {
            automation_id: "a1".to_string(),
            workspace_key: None,
            title: Some("renamed".to_string()),
            cron_expr: None,
            prompt: None,
            model_selection: Some(None),
            mode: Some(Some("plan".to_string())),
            recurring: None,
            max_runs: Some(Some(3)),
            end_at: None,
            schedule_rule: Some(None),
            schedule_edited_by_user: None,
            next_run_at: None,
            lifecycle_status: None,
            reset_retry: false,
            now: 50,
        };
        let updated = AutomationRepository::update(&conn, &update)
            .expect("update")
            .expect("present");
        assert_eq!(updated.title, "renamed");
        assert!(updated.model_selection.is_none());
        assert_eq!(
            AutomationRepository::get_record(&conn, "a1", None)
                .expect("read")
                .expect("present")
                .model_selection
                .as_deref(),
            Some("null"),
            "an explicit null persists the marker; an absent field would have kept the old value"
        );
        assert_eq!(updated.mode.as_deref(), Some("plan"));
        assert_eq!(updated.max_runs, Some(3));
        assert_eq!(updated.updated_at, 50);
    }

    #[test]
    fn a_non_active_lifecycle_disables_an_automation() {
        let mut conn = memory();
        AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        let update = UpdateAutomationRequest {
            automation_id: "a1".to_string(),
            workspace_key: None,
            title: None,
            cron_expr: None,
            prompt: None,
            model_selection: None,
            mode: None,
            recurring: None,
            max_runs: None,
            end_at: None,
            schedule_rule: None,
            schedule_edited_by_user: None,
            next_run_at: None,
            lifecycle_status: Some("completed".to_string()),
            reset_retry: false,
            now: 1,
        };
        let updated = AutomationRepository::update(&conn, &update)
            .expect("update")
            .expect("present");
        assert!(!updated.enabled, "a completed automation must not stay claimable");
        assert_eq!(updated.lifecycle_status, "completed");
    }

    #[test]
    fn run_now_takes_the_lock_and_writes_a_manual_run() {
        let mut conn = memory();
        AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        let claimed = AutomationRepository::run_now(
            &mut conn,
            &RunNowRequest {
                automation_id: "a1".to_string(),
                workspace_key: None,
                run_id: "a1:manual:test".to_string(),
                now: 500,
            },
        )
        .expect("run now")
        .expect("claimed");
        assert_eq!(claimed.run.trigger, "manual");
        assert_eq!(claimed.run.dispatch_status, "claimed");
        assert_eq!(claimed.run.attempts, 1);

        // The lock is held, so a second run-now cannot take it.
        let second = AutomationRepository::run_now(
            &mut conn,
            &RunNowRequest {
                automation_id: "a1".to_string(),
                workspace_key: None,
                run_id: "a1:manual:test-2".to_string(),
                now: 500,
            },
        )
        .expect("run now");
        assert!(second.is_none(), "the single-flight lock must hold");
    }

    #[test]
    fn claim_manual_runs_increments_attempts_and_keeps_the_read_values() {
        let mut conn = memory();
        AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        AutomationRepository::run_now(
            &mut conn,
            &RunNowRequest {
                automation_id: "a1".to_string(),
                workspace_key: None,
                run_id: "a1:manual:test".to_string(),
                now: 500,
            },
        )
        .expect("run now");
        // Release the lock so the manual run can be re-claimed by the scheduler path.
        AutomationRepository::release_manual_claim(
            &conn,
            &ReleaseManualClaimRequest {
                automation_id: "a1".to_string(),
                workspace_key: "/ws".to_string(),
                now: 501,
            },
        )
        .expect("release");

        // `runNow` sets `attempts = 1`, because the run was already handed to the direct
        // dispatcher. The scheduler must NOT re-claim it while the claim is fresh — that is the
        // crash-recovery window, not a normal dispatch.
        let fresh = AutomationRepository::claim_manual_runs(&mut conn, 600).expect("claim fresh");
        assert!(
            fresh.is_empty(),
            "a directly-dispatched manual run is only recovered after the claim goes stale"
        );

        // Past the stale window it is recovered, and the claim bumps `attempts` to 2.
        let claim_now = 500 + CLAIM_STALE_MS + 1;
        let claimed = AutomationRepository::claim_manual_runs(&mut conn, claim_now).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].run.attempts, 2, "the claim bumps attempts to 2");
        assert_eq!(claimed[0].run.updated_at, claim_now);
        assert_eq!(claimed[0].automation.updated_at, claim_now);
    }

    #[test]
    fn mark_dispatched_completes_a_finite_task_at_its_cap() {
        let mut conn = memory();
        let mut finite = request("finite");
        finite.recurring = false;
        AutomationRepository::create(&mut conn, &finite).expect("create");
        AutomationRepository::mark_dispatched(
            &conn,
            &MarkDispatchedRequest {
                automation_id: "finite".to_string(),
                dispatched_at: 100,
                next_run_at: Some(200),
            },
        )
        .expect("dispatch");
        let record = AutomationRepository::get_record(&conn, "finite", None)
            .expect("read")
            .expect("present");
        assert_eq!(record.lifecycle_status, "completed");
        assert_eq!(record.enabled, 0);
        assert_eq!(record.next_run_at, None);
        assert_eq!(record.run_count, 1);
        assert_eq!(record.scheduled_run_count, 1);
    }

    #[test]
    fn mark_dispatch_failed_backs_off_then_gives_up() {
        let mut conn = memory();
        AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        let failure = MarkDispatchFailedRequest {
            automation_id: "a1".to_string(),
            failed_at: 1_000,
            error: "boom".to_string(),
            kind: "transient".to_string(),
            next_run_at: None,
        };
        AutomationRepository::mark_dispatch_failed(&conn, &failure).expect("fail");
        let record = AutomationRepository::get_record(&conn, "a1", None)
            .expect("read")
            .expect("present");
        assert_eq!(record.dispatch_attempts, 1);
        assert_eq!(record.retry_at, Some(compute_retry_at(1_000, 1)));
        assert_eq!(record.running, 0);
    }

    #[test]
    fn mark_run_outcome_never_overwrites_a_settled_result_with_running() {
        let mut conn = memory();
        AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, outcome, attempts, created_at, updated_at)
             VALUES ('r1', 'a1', '/ws', 'schedule', 'dispatched', 'succeeded', 0, 0, 0)",
            [],
        )
        .expect("insert run");
        AutomationRepository::mark_run_outcome(
            &conn,
            &MarkRunOutcomeRequest {
                run_id: "r1".to_string(),
                outcome: "running".to_string(),
                error: None,
                now: 10,
            },
        )
        .expect("outcome");
        let run = AutomationRepository::get_run(&conn, "r1")
            .expect("read")
            .expect("present");
        assert_eq!(run.outcome.as_deref(), Some("succeeded"));
    }

    #[test]
    fn mark_manual_run_dispatched_is_idempotent() {
        let mut conn = memory();
        AutomationRepository::create(&mut conn, &request("a1")).expect("create");
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, attempts, created_at, updated_at)
             VALUES ('r1', 'a1', '/ws', 'manual', 'claimed', 1, 0, 0)",
            [],
        )
        .expect("insert run");
        let first = AutomationRepository::mark_manual_run_dispatched(
            &mut conn,
            &MarkManualRunDispatchedRequest {
                run_id: "r1".to_string(),
                session_id: None,
                dispatched_at: 5,
            },
        )
        .expect("settle");
        assert!(first);
        let second = AutomationRepository::mark_manual_run_dispatched(
            &mut conn,
            &MarkManualRunDispatchedRequest {
                run_id: "r1".to_string(),
                session_id: None,
                dispatched_at: 6,
            },
        )
        .expect("settle again");
        assert!(!second, "the second settlement must not count again");
        let record = AutomationRepository::get_record(&conn, "a1", None)
            .expect("read")
            .expect("present");
        assert_eq!(record.run_count, 1);
    }

    #[test]
    fn the_parent_domain_round_trips() {
        let record = AutomationRecord {
            automation_id: "a1".into(),
            title: "t".into(),
            cron_expr: "0 9 * * *".into(),
            prompt: "p".into(),
            model: None,
            provider: None,
            mode: Some("plan".into()),
            thought_level: None,
            model_selection: Some("null".into()),
            workspace_key: "/ws".into(),
            workspace_path: "/ws".into(),
            workspace_identity: None,
            target_task_id: None,
            bot_delivery_target: None,
            location_kind: "local".into(),
            recurring: 1,
            max_runs: None,
            end_at: None,
            schedule_rule: Some("{\"unit\":\"daily\",\"interval\":1}".into()),
            schedule_edited_by_user: 1,
            run_count: 0,
            scheduled_run_count: 0,
            enabled: 1,
            lifecycle_status: "active".into(),
            next_run_at: None,
            last_run_at: None,
            running: 0,
            claimed_at: None,
            dispatch_status: "idle".into(),
            dispatch_attempts: 0,
            retry_at: None,
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        let json = serde_json::to_value(Automation::from_record(&record).expect("domain"))
            .expect("serialize");
        assert_eq!(json["mode"], "plan");
        assert_eq!(json["scheduleEditedByUser"], true);
        assert_eq!(json["scheduleRule"]["unit"], "daily");
        assert!(json.get("modelSelection").is_none(), "absent, not null");
        assert!(json.get("workspaceIdentity").is_none());
    }
}
