//! Scheduler persistence — the Tauri replacement for the repository half of
//! `packages/desktop/src/scheduler`.
//!
//! The Electron scheduler owned `automations` and `automation_runs` rows
//! (`packages/desktop/src/scheduler/index.ts:48,53-56`) and claimed them
//! atomically with `BEGIN IMMEDIATE` + `running 0→1`
//! (`AutomationRepo.claimDue`, `packages/services/src/session/automationRepo.ts:724-783`).
//! This module reproduces that claim/settle contract over `rusqlite`.
//!
//! ## Wiring `spawn_scheduler`
//!
//! The module is declared in `lib.rs`, but `spawn_scheduler` is not yet given a
//! `claim_due` backed by this store — that is the parent's wiring step. The
//! intended shape (the store owns a `Connection`, which is `Send` but not
//! `Sync`, so it rides inside a mutex):
//!
//! ```ignore
//! let store = std::sync::Mutex::new(SchedulerStore::open(&db_path)?);
//! spawn_scheduler(&supervisor, "scheduler", move |now_ms| {
//!     let mut store = store.lock().expect("scheduler store poisoned");
//!     let claimed = store.claim_due(now_ms).map_err(|e| e.to_string())?;
//!     let mut outcomes = Vec::new();
//!     for automation in claimed {
//!         match automation.evaluate(now_ms) {
//!             TickOutcome::Dispatched { run_id } => {
//!                 // run row already upserted by claim_due; dispatch to a host.
//!                 outcomes.push(TickOutcome::Dispatched { run_id });
//!             }
//!             outcome @ TickOutcome::Skipped { .. } => {
//!                 // Caller computes the next fire (see skip_misfire docs).
//!                 store.skip_misfire(
//!                     &automation.automation_id,
//!                     MISFIRE_SKIP_REASON,
//!                     next_run_at, // Option<i64> from the cron engine
//!                     now_ms,
//!                 ).map_err(|e| e.to_string())?;
//!                 outcomes.push(outcome);
//!             }
//!             TickOutcome::NotDue => {}
//!         }
//!     }
//!     Ok(outcomes)
//! });
//! ```
//!
//! `ClaimedAutomation::evaluate` is a thin delegate to
//! `supervisor::scheduler::evaluate`, and `run_id` is always built with
//! `supervisor::scheduler::build_run_id`, so the misfire rules and the stable
//! `${automationId}:${scheduledAt}` id have exactly one implementation
//! (`src/supervisor/scheduler.rs:67-88`).
//!
//! Deliberately not ported here: `off_peak_tasks` / `OffPeakTaskRepo` (a
//! separate claim model with its own claim and settlement files) and the
//! manual run queue (`claimManualRuns`, `automationRepo.ts:790-940`). Neither
//! is part of the scheduled claim/settle contract this file reproduces.

use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::supervisor::scheduler::{build_run_id, evaluate, DueAutomation, TickOutcome};

/// Dispatch-failure backoff base. Matches `DISPATCH_RETRY_BASE_MS`
/// (`automationRepo.ts:39`).
pub const DISPATCH_RETRY_BASE_MS: i64 = 30_000;
/// Backoff ceiling. Matches `DISPATCH_RETRY_CAP_MS` (`automationRepo.ts:40`).
pub const DISPATCH_RETRY_CAP_MS: i64 = 15 * 60_000;
/// Transient failures beyond this many attempts give up the round.
/// Matches `DISPATCH_MAX_ATTEMPTS` (`automationRepo.ts:41`).
pub const DISPATCH_MAX_ATTEMPTS: i64 = 5;
/// A `running = 1` claim older than this is a crashed holder and may be
/// reclaimed. Matches `CLAIM_STALE_MS` (`automationRepo.ts:43`).
pub const CLAIM_STALE_MS: i64 = 10 * 60_000;
/// The reason string Electron wrote on every misfire skip, both for recurring
/// reschedules and one-shot finalisation
/// (`packages/desktop/src/scheduler/index.ts:147-155`).
pub const MISFIRE_SKIP_REASON: &str = "computer_asleep_or_app_not_running";

/// Schema for `automations` and `automation_runs`, transcribed verbatim from
/// `packages/services/src/session/tasksDatabase/schema-v1.ts:81-145`.
/// Every statement is `IF NOT EXISTS`, so re-running it is a no-op.
const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS automations (
  automation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  cron_expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  mode TEXT,
  thought_level TEXT,
  model_selection TEXT,
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
  next_run_at INTEGER,
  last_run_at INTEGER,
  running INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  dispatch_status TEXT NOT NULL DEFAULT 'idle',
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automations_due
ON automations (enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_automations_retry
ON automations (enabled, retry_at);

CREATE INDEX IF NOT EXISTS idx_automations_workspace
ON automations (workspace_key);

CREATE TABLE IF NOT EXISTS automation_runs (
  run_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  scheduled_at INTEGER,
  trigger TEXT NOT NULL DEFAULT 'schedule',
  model_selection TEXT,
  dispatch_status TEXT NOT NULL DEFAULT 'claimed',
  outcome TEXT,
  session_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_by_automation
ON automation_runs (automation_id, created_at DESC);
";

/// Why a dispatch attempt failed. Mirrors `failureKind` on Electron's
/// `cron-dispatch-result` message
/// (`packages/desktop/src/scheduler/schedulerProtocol.ts:53-61`, consumed at
/// `packages/desktop/src/scheduler/index.ts:315`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DispatchFailureKind {
    /// Worth a backoff retry (`msg.failureKind ?? "transient"`).
    Transient,
    /// Terminal: straight to the failed state, automation disabled.
    Permanent,
}

/// Parameters for [`SchedulerStore::settle`].
///
/// Electron read these off the `cron-dispatch-result` message plus its own
/// `Date.now()` and cron recomputation
/// (`packages/desktop/src/scheduler/index.ts:263-336`); here the caller
/// supplies them because this store owns persistence, not scheduling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleOptions {
    /// Settlement timestamp (Electron used receipt time, `index.ts:265`).
    pub now_ms: i64,
    /// Session id from a successful dispatch result (`index.ts:297`).
    pub session_id: Option<String>,
    /// Failure message; `None` means Electron's `"dispatch failed"` default
    /// (`index.ts:309,316`).
    pub error: Option<String>,
    /// Only consulted when `ok` is false (`index.ts:315`).
    pub failure_kind: DispatchFailureKind,
    /// The caller-computed next fire: on success the next cron fire
    /// (`index.ts:301`); on transient failure at the attempts ceiling, the
    /// next normal fire the recurring task jumps to (`index.ts:327-332`).
    /// `None` writes `NULL` — the store never invents schedule data.
    pub next_run_at_ms: Option<i64>,
}

impl SettleOptions {
    /// A successful dispatch settlement.
    pub fn success(now_ms: i64) -> Self {
        Self {
            now_ms,
            session_id: None,
            error: None,
            failure_kind: DispatchFailureKind::Transient,
            next_run_at_ms: None,
        }
    }

    /// A failed dispatch settlement.
    pub fn failure(now_ms: i64, error: Option<String>, failure_kind: DispatchFailureKind) -> Self {
        Self {
            now_ms,
            session_id: None,
            error,
            failure_kind,
            next_run_at_ms: None,
        }
    }
}

/// One automation claimed by [`SchedulerStore::claim_due`], carrying both the
/// dispatch payload the Electron scheduler sent to main
/// (`packages/desktop/src/scheduler/index.ts:164-199`) and everything needed
/// to evaluate misfire and settle afterwards.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedAutomation {
    pub automation_id: String,
    /// Stable run id `${automationId}:${scheduledAt}`, built with
    /// `supervisor::scheduler::build_run_id`.
    pub run_id: String,
    /// `resolveScheduledAt`: `next_run_at ?? retry_at ?? now`
    /// (`scheduler/index.ts:78-81`). Stable across retries because
    /// `next_run_at` does not advance while a row sits in backoff.
    pub scheduled_at_ms: i64,
    pub next_run_at_ms: Option<i64>,
    pub retry_at_ms: Option<i64>,
    /// `dispatch_attempts` at claim time; `> 0` means this row is a retry and
    /// is exempt from the misfire rule (`scheduler/index.ts:136`).
    pub dispatch_attempts: i64,
    pub is_retry: bool,
    /// `!recurring && (max_runs ?? 1) <= 1`
    /// (`packages/services/src/session/automationCron.ts:45-49`).
    pub one_shot: bool,
    // Dispatch payload (postDispatchRequest, scheduler/index.ts:186-198).
    pub title: String,
    pub prompt: String,
    /// Raw cron expression and schedule rule JSON, so the caller can run the
    /// (not yet ported) `computeAutomationNextRunAt` for skips and settlement.
    pub cron_expr: String,
    pub schedule_rule: Option<String>,
    pub target_task_id: Option<String>,
    pub mode: Option<String>,
    /// Serialized model selection as stored; a run-level pinned selection
    /// lives on `automation_runs.model_selection` instead
    /// (`scheduler/index.ts:177-178,191-193`).
    pub model_selection: Option<String>,
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
}

impl ClaimedAutomation {
    /// Project onto the supervisor's `DueAutomation` so [`Self::evaluate`] can
    /// reuse the single misfire implementation.
    ///
    /// `next_run_at_ms` maps to `resolveScheduledAt` (`next_run_at ?? retry_at
    /// ?? now`): for a first attempt `retry_at` is always NULL — `retry_at` is
    /// only ever written together with `dispatch_attempts >= 1`
    /// (`automationRepo.ts:1049-1061`) — so the misfire comparison sees the
    /// real `next_run_at`, exactly like Electron's
    /// `scheduler/index.ts:139-140`. Rows due only through `retry_at` have
    /// `is_retry = true` and skip the misfire branch entirely.
    pub fn due(&self) -> DueAutomation {
        DueAutomation {
            automation_id: self.automation_id.clone(),
            next_run_at_ms: self.scheduled_at_ms,
            one_shot: self.one_shot,
            is_retry: self.is_retry,
        }
    }

    /// Dispatch / skip / not-due decision for this claimed row. Delegates to
    /// `supervisor::scheduler::evaluate` (`src/supervisor/scheduler.rs:72-88`).
    pub fn evaluate(&self, now_ms: i64) -> TickOutcome {
        evaluate(&self.due(), now_ms)
    }
}

/// The tasks-index store: one SQLite connection holding `automations` and
/// `automation_runs`, reproducing `AutomationRepo`'s scheduled claim/settle
/// methods.
///
/// Fallible methods return `rusqlite::Result` so callers can map with
/// `map_err(|e| e.to_string())` into `spawn_scheduler`'s
/// `Result<Vec<TickOutcome>, String>` (`src/supervisor/scheduler.rs:93-99`).
pub struct SchedulerStore {
    conn: Connection,
}

/// One due row as selected by [`SchedulerStore::claim_due`].
struct DueRow {
    automation_id: String,
    title: String,
    prompt: String,
    cron_expr: String,
    schedule_rule: Option<String>,
    model_selection: Option<String>,
    target_task_id: Option<String>,
    mode: Option<String>,
    workspace_key: String,
    workspace_path: String,
    workspace_identity: Option<String>,
    recurring: i64,
    max_runs: Option<i64>,
    next_run_at: Option<i64>,
    retry_at: Option<i64>,
    dispatch_attempts: i64,
}

fn read_due_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DueRow> {
    Ok(DueRow {
        automation_id: row.get("automation_id")?,
        title: row.get("title")?,
        prompt: row.get("prompt")?,
        cron_expr: row.get("cron_expr")?,
        schedule_rule: row.get("schedule_rule")?,
        model_selection: row.get("model_selection")?,
        target_task_id: row.get("target_task_id")?,
        mode: row.get("mode")?,
        workspace_key: row.get("workspace_key")?,
        workspace_path: row.get("workspace_path")?,
        workspace_identity: row.get("workspace_identity")?,
        recurring: row.get("recurring")?,
        max_runs: row.get("max_runs")?,
        next_run_at: row.get("next_run_at")?,
        retry_at: row.get("retry_at")?,
        dispatch_attempts: row.get("dispatch_attempts")?,
    })
}

/// `now + min(BASE * 2^max(0, attempts - 1), CAP)` — port of
/// `computeRetryAt` (`packages/services/src/session/automationRepo.ts:213-218`).
pub fn compute_retry_at(now_ms: i64, attempts: i64) -> i64 {
    let shift = attempts.saturating_sub(1).clamp(0, 30) as u32;
    let backoff = DISPATCH_RETRY_BASE_MS.saturating_mul(1_i64 << shift);
    now_ms.saturating_add(backoff.min(DISPATCH_RETRY_CAP_MS))
}

/// Resolve which automation a run id belongs to: the run row first, then the
/// `${automationId}:${scheduledAt}` prefix fallback Electron used when the
/// in-memory dispatch context had been lost
/// (`packages/desktop/src/scheduler/index.ts:269`, id shape from
/// `scheduler/index.ts:83-85`).
fn resolve_automation_id(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<String>> {
    if let Some(id) = conn
        .query_row(
            "SELECT automation_id FROM automation_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()?
    {
        return Ok(Some(id));
    }
    Ok(run_id
        .split(':')
        .next()
        .filter(|prefix| !prefix.is_empty())
        .map(String::from))
}

/// Upsert the `claimed` run row (port of `upsertRunClaimed`,
/// `automationRepo.ts:1198-1235`). A conflict means this round's retry hit the
/// same `${automationId}:${scheduledAt}` id, so the row is reused and
/// `attempts` bumps instead of a duplicate row being created.
///
/// `model_selection` is omitted deliberately: the claim-time insert is NULL,
/// and Electron's conflict branch `COALESCE(existing, excluded)` (excluded was
/// always NULL from this call site, `scheduler/index.ts:164-171`) leaves any
/// pinned selection untouched — omitting the column is the same write.
fn upsert_run_claimed(
    conn: &Connection,
    run_id: &str,
    automation_id: &str,
    workspace_key: &str,
    scheduled_at_ms: i64,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO automation_runs (
             run_id, automation_id, workspace_key, scheduled_at, trigger,
             dispatch_status, attempts, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, 'schedule', 'claimed', 0, ?5, ?5)
         ON CONFLICT(run_id) DO UPDATE SET
             dispatch_status = 'claimed',
             outcome = NULL,
             error = NULL,
             attempts = automation_runs.attempts + 1,
             updated_at = excluded.updated_at",
        params![run_id, automation_id, workspace_key, scheduled_at_ms, now_ms],
    )?;
    Ok(())
}

impl SchedulerStore {
    /// Open a database (a filesystem path or `":memory:"`), creating it and
    /// its schema if needed.
    ///
    /// Mirrors `AutomationRepo.initialize` (`automationRepo.ts:280-291`):
    /// create the parent directory, busy-timeout 5 s, WAL + normal sync. The
    /// pragmas are harmless no-ops on `:memory:`.
    pub fn open(path_or_memory: &str) -> rusqlite::Result<SchedulerStore> {
        if path_or_memory != ":memory:" {
            if let Some(parent) = std::path::Path::new(path_or_memory).parent() {
                if !parent.as_os_str().is_empty() {
                    // Best-effort, like the Electron repo's mkdir: on failure
                    // the open below reports the same missing directory with
                    // SQLite's clearer "unable to open database file".
                    let _ = std::fs::create_dir_all(parent);
                }
            }
        }
        let conn = Connection::open_with_flags(
            path_or_memory,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        conn.busy_timeout(Duration::from_millis(5_000))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )?;
        let store = SchedulerStore { conn };
        store.create_schema()?;
        Ok(store)
    }

    /// Idempotent schema creation (`CREATE TABLE IF NOT EXISTS`); private, but
    /// reachable from the in-module tests so re-running the full DDL is
    /// covered directly.
    fn create_schema(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(SCHEMA_SQL)
    }

    /// Single-flight claim of due automations — the port of
    /// `AutomationRepo.claimDue` (`automationRepo.ts:724-783`), one
    /// `BEGIN IMMEDIATE` transaction:
    ///
    /// 1. rows past `end_at` are finalised first so neither cron nor retry can
    ///    claim them (`automationRepo.ts:729-735`);
    /// 2. zombie claims are reclaimed: `running = 1` whose `claimed_at` is at
    ///    least [`CLAIM_STALE_MS`] old (`automationRepo.ts:736-741`);
    /// 3. due rows (`retry_at` due, or `retry_at` NULL and `next_run_at` due)
    ///    are flipped `running 0 → 1` with `claimed_at = now_ms`
    ///    (`automationRepo.ts:742-777`).
    ///
    /// Deviation from Electron, deliberate: the `claimed` run-ledger upsert
    /// (`upsertRunClaimed`, a separate statement after `claimDue` returned in
    /// Electron) is fused into the same transaction. That keeps claim and
    /// ledger all-or-nothing — a crash can no longer leave a claimed
    /// automation without its run row. The final states are identical either
    /// way (`skipped` overwrites `claimed` on the misfire path,
    /// `automationRepo.ts:1138-1141`), so no observable contract changes.
    pub fn claim_due(&mut self, now_ms: i64) -> rusqlite::Result<Vec<ClaimedAutomation>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        tx.execute(
            "UPDATE automations
             SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
                 retry_at = NULL, running = 0, claimed_at = NULL, updated_at = ?1
             WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < ?1",
            [now_ms],
        )?;
        tx.execute(
            "UPDATE automations
             SET running = 0, claimed_at = NULL
             WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?1",
            [now_ms - CLAIM_STALE_MS],
        )?;

        let due_rows = {
            let mut stmt = tx.prepare(
                "SELECT automation_id, title, prompt, cron_expr, schedule_rule,
                        model_selection, target_task_id, mode,
                        workspace_key, workspace_path, workspace_identity,
                        recurring, max_runs, next_run_at, retry_at, dispatch_attempts
                 FROM automations
                 WHERE enabled = 1 AND running = 0
                   AND (
                     (retry_at IS NOT NULL AND retry_at <= ?1)
                     OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?1)
                   )
                 ORDER BY rowid",
            )?;
            let mut rows = stmt.query(params![now_ms])?;
            let mut due_rows = Vec::new();
            while let Some(row) = rows.next()? {
                due_rows.push(read_due_row(row)?);
            }
            due_rows
        };

        let mut claimed = Vec::new();
        for row in due_rows {
            // Claim guard: only rows still `running = 0` win, so a concurrent
            // holder (e.g. a `runNow` taking the same lock) is not stolen from
            // (`automationRepo.ts:759-766`).
            let changed = tx.execute(
                "UPDATE automations
                 SET running = 1, claimed_at = ?1, dispatch_status = 'claimed', updated_at = ?1
                 WHERE automation_id = ?2 AND running = 0",
                params![now_ms, row.automation_id],
            )?;
            if changed != 1 {
                continue;
            }
            let scheduled_at_ms = row.next_run_at.or(row.retry_at).unwrap_or(now_ms);
            let run_id = build_run_id(&row.automation_id, scheduled_at_ms);
            let is_retry = row.dispatch_attempts > 0;
            let one_shot = row.recurring == 0 && row.max_runs.unwrap_or(1) <= 1;
            upsert_run_claimed(
                &tx,
                &run_id,
                &row.automation_id,
                &row.workspace_key,
                scheduled_at_ms,
                now_ms,
            )?;
            claimed.push(ClaimedAutomation {
                automation_id: row.automation_id,
                run_id,
                scheduled_at_ms,
                next_run_at_ms: row.next_run_at,
                retry_at_ms: row.retry_at,
                dispatch_attempts: row.dispatch_attempts,
                is_retry,
                one_shot,
                title: row.title,
                prompt: row.prompt,
                cron_expr: row.cron_expr,
                schedule_rule: row.schedule_rule,
                target_task_id: row.target_task_id,
                mode: row.mode,
                model_selection: row.model_selection,
                workspace_key: row.workspace_key,
                workspace_path: row.workspace_path,
                workspace_identity: row.workspace_identity,
            });
        }
        tx.commit()?;
        Ok(claimed)
    }

    /// Missed fire window: record a skipped run and release the claim,
    /// finalising one-shots — the port of `skipAndReschedule`
    /// (`automationRepo.ts:1113-1166`, called from
    /// `scheduler/index.ts:141-155`).
    ///
    /// * `reason` is written to the run row's `error` column verbatim; pass
    ///   [`MISFIRE_SKIP_REASON`] for misfire skips.
    /// * `next_run_at_ms: Some(v)` sets the rescheduled fire point, `None`
    ///   leaves `next_run_at` unchanged. The store never fabricates a
    ///   timestamp: Electron computed the value with
    ///   `computeAutomationNextRunAt` (`scheduler/index.ts:146`), which has no
    ///   Rust port yet.
    /// * A one-shot (`recurring = 0`, `max_runs <= 1`) is finalised instead:
    ///   `completed`, disabled, schedule cleared
    ///   (`automationRepo.ts:1144-1151`) — a missed one-shot is terminal and
    ///   must not be rescheduled (`scheduler/index.ts:142-146`).
    ///
    /// Returns `false` when the automation row no longer exists (deleted
    /// mid-flight); writeback is discarded, matching `markDispatched`'s
    /// "Deleted, discard writeback, avoid resurrection" (`automationRepo.ts:953`).
    pub fn skip_misfire(
        &mut self,
        automation_id: &str,
        reason: &str,
        next_run_at_ms: Option<i64>,
        now_ms: i64,
    ) -> rusqlite::Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        let row = tx
            .query_row(
                "SELECT next_run_at, retry_at, workspace_key, recurring, max_runs
                 FROM automations WHERE automation_id = ?1",
                [automation_id],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>("next_run_at")?,
                        row.get::<_, Option<i64>>("retry_at")?,
                        row.get::<_, String>("workspace_key")?,
                        row.get::<_, i64>("recurring")?,
                        row.get::<_, Option<i64>>("max_runs")?,
                    ))
                },
            )
            .optional()?;
        let Some((next_run_at, retry_at, workspace_key, recurring, max_runs)) = row else {
            tx.commit()?;
            return Ok(false);
        };

        let scheduled_at_ms = next_run_at.or(retry_at).unwrap_or(now_ms);
        let run_id = build_run_id(automation_id, scheduled_at_ms);

        // Skipped run row (`automationRepo.ts:1127-1142`): a conflict means
        // this fire was already recorded (e.g. re-claimed after a crash), so
        // the record is overwritten in place — `attempts` is left alone.
        tx.execute(
            "INSERT INTO automation_runs (
                 run_id, automation_id, workspace_key, scheduled_at, trigger,
                 dispatch_status, error, attempts, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'schedule', 'skipped', ?5, 0, ?6, ?6)
             ON CONFLICT(run_id) DO UPDATE SET
                 dispatch_status = 'skipped',
                 error = excluded.error,
                 updated_at = excluded.updated_at",
            params![
                run_id,
                automation_id,
                workspace_key,
                scheduled_at_ms,
                reason,
                now_ms
            ],
        )?;

        let one_shot = recurring == 0 && max_runs.unwrap_or(1) <= 1;
        if one_shot {
            // Terminal: missed one-shot finalisation (`automationRepo.ts:1144-1151`).
            tx.execute(
                "UPDATE automations
                 SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
                     running = 0, claimed_at = NULL,
                     dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
                     updated_at = ?2
                 WHERE automation_id = ?1",
                params![automation_id, now_ms],
            )?;
        } else {
            // Reschedule + release (`automationRepo.ts:1152-1160`), with
            // COALESCE so `None` leaves the current `next_run_at` untouched
            // (the caller advances it only when a computed fire point exists).
            tx.execute(
                "UPDATE automations
                 SET next_run_at = COALESCE(?2, next_run_at),
                     running = 0, claimed_at = NULL,
                     dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
                     updated_at = ?3
                 WHERE automation_id = ?1",
                params![automation_id, next_run_at_ms, now_ms],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// Successful dispatch writeback — run row to `dispatched` plus the
    /// automation counter/lifecycle update. This is Electron's
    /// `markRunDispatch('dispatched')` (`automationRepo.ts:1260-1278`) fused
    /// with `markDispatched` (`automationRepo.ts:947-1001`), the pair
    /// `settleDispatchResult` runs on success (`scheduler/index.ts:295-302`).
    ///
    /// * `run_id` resolves the automation via the run row, falling back to
    ///   the id prefix (`scheduler/index.ts:269`).
    /// * `next_run_at_ms`: the caller-computed next fire; a terminal row
    ///   (`max_runs` reached or `end_at` passed) forces `NULL` + `completed`
    ///   regardless (`automationRepo.ts:976-986`).
    /// * `session_id` backfills the run row (`COALESCE`, so `None` keeps any
    ///   existing id).
    ///
    /// Returns `true` when at least one row was written; `false` when nothing
    /// matched (unknown run id, or the automation was deleted before any
    /// writeback could apply).
    pub fn mark_dispatched(
        &mut self,
        run_id: &str,
        dispatched_at_ms: i64,
        next_run_at_ms: Option<i64>,
        session_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(automation_id) = resolve_automation_id(&tx, run_id)? else {
            tx.commit()?;
            return Ok(false);
        };

        let run_written = tx.execute(
            "UPDATE automation_runs
             SET dispatch_status = 'dispatched',
                 session_id = COALESCE(?2, session_id),
                 error = NULL,
                 updated_at = ?3
             WHERE run_id = ?1",
            params![run_id, session_id, dispatched_at_ms],
        )? > 0;

        let row = tx
            .query_row(
                "SELECT run_count, scheduled_run_count, recurring, max_runs, end_at
                 FROM automations WHERE automation_id = ?1",
                [&automation_id],
                |row| {
                    Ok((
                        row.get::<_, i64>("run_count")?,
                        row.get::<_, i64>("scheduled_run_count")?,
                        row.get::<_, i64>("recurring")?,
                        row.get::<_, Option<i64>>("max_runs")?,
                        row.get::<_, Option<i64>>("end_at")?,
                    ))
                },
            )
            .optional()?;
        let Some((run_count, scheduled_run_count, recurring, max_runs, end_at)) = row else {
            // Deleted mid-flight: the run-row writeback already happened, but
            // the automation update is discarded, never resurrected
            // (`automationRepo.ts:953`).
            tx.commit()?;
            return Ok(run_written);
        };

        // Reached max runs / end of schedule → terminal (`automationRepo.ts:976-979`).
        let run_count = run_count + 1;
        let scheduled_run_count = scheduled_run_count + 1;
        let reached_max = recurring == 0 && scheduled_run_count >= max_runs.unwrap_or(1);
        let reached_end = end_at
            .map(|end| next_run_at_ms.unwrap_or(i64::MAX) > end)
            .unwrap_or(false);
        let terminal = reached_max || reached_end;

        let automation_written = tx.execute(
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
            params![
                automation_id,
                run_count,
                scheduled_run_count,
                dispatched_at_ms,
                if terminal { "completed" } else { "active" },
                if terminal { 0 } else { 1 },
                if terminal { None } else { next_run_at_ms },
            ],
        )? > 0;
        tx.commit()?;
        Ok(run_written || automation_written)
    }

    /// Failed dispatch writeback — run row to `failed_to_dispatch` plus the
    /// automation's backoff/terminal update. This is Electron's
    /// `markRunDispatch('failed_to_dispatch')` (`automationRepo.ts:1260-1278`)
    /// fused with `markDispatchFailed` (`automationRepo.ts:997-1063`), the pair
    /// `settleDispatchResult` runs on failure (`scheduler/index.ts:306-335`).
    ///
    /// * [`DispatchFailureKind::Permanent`] goes straight to the failed
    ///   terminal state (`automationRepo.ts:1013-1019`).
    /// * At [`DISPATCH_MAX_ATTEMPTS`] a recurring task gives up the round and
    ///   jumps to the caller-computed `next_run_at_ms` (`None` writes `NULL`,
    ///   `automationRepo.ts:1027-1037`); a finite-run task turns failed
    ///   (`automationRepo.ts:1040-1046`).
    /// * Otherwise the attempt is counted and `retry_at` gets backoff via
    ///   [`compute_retry_at`] (`automationRepo.ts:1049-1062`).
    ///
    /// Returns `true` when at least one row was written.
    pub fn mark_dispatch_failed(
        &mut self,
        run_id: &str,
        error: &str,
        failure_kind: DispatchFailureKind,
        failed_at_ms: i64,
        next_run_at_ms: Option<i64>,
    ) -> rusqlite::Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(automation_id) = resolve_automation_id(&tx, run_id)? else {
            tx.commit()?;
            return Ok(false);
        };

        let run_written = tx.execute(
            "UPDATE automation_runs
             SET dispatch_status = 'failed_to_dispatch',
                 error = ?2,
                 updated_at = ?3
             WHERE run_id = ?1",
            params![run_id, error, failed_at_ms],
        )? > 0;

        let row = tx
            .query_row(
                "SELECT recurring, dispatch_attempts FROM automations
                 WHERE automation_id = ?1",
                [&automation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((recurring, dispatch_attempts)): Option<(i64, i64)> = row else {
            tx.commit()?;
            return Ok(run_written);
        };

        // Terminal failed state, identical SQL for permanent failures and for
        // finite-run tasks that hit the attempts ceiling
        // (`automationRepo.ts:1013-1019` and `:1040-1046`).
        let terminal_failed = |tx: &rusqlite::Transaction<'_>| -> rusqlite::Result<usize> {
            tx.execute(
                "UPDATE automations
                 SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
                     enabled = 0, running = 0, claimed_at = NULL,
                     last_error = ?2, updated_at = ?3
                 WHERE automation_id = ?1",
                params![automation_id, error, failed_at_ms],
            )
        };

        let automation_written = if failure_kind == DispatchFailureKind::Permanent {
            terminal_failed(&tx)? > 0
        } else {
            let attempts = dispatch_attempts + 1;
            if attempts >= DISPATCH_MAX_ATTEMPTS {
                if recurring == 1 {
                    tx.execute(
                        "UPDATE automations
                         SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
                             running = 0, claimed_at = NULL, next_run_at = ?2,
                             last_error = ?3, updated_at = ?4
                         WHERE automation_id = ?1",
                        params![automation_id, next_run_at_ms, error, failed_at_ms],
                    )? > 0
                } else {
                    terminal_failed(&tx)? > 0
                }
            } else {
                tx.execute(
                    "UPDATE automations
                     SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = ?2,
                         retry_at = ?3, running = 0, claimed_at = NULL,
                         last_error = ?4, updated_at = ?5
                     WHERE automation_id = ?1",
                    params![
                        automation_id,
                        attempts,
                        compute_retry_at(failed_at_ms, attempts),
                        error,
                        failed_at_ms
                    ],
                )? > 0
            }
        };
        tx.commit()?;
        Ok(run_written || automation_written)
    }

    /// Settlement of a dispatch result — the port of `settleDispatchResult`
    /// (`packages/desktop/src/scheduler/index.ts:263-336`): on success,
    /// [`Self::mark_dispatched`]; on failure,
    /// [`Self::mark_dispatch_failed`]. Only schedule-triggered runs are
    /// handled (this store never creates manual runs; Electron's manual branch
    /// at `index.ts:290-293,311-313` has no caller here).
    ///
    /// Full signature: `settle(&mut self, run_id: &str, ok: bool, options:
    /// SettleOptions) -> rusqlite::Result<bool>` — returns what the underlying
    /// writeback returned.
    pub fn settle(
        &mut self,
        run_id: &str,
        ok: bool,
        options: SettleOptions,
    ) -> rusqlite::Result<bool> {
        if ok {
            self.mark_dispatched(
                run_id,
                options.now_ms,
                options.next_run_at_ms,
                options.session_id.as_deref(),
            )
        } else {
            let error = options.error.as_deref().unwrap_or("dispatch failed");
            self.mark_dispatch_failed(
                run_id,
                error,
                options.failure_kind,
                options.now_ms,
                options.next_run_at_ms,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::scheduler::{SkipReason, MISFIRE_GRACE_MS};

    /// Deterministic base clock; no wall clock anywhere in these tests.
    const NOW: i64 = 1_000_000_000;
    const GRACE: i64 = MISFIRE_GRACE_MS as i64;
    const STALE: i64 = CLAIM_STALE_MS;

    fn store() -> SchedulerStore {
        SchedulerStore::open(":memory:").expect("in-memory store")
    }

    /// Row overrides for the seed automation.
    struct Seed {
        next_run_at: Option<i64>,
        retry_at: Option<i64>,
        dispatch_attempts: i64,
        recurring: i64,
        max_runs: Option<i64>,
        end_at: Option<i64>,
        running: i64,
        claimed_at: Option<i64>,
    }

    /// Manual default: the schema's `recurring` default is `1`
    /// (`schema-v1.ts:97`), so a plain `#[derive(Default)]` would seed
    /// one-shots instead of the usual recurring automations.
    impl Default for Seed {
        fn default() -> Self {
            Self {
                next_run_at: None,
                retry_at: None,
                dispatch_attempts: 0,
                recurring: 1,
                max_runs: None,
                end_at: None,
                running: 0,
                claimed_at: None,
            }
        }
    }

    fn seed(store: &SchedulerStore, id: &str, seed: Seed) {
        store
            .conn
            .execute(
                "INSERT INTO automations (
                     automation_id, cron_expr, prompt, workspace_key, workspace_path,
                     recurring, max_runs, end_at, next_run_at, retry_at, dispatch_attempts,
                     running, claimed_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    id,
                    "* * * * *",
                    "run the thing",
                    "ws-key",
                    "/tmp/ws",
                    seed.recurring,
                    seed.max_runs,
                    seed.end_at,
                    seed.next_run_at,
                    seed.retry_at,
                    seed.dispatch_attempts,
                    seed.running,
                    seed.claimed_at,
                    NOW,
                    NOW
                ],
            )
            .expect("seed insert");
    }

    fn col<T: rusqlite::types::FromSql>(store: &SchedulerStore, sql: &str) -> T {
        store
            .conn
            .query_row(sql, [], |row| row.get(0))
            .expect("scalar query")
    }

    #[test]
    fn fresh_claim_flips_running_and_writes_run_row() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - 1_000),
                ..Seed::default()
            },
        );

        let claimed = store.claim_due(NOW).expect("claim");
        assert_eq!(claimed.len(), 1);
        let c = &claimed[0];
        assert_eq!(c.automation_id, "a1");
        assert_eq!(c.scheduled_at_ms, NOW - 1_000);
        assert_eq!(c.run_id, format!("a1:{}", NOW - 1_000));
        assert!(!c.is_retry);
        assert!(!c.one_shot);
        // The claimed row maps onto the supervisor's dispatch outcome.
        assert_eq!(
            c.evaluate(NOW),
            TickOutcome::Dispatched {
                run_id: c.run_id.clone()
            }
        );

        assert_eq!(
            col::<i64>(&store, "SELECT running FROM automations WHERE automation_id='a1'"),
            1
        );
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT claimed_at FROM automations WHERE automation_id='a1'"),
            Some(NOW)
        );
        assert_eq!(
            col::<String>(
                &store,
                "SELECT dispatch_status FROM automations WHERE automation_id='a1'"
            ),
            "claimed"
        );
        // Claim fuses the run-ledger upsert.
        assert_eq!(col::<i64>(&store, "SELECT COUNT(*) FROM automation_runs"), 1);
        assert_eq!(
            col::<String>(
                &store,
                &format!(
                    "SELECT dispatch_status FROM automation_runs WHERE run_id='a1:{}'",
                    NOW - 1_000
                )
            ),
            "claimed"
        );
        assert_eq!(col::<i64>(&store, "SELECT attempts FROM automation_runs"), 0);

        // Single-flight: a second claim in the same state claims nothing.
        assert!(store.claim_due(NOW).expect("second claim").is_empty());
    }

    #[test]
    fn future_fire_is_not_claimed() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW + 1),
                ..Seed::default()
            },
        );
        assert!(store.claim_due(NOW).expect("claim").is_empty());
        assert_eq!(col::<i64>(&store, "SELECT running FROM automations"), 0);
        assert_eq!(col::<i64>(&store, "SELECT COUNT(*) FROM automation_runs"), 0);
    }

    #[test]
    fn past_end_at_finalises_before_claim_selection() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - 1_000),
                end_at: Some(NOW - 500),
                ..Seed::default()
            },
        );
        assert!(store.claim_due(NOW).expect("claim").is_empty());
        assert_eq!(
            col::<String>(&store, "SELECT lifecycle_status FROM automations"),
            "completed"
        );
        assert_eq!(col::<i64>(&store, "SELECT enabled FROM automations"), 0);
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT next_run_at FROM automations"),
            None
        );
    }

    #[test]
    fn recurring_misfire_skips_and_reschedules() {
        let mut store = store();
        let late = NOW - GRACE - 1;
        let next_fire = NOW + 60_000;
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(late),
                ..Seed::default()
            },
        );

        let claimed = store.claim_due(NOW).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(
            claimed[0].evaluate(NOW),
            TickOutcome::Skipped {
                reason: SkipReason::ComputerAsleepOrAppNotRunning
            }
        );

        assert!(store
            .skip_misfire("a1", MISFIRE_SKIP_REASON, Some(next_fire), NOW)
            .expect("skip"));

        // Claim released, advanced to the caller-supplied fire, still enabled.
        assert_eq!(col::<i64>(&store, "SELECT running FROM automations"), 0);
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT claimed_at FROM automations"),
            None
        );
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT next_run_at FROM automations"),
            Some(next_fire)
        );
        assert_eq!(col::<i64>(&store, "SELECT enabled FROM automations"), 1);
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automations"),
            "idle"
        );
        // Run row recorded as skipped with the reason; run_count untouched.
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automation_runs"),
            "skipped"
        );
        assert_eq!(
            col::<String>(&store, "SELECT error FROM automation_runs"),
            MISFIRE_SKIP_REASON
        );
        assert_eq!(col::<i64>(&store, "SELECT run_count FROM automations"), 0);
    }

    #[test]
    fn one_shot_misfire_finalises_instead_of_rescheduling() {
        let mut store = store();
        let late = NOW - GRACE - 1;
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(late),
                recurring: 0,
                max_runs: None,
                ..Seed::default()
            },
        );

        let claimed = store.claim_due(NOW).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert!(claimed[0].one_shot);
        assert_eq!(
            claimed[0].evaluate(NOW),
            TickOutcome::Skipped {
                reason: SkipReason::OneShotFinalized
            }
        );

        assert!(store
            .skip_misfire("a1", MISFIRE_SKIP_REASON, None, NOW)
            .expect("skip"));

        assert_eq!(
            col::<String>(&store, "SELECT lifecycle_status FROM automations"),
            "completed"
        );
        assert_eq!(col::<i64>(&store, "SELECT enabled FROM automations"), 0);
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT next_run_at FROM automations"),
            None
        );
        assert_eq!(col::<i64>(&store, "SELECT running FROM automations"), 0);
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automation_runs"),
            "skipped"
        );
    }

    #[test]
    fn skip_with_none_next_run_leaves_schedule_unchanged() {
        // Contract: None never fabricates a timestamp, it leaves next_run_at.
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - GRACE - 1),
                ..Seed::default()
            },
        );
        store.claim_due(NOW).expect("claim");
        assert!(store
            .skip_misfire("a1", MISFIRE_SKIP_REASON, None, NOW)
            .expect("skip"));
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT next_run_at FROM automations"),
            Some(NOW - GRACE - 1)
        );
        assert_eq!(col::<i64>(&store, "SELECT running FROM automations"), 0);
    }

    #[test]
    fn skip_of_deleted_automation_is_a_no_op() {
        let mut store = store();
        assert!(!store
            .skip_misfire("ghost", MISFIRE_SKIP_REASON, Some(NOW), NOW)
            .expect("skip"));
        assert_eq!(col::<i64>(&store, "SELECT COUNT(*) FROM automation_runs"), 0);
    }

    #[test]
    fn retries_are_exempt_from_misfire() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - GRACE - 1),
                retry_at: Some(NOW - 100),
                dispatch_attempts: 2,
                ..Seed::default()
            },
        );
        let claimed = store.claim_due(NOW).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert!(claimed[0].is_retry);
        // Far past the grace window, yet a retry dispatches instead of skipping.
        assert_eq!(
            claimed[0].evaluate(NOW),
            TickOutcome::Dispatched {
                run_id: format!("a1:{}", NOW - GRACE - 1)
            }
        );
    }

    #[test]
    fn stale_claim_is_reclaimed_but_fresh_holder_is_not_stolen() {
        let mut store = store();
        seed(
            &store,
            "stale",
            Seed {
                next_run_at: Some(NOW - 50),
                running: 1,
                claimed_at: Some(NOW - STALE - 1),
                ..Seed::default()
            },
        );
        seed(
            &store,
            "fresh",
            Seed {
                next_run_at: Some(NOW - 50),
                running: 1,
                claimed_at: Some(NOW - 60_000),
                ..Seed::default()
            },
        );

        let claimed = store.claim_due(NOW).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].automation_id, "stale");
        // The zombie's claim was taken over with the new timestamp…
        assert_eq!(
            col::<Option<i64>>(
                &store,
                "SELECT claimed_at FROM automations WHERE automation_id='stale'"
            ),
            Some(NOW)
        );
        // …while the live holder keeps its claim.
        assert_eq!(
            col::<Option<i64>>(
                &store,
                "SELECT claimed_at FROM automations WHERE automation_id='fresh'"
            ),
            Some(NOW - 60_000)
        );
        assert_eq!(
            col::<i64>(&store, "SELECT running FROM automations WHERE automation_id='fresh'"),
            1
        );
    }

    #[test]
    fn schema_init_is_idempotent() {
        let store = store();
        // open() already ran the DDL; run it twice more.
        store.create_schema().expect("second init");
        store.create_schema().expect("third init");
        let tables = col::<i64>(
            &store,
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('automations', 'automation_runs')",
        );
        assert_eq!(tables, 2);
        let indexes = col::<i64>(
            &store,
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
        );
        assert_eq!(indexes, 4);
    }

    #[test]
    fn open_creates_a_file_database_that_survives_reopen() {
        let path = std::env::temp_dir().join(format!(
            "zcode-scheduler-store-{}-{}.db",
            std::process::id(),
            NOW
        ));
        let path_str = path.to_str().expect("utf8 path");
        {
            let mut store = SchedulerStore::open(path_str).expect("first open");
            seed(
                &store,
                "a1",
                Seed {
                    next_run_at: Some(NOW),
                    ..Seed::default()
                },
            );
            store.claim_due(NOW).expect("claim");
        }
        {
            // Reopen: schema DDL runs again over existing data (idempotent).
            let store = SchedulerStore::open(path_str).expect("second open");
            assert_eq!(col::<i64>(&store, "SELECT COUNT(*) FROM automations"), 1);
            assert_eq!(col::<i64>(&store, "SELECT running FROM automations"), 1);
            assert_eq!(col::<i64>(&store, "SELECT COUNT(*) FROM automation_runs"), 1);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn run_id_is_stable_across_a_retry() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - 1_000),
                ..Seed::default()
            },
        );

        let first = store.claim_due(NOW).expect("first claim");
        assert_eq!(first.len(), 1);
        let run_id = first[0].run_id.clone();

        // Transient failure settles into a backoff; next_run_at must not move.
        let settled = store
            .settle(
                &run_id,
                false,
                SettleOptions::failure(
                    NOW,
                    Some("boom".into()),
                    DispatchFailureKind::Transient,
                ),
            )
            .expect("settle");
        assert!(settled);
        assert_eq!(
            col::<i64>(&store, "SELECT dispatch_attempts FROM automations"),
            1
        );
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT retry_at FROM automations"),
            Some(NOW + DISPATCH_RETRY_BASE_MS)
        );
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automation_runs"),
            "failed_to_dispatch"
        );
        assert_eq!(
            col::<String>(&store, "SELECT error FROM automation_runs"),
            "boom"
        );

        // Well past the original fire (and past misfire grace), the retry is
        // claimed again with the identical run id.
        let now2 = NOW + GRACE + 10_000;
        let second = store.claim_due(now2).expect("second claim");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].run_id, run_id);
        assert!(second[0].is_retry);
        assert_eq!(
            second[0].evaluate(now2),
            TickOutcome::Dispatched {
                run_id: run_id.clone()
            }
        );
        // Same run row reused, not duplicated; attempts counts the re-claim.
        assert_eq!(col::<i64>(&store, "SELECT COUNT(*) FROM automation_runs"), 1);
        assert_eq!(col::<i64>(&store, "SELECT attempts FROM automation_runs"), 1);
    }

    #[test]
    fn settle_success_advances_counts_and_next_run() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - 1_000),
                ..Seed::default()
            },
        );
        let claimed = store.claim_due(NOW).expect("claim");
        let next_fire = NOW + 60_000;
        let mut opts = SettleOptions::success(NOW + 5);
        opts.session_id = Some("sess-1".into());
        opts.next_run_at_ms = Some(next_fire);
        assert!(store
            .settle(&claimed[0].run_id, true, opts)
            .expect("settle"));

        assert_eq!(col::<i64>(&store, "SELECT run_count FROM automations"), 1);
        assert_eq!(
            col::<i64>(&store, "SELECT scheduled_run_count FROM automations"),
            1
        );
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT last_run_at FROM automations"),
            Some(NOW + 5)
        );
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT next_run_at FROM automations"),
            Some(next_fire)
        );
        assert_eq!(col::<i64>(&store, "SELECT running FROM automations"), 0);
        assert_eq!(col::<i64>(&store, "SELECT enabled FROM automations"), 1);
        assert_eq!(
            col::<String>(&store, "SELECT lifecycle_status FROM automations"),
            "active"
        );
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automation_runs"),
            "dispatched"
        );
        assert_eq!(
            col::<Option<String>>(&store, "SELECT session_id FROM automation_runs"),
            Some("sess-1".into())
        );
        assert_eq!(
            col::<Option<String>>(&store, "SELECT error FROM automation_runs"),
            None
        );
    }

    #[test]
    fn settle_success_completes_a_one_shot_that_reached_max_runs() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - 1_000),
                recurring: 0,
                max_runs: None,
                ..Seed::default()
            },
        );
        let claimed = store.claim_due(NOW).expect("claim");
        let mut opts = SettleOptions::success(NOW);
        opts.next_run_at_ms = Some(NOW + 60_000);
        assert!(store
            .settle(&claimed[0].run_id, true, opts)
            .expect("settle"));

        assert_eq!(
            col::<String>(&store, "SELECT lifecycle_status FROM automations"),
            "completed"
        );
        assert_eq!(col::<i64>(&store, "SELECT enabled FROM automations"), 0);
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT next_run_at FROM automations"),
            None
        );
    }

    #[test]
    fn settle_permanent_failure_reaches_failed_terminal_state() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - 1_000),
                ..Seed::default()
            },
        );
        let claimed = store.claim_due(NOW).expect("claim");
        assert!(store
            .settle(
                &claimed[0].run_id,
                false,
                SettleOptions::failure(
                    NOW,
                    Some("no host".into()),
                    DispatchFailureKind::Permanent,
                ),
            )
            .expect("settle"));

        assert_eq!(
            col::<String>(&store, "SELECT lifecycle_status FROM automations"),
            "failed"
        );
        assert_eq!(col::<i64>(&store, "SELECT enabled FROM automations"), 0);
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automations"),
            "failed_to_dispatch"
        );
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automation_runs"),
            "failed_to_dispatch"
        );
    }

    #[test]
    fn transient_failure_at_attempts_cap_gives_up_recurring_round() {
        let mut store = store();
        seed(
            &store,
            "a1",
            Seed {
                next_run_at: Some(NOW - 1_000),
                dispatch_attempts: DISPATCH_MAX_ATTEMPTS - 1,
                ..Seed::default()
            },
        );
        let claimed = store.claim_due(NOW).expect("claim");
        assert!(claimed[0].is_retry);
        let next_fire = NOW + 120_000;
        let mut opts = SettleOptions::failure(
            NOW,
            Some("still down".into()),
            DispatchFailureKind::Transient,
        );
        opts.next_run_at_ms = Some(next_fire);
        assert!(store
            .settle(&claimed[0].run_id, false, opts)
            .expect("settle"));

        // Ceiling reached: give up this round, jump to the next normal fire.
        assert_eq!(
            col::<i64>(&store, "SELECT dispatch_attempts FROM automations"),
            0
        );
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT retry_at FROM automations"),
            None
        );
        assert_eq!(
            col::<Option<i64>>(&store, "SELECT next_run_at FROM automations"),
            Some(next_fire)
        );
        assert_eq!(
            col::<String>(&store, "SELECT dispatch_status FROM automations"),
            "idle"
        );
        assert_eq!(col::<i64>(&store, "SELECT running FROM automations"), 0);
    }

    #[test]
    fn retry_backoff_matches_electron_schedule() {
        // computeRetryAt: now + min(BASE * 2^max(0, attempts-1), CAP)
        assert_eq!(compute_retry_at(1_000, 1), 1_000 + 30_000);
        assert_eq!(compute_retry_at(1_000, 2), 1_000 + 60_000);
        assert_eq!(compute_retry_at(1_000, 5), 1_000 + 480_000);
        assert_eq!(compute_retry_at(1_000, 6), 1_000 + 900_000); // capped
        assert_eq!(compute_retry_at(1_000, 50), 1_000 + 900_000); // capped
        assert_eq!(compute_retry_at(0, 0), 30_000); // attempts<1 → single base
    }
}
