//! Write + dispatch state machine for the `automations` / `automation_runs` tables, ported from
//! `packages/services/src/session/automationRepo.ts`. These functions take an open read-write
//! [`rusqlite::Connection`] and mirror the TS repository's exact SQL semantics: the same full-row
//! merge on `update`, the same guarded single-flight claim `UPDATE ... WHERE running = 0`, the same
//! `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` transaction boundaries around the dispatch state
//! machine, and the same retry backoff via [`crate::automation::compute_retry_at`].
//!
//! `now` (the TS `Date.now()`) is injected by every caller that needs it so the port stays
//! deterministic and unit-testable.

use rusqlite::Connection;

use crate::automation::{
    read_serialized_model_selection, serialize_model_selection, Automation, ModelSelection,
};

/// Mirrors TS `DISPATCH_MAX_ATTEMPTS`.
pub const DISPATCH_MAX_ATTEMPTS: i64 = 5;

/// The full `automations` row, including the columns the domain [`Automation`] projection drops
/// (`model`, `provider`, `thought_level`, `bot_delivery_target`, `running`, `claimed_at`,
/// `scheduled_run_count`). `update` must read the raw row first so it can write the untouched
/// columns back unchanged (the TS `{ ...existing, ...next }` merge).
#[derive(Debug, Clone, Default)]
struct RawAutomation {
    automation_id: String,
    title: String,
    cron_expr: String,
    prompt: String,
    model: Option<String>,
    provider: Option<String>,
    mode: Option<String>,
    thought_level: Option<String>,
    model_selection: Option<String>,
    workspace_key: String,
    workspace_path: String,
    workspace_identity: Option<String>,
    target_task_id: Option<String>,
    /// Read as part of the faithful `SELECT *` full-row shape so `update` never drops columns the
    /// domain projection omits. `write_row` intentionally does not persist it, so the stored value is
    /// preserved untouched; no write path here consumes it.
    #[allow(dead_code)]
    bot_delivery_target: Option<String>,
    location_kind: String,
    recurring: i64,
    max_runs: Option<i64>,
    end_at: Option<i64>,
    schedule_rule: Option<String>,
    schedule_edited_by_user: i64,
    run_count: i64,
    scheduled_run_count: i64,
    enabled: i64,
    lifecycle_status: String,
    next_run_at: Option<i64>,
    last_run_at: Option<i64>,
    running: i64,
    claimed_at: Option<i64>,
    dispatch_status: String,
    dispatch_attempts: i64,
    retry_at: Option<i64>,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

/// The columns of [`RawAutomation`], in a fixed order so the positional row mapping is stable
/// against schema additions (same discipline as `AUTOMATION_COLUMNS` in `automation.rs`).
const RAW_COLUMNS: &str = "automation_id, title, cron_expr, prompt, model, provider, mode, \
     thought_level, model_selection, workspace_key, workspace_path, workspace_identity, \
     target_task_id, bot_delivery_target, location_kind, recurring, max_runs, end_at, \
     schedule_rule, schedule_edited_by_user, run_count, scheduled_run_count, enabled, \
     lifecycle_status, next_run_at, last_run_at, running, claimed_at, dispatch_status, \
     dispatch_attempts, retry_at, last_error, created_at, updated_at";

fn map_raw_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawAutomation> {
    Ok(RawAutomation {
        automation_id: r.get(0)?,
        title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        cron_expr: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        prompt: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        model: r.get(4)?,
        provider: r.get(5)?,
        mode: r.get(6)?,
        thought_level: r.get(7)?,
        model_selection: r.get(8)?,
        workspace_key: r.get::<_, Option<String>>(9)?.unwrap_or_default(),
        workspace_path: r.get::<_, Option<String>>(10)?.unwrap_or_default(),
        workspace_identity: r.get(11)?,
        target_task_id: r.get(12)?,
        bot_delivery_target: r.get(13)?,
        location_kind: r.get::<_, Option<String>>(14)?.unwrap_or_default(),
        recurring: r.get::<_, i64>(15).unwrap_or(0),
        max_runs: r.get(16)?,
        end_at: r.get(17)?,
        schedule_rule: r.get(18)?,
        schedule_edited_by_user: r.get::<_, i64>(19).unwrap_or(0),
        run_count: r.get::<_, i64>(20).unwrap_or(0),
        scheduled_run_count: r.get::<_, i64>(21).unwrap_or(0),
        enabled: r.get::<_, i64>(22).unwrap_or(0),
        lifecycle_status: r.get::<_, Option<String>>(23)?.unwrap_or_default(),
        next_run_at: r.get(24)?,
        last_run_at: r.get(25)?,
        running: r.get::<_, i64>(26).unwrap_or(0),
        claimed_at: r.get(27)?,
        dispatch_status: r.get::<_, Option<String>>(28)?.unwrap_or_default(),
        dispatch_attempts: r.get::<_, i64>(29).unwrap_or(0),
        retry_at: r.get(30)?,
        last_error: r.get(31)?,
        created_at: r.get::<_, i64>(32).unwrap_or(0),
        updated_at: r.get::<_, i64>(33).unwrap_or(0),
    })
}

/// Port of the private `getRow`: `SELECT * FROM automations WHERE automation_id=@id AND
/// (@workspace_key IS NULL OR workspace_key=@workspace_key)`. Returns `None` when absent.
fn get_raw_row(
    conn: &Connection,
    automation_id: &str,
    workspace_key: Option<&str>,
) -> Result<Option<RawAutomation>, String> {
    let sql = format!(
        "SELECT {RAW_COLUMNS} FROM automations WHERE automation_id = @automation_id \
         AND (@workspace_key IS NULL OR workspace_key = @workspace_key)"
    );
    let aid = rusqlite::types::Value::Text(automation_id.to_string());
    let wk = workspace_key
        .map(|s| rusqlite::types::Value::Text(s.to_string()))
        .unwrap_or(rusqlite::types::Value::Null);
    let params: Vec<(&str, &dyn rusqlite::types::ToSql)> =
        vec![("@automation_id", &aid), ("@workspace_key", &wk)];
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params.as_slice(), map_raw_row)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(r) => r.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// Port of `rowToAutomation` applied to an in-memory [`RawAutomation`] (the TS update path projects
/// the merged row, it does not re-read from SQLite). `schedule_rule` that is not valid JSON is an
/// error, mirroring the TS `JSON.parse` throwing.
fn row_to_automation(row: &RawAutomation) -> Result<Automation, String> {
    let schedule_rule = match &row.schedule_rule {
        Some(s) => Some(serde_json::from_str(s).map_err(|e| e.to_string())?),
        None => None,
    };
    Ok(Automation {
        automation_id: row.automation_id.clone(),
        title: row.title.clone(),
        cron_expr: row.cron_expr.clone(),
        prompt: row.prompt.clone(),
        model_selection: read_serialized_model_selection(row.model_selection.as_deref()),
        mode: row
            .mode
            .as_deref()
            .filter(|m| crate::VALID_MODES.contains(m))
            .map(str::to_string),
        workspace_key: row.workspace_key.clone(),
        workspace_path: row.workspace_path.clone(),
        workspace_identity: row.workspace_identity.clone(),
        target_task_id: row.target_task_id.clone(),
        location_kind: if row.location_kind == "remote" {
            "remote".to_string()
        } else {
            "local".to_string()
        },
        recurring: row.recurring == 1,
        max_runs: row.max_runs,
        end_at: row.end_at,
        schedule_rule,
        schedule_edited_by_user: (row.schedule_edited_by_user == 1).then_some(true),
        run_count: row.run_count,
        enabled: row.enabled == 1,
        lifecycle_status: row.lifecycle_status.clone(),
        next_run_at: row.next_run_at,
        last_run_at: row.last_run_at,
        dispatch_status: row.dispatch_status.clone(),
        dispatch_attempts: row.dispatch_attempts,
        retry_at: row.retry_at,
        last_error: row.last_error.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// Port of the private `writeRow`: a single `UPDATE automations SET ... WHERE automation_id`. Writes
/// exactly the mutable columns (workspace/path/identity, counts, running/claimed, last_error,
/// created_at and bot_delivery_target are preserved from the raw read).
fn write_row(conn: &Connection, row: &RawAutomation) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET
          title = ?2, cron_expr = ?3, prompt = ?4, model = ?5, provider = ?6,
          model_selection = ?7, mode = ?8, thought_level = ?9,
          recurring = ?10, max_runs = ?11, end_at = ?12, schedule_rule = ?13,
          schedule_edited_by_user = ?14, next_run_at = ?15, lifecycle_status = ?16,
          dispatch_attempts = ?17, retry_at = ?18, dispatch_status = ?19,
          enabled = ?20, updated_at = ?21
        WHERE automation_id = ?1",
        rusqlite::params![
            row.automation_id,
            row.title,
            row.cron_expr,
            row.prompt,
            row.model.as_deref(),
            row.provider.as_deref(),
            row.model_selection.as_deref(),
            row.mode.as_deref(),
            row.thought_level.as_deref(),
            row.recurring,
            row.max_runs,
            row.end_at,
            row.schedule_rule.as_deref(),
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
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `assertValidAutomationMode`: `None`/`Some(None)` (undefined/null) pass; a present value
/// outside [`crate::VALID_MODES`] is rejected. Reading tolerates historical dirty data, but the Repo
/// is the last persistence boundary and must not keep writing it.
pub fn assert_valid_automation_mode(mode: &Option<Option<String>>) -> Result<(), String> {
    if let Some(Some(m)) = mode {
        if !crate::VALID_MODES.contains(&m.as_str()) {
            return Err(format!("Invalid automation mode: {m}"));
        }
    }
    Ok(())
}

/// The patch for [`update`] (mirrors `ZCodeAutomationUpdateParams`). Three-state fields use
/// `Option<Option<T>>`: `None` = the TS `undefined` (keep existing), `Some(None)` = an explicit
/// `null` (clear the column), `Some(Some(v))` = set `v`. Two-state fields (`title`, `cron_expr`,
/// `prompt`) use `Option<T>` because TS collapses `null` and `undefined` through `??`.
#[derive(Debug, Clone, Default)]
pub struct AutomationUpdateParams {
    pub title: Option<String>,
    pub cron_expr: Option<String>,
    pub prompt: Option<String>,
    pub model_selection: Option<Option<ModelSelection>>,
    pub mode: Option<Option<String>>,
    pub recurring: Option<bool>,
    pub max_runs: Option<Option<i64>>,
    pub end_at: Option<Option<i64>>,
    pub schedule_rule: Option<Option<serde_json::Value>>,
    pub schedule_edited_by_user: Option<bool>,
}

/// The scheduling-state options for [`update`] (mirrors the `options` arg). `next_run_at` is
/// three-state: `None` = `undefined` (keep), `Some(None)` = explicit null (clear), `Some(Some)` =
/// set.
#[derive(Debug, Clone, Default)]
pub struct AutomationUpdateOptions {
    pub next_run_at: Option<Option<i64>>,
    pub lifecycle_status: Option<String>,
    pub reset_retry: bool,
}

/// Port of `update`: the full-row merge. Reads the raw row, applies each patch field with the exact
/// undefined-vs-null-vs-value semantics, derives `enabled` from an explicitly changed
/// `lifecycleStatus`, and writes with a single `writeRow` (no transaction). Returns the projected
/// merged row, or `None` when the row (or its workspace scope) is missing.
#[allow(clippy::too_many_lines)]
pub fn update(
    conn: &Connection,
    automation_id: &str,
    params: &AutomationUpdateParams,
    options: &AutomationUpdateOptions,
    workspace_key: Option<&str>,
    now: i64,
) -> Result<Option<Automation>, String> {
    assert_valid_automation_mode(&params.mode)?;
    let existing = match get_raw_row(conn, automation_id, workspace_key)? {
        Some(r) => r,
        None => return Ok(None),
    };

    let model_selection: Option<String> = match &params.model_selection {
        None => existing.model_selection.clone(),
        Some(inner) => Some(
            inner
                .as_ref()
                .and_then(serialize_model_selection)
                .unwrap_or_else(|| "null".to_string()),
        ),
    };
    let mode = match &params.mode {
        None => existing.mode.clone(),
        Some(inner) => inner.clone(),
    };
    let recurring = match params.recurring {
        None => existing.recurring,
        Some(b) => i64::from(b),
    };
    let max_runs = match &params.max_runs {
        None => existing.max_runs,
        Some(inner) => *inner,
    };
    let end_at = match &params.end_at {
        None => existing.end_at,
        Some(inner) => *inner,
    };
    let schedule_rule = match &params.schedule_rule {
        None => existing.schedule_rule.clone(),
        Some(Some(v)) => Some(v.to_string()),
        Some(None) => None,
    };
    let schedule_edited_by_user = match params.schedule_edited_by_user {
        None => existing.schedule_edited_by_user,
        Some(b) => i64::from(b),
    };
    let next_run_at = match &options.next_run_at {
        None => existing.next_run_at,
        Some(inner) => *inner,
    };
    let lifecycle_status = options
        .lifecycle_status
        .clone()
        .unwrap_or_else(|| existing.lifecycle_status.clone());
    let (dispatch_attempts, retry_at, dispatch_status) = if options.reset_retry {
        (0, None, "idle".to_string())
    } else {
        (
            existing.dispatch_attempts,
            existing.retry_at,
            existing.dispatch_status.clone(),
        )
    };
    // enabled 完整由 lifecycleStatus 推导：仅当调用方显式改了生命周期时才动它，否则保持原值。
    let enabled = match &options.lifecycle_status {
        Some(ls) => {
            if ls == "active" {
                1
            } else {
                0
            }
        }
        None => existing.enabled,
    };

    let next = RawAutomation {
        title: params
            .title
            .clone()
            .unwrap_or_else(|| existing.title.clone()),
        cron_expr: params
            .cron_expr
            .clone()
            .unwrap_or_else(|| existing.cron_expr.clone()),
        prompt: params
            .prompt
            .clone()
            .unwrap_or_else(|| existing.prompt.clone()),
        // 旧三列只供回滚保留；标题等编辑不能清除尚未迁入的旧选择。
        model: existing.model.clone(),
        provider: existing.provider.clone(),
        thought_level: existing.thought_level.clone(),
        model_selection,
        mode,
        recurring,
        max_runs,
        end_at,
        schedule_rule,
        schedule_edited_by_user,
        next_run_at,
        lifecycle_status,
        dispatch_attempts,
        retry_at,
        dispatch_status,
        enabled,
        updated_at: now,
        ..existing
    };

    write_row(conn, &next)?;
    row_to_automation(&next).map(Some)
}

/// Port of `delete`: `DELETE FROM automations WHERE automation_id=@id AND (@workspace_key IS NULL
/// OR workspace_key=@workspace_key)`. Returns whether a row was removed.
pub fn delete(
    conn: &Connection,
    automation_id: &str,
    workspace_key: Option<&str>,
) -> Result<bool, String> {
    let wk = workspace_key
        .map(|s| rusqlite::types::Value::Text(s.to_string()))
        .unwrap_or(rusqlite::types::Value::Null);
    let aid = rusqlite::types::Value::Text(automation_id.to_string());
    let params: Vec<(&str, &dyn rusqlite::types::ToSql)> =
        vec![("@id", &aid), ("@workspace_key", &wk)];
    let n = conn
        .execute(
            "DELETE FROM automations WHERE automation_id = @id \
             AND (@workspace_key IS NULL OR workspace_key = @workspace_key)",
            params.as_slice(),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Port of `setEnabled` (pause / resume): `paused` <-> `active`, preserving `next_run_at` /
/// `run_count`. `enabled` maps to `lifecycle_status` (`active` when enabling, `paused` otherwise).
pub fn set_enabled(
    conn: &Connection,
    automation_id: &str,
    enabled: bool,
    workspace_key: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET enabled = ?1, lifecycle_status = ?2, updated_at = ?3 \
         WHERE automation_id = ?4 AND (?5 IS NULL OR workspace_key = ?5)",
        rusqlite::params![
            i64::from(enabled),
            if enabled { "active" } else { "paused" },
            now,
            automation_id,
            workspace_key,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `restart` (terminal-task manual rerun): back to `active`, clears counts and retry state,
/// and sets `next_run_at` (recomputed by the caller).
pub fn restart(
    conn: &Connection,
    automation_id: &str,
    next_run_at: Option<i64>,
    workspace_key: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET lifecycle_status = 'active', enabled = 1, run_count = 0, \
         scheduled_run_count = 0, dispatch_attempts = 0, retry_at = NULL, dispatch_status = 'idle', \
         running = 0, claimed_at = NULL, next_run_at = ?1, last_error = NULL, updated_at = ?2 \
         WHERE automation_id = ?3 AND (?4 IS NULL OR workspace_key = ?4)",
        rusqlite::params![next_run_at, now, automation_id, workspace_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Dispatch / claim state machine ----

/// The kind of a dispatch failure (mirrors the `kind` arg of `markDispatchFailed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchFailureKind {
    /// Retry with exponential backoff until [`DISPATCH_MAX_ATTEMPTS`].
    Transient,
    /// Go straight to the `failed` terminal state.
    Permanent,
}

/// Port of `claimDue`'s stale-reclaim step: release claims held past [`crate::automation::CLAIM_STALE_MS`].
fn reclaim_stale(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET running = 0, claimed_at = NULL \
         WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?1",
        rusqlite::params![crate::automation::claim_stale_threshold(now)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `claimDue`: the single-flight claim of due items (atomic `running = 0 -> 1`), first
/// finalizing any past-`end_at` schedules, then recycling stale claims, then claiming every due row.
/// A row is due when `enabled` and not in-flight and either a `retry_at` is due (transient backoff,
/// `next_run_at` untouched so retries reuse the same runId) or, with no `retry_at`, `next_run_at` is
/// due. Runs under `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
pub fn claim_due(conn: &Connection, now: i64) -> Result<Vec<Automation>, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let result = claim_due_inner(conn, now);
    match result {
        Ok(v) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

fn claim_due_inner(conn: &Connection, now: i64) -> Result<Vec<Automation>, String> {
    // 截止日期是计划边界；过期任务先转终态，避免继续被正常 cron 或 retry 认领。
    conn.execute(
        "UPDATE automations SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL, \
         retry_at = NULL, running = 0, claimed_at = NULL, updated_at = ?1 \
         WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < ?1",
        rusqlite::params![now],
    )
    .map_err(|e| e.to_string())?;
    reclaim_stale(conn, now)?;

    let sql = format!(
        "SELECT {RAW_COLUMNS} FROM automations WHERE enabled = 1 AND running = 0 \
         AND ((retry_at IS NOT NULL AND retry_at <= ?1) \
              OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?1))"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let due: Vec<RawAutomation> = stmt
        .query_map([now], map_raw_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut claimed = Vec::new();
    for mut row in due {
        let n = conn
            .execute(
                "UPDATE automations SET running = 1, claimed_at = ?2, dispatch_status = 'claimed', \
                 updated_at = ?2 WHERE automation_id = ?1 AND running = 0",
                rusqlite::params![row.automation_id, now],
            )
            .map_err(|e| e.to_string())?;
        if n == 1 {
            row.running = 1;
            row.claimed_at = Some(now);
            row.dispatch_status = "claimed".to_string();
            claimed.push(row_to_automation(&row)?);
        }
    }
    Ok(claimed)
}

/// Port of `markDispatched`: dispatch-success settlement. Increments both the display `run_count`
/// and the `scheduled_run_count`, writes `last_run_at`, clears retry state, releases the in-flight
/// lock, and advances `next_run_at`; a finite (non-recurring) task reaching `max_runs` (default 1)
/// or a schedule past `end_at` transitions to `completed` and stops being scheduled. Uses
/// `dispatched_at` as the `updated_at` stamp. If the automation was deleted, the write-back is
/// dropped (never resurrect the row).
pub fn mark_dispatched(
    conn: &Connection,
    automation_id: &str,
    dispatched_at: i64,
    next_run_at: Option<i64>,
) -> Result<(), String> {
    let row = match get_raw_row(conn, automation_id, None)? {
        Some(r) => r,
        None => return Ok(()),
    };
    let run_count = row.run_count + 1;
    let scheduled_run_count = row.scheduled_run_count + 1;
    let reached_max = row.recurring == 0 && scheduled_run_count >= row.max_runs.unwrap_or(1);
    let reached_end = match row.end_at {
        Some(end_at) => next_run_at.unwrap_or(i64::MAX) > end_at,
        None => false,
    };
    let completed = reached_max || reached_end;

    conn.execute(
        "UPDATE automations SET run_count = ?1, scheduled_run_count = ?2, last_run_at = ?3, \
         dispatch_status = 'dispatched', dispatch_attempts = 0, retry_at = NULL, last_error = NULL, \
         running = 0, claimed_at = NULL, lifecycle_status = ?4, enabled = ?5, next_run_at = ?6, \
         updated_at = ?7 WHERE automation_id = ?8",
        rusqlite::params![
            run_count,
            scheduled_run_count,
            dispatched_at,
            if completed { "completed" } else { "active" },
            i64::from(!completed),
            if completed { None } else { next_run_at },
            dispatched_at,
            automation_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `markDispatchFailed`: `transient` accumulates attempts and writes a backoff `retry_at`;
/// on reaching [`DISPATCH_MAX_ATTEMPTS`] a recurring task abandons the round and jumps to the next
/// `next_run_at` (caller-supplied), while a finite task goes `failed`. `permanent` goes straight to
/// the `failed` terminal state.
pub fn mark_dispatch_failed(
    conn: &Connection,
    automation_id: &str,
    failed_at: i64,
    error: &str,
    kind: DispatchFailureKind,
    next_run_at: Option<i64>,
) -> Result<(), String> {
    let row = match get_raw_row(conn, automation_id, None)? {
        Some(r) => r,
        None => return Ok(()),
    };
    if kind == DispatchFailureKind::Permanent {
        conn.execute(
            "UPDATE automations SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed', \
             enabled = 0, running = 0, claimed_at = NULL, last_error = ?2, updated_at = ?3 \
             WHERE automation_id = ?1",
            rusqlite::params![automation_id, error, failed_at],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let attempts = row.dispatch_attempts + 1;
    if attempts >= DISPATCH_MAX_ATTEMPTS {
        if row.recurring == 1 {
            // 循环任务：放弃本轮，跳下一个正常 next_run_at，清重试态回 idle。
            conn.execute(
                "UPDATE automations SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL, \
                 running = 0, claimed_at = NULL, next_run_at = ?2, last_error = ?3, updated_at = ?4 \
                 WHERE automation_id = ?1",
                rusqlite::params![automation_id, next_run_at, error, failed_at],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE automations SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed', \
                 enabled = 0, running = 0, claimed_at = NULL, last_error = ?2, updated_at = ?3 \
                 WHERE automation_id = ?1",
                rusqlite::params![automation_id, error, failed_at],
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    // 未达上限：写退避 retry_at，复位 running 等下轮重认领。
    conn.execute(
        "UPDATE automations SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = ?2, \
         retry_at = ?3, running = 0, claimed_at = NULL, last_error = ?4, updated_at = ?5 \
         WHERE automation_id = ?1",
        rusqlite::params![
            automation_id,
            attempts,
            crate::automation::compute_retry_at(failed_at, attempts),
            error,
            failed_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `releaseClaim`: on shutdown/exit release the claim (clear `running`, keep `next_run_at`,
/// no failure recorded, no advance). Guarded by `running = 1`.
pub fn release_claim(conn: &Connection, automation_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET running = 0, claimed_at = NULL, dispatch_status = 'idle', \
         updated_at = ?2 WHERE automation_id = ?1 AND running = 1",
        rusqlite::params![automation_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `releaseManualClaim`: after a manual run finishes, release only the single-flight lock.
pub fn release_manual_claim(
    conn: &Connection,
    automation_id: &str,
    workspace_key: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET running = 0, claimed_at = NULL, updated_at = ?3 \
         WHERE automation_id = ?1 AND workspace_key = ?2 AND running = 1",
        rusqlite::params![automation_id, workspace_key, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `touchManualClaim`: extend the lease while the host still holds a queued/running manual
/// run, so the scheduler does not recycle it as a stale claim.
pub fn touch_manual_claim(
    conn: &Connection,
    automation_id: &str,
    workspace_key: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET claimed_at = ?3, updated_at = ?3 \
         WHERE automation_id = ?1 AND workspace_key = ?2 AND running = 1",
        rusqlite::params![automation_id, workspace_key, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `getScheduledRunCount`: the `maxRuns` lifecycle counter only counts scheduled dispatches.
pub fn get_scheduled_run_count(
    conn: &Connection,
    automation_id: &str,
    workspace_key: Option<&str>,
) -> Result<Option<i64>, String> {
    Ok(get_raw_row(conn, automation_id, workspace_key)?.map(|r| r.scheduled_run_count))
}

/// Port of `hasTaskBinding`: an authorization-only existence probe scoped strictly to a workspace
/// key (never reads/serializes the whole list, which a single dirty display field could break).
pub fn has_task_binding(
    conn: &Connection,
    workspace_key: &str,
    target_task_id: &str,
) -> Result<bool, String> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM automations WHERE workspace_key = ?1 AND target_task_id = ?2 LIMIT 1",
            rusqlite::params![workspace_key, target_task_id],
            |r| r.get(0),
        )
        .ok();
    Ok(found.is_some())
}

/// Port of `getModelSelectionForDispatch`: the first-dispatch read. A list may show an unbound
/// automation, but a dispatch must not treat a corrupt value as "follow the default". Errors when
/// the automation is missing, when the selection is unusable, or when it is neither a valid selection
/// nor the explicit `"null"` follow-workspace sentinel.
pub fn get_model_selection_for_dispatch(
    conn: &Connection,
    automation_id: &str,
    workspace_key: &str,
) -> Result<Option<ModelSelection>, String> {
    let row = get_raw_row(conn, automation_id, Some(workspace_key))?
        .ok_or_else(|| "Automation 不存在或不属于当前工作区".to_string())?;
    if let Some(sel) = read_serialized_model_selection(row.model_selection.as_deref()) {
        return Ok(Some(sel));
    }
    // SQL NULL is a missing config; only the explicit "null" sentinel means "follow the workspace".
    if row.model_selection.as_deref() == Some("null") {
        return Ok(None);
    }
    Err("Automation 模型选择不可用，请重新选择模型与思考档位".to_string())
}

// ---- automation_runs ledger ----

/// A single `automation_runs` ledger row projected for callers (mirrors `ZCodeAutomationRun`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
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

const RUN_COLUMNS: &str = "run_id, automation_id, workspace_key, scheduled_at, trigger, \
     model_selection, dispatch_status, outcome, session_id, error, attempts, created_at, updated_at";

fn map_run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        run_id: r.get(0)?,
        automation_id: r.get(1)?,
        workspace_key: r.get(2)?,
        scheduled_at: r.get(3)?,
        trigger: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
        model_selection: read_serialized_model_selection(r.get::<_, Option<String>>(5)?.as_deref()),
        dispatch_status: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
        outcome: r.get(7)?,
        session_id: r.get(8)?,
        error: r.get(9)?,
        attempts: r.get::<_, i64>(10).unwrap_or(0),
        created_at: r.get::<_, i64>(11).unwrap_or(0),
        updated_at: r.get::<_, i64>(12).unwrap_or(0),
    })
}

/// Port of `rowToRun` for an in-memory ledger row (used by `runNow`, which returns the run it just
/// wrote without re-reading).
fn row_to_run(row: &AutomationRun) -> AutomationRun {
    row.clone()
}

/// Port of `listRuns`: every run for one automation (+ optional workspace scope),
/// `ORDER BY created_at DESC`.
pub fn list_runs(
    conn: &Connection,
    automation_id: &str,
    workspace_key: Option<&str>,
) -> Result<Vec<AutomationRun>, String> {
    let sql = format!(
        "SELECT {RUN_COLUMNS} FROM automation_runs WHERE automation_id = ?1 \
         AND (?2 IS NULL OR workspace_key = ?2) ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![automation_id, workspace_key], map_run_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Port of `getRun`: a single ledger row by `run_id`, `None` when absent.
pub fn get_run(conn: &Connection, run_id: &str) -> Result<Option<AutomationRun>, String> {
    let sql = format!("SELECT {RUN_COLUMNS} FROM automation_runs WHERE run_id = ?1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([run_id], map_run_row)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(r) => r.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// Port of `deleteRun`: drop a ledger row (+ optional workspace scope).
pub fn delete_run(
    conn: &Connection,
    run_id: &str,
    workspace_key: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM automation_runs WHERE run_id = ?1 AND (?2 IS NULL OR workspace_key = ?2)",
        rusqlite::params![run_id, workspace_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `pruneRuns`: delete history older than `now - max_age_ms` (bounded growth); returns the
/// number of removed rows.
pub fn prune_runs(conn: &Connection, max_age_ms: i64, now: i64) -> Result<usize, String> {
    let n = conn
        .execute(
            "DELETE FROM automation_runs WHERE created_at < ?1",
            rusqlite::params![now - max_age_ms],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// The identity columns shared by the `automation_runs` write helpers (mirrors the repeated
/// `(run_id, automation_id, workspace_key, scheduled_at, trigger)` arg group). Bundled so the ledger
/// writers stay within the argument budget.
#[derive(Debug, Clone)]
pub struct RunIdentity<'a> {
    pub run_id: &'a str,
    pub automation_id: &'a str,
    pub workspace_key: &'a str,
    pub scheduled_at: Option<i64>,
    pub trigger: &'a str,
}

/// Port of `ensureRunClaimed`: guarantee a ledger row exists (host outcome write-back fallback).
/// Does not bump `attempts` (so it cannot pollute the scheduler retry count). `ON CONFLICT DO NOTHING`.
pub fn ensure_run_claimed(conn: &Connection, id: &RunIdentity<'_>, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, trigger, \
         dispatch_status, attempts, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'claimed', 0, ?6, ?6) ON CONFLICT(run_id) DO NOTHING",
        rusqlite::params![id.run_id, id.automation_id, id.workspace_key, id.scheduled_at, id.trigger, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `upsertRunClaimed`: claim upserts a run row (a `run_id` conflict means this round's retry
/// reuses the row instead of creating a new one). On conflict it resets to `claimed`, keeps any
/// frozen `model_selection`, clears outcome/error and increments `attempts`.
pub fn upsert_run_claimed(
    conn: &Connection,
    id: &RunIdentity<'_>,
    model_selection: Option<&ModelSelection>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, trigger, \
         model_selection, dispatch_status, attempts, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'claimed', 0, ?7, ?7) \
         ON CONFLICT(run_id) DO UPDATE SET dispatch_status = 'claimed', \
           model_selection = COALESCE(automation_runs.model_selection, excluded.model_selection), \
           outcome = NULL, error = NULL, attempts = attempts + 1, updated_at = excluded.updated_at",
        rusqlite::params![
            id.run_id,
            id.automation_id,
            id.workspace_key,
            id.scheduled_at,
            id.trigger,
            model_selection.and_then(serialize_model_selection),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `fixRunModelSelection`: the first Submission atomically freezes the run's selection; later
/// calls read back the original. Errors when the run is missing or the frozen selection is unreadable.
pub fn fix_run_model_selection(
    conn: &Connection,
    run_id: &str,
    selection: &ModelSelection,
    now: i64,
) -> Result<ModelSelection, String> {
    conn.execute(
        "UPDATE automation_runs SET model_selection = COALESCE(model_selection, ?2), updated_at = ?3 \
         WHERE run_id = ?1",
        rusqlite::params![run_id, serialize_model_selection(selection), now],
    )
    .map_err(|e| e.to_string())?;
    let stored: Option<Option<String>> = conn
        .query_row(
            "SELECT model_selection FROM automation_runs WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .ok();
    let fixed = stored.and_then(|v| read_serialized_model_selection(v.as_deref()));
    fixed.ok_or_else(|| format!("Automation run 不存在或无法固定模型选择: {run_id}"))
}

/// Port of `markRunDispatch`: write the dispatch outcome back to the run (dispatched fills
/// `session_id`, failed_to_dispatch records `error`). `session_id` uses `COALESCE` so a null update
/// does not clear a previously set id.
pub fn mark_run_dispatch(
    conn: &Connection,
    run_id: &str,
    dispatch_status: &str,
    session_id: Option<&str>,
    error: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_runs SET dispatch_status = ?2, session_id = COALESCE(?3, session_id), \
         error = ?4, updated_at = ?5 WHERE run_id = ?1",
        rusqlite::params![run_id, dispatch_status, session_id, error, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `markRunOutcome`: the session runtime writes the run result (running / succeeded / failed
/// / stopped). A non-`running` outcome is terminal: a late `running` update cannot overwrite an
/// already-settled outcome or clear its error (the `CASE` guards).
pub fn mark_run_outcome(
    conn: &Connection,
    run_id: &str,
    outcome: &str,
    error: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_runs SET outcome = CASE \
             WHEN ?2 = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN outcome \
             ELSE ?2 END, \
           error = CASE \
             WHEN ?2 = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN error \
             ELSE COALESCE(?3, error) END, \
           updated_at = ?4 WHERE run_id = ?1",
        rusqlite::params![run_id, outcome, error, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `recordSkippedRun`: a missed trigger writes a `skipped` run (no `run_count`). On a
/// `run_id` conflict it re-marks the row skipped and refreshes the error/timestamp.
pub fn record_skipped_run(
    conn: &Connection,
    id: &RunIdentity<'_>,
    reason: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, trigger, \
         dispatch_status, error, attempts, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'skipped', ?6, 0, ?7, ?7) \
         ON CONFLICT(run_id) DO UPDATE SET dispatch_status = 'skipped', error = excluded.error, \
           updated_at = excluded.updated_at",
        rusqlite::params![
            id.run_id,
            id.automation_id,
            id.workspace_key,
            id.scheduled_at,
            id.trigger,
            reason,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The `(automation, run)` pair returned by `runNow` / `claimManualRuns` (mirrors
/// `ClaimedManualAutomationRun`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimedManualRun {
    pub automation: Automation,
    pub run: AutomationRun,
}

/// Port of `runNow`: immediately enqueue a manual run held by the current host, without touching the
/// automation's cron schedule/lifecycle. Under `BEGIN IMMEDIATE`, it first recycles stale claims,
/// then atomically takes the single-flight `running` lock (`running = 0` guard) and writes a
/// `claimed` manual run with `attempts = 1`. Returns `None` when the automation is missing/scope-
/// mismatched or the lock is already held.
pub fn run_now(
    conn: &Connection,
    automation_id: &str,
    workspace_key: Option<&str>,
    now: i64,
) -> Result<Option<ClaimedManualRun>, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let inner = (|| -> Result<Option<ClaimedManualRun>, String> {
        reclaim_stale(conn, now)?;
        let row = match get_raw_row(conn, automation_id, workspace_key)? {
            Some(r) => r,
            None => return Ok(None),
        };
        let n = conn
            .execute(
                "UPDATE automations SET running = 1, claimed_at = ?2, updated_at = ?2 \
                 WHERE automation_id = ?1 AND running = 0 \
                 AND (?3 IS NULL OR workspace_key = ?3)",
                rusqlite::params![automation_id, now, workspace_key],
            )
            .map_err(|e| e.to_string())?;
        if n != 1 {
            return Ok(None);
        }
        let run_id = format!("{automation_id}:manual:{}", uuid::Uuid::new_v4());
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, \
             trigger, model_selection, dispatch_status, attempts, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'manual', NULL, 'claimed', 1, ?5, ?5)",
            rusqlite::params![run_id, automation_id, row.workspace_key, now, now],
        )
        .map_err(|e| e.to_string())?;

        let mut automation_raw = row.clone();
        automation_raw.running = 1;
        automation_raw.claimed_at = Some(now);
        automation_raw.updated_at = now;
        let automation = row_to_automation(&automation_raw)?;
        let run = AutomationRun {
            run_id,
            automation_id: automation_id.to_string(),
            workspace_key: row.workspace_key.clone(),
            scheduled_at: Some(now),
            trigger: "manual".to_string(),
            model_selection: None,
            dispatch_status: "claimed".to_string(),
            outcome: None,
            session_id: None,
            error: None,
            attempts: 1,
            created_at: now,
            updated_at: now,
        };
        Ok(Some(ClaimedManualRun {
            automation,
            run: row_to_run(&run),
        }))
    })();
    match inner {
        Ok(v) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Port of `claimManualRuns`: claim manual runs produced by the UI's "run now" without disturbing the
/// cron rhythm. Under `BEGIN IMMEDIATE`, recycles stale claims, selects pending manual `claimed` runs
/// whose automation is idle (`running = 0`) and either never attempted or stale-reclaimable
/// (`updated_at <= now - CLAIM_STALE_MS`), ordered `r.created_at ASC`, then takes the automation
/// single-flight lock and increments the run's `attempts` for each pair it wins.
pub fn claim_manual_runs(conn: &Connection, now: i64) -> Result<Vec<ClaimedManualRun>, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let inner = (|| -> Result<Vec<ClaimedManualRun>, String> {
        reclaim_stale(conn, now)?;
        let stale = crate::automation::claim_stale_threshold(now);
        let sql = "SELECT r.run_id, a.automation_id FROM automation_runs r \
             JOIN automations a ON a.automation_id = r.automation_id \
             WHERE r.trigger = 'manual' AND r.dispatch_status = 'claimed' AND a.running = 0 \
             AND (r.attempts = 0 OR r.updated_at <= ?1) ORDER BY r.created_at ASC";
        let pending: Vec<(String, String)> = {
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([stale], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let mut claimed = Vec::new();
        for (run_id, automation_id) in pending {
            let n = conn
                .execute(
                    "UPDATE automations SET running = 1, claimed_at = ?2, updated_at = ?2 \
                     WHERE automation_id = ?1 AND running = 0",
                    rusqlite::params![automation_id, now],
                )
                .map_err(|e| e.to_string())?;
            if n != 1 {
                continue;
            }
            conn.execute(
                "UPDATE automation_runs SET attempts = attempts + 1, updated_at = ?2 \
                 WHERE run_id = ?1 AND trigger = 'manual' AND dispatch_status = 'claimed'",
                rusqlite::params![run_id, now],
            )
            .map_err(|e| e.to_string())?;

            let mut automation_raw = get_raw_row(conn, &automation_id, None)?
                .ok_or_else(|| format!("automation missing in claim: {automation_id}"))?;
            automation_raw.running = 1;
            automation_raw.claimed_at = Some(now);
            automation_raw.updated_at = now;
            let automation = row_to_automation(&automation_raw)?;
            let run =
                get_run(conn, &run_id)?.ok_or_else(|| format!("run missing in claim: {run_id}"))?;
            claimed.push(ClaimedManualRun { automation, run });
        }
        Ok(claimed)
    })();
    match inner {
        Ok(v) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Params for [`skip_and_reschedule`] (mirrors the TS object arg).
#[derive(Debug, Clone)]
pub struct SkipAndRescheduleParams {
    pub automation_id: String,
    pub run_id: String,
    pub workspace_key: String,
    pub scheduled_at: Option<i64>,
    pub reason: String,
    pub next_run_at: Option<i64>,
    /// `finalize` = a pure one-shot: the missed target is terminal (completed + disabled + cleared).
    pub finalize: bool,
}

/// Port of `skipAndReschedule`: a missed trigger window atomically records a `skipped` run, pushes
/// `next_run_at` forward, and releases the claim (does not count `run_count`). Under `BEGIN
/// IMMEDIATE`. With `finalize`, the one-shot instead goes terminal (completed, disabled, schedule
/// cleared) and must not derive further cycles from a compatibility `scheduleRule`.
pub fn skip_and_reschedule(
    conn: &Connection,
    p: &SkipAndRescheduleParams,
    now: i64,
) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let inner = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, \
             trigger, dispatch_status, error, attempts, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'schedule', 'skipped', ?5, 0, ?6, ?6) \
             ON CONFLICT(run_id) DO UPDATE SET dispatch_status = 'skipped', error = excluded.error, \
               updated_at = excluded.updated_at",
            rusqlite::params![
                p.run_id,
                p.automation_id,
                p.workspace_key,
                p.scheduled_at,
                p.reason,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        if p.finalize {
            conn.execute(
                "UPDATE automations SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL, \
                 running = 0, claimed_at = NULL, dispatch_status = 'idle', dispatch_attempts = 0, \
                 retry_at = NULL, updated_at = ?2 WHERE automation_id = ?1",
                rusqlite::params![p.automation_id, now],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE automations SET next_run_at = ?2, running = 0, claimed_at = NULL, \
                 dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL, updated_at = ?3 \
                 WHERE automation_id = ?1",
                rusqlite::params![p.automation_id, p.next_run_at, now],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    match inner {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Port of `markManualRunDispatched`: settle a manual run's first dispatch atomically in the ledger
/// and the automation's cumulative `run_count`. Idempotency boundary: `dispatch_status` first
/// entering `dispatched`. A manual run does not advance cron/maxRuns/lifecycle and does not release
/// the single-flight claim. Returns whether the automation's `run_count` was actually incremented.
pub fn mark_manual_run_dispatched(
    conn: &Connection,
    run_id: &str,
    session_id: Option<&str>,
    dispatched_at: i64,
) -> Result<bool, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let inner = (|| -> Result<bool, String> {
        let run: Option<(String, String, String)> = conn
            .query_row(
                "SELECT automation_id, workspace_key, dispatch_status FROM automation_runs \
                 WHERE run_id = ?1 AND trigger = 'manual'",
                [run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        let (automation_id, workspace_key, dispatch_status) = match run {
            Some(v) => v,
            None => return Ok(false),
        };
        if dispatch_status == "dispatched" {
            return Ok(false);
        }
        conn.execute(
            "UPDATE automation_runs SET dispatch_status = 'dispatched', \
             session_id = COALESCE(?2, session_id), error = NULL, updated_at = ?3 \
             WHERE run_id = ?1 AND trigger = 'manual' AND dispatch_status <> 'dispatched'",
            rusqlite::params![run_id, session_id, dispatched_at],
        )
        .map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE automations SET run_count = run_count + 1, last_run_at = ?3, updated_at = ?3 \
                 WHERE automation_id = ?1 AND workspace_key = ?2",
                rusqlite::params![automation_id, workspace_key, dispatched_at],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    })();
    match inner {
        Ok(v) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        crate::migrations::adopt_schema(&conn).expect("invariant: adopt schema");
        conn
    }

    fn insert_full(conn: &Connection, id: &str, wk: &str) {
        conn.execute(
            "INSERT INTO automations (automation_id, title, cron_expr, prompt, model, provider, \
             mode, thought_level, model_selection, workspace_key, workspace_path, workspace_identity, \
             target_task_id, bot_delivery_target, location_kind, recurring, max_runs, end_at, \
             schedule_rule, schedule_edited_by_user, run_count, scheduled_run_count, enabled, \
             lifecycle_status, next_run_at, last_run_at, running, claimed_at, dispatch_status, \
             dispatch_attempts, retry_at, last_error, created_at, updated_at) \
             VALUES (?1,'title','* * * * *','prompt','oldmodel','oldprovider',NULL,'oldthought',?2,?3,'/w',NULL,NULL,NULL,'local',1,NULL,NULL,NULL,0,7,3,1,'active',111,NULL,0,NULL,'idle',0,NULL,NULL,10,10)",
            rusqlite::params![id, r#"{"providerId":"p","modelId":"m"}"#, wk],
        )
        .expect("insert");
    }

    #[test]
    fn update_keeps_undefined_and_preserves_raw_columns() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        // Patch only the title; everything else must be kept, including the raw-only columns.
        let params = AutomationUpdateParams {
            title: Some("New".into()),
            ..Default::default()
        };
        let a = update(
            &conn,
            "a1",
            &params,
            &AutomationUpdateOptions::default(),
            Some("wk"),
            999,
        )
        .unwrap()
        .unwrap();
        assert_eq!(a.title, "New");
        assert_eq!(a.cron_expr, "* * * * *");
        assert_eq!(a.updated_at, 999);
        // model_selection kept (defined value present originally) → still projects the selection.
        assert_eq!(a.model_selection.as_ref().unwrap().model_id, "m");
        assert_eq!(a.run_count, 7);

        // The columns write_row does NOT touch survive in the DB (raw read proves it).
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.model.as_deref(), Some("oldmodel"));
        assert_eq!(raw.provider.as_deref(), Some("oldprovider"));
        assert_eq!(raw.thought_level.as_deref(), Some("oldthought"));
        assert_eq!(raw.location_kind, "local");
    }

    #[test]
    fn update_distinguishes_undefined_from_null_for_model_selection() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        // undefined → keep existing selection.
        let a = update(
            &conn,
            "a1",
            &AutomationUpdateParams::default(),
            &AutomationUpdateOptions::default(),
            None,
            1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(a.model_selection.as_ref().unwrap().model_id, "m");

        // explicit null → clear to the JSON "null" sentinel (followsWorkspace), which projects as no
        // selection but is distinct from a SQL NULL.
        let params = AutomationUpdateParams {
            model_selection: Some(None),
            ..Default::default()
        };
        update(
            &conn,
            "a1",
            &params,
            &AutomationUpdateOptions::default(),
            None,
            2,
        )
        .unwrap();
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.model_selection.as_deref(), Some("null"));
    }

    #[test]
    fn update_mode_three_state_and_validation() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        // A valid mode value is written.
        let params = AutomationUpdateParams {
            mode: Some(Some("plan".into())),
            ..Default::default()
        };
        let a = update(
            &conn,
            "a1",
            &params,
            &AutomationUpdateOptions::default(),
            None,
            1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(a.mode.as_deref(), Some("plan"));

        // Explicit null clears mode.
        let params = AutomationUpdateParams {
            mode: Some(None),
            ..Default::default()
        };
        let a = update(
            &conn,
            "a1",
            &params,
            &AutomationUpdateOptions::default(),
            None,
            2,
        )
        .unwrap()
        .unwrap();
        assert_eq!(a.mode, None);

        // Invalid mode is rejected before touching the row.
        let params = AutomationUpdateParams {
            mode: Some(Some("bogus".into())),
            ..Default::default()
        };
        let err = update(
            &conn,
            "a1",
            &params,
            &AutomationUpdateOptions::default(),
            None,
            3,
        )
        .unwrap_err();
        assert!(err.contains("Invalid automation mode"), "{err}");
    }

    #[test]
    fn update_recurring_and_maxruns_and_endat() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        let params = AutomationUpdateParams {
            recurring: Some(false),
            max_runs: Some(Some(5)),
            end_at: Some(None),
            ..Default::default()
        };
        let a = update(
            &conn,
            "a1",
            &params,
            &AutomationUpdateOptions::default(),
            None,
            1,
        )
        .unwrap()
        .unwrap();
        assert!(!a.recurring);
        assert_eq!(a.max_runs, Some(5));
        assert_eq!(a.end_at, None);
    }

    #[test]
    fn update_lifecycle_status_derives_enabled_and_nextrun() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        // Setting lifecycle to completed forces enabled=0.
        let opts = AutomationUpdateOptions {
            lifecycle_status: Some("completed".into()),
            next_run_at: Some(Some(4242)),
            reset_retry: false,
        };
        let a = update(
            &conn,
            "a1",
            &AutomationUpdateParams::default(),
            &opts,
            None,
            1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(a.lifecycle_status, "completed");
        assert!(!a.enabled);
        assert_eq!(a.next_run_at, Some(4242));

        // No lifecycle change → enabled preserved from existing (now 0, persisted by the previous
        // update). `enabled` only moves when the caller explicitly changes lifecycleStatus.
        let opts = AutomationUpdateOptions {
            next_run_at: Some(None),
            ..Default::default()
        };
        let a = update(
            &conn,
            "a1",
            &AutomationUpdateParams {
                title: Some("t".into()),
                ..Default::default()
            },
            &opts,
            None,
            2,
        )
        .unwrap()
        .unwrap();
        assert!(!a.enabled);
        assert_eq!(a.next_run_at, None);
    }

    #[test]
    fn update_reset_retry_clears_dispatch_state() {
        let conn = db();
        // Seed with a non-idle dispatch state.
        conn.execute(
            "INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, \
             workspace_path, enabled, lifecycle_status, dispatch_status, dispatch_attempts, retry_at, \
             created_at, updated_at) VALUES ('a1','t','* * * * *','p','wk','/w',1,'active',\
             'failed_to_dispatch',3,1234,10,10)",
            [],
        )
        .expect("insert");
        let opts = AutomationUpdateOptions {
            reset_retry: true,
            ..Default::default()
        };
        let a = update(
            &conn,
            "a1",
            &AutomationUpdateParams::default(),
            &opts,
            None,
            5,
        )
        .unwrap()
        .unwrap();
        assert_eq!(a.dispatch_attempts, 0);
        assert_eq!(a.retry_at, None);
        assert_eq!(a.dispatch_status, "idle");
    }

    #[test]
    fn update_missing_row_returns_none() {
        let conn = db();
        let a = update(
            &conn,
            "nope",
            &AutomationUpdateParams::default(),
            &AutomationUpdateOptions::default(),
            None,
            1,
        )
        .unwrap();
        assert!(a.is_none());
    }

    #[test]
    fn update_respects_workspace_scope() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        // Wrong workspace key → treated as missing.
        let a = update(
            &conn,
            "a1",
            &AutomationUpdateParams {
                title: Some("x".into()),
                ..Default::default()
            },
            &AutomationUpdateOptions::default(),
            Some("other"),
            1,
        )
        .unwrap();
        assert!(a.is_none());
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.title, "title", "row must not be touched on scope miss");
    }

    #[test]
    fn delete_removes_and_scopes() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        // Wrong scope → no-op.
        assert!(!delete(&conn, "a1", Some("other")).unwrap());
        assert!(get_raw_row(&conn, "a1", None).unwrap().is_some());
        // Right scope → removed.
        assert!(delete(&conn, "a1", Some("wk")).unwrap());
        assert!(get_raw_row(&conn, "a1", None).unwrap().is_none());
        // Idempotent second delete.
        assert!(!delete(&conn, "a1", None).unwrap());
    }

    #[test]
    fn set_enabled_toggles_and_scopes() {
        let conn = db();
        insert_full(&conn, "a1", "wk");
        set_enabled(&conn, "a1", false, Some("wk"), 50).unwrap();
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.enabled, 0);
        assert_eq!(raw.lifecycle_status, "paused");
        assert_eq!(raw.next_run_at, Some(111), "pause keeps next_run_at");
        // Wrong scope → no-op.
        set_enabled(&conn, "a1", true, Some("other"), 60).unwrap();
        assert_eq!(get_raw_row(&conn, "a1", None).unwrap().unwrap().enabled, 0);
        set_enabled(&conn, "a1", true, Some("wk"), 60).unwrap();
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.enabled, 1);
        assert_eq!(raw.lifecycle_status, "active");
    }

    #[test]
    fn restart_resets_terminal_state() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             run_count, scheduled_run_count, enabled, lifecycle_status, dispatch_status, \
             dispatch_attempts, retry_at, running, claimed_at, last_error, created_at, updated_at) \
             VALUES ('a1','* * * * *','p','wk','/w',9,4,0,'failed','failed_to_dispatch',5,1234,1,777,'boom',1,1)",
            [],
        ).unwrap();
        restart(&conn, "a1", Some(2000), Some("wk"), 3000).unwrap();
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.lifecycle_status, "active");
        assert_eq!(raw.enabled, 1);
        assert_eq!(raw.run_count, 0);
        assert_eq!(raw.scheduled_run_count, 0);
        assert_eq!(raw.dispatch_attempts, 0);
        assert_eq!(raw.retry_at, None);
        assert_eq!(raw.dispatch_status, "idle");
        assert_eq!(raw.running, 0);
        assert_eq!(raw.claimed_at, None);
        assert_eq!(raw.next_run_at, Some(2000));
        assert_eq!(raw.last_error, None);
    }

    #[test]
    fn claim_due_claims_by_next_run_and_finalizes_past_end() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             enabled, running, next_run_at, end_at, created_at, updated_at) \
             VALUES ('due','* * * * *','p','wk','/w',1,0,1000,NULL,1,1)",
            [],
        )
        .unwrap();
        // A past-due one-shot whose end_at already passed → finalized to completed, not claimed.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             enabled, running, next_run_at, end_at, created_at, updated_at) \
             VALUES ('past','* * * * *','p','wk','/w',1,0,500,900,1,1)",
            [],
        )
        .unwrap();
        // Not yet due.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             enabled, running, next_run_at, created_at, updated_at) \
             VALUES ('future','* * * * *','p','wk','/w',1,0,999999,1,1)",
            [],
        )
        .unwrap();
        let now = 1500;
        let claimed = claim_due(&conn, now).unwrap();
        let ids: Vec<&str> = claimed.iter().map(|a| a.automation_id.as_str()).collect();
        assert_eq!(ids, vec!["due"]);
        assert_eq!(claimed[0].dispatch_status, "claimed");
        let raw = get_raw_row(&conn, "due", None).unwrap().unwrap();
        assert_eq!(raw.running, 1);
        assert_eq!(raw.claimed_at, Some(now));
        assert_eq!(raw.dispatch_status, "claimed");
        // The past-due one is completed + disabled.
        let raw = get_raw_row(&conn, "past", None).unwrap().unwrap();
        assert_eq!(raw.lifecycle_status, "completed");
        assert_eq!(raw.enabled, 0);
        assert_eq!(raw.next_run_at, None);
        // Re-claiming the in-flight 'due' returns nothing (running=0 guard).
        assert!(claim_due(&conn, now).unwrap().is_empty());
    }

    #[test]
    fn claim_due_uses_retry_at_and_reclaims_stale() {
        let conn = db();
        // A transient retry: retry_at due, next_run_at in the future (must NOT gate on next_run_at).
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             enabled, running, next_run_at, retry_at, created_at, updated_at) \
             VALUES ('retry','* * * * *','p','wk','/w',1,0,999999,1000,1,1)",
            [],
        )
        .unwrap();
        // A stale in-flight claim (holder crashed): running=1 with an old claimed_at → reclaimed, then claimed.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             enabled, running, claimed_at, next_run_at, created_at, updated_at) \
             VALUES ('zombie','* * * * *','p','wk','/w',1,1,1,1000,1,1)",
            [],
        )
        .unwrap();
        let now = 700_000;
        let claimed = claim_due(&conn, now).unwrap();
        let mut ids: Vec<String> = claimed.iter().map(|a| a.automation_id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["retry", "zombie"]);
        // next_run_at is preserved for the retry path (reuses the same runId/scheduledAt).
        let raw = get_raw_row(&conn, "retry", None).unwrap().unwrap();
        assert_eq!(raw.next_run_at, Some(999999));
    }

    #[test]
    fn mark_dispatched_advances_and_completes() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             recurring, max_runs, run_count, scheduled_run_count, running, claimed_at, dispatch_status, \
             dispatch_attempts, retry_at, last_error, created_at, updated_at) \
             VALUES ('rep','* * * * *','p','wk','/w',1,NULL,2,1,1,5,'claimed',3,999,'e',1,1)",
            [],
        )
        .unwrap();
        mark_dispatched(&conn, "rep", 100, Some(2000)).unwrap();
        let a = get_raw_row(&conn, "rep", None).unwrap().unwrap();
        assert_eq!(a.run_count, 3);
        assert_eq!(a.scheduled_run_count, 2);
        assert_eq!(a.last_run_at, Some(100));
        assert_eq!(a.dispatch_status, "dispatched");
        assert_eq!(a.dispatch_attempts, 0);
        assert_eq!(a.retry_at, None);
        assert_eq!(a.running, 0);
        assert_eq!(a.lifecycle_status, "active");
        assert_eq!(a.enabled, 1);
        assert_eq!(a.next_run_at, Some(2000));

        // One-shot (recurring=0, no max_runs → default cap 1): first scheduled dispatch completes it.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             recurring, max_runs, run_count, scheduled_run_count, created_at, updated_at) \
             VALUES ('once','* * * * *','p','wk','/w',0,NULL,0,0,1,1)",
            [],
        )
        .unwrap();
        mark_dispatched(&conn, "once", 300, Some(4000)).unwrap();
        let raw = get_raw_row(&conn, "once", None).unwrap().unwrap();
        assert_eq!(raw.lifecycle_status, "completed");
        assert_eq!(raw.enabled, 0);
        assert_eq!(raw.next_run_at, None);

        // reached_end: a recurring task whose next would be past end_at → completed.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             recurring, end_at, run_count, scheduled_run_count, created_at, updated_at) \
             VALUES ('endcap','* * * * *','p','wk','/w',1,5000,0,0,1,1)",
            [],
        )
        .unwrap();
        mark_dispatched(&conn, "endcap", 100, Some(6000)).unwrap();
        assert_eq!(
            get_raw_row(&conn, "endcap", None)
                .unwrap()
                .unwrap()
                .lifecycle_status,
            "completed"
        );

        // Deleted automation: write-back dropped without resurrecting.
        assert!(mark_dispatched(&conn, "missing", 100, Some(1)).is_ok());
    }

    #[test]
    fn mark_dispatch_failed_transient_backoff_and_max_attempts() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             recurring, dispatch_attempts, running, created_at, updated_at) \
             VALUES ('rep','* * * * *','p','wk','/w',1,0,1,1,1)",
            [],
        )
        .unwrap();
        // First transient failure: attempts→1, retry_at = now + base.
        mark_dispatch_failed(
            &conn,
            "rep",
            1000,
            "boom",
            DispatchFailureKind::Transient,
            Some(9999),
        )
        .unwrap();
        let raw = get_raw_row(&conn, "rep", None).unwrap().unwrap();
        assert_eq!(raw.dispatch_attempts, 1);
        assert_eq!(
            raw.retry_at,
            Some(crate::automation::compute_retry_at(1000, 1))
        );
        assert_eq!(raw.dispatch_status, "failed_to_dispatch");
        assert_eq!(raw.running, 0);

        // At max attempts on a recurring task: idle, reset, jump to next_run_at.
        conn.execute(
            "UPDATE automations SET dispatch_attempts = 4 WHERE automation_id='rep'",
            [],
        )
        .unwrap();
        mark_dispatch_failed(
            &conn,
            "rep",
            2000,
            "boom2",
            DispatchFailureKind::Transient,
            Some(7777),
        )
        .unwrap();
        let raw = get_raw_row(&conn, "rep", None).unwrap().unwrap();
        assert_eq!(raw.dispatch_status, "idle");
        assert_eq!(raw.dispatch_attempts, 0);
        assert_eq!(raw.retry_at, None);
        assert_eq!(raw.next_run_at, Some(7777));
        assert_eq!(raw.lifecycle_status, "active");
    }

    #[test]
    fn mark_dispatch_failed_max_nonrecurring_and_permanent() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             recurring, dispatch_attempts, enabled, created_at, updated_at) \
             VALUES ('once','* * * * *','p','wk','/w',0,4,1,1,1)",
            [],
        )
        .unwrap();
        mark_dispatch_failed(
            &conn,
            "once",
            5000,
            "e",
            DispatchFailureKind::Transient,
            None,
        )
        .unwrap();
        let raw = get_raw_row(&conn, "once", None).unwrap().unwrap();
        assert_eq!(raw.lifecycle_status, "failed");
        assert_eq!(raw.enabled, 0);
        assert_eq!(raw.dispatch_status, "failed_to_dispatch");

        // Permanent failure goes terminal immediately.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             recurring, enabled, running, created_at, updated_at) \
             VALUES ('perm','* * * * *','p','wk','/w',1,1,1,1,1)",
            [],
        )
        .unwrap();
        mark_dispatch_failed(
            &conn,
            "perm",
            1,
            "dead",
            DispatchFailureKind::Permanent,
            None,
        )
        .unwrap();
        let raw = get_raw_row(&conn, "perm", None).unwrap().unwrap();
        assert_eq!(raw.lifecycle_status, "failed");
        assert_eq!(raw.enabled, 0);
        assert_eq!(raw.running, 0);
        assert_eq!(raw.last_error.as_deref(), Some("dead"));
    }

    #[test]
    fn release_claim_guarded_by_running() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             running, claimed_at, next_run_at, created_at, updated_at) \
             VALUES ('a1','* * * * *','p','wk','/w',1,123,500,1,1)",
            [],
        )
        .unwrap();
        release_claim(&conn, "a1", 900).unwrap();
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.running, 0);
        assert_eq!(raw.claimed_at, None);
        assert_eq!(raw.dispatch_status, "idle");
        assert_eq!(raw.next_run_at, Some(500), "release keeps next_run_at");

        // An idle automation is untouched (running=1 guard).
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             running, dispatch_status, created_at, updated_at) \
             VALUES ('b1','* * * * *','p','wk','/w',0,'claimed',1,1)",
            [],
        )
        .unwrap();
        release_claim(&conn, "b1", 900).unwrap();
        assert_eq!(
            get_raw_row(&conn, "b1", None)
                .unwrap()
                .unwrap()
                .dispatch_status,
            "claimed"
        );
    }

    #[test]
    fn run_now_claims_once_and_releases_via_stale() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             running, created_at, updated_at) VALUES ('a1','* * * * *','p','wk','/w',0,1,1)",
        [],
        )
        .unwrap();
        let first = run_now(&conn, "a1", Some("wk"), 100)
            .unwrap()
            .expect("claimed");
        assert_eq!(first.run.trigger, "manual");
        assert_eq!(first.run.attempts, 1);
        assert_eq!(
            first.automation.dispatch_status, "idle",
            "manual does not change dispatch_status"
        );
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.running, 1);
        assert_eq!(raw.claimed_at, Some(100));
        // Second click while held → None (single-flight lock).
        assert!(run_now(&conn, "a1", Some("wk"), 200).unwrap().is_none());
        // A ledger row was written.
        let runs = list_runs(&conn, "a1", None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].dispatch_status, "claimed");

        // After the claim goes stale, run_now recycles it and re-claims.
        let later = 100 + crate::automation::CLAIM_STALE_MS;
        let re = run_now(&conn, "a1", Some("wk"), later).unwrap();
        assert!(re.is_some());
    }

    #[test]
    fn run_now_scope_mismatch_returns_none() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             running, created_at, updated_at) VALUES ('a1','* * * * *','p','wk','/w',0,1,1)",
            [],
        )
        .unwrap();
        assert!(run_now(&conn, "a1", Some("other"), 100).unwrap().is_none());
    }

    #[test]
    fn claim_manual_runs_claims_pending_and_orders_asc() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             running, created_at, updated_at) VALUES ('a1','* * * * *','p','wk','/w',0,1,1)",
            [],
        )
        .unwrap();
        // Two manual claimed runs awaiting pickup (attempts=0).
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, trigger, \
             dispatch_status, attempts, created_at, updated_at) VALUES ('r1','a1','wk',10,'manual','claimed',0,10,10)",
            [],
        ).unwrap();
        // r2 is created later but the automation is idle; only the first wins (running lock), the
        // second is skipped because after claiming a1.running=1.
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, trigger, \
             dispatch_status, attempts, created_at, updated_at) VALUES ('r2','a1','wk',20,'manual','claimed',0,20,20)",
            [],
        ).unwrap();
        let claimed = claim_manual_runs(&conn, 50).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(
            claimed[0].run.run_id, "r1",
            "ORDER BY created_at ASC picks r1 first"
        );
        assert_eq!(claimed[0].run.attempts, 1, "attempts incremented");
        // The automation lock is now held.
        assert_eq!(get_raw_row(&conn, "a1", None).unwrap().unwrap().running, 1);
    }

    #[test]
    fn upsert_and_fix_run_selection_coalesce_semantics() {
        let conn = db();
        let sel = ModelSelection {
            provider_id: "p".into(),
            model_id: "m".into(),
            options: None,
        };
        upsert_run_claimed(
            &conn,
            &RunIdentity {
                run_id: "r1",
                automation_id: "a1",
                workspace_key: "wk",
                scheduled_at: Some(10),
                trigger: "schedule",
            },
            Some(&sel),
            100,
        )
        .unwrap();
        // Re-claiming the same runId (retry): attempts+1, keeps frozen model_selection.
        upsert_run_claimed(
            &conn,
            &RunIdentity {
                run_id: "r1",
                automation_id: "a1",
                workspace_key: "wk",
                scheduled_at: Some(10),
                trigger: "schedule",
            },
            None,
            200,
        )
        .unwrap();
        let run = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!(run.attempts, 1);
        assert_eq!(run.model_selection.as_ref().unwrap().model_id, "m");

        // fixRunModelSelection only fills the first time; the frozen value wins afterwards.
        let other = ModelSelection {
            provider_id: "x".into(),
            model_id: "y".into(),
            options: None,
        };
        let fixed = fix_run_model_selection(&conn, "r1", &other, 300).unwrap();
        assert_eq!(fixed.model_id, "m", "existing selection is preserved");
        // fix on a fresh row sets it.
        upsert_run_claimed(
            &conn,
            &RunIdentity {
                run_id: "r2",
                automation_id: "a1",
                workspace_key: "wk",
                scheduled_at: None,
                trigger: "schedule",
            },
            None,
            100,
        )
        .unwrap();
        let fixed = fix_run_model_selection(&conn, "r2", &other, 200).unwrap();
        assert_eq!(fixed.model_id, "y");
    }

    #[test]
    fn mark_run_outcome_terminal_guard() {
        let conn = db();
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, created_at, updated_at) \
             VALUES ('r1','a1','wk','schedule','dispatched',1,1)",
            [],
        ).unwrap();
        mark_run_outcome(&conn, "r1", "running", None, 10).unwrap();
        assert_eq!(
            get_run(&conn, "r1").unwrap().unwrap().outcome.as_deref(),
            Some("running")
        );
        // A terminal outcome is written.
        mark_run_outcome(&conn, "r1", "succeeded", Some("late"), 20).unwrap();
        assert_eq!(
            get_run(&conn, "r1").unwrap().unwrap().outcome.as_deref(),
            Some("succeeded")
        );
        // A late 'running' must not overwrite the settled outcome nor its error.
        mark_run_outcome(&conn, "r1", "running", Some("ignored"), 30).unwrap();
        let r = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!(r.outcome.as_deref(), Some("succeeded"));
        assert_eq!(r.error.as_deref(), Some("late"));
    }

    #[test]
    fn mark_run_dispatch_session_coalesce() {
        let conn = db();
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, session_id, created_at, updated_at) \
             VALUES ('r1','a1','wk','schedule','claimed','sess-orig',1,1)",
            [],
        ).unwrap();
        mark_run_dispatch(&conn, "r1", "dispatched", None, None, 10).unwrap();
        let r = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!(r.dispatch_status, "dispatched");
        assert_eq!(
            r.session_id.as_deref(),
            Some("sess-orig"),
            "COALESCE keeps prior session"
        );
        mark_run_dispatch(
            &conn,
            "r1",
            "failed_to_dispatch",
            Some("new"),
            Some("err"),
            20,
        )
        .unwrap();
        let r = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!(r.session_id.as_deref(), Some("new"));
        assert_eq!(r.error.as_deref(), Some("err"));
    }

    #[test]
    fn skip_and_reschedule_records_run_and_advances() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             run_count, enabled, lifecycle_status, running, created_at, updated_at) \
             VALUES ('a1','* * * * *','p','wk','/w',2,1,'active',1,1,1)",
            [],
        ).unwrap();
        let p = SkipAndRescheduleParams {
            automation_id: "a1".into(),
            run_id: "r1".into(),
            workspace_key: "wk".into(),
            scheduled_at: Some(5),
            reason: "missed".into(),
            next_run_at: Some(3000),
            finalize: false,
        };
        skip_and_reschedule(&conn, &p, 100).unwrap();
        let run = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!(run.dispatch_status, "skipped");
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.run_count, 2, "skip does not count run_count");
        assert_eq!(raw.next_run_at, Some(3000));
        assert_eq!(raw.running, 0);

        // finalize turns the one-shot terminal.
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             enabled, lifecycle_status, running, created_at, updated_at) \
             VALUES ('a2','* * * * *','p','wk','/w',1,'active',1,1,1)",
            [],
        ).unwrap();
        let p = SkipAndRescheduleParams {
            automation_id: "a2".into(),
            run_id: "r2".into(),
            workspace_key: "wk".into(),
            scheduled_at: None,
            reason: "missed".into(),
            next_run_at: None,
            finalize: true,
        };
        skip_and_reschedule(&conn, &p, 100).unwrap();
        let raw = get_raw_row(&conn, "a2", None).unwrap().unwrap();
        assert_eq!(raw.lifecycle_status, "completed");
        assert_eq!(raw.enabled, 0);
        assert_eq!(raw.next_run_at, None);
    }

    #[test]
    fn mark_manual_run_dispatched_idempotent_run_count() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             run_count, running, claimed_at, created_at, updated_at) \
             VALUES ('a1','* * * * *','p','wk','/w',0,1,10,1,1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, attempts, created_at, updated_at) \
             VALUES ('r1','a1','wk','manual','claimed',1,10,10)",
            [],
        ).unwrap();
        // First settle → true, run_count → 1, claim still held (manual does not release).
        assert!(mark_manual_run_dispatched(&conn, "r1", Some("s1"), 200).unwrap());
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.run_count, 1);
        assert_eq!(raw.running, 1);
        assert_eq!(
            get_run(&conn, "r1").unwrap().unwrap().session_id.as_deref(),
            Some("s1")
        );
        // Second settle is a no-op (already dispatched).
        assert!(!mark_manual_run_dispatched(&conn, "r1", Some("s2"), 300).unwrap());
        assert_eq!(
            get_raw_row(&conn, "a1", None).unwrap().unwrap().run_count,
            1
        );
        // Non-manual run → false (trigger guard).
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, created_at, updated_at) \
             VALUES ('r2','a1','wk','schedule','claimed',1,1)",
            [],
        ).unwrap();
        assert!(!mark_manual_run_dispatched(&conn, "r2", None, 400).unwrap());
    }

    #[test]
    fn ledger_reads_and_prune() {
        let conn = db();
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, attempts, created_at, updated_at) \
             VALUES ('r1','a1','wk','manual','claimed',0,10,10)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, attempts, created_at, updated_at) \
             VALUES ('r2','a1','other','manual','claimed',0,20,20)",
            [],
        ).unwrap();
        // listRuns is DESC by created_at, workspace-scoped.
        let all = list_runs(&conn, "a1", None).unwrap();
        assert_eq!(
            all.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(),
            vec!["r2", "r1"]
        );
        let scoped = list_runs(&conn, "a1", Some("wk")).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(get_run(&conn, "r1").unwrap().unwrap().automation_id, "a1");
        assert!(get_run(&conn, "nope").unwrap().is_none());

        delete_run(&conn, "r1", Some("other")).unwrap();
        assert!(get_run(&conn, "r1").unwrap().is_some(), "wrong scope no-op");
        delete_run(&conn, "r1", Some("wk")).unwrap();
        assert!(get_run(&conn, "r1").unwrap().is_none());

        // ensure_run_claimed is idempotent (DO NOTHING).
        let r3 = RunIdentity {
            run_id: "r3",
            automation_id: "a1",
            workspace_key: "wk",
            scheduled_at: None,
            trigger: "schedule",
        };
        ensure_run_claimed(&conn, &r3, 5).unwrap();
        ensure_run_claimed(&conn, &r3, 6).unwrap();
        assert_eq!(get_run(&conn, "r3").unwrap().unwrap().updated_at, 5);

        // prune_runs removes everything strictly older than now - max_age_ms.
        let removed = prune_runs(&conn, 1, 25).unwrap();
        // r2 created_at=20 < 24, r3 created_at=5 < 24 → both pruned.
        assert_eq!(removed, 2);
    }

    #[test]
    fn claim_due_rolls_back_the_transaction_on_projection_error() {
        let conn = db();
        // A due automation whose schedule_rule is invalid JSON: the claim UPDATE sets running=1,
        // but row_to_automation throws on JSON.parse, so the BEGIN IMMEDIATE must ROLLBACK and leave
        // the automation un-claimed (matching the TS catch → ROLLBACK → rethrow).
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             enabled, running, next_run_at, schedule_rule, created_at, updated_at) \
             VALUES ('a1','* * * * *','p','wk','/w',1,0,1000,'{not json',1,1)",
            [],
        )
        .unwrap();
        let err = claim_due(&conn, 1500).unwrap_err();
        assert!(!err.is_empty(), "projection error must propagate: {err}");
        // The running=1 write inside the aborted transaction is not persisted.
        let raw = get_raw_row(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(raw.running, 0, "rollback must undo the claim");
        assert_eq!(raw.dispatch_status, "idle");
    }

    #[test]
    fn read_helpers_scheduled_count_binding_and_dispatch_selection() {
        let conn = db();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, \
             scheduled_run_count, target_task_id, model_selection, created_at, updated_at) \
             VALUES ('a1','* * * * *','p','wk','/w',3,'task-1','null',1,1)",
            [],
        ).unwrap();
        assert_eq!(get_scheduled_run_count(&conn, "a1", None).unwrap(), Some(3));
        assert_eq!(
            get_scheduled_run_count(&conn, "a1", Some("other")).unwrap(),
            None
        );
        assert!(has_task_binding(&conn, "wk", "task-1").unwrap());
        assert!(!has_task_binding(&conn, "other", "task-1").unwrap());

        // model_selection "null" sentinel → follows the workspace (None, no error).
        assert!(get_model_selection_for_dispatch(&conn, "a1", "wk")
            .unwrap()
            .is_none());
        // A real selection is returned.
        conn.execute(
            "UPDATE automations SET model_selection='{\"providerId\":\"p\",\"modelId\":\"m\"}' WHERE automation_id='a1'",
            [],
        ).unwrap();
        assert_eq!(
            get_model_selection_for_dispatch(&conn, "a1", "wk")
                .unwrap()
                .unwrap()
                .model_id,
            "m"
        );
        // SQL NULL (missing config) is an error, not a silent default.
        conn.execute(
            "UPDATE automations SET model_selection=NULL WHERE automation_id='a1'",
            [],
        )
        .unwrap();
        assert!(get_model_selection_for_dispatch(&conn, "a1", "wk").is_err());
        // Missing automation is an error.
        assert!(get_model_selection_for_dispatch(&conn, "nope", "wk").is_err());
    }
}
