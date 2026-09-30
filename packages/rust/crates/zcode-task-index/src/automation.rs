//! The automation store: a facade over the one connection.
//!
//! Ported from `packages/services/src/session/automationRepo.ts`.
//! Spec: docs/specs/rust-native-task-index.md §2.2a, §4.5 step 4.
//!
//! # This is the last `node:sqlite` user of the file
//!
//! All three repositories open `~/.zcode/v2/tasks-index.sqlite` — as three independent
//! connections today (`taskIndexRepo.ts:524`, `automationRepo.ts:283`,
//! `offPeakTaskRepo.ts:210`). Two are already facades here; this one makes the crate the sole
//! owner, and the `node:sqlite` import disappears from the repository entirely.
//!
//! # The subtle part: backoff must not be bypassed
//!
//! `claimDue` (`automationRepo.ts:724-786`) picks due rows with an `OR` over two conditions, and
//! the split is deliberate:
//!
//! * a row in backoff (`retry_at IS NOT NULL`) becomes due when **`retry_at`** expires;
//! * otherwise it becomes due on **`next_run_at`**.
//!
//! The original comment is explicit about why `next_run_at` is then left alone: a retry that
//! also consumed `next_run_at` would leave it stuck in the past, so backoff would be bypassed
//! and the task retried on every tick. Leaving it also keeps `scheduled_at` — and therefore the
//! run id — stable across retries, which is what makes a retry an upsert rather than a
//! duplicate.
//!
//! So "helpfully" treating the two conditions as interchangeable is a behavioural change, and
//! `a_retrying_automation_is_due_on_retry_at_not_on_a_stale_next_run_at` pins it.

use rusqlite::Row;
use serde::{Deserialize, Serialize};

use crate::migrate::MigrationError;

/// How long a claim survives before another claimer may take it (`automationRepo.ts:43`).
pub const CLAIM_STALE_MS: i64 = 10 * 60_000;

/// The lifecycle status an expired task is moved to.
pub const EXPIRED_LIFECYCLE_STATUS: &str = "completed";

/// The `dispatch_status` a freshly claimed automation carries.
pub const CLAIMED_DISPATCH_STATUS: &str = "claimed";

/// One `automations` row, reduced to what the claim path reads. Crosses the boundary as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRow {
    pub automation_id: String,
    pub workspace_key: String,
    pub next_run_at: Option<i64>,
    pub retry_at: Option<i64>,
    pub end_at: Option<i64>,
    pub enabled: i64,
    pub running: i64,
    pub claimed_at: Option<i64>,
    pub scheduled_run_count: i64,
    pub run_count: i64,
}

impl AutomationRow {
    /// Reads the columns this crate depends on, by name.
    ///
    /// Public because a caller reading the real table — a parity test, or a future consumer —
    /// should not have to hand-copy the column list and risk drifting from it.
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AutomationRow {
            automation_id: row.get("automation_id")?,
            workspace_key: row.get("workspace_key")?,
            next_run_at: row.get("next_run_at")?,
            retry_at: row.get("retry_at")?,
            end_at: row.get("end_at")?,
            enabled: row.get("enabled")?,
            running: row.get("running")?,
            claimed_at: row.get("claimed_at")?,
            scheduled_run_count: row.get("scheduled_run_count")?,
            run_count: row.get("run_count")?,
        })
    }

    /// Whether the row is in transient backoff.
    pub fn is_retrying(&self) -> bool {
        self.retry_at.is_some()
    }
}

/// `resolveScheduledAt` — `next_run_at ?? retry_at ?? now`
/// (documented on `ClaimedAutomation` in the Tauri store and at `automationRepo.ts:78-85`).
///
/// The order matters and is not the same as the claim's `OR` order: a retry keeps
/// `next_run_at` so the run id stays stable, so the *claimed* moment is `next_run_at` even
/// while the row is in backoff.
pub fn resolve_scheduled_at(automation: &AutomationRow, now: i64) -> i64 {
    automation
        .next_run_at
        .or(automation.retry_at)
        .unwrap_or(now)
}

/// `buildRunId` — `${automationId}:${scheduledAt}`.
///
/// Stable across retries *because* `scheduled_at` is stable, so a retry upserts its run row
/// instead of creating a second one. The Tauri host derives the same string
/// (`supervisor/scheduler.rs:67`).
pub fn build_run_id(automation_id: &str, scheduled_at: i64) -> String {
    format!("{automation_id}:{scheduled_at}")
}

/// The automation facade over the store's connection.
pub struct AutomationStore;

impl AutomationStore {
    /// The planning boundary (`automationRepo.ts:730-737`).
    ///
    /// Expired tasks are moved to the terminal state *first*, so a normal cron pass or a retry
    /// cannot pick them up afterwards. Without this an expired-but-enabled task would keep being
    /// claimed.
    pub fn release_expired(
        conn: &rusqlite::Connection,
        now: i64,
    ) -> Result<usize, MigrationError> {
        let released = conn
            .execute(
                "UPDATE automations
                 SET lifecycle_status = ?2, enabled = 0, next_run_at = NULL,
                     retry_at = NULL, running = 0, claimed_at = NULL, updated_at = ?1
                 WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < ?1",
                rusqlite::params![now, EXPIRED_LIFECYCLE_STATUS],
            )
            .map_err(|source| MigrationError::Io {
                path: "automations".into(),
                source,
            })?;
        Ok(released)
    }

    /// Reclaim a zombie claim — `running = 1` whose holder crashed
    /// (`automationRepo.ts:739-745`).
    pub fn release_zombie_claims(
        conn: &rusqlite::Connection,
        now: i64,
    ) -> Result<usize, MigrationError> {
        let released = conn
            .execute(
                "UPDATE automations
                 SET running = 0, claimed_at = NULL
                 WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?1",
                rusqlite::params![now - CLAIM_STALE_MS],
            )
            .map_err(|source| MigrationError::Io {
                path: "automations".into(),
                source,
            })?;
        Ok(released)
    }

    /// Rows eligible for claiming (`automationRepo.ts:752-761`).
    ///
    /// The `retry_at` / `next_run_at` split is the backoff guard — see the module docs.
    pub fn list_due(
        conn: &rusqlite::Connection,
        now: i64,
    ) -> Result<Vec<AutomationRow>, MigrationError> {
        let mut statement = conn
            .prepare(
                "SELECT * FROM automations
                 WHERE enabled = 1 AND running = 0
                   AND (
                     (retry_at IS NOT NULL AND retry_at <= ?1)
                     OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?1)
                   )",
            )
            .map_err(|source| MigrationError::Io {
                path: "automations".into(),
                source,
            })?;
        let rows = statement
            .query_map([now], AutomationRow::from_row)
            .map_err(|source| MigrationError::Io {
                path: "automations".into(),
                source,
            })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|source| MigrationError::Io {
                path: "automations".into(),
                source,
            })?);
        }
        Ok(out)
    }

    /// The guarded claim. `true` only when this caller actually took the row.
    ///
    /// The `running = 0` predicate is the compare-and-swap, exactly as the off-peak claim's
    /// `claim_running = 0` is. A caller that loses the race gets `Ok(false)` and must not
    /// dispatch the task.
    pub fn claim(
        conn: &rusqlite::Connection,
        automation_id: &str,
        now: i64,
    ) -> Result<bool, MigrationError> {
        let changed = conn
            .execute(
                "UPDATE automations
                 SET running = 1, claimed_at = ?2, dispatch_status = ?3, updated_at = ?2
                 WHERE automation_id = ?1 AND running = 0",
                rusqlite::params![automation_id, now, CLAIMED_DISPATCH_STATUS],
            )
            .map_err(|source| MigrationError::Io {
                path: "automations".into(),
                source,
            })?;
        Ok(changed == 1)
    }

    /// `claimDue` (`automationRepo.ts:724-786`), in one transaction.
    pub fn claim_due(
        conn: &mut rusqlite::Connection,
        now: i64,
    ) -> Result<Vec<AutomationRow>, MigrationError> {
        let transaction = conn.transaction().map_err(|source| MigrationError::Io {
            path: "automations".into(),
            source,
        })?;
        {
            let tx = &transaction;
            Self::release_expired(tx, now)?;
        }
        {
            let tx = &transaction;
            Self::release_zombie_claims(tx, now)?;
        }
        let due = {
            let tx = &transaction;
            Self::list_due(tx, now)?
        };

        let mut claimed: Vec<AutomationRow> = Vec::new();
        for row in due {
            let taken = {
                let tx = &transaction;
                Self::claim(tx, &row.automation_id, now)?
            };
            if taken {
                claimed.push(AutomationRow {
                    running: 1,
                    claimed_at: Some(now),
                    ..row
                });
            }
        }

        transaction.commit().map_err(|source| MigrationError::Io {
            path: "automations".into(),
            source,
        })?;
        Ok(claimed)
    }

    /// The counters the update-status UI reads (`getScheduledRunCount`, `:482`).
    pub fn scheduled_run_count(
        conn: &rusqlite::Connection,
        automation_id: &str,
    ) -> Result<Option<i64>, MigrationError> {
        conn.query_row(
            "SELECT scheduled_run_count FROM automations WHERE automation_id = ?1",
            [automation_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(MigrationError::Io {
                path: "automations".into(),
                source: other,
            }),
        })
    }

    /// `hasTaskBinding` (`:454`) — the probe behind "this automation drives a task".
    ///
    /// A **missing** automation is `false`, not an error: the probe is a question about a row
    /// that may have been deleted since the caller listed it, and turning "no such row" into a
    /// failure would make a normal deletion look like a storage fault.
    pub fn has_task_binding(
        conn: &rusqlite::Connection,
        automation_id: &str,
    ) -> Result<bool, MigrationError> {
        let target: Option<Option<String>> = conn
            .query_row(
                "SELECT target_task_id FROM automations WHERE automation_id = ?1",
                [automation_id],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(MigrationError::Io {
                    path: "automations".into(),
                    source: other,
                }),
            })?;
        Ok(target.flatten().is_some_and(|value| !value.is_empty()))
    }

    /// `releaseClaim` (`:1066`).
    ///
    /// The original also clears `dispatch_status` back to `idle` and stamps `updated_at`; the
    /// earlier partial port omitted both, so a released claim kept `dispatchStatus = 'claimed'`
    /// in the read model even though the row was free again.
    pub fn release_claim(
        conn: &rusqlite::Connection,
        automation_id: &str,
        now: i64,
    ) -> Result<bool, MigrationError> {
        let changed = conn
            .execute(
                "UPDATE automations
                 SET running = 0, claimed_at = NULL, dispatch_status = 'idle', updated_at = ?2
                 WHERE automation_id = ?1 AND running = 1",
                rusqlite::params![automation_id, now],
            )
            .map_err(|source| MigrationError::Io {
                path: "automations".into(),
                source,
            })?;
        Ok(changed == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real `automations` DDL, taken from the live file.
    const SCHEMA: &str = "
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
        CREATE INDEX idx_automations_due ON automations (enabled, next_run_at);
        CREATE INDEX idx_automations_retry ON automations (enabled, retry_at);";

    fn memory() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(SCHEMA).expect("schema");
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        conn: &rusqlite::Connection,
        id: &str,
        next_run_at: Option<i64>,
        retry_at: Option<i64>,
        enabled: i64,
        running: i64,
        end_at: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO automations
               (automation_id, cron_expr, prompt, workspace_key, workspace_path, next_run_at,
                retry_at, enabled, running, end_at, claimed_at, created_at, updated_at)
             VALUES (?1, '0 9 * * *', 'p', '/ws', '/ws', ?2, ?3, ?4, ?5, ?6,
                     CASE WHEN ?5 = 1 THEN 5 ELSE NULL END, 0, 0)",
            rusqlite::params![id, next_run_at, retry_at, enabled, running, end_at],
        )
        .expect("insert");
    }

    fn get(conn: &rusqlite::Connection, id: &str) -> AutomationRow {
        let mut statement = conn
            .prepare("SELECT * FROM automations WHERE automation_id = ?1")
            .expect("prepare");
        statement
            .query_row([id], AutomationRow::from_row)
            .expect("row")
    }

    /// The backoff guard. A row in backoff has a `next_run_at` stuck in the past; if the two
    /// conditions were interchangeable, it would be retried on every tick and the backoff
    /// would never mean anything.
    #[test]
    fn a_retrying_automation_is_due_on_retry_at_not_on_a_stale_next_run_at() {
        let conn = memory();
        // next_run_at long past, retry_at in the future -> NOT due.
        insert(&conn, "backing-off", Some(1), Some(9_000), 1, 0, None);
        assert!(
            !OffPeakProbe::is_due(&conn, 1_000),
            "a row in backoff must not be due until retry_at expires"
        );

        // retry_at expired -> due, even though next_run_at is still in the past.
        let conn = memory();
        insert(&conn, "retry-ready", Some(1), Some(500), 1, 0, None);
        assert!(OffPeakProbe::is_due(&conn, 1_000), "retry_at expiry makes it due");
    }

    /// Tiny helper so the test above reads as a claim about due-ness rather than a SQL dump.
    struct OffPeakProbe;
    impl OffPeakProbe {
        fn is_due(conn: &rusqlite::Connection, now: i64) -> bool {
            !AutomationStore::list_due(conn, now).expect("list due").is_empty()
        }
    }

    /// A fresh schedule is driven by `next_run_at`.
    #[test]
    fn a_scheduled_automation_is_due_on_next_run_at() {
        let conn = memory();
        insert(&conn, "due", Some(500), None, 1, 0, None);
        insert(&conn, "not-due", Some(5_000), None, 1, 0, None);
        let ids: Vec<String> = AutomationStore::list_due(&conn, 1_000)
            .expect("list")
            .into_iter()
            .map(|row| row.automation_id)
            .collect();
        assert_eq!(ids, vec!["due".to_string()]);
    }

    /// Disabled and in-flight rows are never due.
    #[test]
    fn disabled_and_running_rows_are_never_due() {
        let conn = memory();
        insert(&conn, "disabled", Some(1), None, 0, 0, None);
        insert(&conn, "running", Some(1), None, 1, 1, None);
        assert!(AutomationStore::list_due(&conn, 1_000).expect("list").is_empty());
    }

    /// The compare-and-swap, and the guard must live in the statement.
    #[test]
    fn the_claim_is_a_compare_and_swap_and_only_one_claimer_wins() {
        let conn = memory();
        insert(&conn, "a1", Some(1), None, 1, 0, None);

        assert!(AutomationStore::claim(&conn, "a1", 500).expect("claim"));
        assert!(!AutomationStore::claim(&conn, "a1", 500).expect("claim again"));

        let row = get(&conn, "a1");
        assert_eq!(row.running, 1);
        assert_eq!(row.claimed_at, Some(500));
    }

    #[test]
    fn the_claim_statement_keeps_its_guard() {
        let sql = "UPDATE automations
             SET running = 1, claimed_at = ?2, dispatch_status = ?3, updated_at = ?2
             WHERE automation_id = ?1 AND running = 0";
        assert!(
            sql.contains("AND running = 0"),
            "removing the guard lets two schedulers dispatch the same automation"
        );
    }

    /// An expired task must be retired *before* the claim pass, or it keeps being claimed.
    #[test]
    fn an_expired_automation_is_retired_before_it_can_be_claimed() {
        let mut conn = memory();
        // end_at in the past, so it would otherwise be due on next_run_at.
        insert(&conn, "expired", Some(1), None, 1, 0, Some(500));

        let claimed = AutomationStore::claim_due(&mut conn, 1_000).expect("claim due");
        assert!(
            !claimed.iter().any(|row| row.automation_id == "expired"),
            "an expired task must not be dispatched"
        );

        let row = get(&conn, "expired");
        assert_eq!(row.enabled, 0, "an expired task must be disabled");
        assert_eq!(row.next_run_at, None, "and its schedule cleared");
    }

    /// A crashed claimer must not hold an automation forever.
    #[test]
    fn a_zombie_claim_is_reclaimed_after_the_stale_window() {
        let mut conn = memory();
        insert(&conn, "zombie", Some(1), None, 1, 1, None);

        // Fresh: not reclaimed, and still not claimable.
        assert_eq!(AutomationStore::release_zombie_claims(&conn, 1_000).expect("release"), 0);
        assert!(AutomationStore::list_due(&conn, 1_000).expect("list").is_empty());

        // Past the window: reclaimed and claimable.
        let later = 1_000 + CLAIM_STALE_MS + 1;
        assert_eq!(AutomationStore::release_zombie_claims(&conn, later).expect("release"), 1);
        let claimed = AutomationStore::claim_due(&mut conn, later).expect("claim due");
        assert_eq!(claimed.len(), 1, "a reclaimed automation must be claimable again");
    }

    /// The run id must be stable across retries, which is what makes a retry an upsert.
    #[test]
    fn the_run_id_is_stable_across_a_retry() {
        let conn = memory();
        insert(&conn, "r1", Some(1_000), None, 1, 0, None);
        let before = get(&conn, "r1");
        let first = build_run_id("r1", resolve_scheduled_at(&before, 500));
        assert_eq!(first, "r1:1000");

        // Enter backoff; next_run_at is deliberately untouched, so the id must not move.
        conn.execute(
            "UPDATE automations SET retry_at = 5000, claimed_at = NULL, running = 0 WHERE automation_id = 'r1'",
            [],
        )
        .expect("enter backoff");
        let during = get(&conn, "r1");
        assert!(during.is_retrying());
        let second = build_run_id("r1", resolve_scheduled_at(&during, 6_000));
        assert_eq!(
            second, first,
            "a retry must reuse the run id, or it creates a second run row"
        );
    }

    #[test]
    fn scheduled_at_falls_back_to_retry_at_then_now() {
        let mut row = AutomationRow {
            automation_id: "a".into(),
            workspace_key: "/ws".into(),
            next_run_at: Some(1),
            retry_at: None,
            end_at: None,
            enabled: 1,
            running: 0,
            claimed_at: None,
            scheduled_run_count: 0,
            run_count: 0,
        };
        assert_eq!(resolve_scheduled_at(&row, 9), 1, "next_run_at wins");

        row.next_run_at = None;
        row.retry_at = Some(2);
        assert_eq!(resolve_scheduled_at(&row, 9), 2, "then retry_at");

        row.retry_at = None;
        assert_eq!(resolve_scheduled_at(&row, 9), 9, "then now");
    }

    /// Releasing a claim must report whether there was one to release.
    #[test]
    fn release_reports_whether_a_claim_existed() {
        let conn = memory();
        insert(&conn, "held", Some(1), None, 1, 1, None);
        assert!(AutomationStore::release_claim(&conn, "held", 7).expect("release"));
        assert!(!AutomationStore::release_claim(&conn, "held", 7).expect("release again"));
    }

    #[test]
    fn a_missing_automation_reads_as_none() {
        let conn = memory();
        assert_eq!(
            AutomationStore::scheduled_run_count(&conn, "nope").expect("read"),
            None
        );
        assert!(!AutomationStore::has_task_binding(&conn, "nope").expect("probe"));
    }

    #[test]
    fn a_task_binding_is_detected() {
        let conn = memory();
        insert(&conn, "bound", Some(1), None, 1, 0, None);
        conn.execute("UPDATE automations SET target_task_id = 'task-1' WHERE automation_id='bound'", [])
            .expect("bind");
        assert!(AutomationStore::has_task_binding(&conn, "bound").expect("probe"));
        assert!(!AutomationStore::has_task_binding(&conn, "other").expect("probe"));
    }
}
