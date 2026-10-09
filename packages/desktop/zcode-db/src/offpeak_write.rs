//! OffPeakTaskRepo state-machine + write path (ported from
//! `packages/services/src/session/offPeakTaskRepo.ts`).
//!
//! The repo owns only storage and atomic state transitions for the `off_peak_tasks` table. Two
//! invariants are guarded here: terminal states are irreversible, and the single-flight claim lock
//! (`claim_running`) allows one dispatcher per task. Queue/promotion semantics live server-side —
//! `schedulable` is just a snapshot the host poll writes back, so no logic here derives it.
//!
//! Read projections are reused from [`crate::offpeak`] (`get_off_peak` == the TS `getRow`+`rowToTask`
//! single-row path; `map_off_peak_row` deliberately omits the claim/attempt/last-error columns that
//! the domain output never surfaces). The `model_selection` column is (de)serialized through
//! [`crate::automation`] so the schema stays the single shared definition.

use rusqlite::{params, Connection, OptionalExtension};

use crate::automation::{serialize_model_selection, ModelSelection};
use crate::offpeak::{
    get_off_peak, OffPeakTask, OFF_PEAK_CLAIM_STALE_MS, OFF_PEAK_TERMINAL_STATUSES,
};

/// The `status IN (...)` fragment projected from [`OFF_PEAK_TERMINAL_STATUSES`] — a single source so
/// the terminal-set guards cannot drift from the constant (mirrors TS `TERMINAL_SQL_LIST`).
fn terminal_in_list() -> String {
    OFF_PEAK_TERMINAL_STATUSES
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Port of `isOffPeakBoundSessionConflict`: whether a failed INSERT hit the partial unique index
/// `idx_off_peak_bound_active(workspace_key, session_id)` (the loser of a concurrent double-create of
/// the same bound, still-active session). Matches the SQLite error text exactly as the TS regex does.
///
/// # Arguments
///
/// * `error` — the `String` error a [`create_off_peak`] call returned.
///
/// # Returns
///
/// `true` iff the message is the `(workspace_key, session_id)` UNIQUE-constraint failure.
pub fn is_off_peak_bound_session_conflict(error: &str) -> bool {
    error.contains(
        "UNIQUE constraint failed: off_peak_tasks.workspace_key, off_peak_tasks.session_id",
    )
}

/// Inputs for [`create_off_peak`] (mirrors `ZCodeOffPeakTaskCreateParams`).
#[derive(Debug, Clone)]
pub struct OffPeakCreateParams {
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub title: String,
    pub prompt: String,
    pub permission_mode: String,
    pub model_selection: ModelSelection,
    /// Bound conversation/session id (`boundSessionId`): non-null binds the card to a running
    /// session and is subject to `idx_off_peak_bound_active`.
    pub bound_session_id: Option<String>,
}

/// Caller-supplied registration state (mirrors the `create` `options` arg). `off_peak_task_id`
/// defaults to a generated `offpeak-<uuid>` when `None` (the service takes a server ticket first,
/// which needs an id, and passes it in).
#[derive(Debug, Clone, Default)]
pub struct OffPeakCreateOptions {
    pub off_peak_task_id: Option<String>,
    pub server_ticket_id: Option<String>,
    pub queue_position: Option<i64>,
    pub registered_at: Option<i64>,
    /// 取号即 ready：随建即可被 scheduler 认领。
    pub schedulable: bool,
}

/// Port of `create`: insert an `off_peak_tasks` row with `status='queued'` and read it back.
///
/// `conversation_id` is forced NULL (backfilled on first run); `model`/`thought_level` stay NULL
/// (legacy rollback columns); `claim_running`/`attempt_count` start at 0; `created_at`/`updated_at`
/// both use `now`. `now` is injected (TS defaults to `Date.now()`); the id defaults to a fresh
/// `offpeak-<uuid>`.
///
/// # Errors
///
/// Returns `Err` when the `model_selection` cannot be serialized (empty provider/model, mirroring
/// the TS `modelSelectionSchema.parse` throw) or when the insert violates
/// `idx_off_peak_bound_active` — inspect with [`is_off_peak_bound_session_conflict`].
pub fn create_off_peak(
    conn: &Connection,
    p: &OffPeakCreateParams,
    o: &OffPeakCreateOptions,
    now: i64,
) -> Result<OffPeakTask, String> {
    let id = o
        .off_peak_task_id
        .clone()
        .unwrap_or_else(|| format!("offpeak-{}", uuid::Uuid::new_v4()));
    let wk = crate::workspace_key(&p.workspace_path, p.workspace_identity.as_deref());
    let model_selection = serialize_model_selection(&p.model_selection)
        .ok_or_else(|| "Off-Peak ModelSelection 校验失败（providerId/modelId 为空）".to_string())?;

    conn.execute(
        "INSERT INTO off_peak_tasks (
          off_peak_task_id, server_ticket_id, title, conversation_id, session_id,
          prompt, permission_mode, model, thought_level, model_selection,
          workspace_key, workspace_path, workspace_identity,
          status, queued_at, registered_at, schedulable, queue_position,
          claim_running, attempt_count, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, NULL, ?4,
          ?5, ?6, NULL, NULL, ?7,
          ?8, ?9, ?10,
          'queued', ?11, ?12, ?13, ?14,
          0, 0, ?15, ?15
        )",
        params![
            id,
            o.server_ticket_id,
            p.title,
            p.bound_session_id,
            p.prompt,
            p.permission_mode,
            model_selection,
            wk,
            p.workspace_path,
            p.workspace_identity,
            now,
            o.registered_at,
            i64::from(o.schedulable),
            o.queue_position,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    get_off_peak(conn, &id)?.ok_or_else(|| format!("off_peak row missing after insert: {id}"))
}

/// Port of `invalidateModelSelection`: when a Registry change invalidates the saved selection, keep
/// the resolved `model`/`thought_level` snapshot for repair, clear `model_selection`, and revoke
/// `schedulable`. Wrapped in `BEGIN IMMEDIATE` (mirrors TS).
///
/// The stale `observed` selection is only applied when it still matches what is stored; if another
/// process already repaired the row to a different provider/model/reasoningLevel, the updated row is
/// returned untouched (never overwritten by a stale observation).
///
/// # Returns
///
/// `Ok(None)` when the row is absent; otherwise the post-invalidation (or preserved) projection.
pub fn invalidate_model_selection(
    conn: &Connection,
    id: &str,
    observed: &ModelSelection,
    now: i64,
) -> Result<Option<OffPeakTask>, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let result = invalidate_model_selection_inner(conn, id, observed, now);
    finish_txn(conn, result)
}

fn invalidate_model_selection_inner(
    conn: &Connection,
    id: &str,
    observed: &ModelSelection,
    now: i64,
) -> Result<Option<OffPeakTask>, String> {
    let current = match get_off_peak(conn, id)? {
        Some(c) => c,
        None => return Ok(None),
    };
    if let Some(cur) = current.model_selection.as_ref() {
        let cur_level = cur
            .options
            .as_ref()
            .and_then(|o| o.reasoning_level.as_deref());
        let obs_level = observed
            .options
            .as_ref()
            .and_then(|o| o.reasoning_level.as_deref());
        if cur.provider_id != observed.provider_id
            || cur.model_id != observed.model_id
            || cur_level != obs_level
        {
            // 另一进程已完成用户修复，以更新后的值为准，不能用旧 Registry 观察覆盖它。
            return Ok(Some(current));
        }
    }
    let thought_level = observed
        .options
        .as_ref()
        .and_then(|o| o.reasoning_level.clone());
    conn.execute(
        "UPDATE off_peak_tasks
         SET model = ?1, thought_level = ?2,
             model_selection = NULL, schedulable = 0, updated_at = ?3
         WHERE off_peak_task_id = ?4",
        params![observed.model_id, thought_level, now, id],
    )
    .map_err(|e| e.to_string())?;
    get_off_peak(conn, id)
}

/// Patch fields for [`update_editable_fields`] (mirrors the `params` arg). `model_selection`:
/// outer `None` = leave unchanged, `Some(None)` = explicit null (rejected), `Some(Some(_))` = replace.
#[derive(Debug, Clone, Default)]
pub struct EditableFields {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub permission_mode: Option<String>,
    pub model_selection: Option<Option<ModelSelection>>,
}

/// Port of `updateEditableFields`: edit card fields during the queued/paused window only.
///
/// A row that is missing, or not in `queued`/`paused`, returns `Ok(None)` (no edit). `model`/
/// `thought_level` are never rewritten here (they are the published rollback snapshot), and this
/// update only changes `model_selection` — it does not fabricate legacy values for new rows.
///
/// # Errors
///
/// Returns `Err` when no effective selection can be resolved (no incoming replacement and the row
/// has no valid stored selection), mirroring the TS throw.
pub fn update_editable_fields(
    conn: &Connection,
    id: &str,
    patch: &EditableFields,
    now: i64,
) -> Result<Option<OffPeakTask>, String> {
    let row = match get_off_peak(conn, id)? {
        Some(r) => r,
        None => return Ok(None),
    };
    if row.status != "queued" && row.status != "paused" {
        return Ok(None);
    }
    if matches!(patch.model_selection, Some(None)) {
        return Ok(None);
    }
    let next = match &patch.model_selection {
        Some(Some(ms)) => ms.clone(),
        _ => row
            .model_selection
            .clone()
            .ok_or_else(|| format!("Off-Peak task 缺少有效 ModelSelection: {id}"))?,
    };
    let serialized = serialize_model_selection(&next)
        .ok_or_else(|| format!("Off-Peak task 缺少有效 ModelSelection: {id}"))?;
    conn.execute(
        "UPDATE off_peak_tasks SET
          title = ?1, prompt = ?2, permission_mode = ?3,
          model_selection = ?4, updated_at = ?5
        WHERE off_peak_task_id = ?6",
        params![
            patch.title.as_ref().unwrap_or(&row.title),
            patch.prompt.as_ref().unwrap_or(&row.prompt),
            patch
                .permission_mode
                .as_ref()
                .unwrap_or(&row.permission_mode),
            serialized,
            now,
            id,
        ],
    )
    .map_err(|e| e.to_string())?;
    get_off_peak(conn, id)
}

/// Patch fields for [`update_scheduling_snapshot`] (host poll / re-registration writeback). Every
/// field distinguishes "absent = keep current" from an explicit new value; the two nullable queue
/// columns additionally distinguish explicit null (= clear).
#[derive(Debug, Clone, Default)]
pub struct SchedulingPatch {
    pub schedulable: Option<bool>,
    pub queue_position: Option<Option<i64>>,
    pub next_poll_at: Option<Option<i64>>,
    pub server_ticket_id: Option<String>,
    pub registered_at: Option<i64>,
}

/// Port of `updateSchedulingSnapshot`: overwrite only the explicitly-provided scheduling fields and
/// bump `updated_at`. A missing row is a no-op. Single statement (TS does not wrap it).
pub fn update_scheduling_snapshot(
    conn: &Connection,
    id: &str,
    patch: &SchedulingPatch,
    now: i64,
) -> Result<(), String> {
    let row = match get_off_peak(conn, id)? {
        Some(r) => r,
        None => return Ok(()),
    };
    let schedulable = match patch.schedulable {
        Some(v) => i64::from(v),
        None => i64::from(row.schedulable),
    };
    let queue_position = match &patch.queue_position {
        Some(v) => *v,
        None => row.queue_position,
    };
    let next_poll_at = match &patch.next_poll_at {
        Some(v) => *v,
        None => row.next_poll_at,
    };
    let server_ticket_id = patch
        .server_ticket_id
        .clone()
        .or_else(|| row.server_ticket_id.clone());
    let registered_at = patch.registered_at.or(row.registered_at);
    conn.execute(
        "UPDATE off_peak_tasks SET
          schedulable = ?1, queue_position = ?2, next_poll_at = ?3,
          server_ticket_id = ?4, registered_at = ?5, updated_at = ?6
        WHERE off_peak_task_id = ?7",
        params![
            schedulable,
            queue_position,
            next_poll_at,
            server_ticket_id,
            registered_at,
            now,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `claimDue`: reclaim stale single-flight claims, then atomically claim every dispatchable
/// task (`status='queued'`, `schedulable=1`, `claim_running=0`, FIFO by `queued_at` then
/// `created_at`). Rows without a valid `model_selection` are skipped (so a legacy row can neither be
/// claimed nor block the healthy tasks behind it). Wrapped in `BEGIN IMMEDIATE`.
///
/// Each claim is a guarded `UPDATE ... WHERE claim_running = 0`; the returned projections reflect the
/// row as read before its own claim (the claim columns are not part of the domain output, matching
/// `rowToTask`).
pub fn claim_due(conn: &Connection, now: i64) -> Result<Vec<OffPeakTask>, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<Vec<OffPeakTask>, String> {
        conn.execute(
            "UPDATE off_peak_tasks
             SET claim_running = 0, claimed_at = NULL
             WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?1",
            params![now - OFF_PEAK_CLAIM_STALE_MS],
        )
        .map_err(|e| e.to_string())?;

        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT off_peak_task_id FROM off_peak_tasks
                     WHERE status = 'queued' AND schedulable = 1 AND claim_running = 0
                     ORDER BY queued_at ASC, created_at ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let mut claimed = Vec::new();
        for id in ids {
            // 历史行可能没有 Provider 身份：留在列表等待修复，但不被 scheduler 认领。
            let Some(proj) = get_off_peak(conn, &id)? else {
                continue;
            };
            if proj.model_selection.is_none() {
                continue;
            }
            let changed = conn
                .execute(
                    "UPDATE off_peak_tasks
                     SET claim_running = 1, claimed_at = ?1, updated_at = ?1
                     WHERE off_peak_task_id = ?2 AND claim_running = 0",
                    params![now, id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 1 {
                claimed.push(proj);
            }
        }
        Ok(claimed)
    })();
    finish_txn(conn, result)
}

/// Port of `markRunning`: dispatch admitted, `queued → running`. Guards on `status='queued'` (a
/// terminal row or a `paused` race returns `Ok(None)`). Keeps the first segment's `started_at`
/// (`COALESCE`); only overwrites `conversation`/`session`/`server_ticket` when provided; releases the
/// claim and clears `last_error`. `updated_at` uses `started_at` (TS).
pub fn mark_running(
    conn: &Connection,
    id: &str,
    started_at: i64,
    conversation_id: Option<&str>,
    session_id: Option<&str>,
    server_ticket_id: Option<&str>,
) -> Result<Option<OffPeakTask>, String> {
    let changed = conn
        .execute(
            "UPDATE off_peak_tasks
            SET status = 'running',
                started_at = COALESCE(started_at, ?1),
                conversation_id = COALESCE(?2, conversation_id),
                session_id = COALESCE(?3, session_id),
                server_ticket_id = COALESCE(?4, server_ticket_id),
                claim_running = 0, claimed_at = NULL,
                last_error = NULL,
                updated_at = ?1
            WHERE off_peak_task_id = ?5 AND status = 'queued'",
            params![
                started_at,
                conversation_id,
                session_id,
                server_ticket_id,
                id
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Ok(None);
    }
    get_off_peak(conn, id)
}

/// The three irreversible terminal states a task may settle into (mirrors the TS literal union).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffPeakTerminalStatus {
    Completed,
    Failed,
    Cancelled,
}

impl OffPeakTerminalStatus {
    /// The stored `status` string.
    pub fn as_str(self) -> &'static str {
        match self {
            OffPeakTerminalStatus::Completed => "completed",
            OffPeakTerminalStatus::Failed => "failed",
            OffPeakTerminalStatus::Cancelled => "cancelled",
        }
    }
}

/// Port of `markTerminal`: settle a task into a terminal state. Guards on `status NOT IN (terminal)`
/// — a row already terminal rejects the second transition (`Ok(None)`), the state-machine invariant.
///
/// `failure_reason` is set directly (cleared when absent); `files_changed` is kept when not provided
/// (`COALESCE`); `dispatch_error` atomically adds one dispatch attempt and records `last_error`.
/// `schedulable` is revoked and the claim released; `updated_at` uses `ended_at` (TS). `settled_at` is
/// backfilled separately by [`mark_settled`].
pub fn mark_terminal(
    conn: &Connection,
    id: &str,
    status: OffPeakTerminalStatus,
    ended_at: i64,
    failure_reason: Option<&str>,
    files_changed: Option<i64>,
    dispatch_error: Option<&str>,
) -> Result<Option<OffPeakTask>, String> {
    let changed = conn
        .execute(
            &format!(
                "UPDATE off_peak_tasks
            SET status = ?1,
                ended_at = ?2,
                failure_reason = ?3,
                files_changed = COALESCE(?4, files_changed),
                attempt_count = attempt_count + ?5,
                last_error = COALESCE(?6, last_error),
                schedulable = 0,
                claim_running = 0, claimed_at = NULL,
                updated_at = ?2
            WHERE off_peak_task_id = ?7 AND status NOT IN ({})",
                terminal_in_list()
            ),
            params![
                status.as_str(),
                ended_at,
                failure_reason,
                files_changed,
                i64::from(dispatch_error.is_some()),
                dispatch_error,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Ok(None);
    }
    get_off_peak(conn, id)
}

/// Port of `setPaused`: user Pause/Continue, `queued ⇄ paused`. Guards on the expected `from` status
/// and `claim_running = 0` (a task mid-dispatch cannot be paused → `Ok(None)`).
pub fn set_paused(
    conn: &Connection,
    id: &str,
    paused: bool,
    now: i64,
) -> Result<Option<OffPeakTask>, String> {
    let (to, from) = if paused {
        ("paused", "queued")
    } else {
        ("queued", "paused")
    };
    let changed = conn
        .execute(
            "UPDATE off_peak_tasks
            SET status = ?1, updated_at = ?2
            WHERE off_peak_task_id = ?3 AND status = ?4 AND claim_running = 0",
            params![to, now, id, from],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Ok(None);
    }
    get_off_peak(conn, id)
}

/// Port of `releaseClaim`: reset the single-flight lock after a dispatch failure / shutdown. With an
/// `error`, atomically adds one attempt and records `last_error` (for dispatch backoff / diagnosis).
/// Does not change `status` — the task stays `queued` for the next round. Single statement guarded on
/// `claim_running = 1`.
pub fn release_claim(
    conn: &Connection,
    id: &str,
    error: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE off_peak_tasks
        SET claim_running = 0, claimed_at = NULL,
            attempt_count = attempt_count + ?1,
            last_error = COALESCE(?2, last_error),
            updated_at = ?3
        WHERE off_peak_task_id = ?4 AND claim_running = 1",
        params![i64::from(error.is_some()), error, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `recoverInterrupted`: app-start reclaim (before any dispatch). Rows left `running` by a
/// dead process return to `queued` (keeping `queued_at` and `session_id` for resume), plus stale-claim
/// cleanup. Wrapped in `BEGIN IMMEDIATE`. Returns the number of rows recovered.
///
/// 早期预留的 `awaiting_approval` 从未在生产写入：一并回 `running`，再随本轮回收为 `queued`
/// （原 `initialize` 的遗留数据修复语句；adopt_schema 只做建表，不做该修复）。
pub fn recover_interrupted(conn: &Connection, now: i64) -> Result<i64, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<i64, String> {
        conn.execute(
            "UPDATE off_peak_tasks
             SET status = 'running', updated_at = ?1
             WHERE status = 'awaiting_approval'",
            params![now],
        )
        .map_err(|e| e.to_string())?;
        let recovered = conn
            .execute(
                "UPDATE off_peak_tasks
                SET status = 'queued', claim_running = 0, claimed_at = NULL, updated_at = ?1
                WHERE status = 'running'",
                params![now],
            )
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE off_peak_tasks
            SET claim_running = 0, claimed_at = NULL, updated_at = ?1
            WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?2",
            params![now, now - OFF_PEAK_CLAIM_STALE_MS],
        )
        .map_err(|e| e.to_string())?;
        Ok(recovered as i64)
    })();
    finish_txn(conn, result)
}

/// Port of `requeueForContinuation`: time-box expiry / ready-ticket re-queue, `running → queued`.
/// Keeps `session`/`conversation`/`started_at` for resume; revokes `schedulable` and clears the queue
/// position until the next poll re-registers. Guards on `status='running'` (terminal/paused cannot
/// re-queue → `Ok(None)`, e.g. the user cancelled first).
pub fn requeue_for_continuation(
    conn: &Connection,
    id: &str,
    now: i64,
) -> Result<Option<OffPeakTask>, String> {
    let changed = conn
        .execute(
            "UPDATE off_peak_tasks
            SET status = 'queued', schedulable = 0, queue_position = NULL,
                claim_running = 0, claimed_at = NULL, updated_at = ?1
            WHERE off_peak_task_id = ?2 AND status = 'running'",
            params![now, id],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Ok(None);
    }
    get_off_peak(conn, id)
}

/// Port of `markHistoryDeleted`: hide the History row only. The task must have actually started
/// (`started_at NOT NULL`); repeat calls are idempotent. Never touches status/session/started/ended/
/// filesChanged or the server settlement fields.
pub fn mark_history_deleted(
    conn: &Connection,
    id: &str,
    now: i64,
) -> Result<Option<OffPeakTask>, String> {
    let row = match get_off_peak(conn, id)? {
        Some(r) => r,
        None => return Ok(None),
    };
    if row.started_at.is_none() {
        return Ok(Some(row));
    }
    if row.history_deleted_at.is_some() {
        return Ok(Some(row));
    }
    conn.execute(
        "UPDATE off_peak_tasks
        SET history_deleted_at = ?1, updated_at = ?1
        WHERE off_peak_task_id = ?2 AND started_at IS NOT NULL",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    get_off_peak(conn, id)
}

/// Port of `countNonTerminal`: rows not in a terminal state (`status NOT IN (terminal)`). This is the
/// local pre-check for the create cap; the authoritative limit is server-side ticketing.
pub fn count_non_terminal(conn: &Connection) -> Result<i64, String> {
    let sql = format!(
        "SELECT COUNT(*) FROM off_peak_tasks WHERE status NOT IN ({})",
        terminal_in_list()
    );
    conn.query_row(&sql, [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Port of `hasActiveBoundTask`: whether this session already has a still-active (non-terminal) bound
/// task — mirrors the `idx_off_peak_bound_active` predicate (workspace_key + session_id + non-terminal).
pub fn has_active_bound_task(
    conn: &Connection,
    workspace_key: &str,
    session_id: &str,
) -> Result<bool, String> {
    let sql = format!(
        "SELECT 1 FROM off_peak_tasks
         WHERE workspace_key = ?1 AND session_id = ?2 AND status NOT IN ({})
         LIMIT 1",
        terminal_in_list()
    );
    let hit: Option<i64> = conn
        .query_row(&sql, params![workspace_key, session_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(hit.is_some())
}

/// Port of `listNonTerminal`: every still-active task (the host poll input — poll only when non-empty),
/// `status NOT IN (terminal) ORDER BY queued_at ASC`.
pub fn list_non_terminal(conn: &Connection) -> Result<Vec<OffPeakTask>, String> {
    let sql = format!(
        "SELECT off_peak_task_id FROM off_peak_tasks
         WHERE status NOT IN ({}) ORDER BY queued_at ASC",
        terminal_in_list()
    );
    select_ids_then_project(conn, &sql)
}

/// Port of `markSettled`: backfill the server ack time after settle. Only terminal rows can settle
/// (idempotent — a repeat overwrites with the latest ack time). Single statement.
pub fn mark_settled(conn: &Connection, id: &str, settled_at: i64) -> Result<(), String> {
    let sql = format!(
        "UPDATE off_peak_tasks
         SET settled_at = ?1, updated_at = ?1
         WHERE off_peak_task_id = ?2 AND status IN ({})",
        terminal_in_list()
    );
    conn.execute(&sql, params![settled_at, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `listUnsettledTerminal`: terminal rows whose ack has not landed yet (poll-side resubmit +
/// host-start scan), `status IN (terminal) AND settled_at IS NULL ORDER BY ended_at ASC`.
pub fn list_unsettled_terminal(conn: &Connection) -> Result<Vec<OffPeakTask>, String> {
    let sql = format!(
        "SELECT off_peak_task_id FROM off_peak_tasks
         WHERE status IN ({}) AND settled_at IS NULL
         ORDER BY ended_at ASC",
        terminal_in_list()
    );
    select_ids_then_project(conn, &sql)
}

/// Reads ids (in the query's `ORDER BY` order) then projects each through [`get_off_peak`], keeping the
/// SQL ordering. Reusing the single-row read avoids duplicating `map_off_peak_row`'s column mapping.
fn select_ids_then_project(conn: &Connection, sql: &str) -> Result<Vec<OffPeakTask>, String> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        mapped
    };
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(t) = get_off_peak(conn, &id)? {
            out.push(t);
        }
    }
    Ok(out)
}

/// Commit on success / rollback on failure for the `BEGIN IMMEDIATE` transactions (mirrors the TS
/// try/COMMIT/catch/ROLLBACK shape). The inner closure's value is returned unchanged.
fn finish_txn<T>(conn: &Connection, result: Result<T, String>) -> Result<T, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::SelectionOptions;

    fn off_peak_db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        crate::migrations::adopt_schema(&conn).expect("invariant: adopt_schema");
        conn
    }

    fn ms(provider: &str, model: &str, level: Option<&str>) -> ModelSelection {
        ModelSelection {
            provider_id: provider.to_string(),
            model_id: model.to_string(),
            options: level.map(|l| SelectionOptions {
                reasoning_level: Some(l.to_string()),
            }),
        }
    }

    fn create_params(ws: &str) -> OffPeakCreateParams {
        OffPeakCreateParams {
            workspace_path: ws.to_string(),
            workspace_identity: None,
            title: "t".into(),
            prompt: "p".into(),
            permission_mode: "plan".into(),
            model_selection: ms("account:zai", "GLM-5", None),
            bound_session_id: None,
        }
    }

    fn insert_raw(
        conn: &Connection,
        id: &str,
        status: &str,
        schedulable: i64,
        claim_running: i64,
        queued_at: i64,
        model_selection: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO off_peak_tasks (off_peak_task_id, title, prompt, permission_mode, \
             session_id, workspace_key, workspace_path, status, queued_at, schedulable, \
             claim_running, claimed_at, attempt_count, created_at, updated_at, model_selection) \
             VALUES (?1,'t','p','plan',?2,'wk','/w',?3,?4,?5,?6,NULL,0,?7,?7,?8)",
            params![
                id,
                format!("sess-{id}"),
                status,
                queued_at,
                schedulable,
                claim_running,
                queued_at,
                model_selection
            ],
        )
        .expect("insert_raw");
    }

    const VALID_SEL: &str = r#"{"providerId":"account:zai","modelId":"GLM-5"}"#;

    #[test]
    fn create_inserts_queued_row_and_projects() {
        let conn = off_peak_db();
        let mut p = create_params("/w");
        p.bound_session_id = None;
        let t = create_off_peak(
            &conn,
            &p,
            &OffPeakCreateOptions {
                off_peak_task_id: Some("off1".into()),
                server_ticket_id: Some("tk1".into()),
                queue_position: Some(3),
                registered_at: Some(50),
                schedulable: true,
            },
            100,
        )
        .expect("create ok");
        assert_eq!(t.off_peak_task_id, "off1");
        assert_eq!(t.status, "queued");
        assert_eq!(t.server_ticket_id.as_deref(), Some("tk1"));
        assert_eq!(t.queue_position, Some(3));
        assert_eq!(t.registered_at, Some(50));
        assert!(t.schedulable);
        assert_eq!(t.queued_at, 100);
        assert_eq!(t.created_at, 100);
        assert_eq!(t.updated_at, 100);
        assert_eq!(t.conversation_id, None);
        assert_eq!(t.model_selection.as_ref().unwrap().model_id, "GLM-5");
        assert!(t.model_selection_issue.is_none());
    }

    #[test]
    fn create_defaults_generate_prefixed_id() {
        let conn = off_peak_db();
        let t = create_off_peak(
            &conn,
            &create_params("/w"),
            &OffPeakCreateOptions::default(),
            1,
        )
        .expect("create ok");
        assert!(t.off_peak_task_id.starts_with("offpeak-"));
    }

    #[test]
    fn create_rejects_empty_provider_model_selection() {
        let conn = off_peak_db();
        let mut p = create_params("/w");
        p.model_selection = ms("  ", "GLM-5", None);
        assert!(create_off_peak(&conn, &p, &OffPeakCreateOptions::default(), 1).is_err());
    }

    #[test]
    fn create_bound_conflict_detected_and_blocks_second_active() {
        let conn = off_peak_db();
        let mut p = create_params("/w");
        p.workspace_identity = None; // workspace_key resolves to "/w"
        p.bound_session_id = Some("sess-a".into());
        create_off_peak(&conn, &p, &OffPeakCreateOptions::default(), 1).expect("first bound ok");
        // A second active bound task with the same (workspace_key, session_id) violates the
        // partial unique index idx_off_peak_bound_active.
        let err = create_off_peak(&conn, &p, &OffPeakCreateOptions::default(), 2).unwrap_err();
        assert!(
            is_off_peak_bound_session_conflict(&err),
            "unexpected error: {err}"
        );
        assert!(has_active_bound_task(&conn, "/w", "sess-a").expect("query ok"));
    }

    #[test]
    fn has_active_bound_task_false_for_terminal_and_absent() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 0, 0, 10, None);
        assert!(has_active_bound_task(&conn, "wk", "sess-o1").expect("ok"));
        conn.execute(
            "UPDATE off_peak_tasks SET status='completed' WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("set terminal");
        assert!(
            !has_active_bound_task(&conn, "wk", "sess-o1").expect("ok"),
            "terminal rows are not active"
        );
        assert!(!has_active_bound_task(&conn, "wk", "ghost").expect("ok"));
    }

    #[test]
    fn claim_due_skips_selectionless_and_reclaims_stale() {
        let conn = off_peak_db();
        // due: valid selection, schedulable, unclaimed.
        insert_raw(&conn, "d1", "queued", 1, 0, 100, Some(VALID_SEL));
        // skipped: schedulable + unclaimed but no valid selection (legacy row).
        insert_raw(&conn, "d2", "queued", 1, 0, 101, None);
        // stale claim: claimed long ago; must be reclaimed then re-claimable.
        insert_raw(&conn, "d3", "queued", 1, 1, 102, Some(VALID_SEL));
        conn.execute(
            "UPDATE off_peak_tasks SET claimed_at = ?1 WHERE off_peak_task_id='d3'",
            params![1_000_000 - OFF_PEAK_CLAIM_STALE_MS - 1],
        )
        .expect("age claim");
        // not due: already freshly claimed (claim_running=1, claimed_at recent).
        insert_raw(&conn, "d4", "queued", 1, 1, 103, Some(VALID_SEL));
        conn.execute(
            "UPDATE off_peak_tasks SET claimed_at = ?1 WHERE off_peak_task_id='d4'",
            params![2_000_000],
        )
        .expect("fresh claim");

        let claimed = claim_due(&conn, 2_000_000).expect("claim ok");
        let ids: Vec<&str> = claimed
            .iter()
            .map(|t| t.off_peak_task_id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["d1", "d3"],
            "stale reclaimed, selectionless skipped, fresh skipped"
        );

        // claim_running/claimed_at set for winners; the projection carries the pre-claim updated_at.
        assert_eq!(
            claimed[0].updated_at, 100,
            "projection reflects pre-claim row"
        );
        let running: i64 = conn
            .query_row(
                "SELECT claim_running FROM off_peak_tasks WHERE off_peak_task_id='d1'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(running, 1);

        // Second round: d1 already claimed (fresh) → not re-claimed.
        let again = claim_due(&conn, 2_000_001).expect("claim ok");
        assert!(again.iter().all(|t| t.off_peak_task_id != "d1"));
    }

    #[test]
    fn mark_running_queued_only_and_keeps_first_started_at() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 1, 1, 100, Some(VALID_SEL));
        let r = mark_running(&conn, "o1", 500, Some("conv1"), Some("sess1"), Some("tk9"))
            .expect("ok")
            .expect("transitioned");
        assert_eq!(r.status, "running");
        assert_eq!(r.started_at, Some(500));
        assert_eq!(r.conversation_id.as_deref(), Some("conv1"));
        assert_eq!(r.session_id.as_deref(), Some("sess1"));

        // A second markRunning on a running row is rejected (guard: only queued→running).
        assert!(mark_running(&conn, "o1", 900, None, None, None)
            .expect("ok")
            .is_none());
        // started_at kept at the first segment value (COALESCE).
        assert_eq!(
            get_off_peak(&conn, "o1").expect("ok").unwrap().started_at,
            Some(500)
        );
    }

    #[test]
    fn mark_terminal_irreversible_and_files_changed_coalesce() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "running", 0, 0, 100, Some(VALID_SEL));
        conn.execute(
            "UPDATE off_peak_tasks SET files_changed = 4 WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("set files");
        let r = mark_terminal(
            &conn,
            "o1",
            OffPeakTerminalStatus::Failed,
            700,
            Some("boom"),
            None,
            Some("dispatch-boom"),
        )
        .expect("ok")
        .expect("transitioned");
        assert_eq!(r.status, "failed");
        assert_eq!(r.ended_at, Some(700));
        assert_eq!(r.failure_reason.as_deref(), Some("boom"));
        assert_eq!(r.files_changed, Some(4), "COALESCE keeps existing");

        // Terminal → cannot transition again.
        assert!(mark_terminal(
            &conn,
            "o1",
            OffPeakTerminalStatus::Completed,
            800,
            None,
            None,
            None
        )
        .expect("ok")
        .is_none());
        // dispatch_error atomically incremented attempt_count (0 → 1).
        let attempts: i64 = conn
            .query_row(
                "SELECT attempt_count FROM off_peak_tasks WHERE off_peak_task_id='o1'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(attempts, 1);
    }

    #[test]
    fn set_paused_toggles_with_dispatch_guard() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 1, 0, 100, Some(VALID_SEL));
        let p = set_paused(&conn, "o1", true, 200)
            .expect("ok")
            .expect("paused");
        assert_eq!(p.status, "paused");
        // Cannot pause twice (guard: from status must match).
        assert!(set_paused(&conn, "o1", true, 201).expect("ok").is_none());
        // Continue back to queued.
        let q = set_paused(&conn, "o1", false, 202)
            .expect("ok")
            .expect("queued");
        assert_eq!(q.status, "queued");

        // A claimed (dispatch-in-flight) task cannot be paused.
        conn.execute(
            "UPDATE off_peak_tasks SET claim_running = 1 WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("claim");
        assert!(set_paused(&conn, "o1", true, 203).expect("ok").is_none());
    }

    #[test]
    fn release_claim_resets_lock_and_counts_attempt() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 1, 1, 100, Some(VALID_SEL));
        conn.execute(
            "UPDATE off_peak_tasks SET claimed_at = 999 WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("age");
        release_claim(&conn, "o1", Some("net-down"), 1000).expect("ok");
        let row: (i64, i64, Option<String>) = conn
            .query_row(
                "SELECT claim_running, attempt_count, last_error FROM off_peak_tasks WHERE off_peak_task_id='o1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("read");
        assert_eq!(row.0, 0, "lock released");
        assert_eq!(row.1, 1, "attempt counted on error");
        assert_eq!(row.2.as_deref(), Some("net-down"));
        // Releasing an unclaimed row is a no-op (guard claim_running=1).
        release_claim(&conn, "o1", None, 1001).expect("ok");
        let attempts: i64 = conn
            .query_row(
                "SELECT attempt_count FROM off_peak_tasks WHERE off_peak_task_id='o1'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(attempts, 1, "no change when not claimed");
    }

    #[test]
    fn recover_interrupted_requeues_running_and_normalizes_legacy() {
        let conn = off_peak_db();
        insert_raw(&conn, "r1", "running", 1, 0, 100, Some(VALID_SEL));
        insert_raw(&conn, "r2", "awaiting_approval", 0, 0, 101, Some(VALID_SEL));
        let recovered = recover_interrupted(&conn, 5_000).expect("ok");
        assert_eq!(
            recovered, 2,
            "running + normalized awaiting_approval both requeued"
        );
        for id in ["r1", "r2"] {
            let t = get_off_peak(&conn, id).expect("ok").unwrap();
            assert_eq!(t.status, "queued");
        }
    }

    #[test]
    fn requeue_for_continuation_only_from_running() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 1, 0, 100, Some(VALID_SEL));
        // Not running → rejected.
        assert!(requeue_for_continuation(&conn, "o1", 200)
            .expect("ok")
            .is_none());
        conn.execute(
            "UPDATE off_peak_tasks SET status='running', queue_position=5, schedulable=1 WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("set running");
        let r = requeue_for_continuation(&conn, "o1", 300)
            .expect("ok")
            .expect("requeued");
        assert_eq!(r.status, "queued");
        assert_eq!(r.queue_position, None, "queue position cleared");
        assert!(!r.schedulable, "schedulable revoked");
    }

    #[test]
    fn invalidate_model_selection_clears_and_preserves_repairs() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 1, 0, 100, Some(VALID_SEL));

        // Matching observation → clear selection, revoke schedulable, keep model/thought_level.
        let cleared =
            invalidate_model_selection(&conn, "o1", &ms("account:zai", "GLM-5", None), 200)
                .expect("ok")
                .expect("row");
        assert_eq!(cleared.model_selection, None);
        assert!(!cleared.schedulable);
        assert!(cleared.model_selection_issue.is_some());
        let model: Option<String> = conn
            .query_row(
                "SELECT model FROM off_peak_tasks WHERE off_peak_task_id='o1'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(model.as_deref(), Some("GLM-5"), "model snapshot preserved");

        // Stale observation vs a repaired row → row returned untouched.
        conn.execute(
            "UPDATE off_peak_tasks SET model_selection = ?1 WHERE off_peak_task_id='o1'",
            params![r#"{"providerId":"account:zai","modelId":"GLM-4"}"#],
        )
        .expect("repair");
        let preserved =
            invalidate_model_selection(&conn, "o1", &ms("account:zai", "GLM-5", None), 300)
                .expect("ok")
                .expect("row");
        assert_eq!(
            preserved.model_selection.unwrap().model_id,
            "GLM-4",
            "stale observation must not overwrite a newer repair"
        );

        // Missing row → None.
        assert!(
            invalidate_model_selection(&conn, "ghost", &ms("p", "m", None), 1)
                .expect("ok")
                .is_none()
        );
    }

    #[test]
    fn update_editable_fields_window_and_model_null() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 0, 0, 100, Some(VALID_SEL));

        let upd = update_editable_fields(
            &conn,
            "o1",
            &EditableFields {
                title: Some("new title".into()),
                prompt: None,
                permission_mode: None,
                model_selection: Some(Some(ms("account:zai", "GLM-6", Some("high")))),
            },
            200,
        )
        .expect("ok")
        .expect("updated");
        assert_eq!(upd.title, "new title");
        assert_eq!(upd.prompt, "p", "prompt unchanged");
        assert_eq!(upd.model_selection.unwrap().model_id, "GLM-6");

        // Explicit null selection → rejected (None).
        let rej = update_editable_fields(
            &conn,
            "o1",
            &EditableFields {
                title: Some("x".into()),
                model_selection: Some(None),
                ..Default::default()
            },
            201,
        )
        .expect("ok");
        assert!(rej.is_none());

        // Non-editable status → None.
        conn.execute(
            "UPDATE off_peak_tasks SET status='running' WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("running");
        assert!(update_editable_fields(
            &conn,
            "o1",
            &EditableFields {
                title: Some("y".into()),
                ..Default::default()
            },
            202,
        )
        .expect("ok")
        .is_none());
    }

    #[test]
    fn update_editable_errors_when_no_valid_selection() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 0, 0, 100, None); // no stored selection
        let err = update_editable_fields(
            &conn,
            "o1",
            &EditableFields {
                title: Some("t".into()),
                model_selection: None,
                ..Default::default()
            },
            200,
        );
        assert!(err.is_err(), "missing selection + no replacement → Err");
    }

    #[test]
    fn update_scheduling_snapshot_keeps_unset_and_clears_null() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "queued", 0, 0, 100, Some(VALID_SEL));
        conn.execute(
            "UPDATE off_peak_tasks SET queue_position=7, next_poll_at=88, server_ticket_id='tk', registered_at=9 WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("seed");
        // Only schedulable provided → others kept.
        update_scheduling_snapshot(
            &conn,
            "o1",
            &SchedulingPatch {
                schedulable: Some(true),
                ..Default::default()
            },
            300,
        )
        .expect("ok");
        let t = get_off_peak(&conn, "o1").expect("ok").unwrap();
        assert!(t.schedulable);
        assert_eq!(t.queue_position, Some(7), "unchanged field kept");
        assert_eq!(t.next_poll_at, Some(88));

        // Explicit null clears the queue column.
        update_scheduling_snapshot(
            &conn,
            "o1",
            &SchedulingPatch {
                queue_position: Some(None),
                ..Default::default()
            },
            301,
        )
        .expect("ok");
        let t2 = get_off_peak(&conn, "o1").expect("ok").unwrap();
        assert_eq!(t2.queue_position, None, "explicit null clears");
        assert!(t2.schedulable, "schedulable kept when absent");
    }

    #[test]
    fn mark_history_deleted_requires_start_and_is_idempotent() {
        let conn = off_peak_db();
        insert_raw(&conn, "o1", "running", 0, 0, 100, Some(VALID_SEL));
        // Not started → projection unchanged (no history_deleted_at).
        let r = mark_history_deleted(&conn, "o1", 200).expect("ok").unwrap();
        assert_eq!(r.history_deleted_at, None);
        // Mark started, then hide.
        conn.execute(
            "UPDATE off_peak_tasks SET started_at = 150 WHERE off_peak_task_id='o1'",
            [],
        )
        .expect("start");
        let hidden = mark_history_deleted(&conn, "o1", 300).expect("ok").unwrap();
        assert_eq!(hidden.history_deleted_at, Some(300));
        // Idempotent: a repeat keeps the first timestamp.
        let again = mark_history_deleted(&conn, "o1", 400).expect("ok").unwrap();
        assert_eq!(again.history_deleted_at, Some(300));
    }

    #[test]
    fn counts_and_list_orderings() {
        let conn = off_peak_db();
        insert_raw(&conn, "a", "queued", 0, 0, 30, Some(VALID_SEL));
        insert_raw(&conn, "b", "running", 0, 0, 10, Some(VALID_SEL));
        insert_raw(&conn, "c", "completed", 0, 0, 20, Some(VALID_SEL));
        assert_eq!(count_non_terminal(&conn).expect("ok"), 2);

        let non_term = list_non_terminal(&conn).expect("ok");
        let ids: Vec<&str> = non_term
            .iter()
            .map(|t| t.off_peak_task_id.as_str())
            .collect();
        assert_eq!(ids, vec!["b", "a"], "queued_at ASC: b(10) then a(30)");

        // c is terminal but unsettled; give it an ended_at for ordering.
        conn.execute(
            "UPDATE off_peak_tasks SET ended_at = 50 WHERE off_peak_task_id='c'",
            [],
        )
        .expect("ended");
        let unsettled = list_unsettled_terminal(&conn).expect("ok");
        assert_eq!(unsettled.len(), 1);
        assert_eq!(unsettled[0].off_peak_task_id, "c");

        mark_settled(&conn, "c", 60).expect("settle");
        assert!(list_unsettled_terminal(&conn).expect("ok").is_empty());
        // settle only touches terminal rows: a still queued is unaffected by mark_settled.
        mark_settled(&conn, "a", 60).expect("settle");
        assert_eq!(
            get_off_peak(&conn, "a").expect("ok").unwrap().settled_at,
            None,
            "non-terminal row cannot be settled"
        );
    }
}
