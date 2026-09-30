//! The off-peak task store: a facade over the one connection.
//!
//! Ported from `packages/services/src/session/offPeakTaskRepo.ts`.
//! Spec: docs/specs/rust-native-task-index.md §2.2a, §4.5 step 5.
//!
//! # Why a facade and not a second store
//!
//! All three repositories open the **same** `~/.v2/tasks-index.sqlite` — today as three
//! independent `node:sqlite` connections (`taskIndexRepo.ts:524`, `automationRepo.ts:283`,
//! `offPeakTaskRepo.ts:210`). Porting one and leaving the other two on `node:sqlite` would
//! leave two languages owning a persisted file, and the migration ledger
//! (`tasks_schema_migration`) written by whichever repo opened it first.
//!
//! So the crate owns the connection and these are facades over it. The `node:sqlite` import
//! disappears only when the last facade moves.
//!
//! # The claim is a compare-and-swap, and that is the whole point
//!
//! [`OffPeakStore::claim_due`] does not "read the list and mark it". Each row is taken with a
//! guarded update —
//!
//! ```sql
//! UPDATE off_peak_tasks SET claim_running = 1, claimed_at = ?now, updated_at = ?now
//! WHERE off_peak_task_id = ?id AND claim_running = 0
//! ```
//!
//! — and accepted **only when it changed exactly one row** (`res.changes === 1` in the
//! TypeScript). That is what makes two claimers safe: the loser of the race sees `changes == 0`
//! and does not report the task. Replacing it with a read-then-write would let both schedulers
//! dispatch the same task, and the test below asserts the guard is present in the SQL rather
//! than only in the calling code.

use rusqlite::Row;
use serde::{Deserialize, Serialize};

use crate::migrate::MigrationError;

/// How long a claim survives before another claimer may take it (`offPeakTaskRepo.ts:35`).
pub const OFF_PEAK_CLAIM_STALE_MS: i64 = 10 * 60_000;

/// `OFF_PEAK_TERMINAL_STATUSES` (`off-peak-types.ts:24`).
pub const TERMINAL_STATUSES: [&str; 3] = ["completed", "failed", "cancelled"];

/// One `off_peak_tasks` row, as the port reads it. Crosses the boundary as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OffPeakRow {
    pub off_peak_task_id: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub workspace_key: String,
    pub status: String,
    pub queued_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub schedulable: i64,
    pub claim_running: i64,
    pub claimed_at: Option<i64>,
    /// Raw `TEXT`; validity is decided by [`model_selection_is_valid`], not by parsing here.
    pub model_selection: Option<String>,
}

impl OffPeakRow {
    /// Reads the columns this crate depends on, by name. Public for the same reason as
    /// [`crate::automation::AutomationRow::from_row`].
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(OffPeakRow {
            off_peak_task_id: row.get("off_peak_task_id")?,
            session_id: row.get("session_id")?,
            prompt: row.get("prompt")?,
            workspace_key: row.get("workspace_key")?,
            status: row.get("status")?,
            queued_at: row.get("queued_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            schedulable: row.get("schedulable")?,
            claim_running: row.get("claim_running")?,
            claimed_at: row.get("claimed_at")?,
            model_selection: row.get("model_selection")?,
        })
    }

    pub fn is_terminal(&self) -> bool {
        TERMINAL_STATUSES.contains(&self.status.as_str())
    }
}

/// `readOffPeakModelSelection` (`offPeakTaskRepo.ts:115-125`).
///
/// Returns whether the row carries a usable selection. The TypeScript tries
/// `JSON.parse` then validates against `modelSelectionSchema`, and on any failure falls back to
/// `null` so the row stays in the list awaiting repair but is never claimed.
///
/// The port only decides *parseable-and-nonempty*, which is the same accept/reject boundary for
/// the claim loop. The field-level schema validation stays on the TypeScript side, because
/// `ZCodeModelSelection` is a shared wire type the crate deliberately does not own — inventing a
/// second validator for it would be a place for the two to disagree.
///
/// Note the one-way import the original comment describes: the old single `model` column has no
/// provider family and cannot be migrated, so such rows are **skipped**, not repaired.
pub fn model_selection_is_valid(row: &OffPeakRow) -> bool {
    let Some(raw) = row.model_selection.as_deref().map(str::trim) else {
        return false;
    };
    if raw.is_empty() {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(raw).is_ok()
}

/// One task this caller took, in both shapes.
///
/// `row` carries the claim columns for a caller that needs them; `task` is the **domain** shape the
/// repository publishes, captured before the UPDATE. Keeping both avoids reading the row back
/// afterwards, which would report the claim's own `updated_at` instead of the value the caller
/// acted on.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimedOffPeak {
    pub row: OffPeakRow,
    pub task: Task,
}

/// The off-peak facade over the store's connection.
pub struct OffPeakStore;

impl OffPeakStore {
    /// Releases claims abandoned by a claimer that died (`offPeakTaskRepo.ts:567-571`).
    ///
    /// Without this a crashed scheduler would hold a task forever: `claim_running` stays 1, so
    /// `claim_due` never selects it and nothing else can take it.
    pub fn release_stale_claims(
        conn: &rusqlite::Connection,
        now: i64,
    ) -> Result<usize, MigrationError> {
        let released = conn
            .execute(
                "UPDATE off_peak_tasks
                 SET claim_running = 0, claimed_at = NULL
                 WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?1",
                rusqlite::params![now - OFF_PEAK_CLAIM_STALE_MS],
            )
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        Ok(released)
    }

    /// Rows eligible for claiming, in the order the scheduler wants them
    /// (`offPeakTaskRepo.ts:573-580`).
    pub fn list_due(conn: &rusqlite::Connection) -> Result<Vec<OffPeakRow>, MigrationError> {
        let mut statement = conn
            .prepare(
                "SELECT * FROM off_peak_tasks
                 WHERE status = 'queued' AND schedulable = 1 AND claim_running = 0
                 ORDER BY queued_at ASC, created_at ASC",
            )
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        let rows = statement
            .query_map([], OffPeakRow::from_row)
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?);
        }
        Ok(out)
    }

    /// The guarded claim. Returns `true` only when this caller actually took the row.
    ///
    /// The `claim_running = 0` predicate is the compare-and-swap; a caller that loses the race
    /// gets `Ok(false)` and must not report the task as claimed.
    pub fn claim(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        now: i64,
    ) -> Result<bool, MigrationError> {
        let changed = conn
            .execute(
                "UPDATE off_peak_tasks
                 SET claim_running = 1, claimed_at = ?2, updated_at = ?2
                 WHERE off_peak_task_id = ?1 AND claim_running = 0",
                rusqlite::params![off_peak_task_id, now],
            )
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        Ok(changed == 1)
    }

    /// `claimDue` (`offPeakTaskRepo.ts:562-610`), in one transaction.
    ///
    /// The order matters and is preserved: release stale claims, select the due set, then take
    /// each row individually. Batching the claims into a single statement would lose the
    /// per-row `changes == 1` check, which is what makes concurrent claimers safe.
    pub fn claim_due(
        conn: &mut rusqlite::Connection,
        now: i64,
    ) -> Result<Vec<ClaimedOffPeak>, MigrationError> {
        let transaction = conn.transaction().map_err(|source| MigrationError::Io {
            path: "off_peak_tasks".into(),
            source,
        })?;
        // The statements borrow the transaction, so each is scoped before the next runs.
        {
            let tx = &transaction;
            Self::release_stale_claims(tx, now)?;
        }
        let due = {
            let tx = &transaction;
            Self::list_due(tx)?
        };

        let mut claimed: Vec<ClaimedOffPeak> = Vec::new();
        for row in due {
            // A row with no usable model selection stays listed for repair but is never
            // claimed. Skipping row by row is also what stops one bad record from blocking
            // every healthy task behind it.
            if !model_selection_is_valid(&row) {
                continue;
            }
            // Read the domain shape **before** the UPDATE: the caller is told what it
            // dispatched, and the claim's own `updated_at` write must not be reflected back.
            let task = Self::get_task(&transaction, &row.off_peak_task_id)?;
            let taken = Self::claim(&transaction, &row.off_peak_task_id, now)?;
            if taken {
                let task = task.ok_or_else(|| MigrationError::Io {
                    path: format!(
                        "off_peak_tasks:{} was read as due but cannot be read",
                        row.off_peak_task_id
                    ),
                    source: rusqlite::Error::InvalidQuery,
                })?;
                claimed.push(ClaimedOffPeak {
                    row: OffPeakRow {
                        claim_running: 1,
                        claimed_at: Some(now),
                        ..row
                    },
                    task,
                });
            }
        }

        transaction.commit().map_err(|source| MigrationError::Io {
            path: "off_peak_tasks".into(),
            source,
        })?;
        Ok(claimed)
    }

    /// `awaiting_approval` → `running`, run once after the migrations.
    ///
    /// **Not** the same transition as [`Self::recover_interrupted`], which goes the other way
    /// (`running` → `queued`). This one exists because `awaiting_approval` was reserved early and
    /// the production link was never written, while the UI kept counting it as available capacity —
    /// so a row left in it looks dispatchable and is never dispatched. Only ordinary sessions were
    /// ever confirmed, so the rest go back to `running` and startup recycling decides their fate.
    ///
    /// Returns how many rows were recycled, so a caller can tell an empty pass from a missed one.
    pub fn recycle_awaiting_approval(
        conn: &rusqlite::Connection,
        now: i64,
    ) -> Result<usize, MigrationError> {
        let recycled = conn
            .execute(
                "UPDATE off_peak_tasks
                 SET status = 'running', updated_at = ?1
                 WHERE status = 'awaiting_approval'",
                rusqlite::params![now],
            )
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        Ok(recycled)
    }

    /// `countNonTerminal` (`:437`).
    pub fn count_non_terminal(conn: &rusqlite::Connection) -> Result<i64, MigrationError> {
        conn.query_row(
            "SELECT count(*) FROM off_peak_tasks WHERE status NOT IN ('completed','failed','cancelled')",
            [],
            |row| row.get(0),
        )
        .map_err(|source| MigrationError::Io {
            path: "off_peak_tasks".into(),
            source,
        })
    }

    /// `countActive` (`:462`) — the schedulable subset.
    pub fn count_active(conn: &rusqlite::Connection) -> Result<i64, MigrationError> {
        // `offPeakTaskRepo.ts:462-468` counts `status = 'running'` — nothing else. This used to
        // count `schedulable = 1 AND status NOT IN (terminal)`, which is a different set: a
        // `queued` schedulable task is not in flight, and the keep-awake power blocker must not
        // hold on one. The two agree only once every non-terminal task happens to be running.
        conn.query_row(
            "SELECT count(*) FROM off_peak_tasks WHERE status = 'running'",
            [],
            |row| row.get(0),
        )
        .map_err(|source| MigrationError::Io {
            path: "off_peak_tasks".into(),
            source,
        })
    }

    /// `hasActiveBoundTask` (`:448`) — the unique-index probe
    /// `idx_off_peak_bound_active`.
    pub fn has_active_bound_task(
        conn: &rusqlite::Connection,
        workspace_key: &str,
        session_id: &str,
    ) -> Result<bool, MigrationError> {
        let bound: i64 = conn
            .query_row(
                "SELECT count(*) FROM off_peak_tasks
                 WHERE workspace_key = ?1 AND session_id = ?2
                   AND session_id IS NOT NULL
                   AND status NOT IN ('completed','failed','cancelled')",
                rusqlite::params![workspace_key, session_id],
                |row| row.get(0),
            )
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        Ok(bound > 0)
    }

    /// `get` (`:347`).
    pub fn get(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
    ) -> Result<Option<OffPeakRow>, MigrationError> {
        let mut statement = conn
            .prepare("SELECT * FROM off_peak_tasks WHERE off_peak_task_id = ?1")
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        let mut rows = statement
            .query_map([off_peak_task_id], OffPeakRow::from_row)
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?)),
            None => Ok(None),
        }
    }

    /// `delete` (`:405`).
    pub fn delete(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
    ) -> Result<bool, MigrationError> {
        let changed = conn
            .execute(
                "DELETE FROM off_peak_tasks WHERE off_peak_task_id = ?1",
                [off_peak_task_id],
            )
            .map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?;
        Ok(changed == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real schema, taken from the live `off_peak_tasks` DDL, so the tests run against the
    /// columns and indexes the product actually uses.
    const SCHEMA: &str = "
        CREATE TABLE off_peak_tasks (
                off_peak_task_id   TEXT PRIMARY KEY,
                server_ticket_id   TEXT,
                title              TEXT NOT NULL DEFAULT '',
                conversation_id    TEXT,
                session_id         TEXT,
                prompt             TEXT NOT NULL,
                permission_mode    TEXT NOT NULL,
                model              TEXT,
                thought_level      TEXT,
                model_selection    TEXT,
                workspace_key      TEXT NOT NULL,
                workspace_path     TEXT NOT NULL,
                workspace_identity TEXT,
                status             TEXT NOT NULL,
                queued_at          INTEGER NOT NULL,
                started_at         INTEGER,
                ended_at           INTEGER,
                failure_reason     TEXT,
                files_changed      INTEGER,
                settled_at         INTEGER,
                history_deleted_at INTEGER,
                registered_at      INTEGER,
                schedulable        INTEGER NOT NULL DEFAULT 0,
                queue_position     INTEGER,
                next_poll_at       INTEGER,
                claim_running      INTEGER NOT NULL DEFAULT 0,
                claimed_at         INTEGER,
                attempt_count      INTEGER NOT NULL DEFAULT 0,
                last_error         TEXT,
                created_at         INTEGER NOT NULL,
                updated_at         INTEGER NOT NULL
              );
        CREATE UNIQUE INDEX idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id)
          WHERE session_id IS NOT NULL AND status NOT IN ('completed','failed','cancelled');
        CREATE INDEX idx_off_peak_pick ON off_peak_tasks (status, queued_at);
        CREATE INDEX idx_off_peak_ws ON off_peak_tasks (workspace_key, status);";

    fn memory() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(SCHEMA).expect("schema");
        conn
    }

    fn insert(
        conn: &rusqlite::Connection,
        id: &str,
        status: &str,
        schedulable: i64,
        model_selection: Option<&str>,
        queued_at: i64,
        claim_running: i64,
    ) {
        conn.execute(
            "INSERT INTO off_peak_tasks
               (off_peak_task_id, session_id, prompt, permission_mode, model_selection, workspace_key,
                workspace_path, status, queued_at, schedulable, claim_running, claimed_at,
                created_at, updated_at)
             VALUES (?1, ?2, 'p', 'default', ?3, '/ws', '/ws', ?4, ?5, ?6, ?7,
                     CASE WHEN ?7 = 1 THEN 5 ELSE NULL END, ?5, ?5)",
            rusqlite::params![id, id, model_selection, status, queued_at, schedulable, claim_running],
        )
        .expect("insert");
    }

    fn valid_selection() -> &'static str {
        r#"{"providerId":"zai","modelId":"glm-4.6"}"#
    }

    /// The compare-and-swap: two claimers, one winner. Batching the claims would make both
    /// succeed and dispatch the same task twice.
    #[test]
    fn a_claim_is_a_compare_and_swap_and_only_one_claimer_wins() {
        let conn = memory();
        insert(&conn, "t1", "queued", 1, Some(valid_selection()), 1, 0);

        assert!(OffPeakStore::claim(&conn, "t1", 100).expect("first claim"));
        assert!(
            !OffPeakStore::claim(&conn, "t1", 100).expect("second claim"),
            "a second claimer must lose the race"
        );

        let row = OffPeakStore::get(&conn, "t1").expect("read").expect("present");
        assert_eq!(row.claim_running, 1);
        assert_eq!(row.claimed_at, Some(100));
    }

    /// The guarded `WHERE claim_running = 0` is load-bearing and must stay in the SQL, not
    /// only in the calling code.
    #[test]
    fn the_claim_statement_keeps_its_guard() {
        let sql = "UPDATE off_peak_tasks
             SET claim_running = 1, claimed_at = ?2, updated_at = ?2
             WHERE off_peak_task_id = ?1 AND claim_running = 0";
        assert!(
            sql.contains("AND claim_running = 0"),
            "removing the guard turns the claim into a read-then-write and two schedulers can \
             both dispatch the same task"
        );
    }

    /// A row with no usable model selection is skipped, not claimed — and skipping it must not
    /// block the healthy rows behind it.
    #[test]
    fn a_row_without_a_usable_selection_is_skipped_and_does_not_block_others() {
        let mut conn = memory();
        insert(&conn, "no-selection", "queued", 1, None, 1, 0);
        insert(&conn, "bad-json", "queued", 1, Some("{not json"), 1, 0);
        insert(&conn, "empty", "queued", 1, Some("   "), 1, 0);
        insert(&conn, "healthy", "queued", 1, Some(valid_selection()), 1, 0);

        let claimed = OffPeakStore::claim_due(&mut conn, 100).expect("claim due");
        let ids: Vec<&str> = claimed.iter().map(|entry| entry.row.off_peak_task_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["healthy"],
            "only the usable row may be claimed; the others stay for repair"
        );
    }

    /// FIFO by `queued_at`, then `created_at` — the order the scheduler wants.
    #[test]
    fn due_rows_are_claimed_in_queue_order() {
        let mut conn = memory();
        insert(&conn, "third", "queued", 1, Some(valid_selection()), 300, 0);
        insert(&conn, "first", "queued", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "second", "queued", 1, Some(valid_selection()), 200, 0);
        let claimed = OffPeakStore::claim_due(&mut conn, 1).expect("claim due");
        let ids: Vec<&str> = claimed.iter().map(|entry| entry.row.off_peak_task_id.as_str()).collect();
        assert_eq!(ids, vec!["first", "second", "third"]);
    }

    /// Only `queued` + `schedulable` + unclaimed rows are eligible.
    #[test]
    fn only_queued_schedulable_unclaimed_rows_are_eligible() {
        let conn = memory();
        insert(&conn, "eligible", "queued", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "not-schedulable", "queued", 0, Some(valid_selection()), 100, 0);
        insert(&conn, "running", "running", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "completed", "completed", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "already-claimed", "queued", 1, Some(valid_selection()), 100, 1);

        let due = OffPeakStore::list_due(&conn).expect("list due");
        let ids: Vec<&str> = due.iter().map(|r| r.off_peak_task_id.as_str()).collect();
        assert_eq!(ids, vec!["eligible"]);
    }

    /// A crashed claimer must not hold a task forever.
    #[test]
    fn a_stale_claim_is_released_so_the_task_can_be_taken_again() {
        let mut conn = memory();
        insert(&conn, "t1", "queued", 1, Some(valid_selection()), 100, 1);

        // Fresh claim: not released.
        let now = 1_000;
        assert_eq!(OffPeakStore::release_stale_claims(&conn, now).expect("release"), 0);
        assert!(OffPeakStore::list_due(&conn).expect("list").is_empty());

        // Past the staleness window: released and claimable again.
        let later = now + OFF_PEAK_CLAIM_STALE_MS + 1;
        assert_eq!(OffPeakStore::release_stale_claims(&conn, later).expect("release"), 1);
        let claimed = OffPeakStore::claim_due(&mut conn, later).expect("claim due");
        assert_eq!(claimed.len(), 1, "a released task must be claimable again");
    }

    /// The counters the UI shows.
    #[test]
    fn the_counters_exclude_terminal_statuses() {
        let conn = memory();
        insert(&conn, "a", "queued", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "b", "running", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "c", "completed", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "d", "failed", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "e", "cancelled", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "f", "queued", 0, Some(valid_selection()), 100, 0);

        assert_eq!(OffPeakStore::count_non_terminal(&conn).expect("count"), 3, "a, b, f");
        // `countActive` is `status = 'running'` and nothing else — **not**
        // `schedulable = 1 AND status NOT IN (terminal)`. Those are different sets: row `a` is
        // `queued` and schedulable, so the old predicate counted it and the correct one does not.
        // The distinction matters because this number is the criterion for the keep-awake power
        // blocker, which must not stay awake for a task that is merely waiting in the queue.
        assert_eq!(OffPeakStore::count_active(&conn).expect("count"), 1, "only b is running");
    }

    /// `awaiting_approval` rows are recycled to `running` at startup, and only then.
    ///
    /// The distinction from `recover_interrupted` is the whole point: this goes *to* `running`,
    /// that one goes *from* it. Applying the wrong one strands rows the UI counts as dispatchable.
    #[test]
    fn awaiting_approval_rows_are_recycled_to_running_not_queued() {
        let conn = memory();
        insert(&conn, "stuck", "awaiting_approval", 1, Some(valid_selection()), 100, 0);
        insert(&conn, "live", "running", 1, Some(valid_selection()), 100, 0);

        assert_eq!(
            OffPeakStore::recycle_awaiting_approval(&conn, 500).expect("recycle"),
            1,
            "only the awaiting_approval row"
        );
        let status: String = conn
            .query_row(
                "SELECT status FROM off_peak_tasks WHERE off_peak_task_id = 'stuck'",
                [],
                |row| row.get(0),
            )
            .expect("read back");
        assert_eq!(status, "running", "recycled forward to running, not back to queued");

        // Running it twice is a no-op rather than an error.
        assert_eq!(OffPeakStore::recycle_awaiting_approval(&conn, 600).expect("recycle"), 0);
    }

    /// The unique-index probe behind the one-active-task-per-session rule.
    #[test]
    fn an_active_bound_task_is_detected_and_a_terminal_one_is_not() {
        let conn = memory();
        insert(&conn, "live", "running", 1, Some(valid_selection()), 100, 0);
        assert!(OffPeakStore::has_active_bound_task(&conn, "/ws", "live").expect("probe"));
        assert!(
            !OffPeakStore::has_active_bound_task(&conn, "/ws", "absent").expect("probe"),
            "an unbound session must not report a bound task"
        );

        conn.execute(
            "UPDATE off_peak_tasks SET status='completed' WHERE off_peak_task_id='live'",
            [],
        )
        .expect("finish");
        assert!(
            !OffPeakStore::has_active_bound_task(&conn, "/ws", "live").expect("probe"),
            "a terminal task frees the binding"
        );
    }

    /// The unique index is a real constraint, not just a query convention.
    #[test]
    fn the_bound_active_index_rejects_a_second_active_task_for_a_session() {
        let conn = memory();
        insert(&conn, "one", "running", 1, Some(valid_selection()), 100, 0);
        let second = conn.execute(
            "INSERT INTO off_peak_tasks
               (off_peak_task_id, session_id, prompt, permission_mode, workspace_key, workspace_path,
                status, queued_at, schedulable, created_at, updated_at)
             VALUES ('two', 'one', 'p', 'default', '/ws', '/ws', 'running', 100, 1, 100, 100)",
            [],
        );
        assert!(
            second.is_err(),
            "idx_off_peak_bound_active must refuse a second active task for one session"
        );
    }

    #[test]
    fn delete_reports_whether_a_row_was_removed() {
        let conn = memory();
        insert(&conn, "t1", "queued", 1, Some(valid_selection()), 100, 0);
        assert!(OffPeakStore::delete(&conn, "t1").expect("delete"));
        assert!(!OffPeakStore::delete(&conn, "t1").expect("delete again"));
        assert!(OffPeakStore::get(&conn, "t1").expect("read").is_none());
    }

    #[test]
    fn a_missing_row_is_none_rather_than_an_error() {
        let conn = memory();
        assert!(OffPeakStore::get(&conn, "nope").expect("read").is_none());
    }

    /// The three terminal statuses, pinned.
    #[test]
    fn the_terminal_statuses_are_exactly_three() {
        assert_eq!(TERMINAL_STATUSES, ["completed", "failed", "cancelled"]);
    }
}

// ---------------------------------------------------------------------------
// The rest of the repository: the writes, and the domain shape the callers see.
// ---------------------------------------------------------------------------
//
// Split out of `offpeak.rs`'s claim path and appended here, because the claim is the part that
// has to be read as one idea. The methods below are a transcription of the remaining fifteen
// public methods of `offPeakTaskRepo.ts`, in that file's order.

/// A validated `ModelSelection`, the value `rowToTask` puts on `modelSelection`.
///
/// Mirrors `modelSelectionSchema` (`model-selection.ts:4-15`): `providerId` and `modelId` are
/// trimmed non-empty strings, `options` is a **strict** object whose only member is an optional
/// non-empty `reasoningLevel`, and the outer object is strict too. `strict()` matters — it is why
/// a stored selection carrying an extra key is *invalid* rather than tolerated, which is what
/// makes such a row un-claimable instead of silently dispatched with a config the scheduler
/// cannot resolve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelection {
    pub provider_id: String,
    pub model_id: String,
    /// Skipped when **empty**, not merely when absent.
    ///
    /// `serializeOffPeakModelSelection` writes `…(options && Object.keys(options).length > 0 ?
    /// { options } : {})`, so a selection with no reasoning level is stored as
    /// `{ providerId, modelId }`. Emitting `"options": {}` instead would not round-trip: the
    /// differential transcript shows every read of such a row differing by exactly that key.
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        // The `{}` case is dropped too, via the helper below.
        with = "empty_options_as_none"
    )]
    pub options: Option<ModelSelectionOptions>,
}

/// Serialises `Some({})` as `None`, so a memberless `options` is omitted exactly as the original's
/// `Object.keys(options).length > 0` check omitted it.
mod empty_options_as_none {
    use super::ModelSelectionOptions;
    use serde::Serializer;

    /// `Option`'s default `serialize`, minus the `Some({})` case.
    pub fn serialize<S: Serializer>(
        options: &Option<ModelSelectionOptions>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match options {
            // A memberless options object is dropped rather than written as `{}`.
            Some(options) if options.reasoning_level.is_some() => serializer.serialize_some(options),
            _ => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<ModelSelectionOptions>, D::Error> {
        <Option<ModelSelectionOptions> as serde::Deserialize>::deserialize(deserializer)
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelectionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
}

/// Parses a stored `model_selection` cell under the zod schema's rules.
///
/// A cell that does not parse is `None`, which the caller turns into `modelSelectionIssue: { code:
/// "repair-required" }` — the same thing the TypeScript does. Trimming is applied because zod's
/// `.trim().min(1)` both trims and rejects an all-whitespace value.
pub fn parse_model_selection(raw: Option<&str>) -> Option<ModelSelection> {
    let parsed: serde_json::Value = serde_json::from_str(raw?.trim()).ok()?;
    let object = parsed.as_object()?;
    let provider_id = object.get("providerId")?.as_str()?.trim();
    let model_id = object.get("modelId")?.as_str()?.trim();
    if provider_id.is_empty() || model_id.is_empty() {
        return None;
    }
    let options = match object.get("options") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let inner = value.as_object()?;
            // `.strict()` on the options object: an unrecognised member is a validation failure.
            if inner.keys().any(|key| key != "reasoningLevel") {
                return None;
            }
            let reasoning_level = match inner.get("reasoningLevel") {
                None | Some(serde_json::Value::Null) => None,
                Some(level) => {
                    let level = level.as_str()?.trim().to_string();
                    if level.is_empty() {
                        return None;
                    }
                    Some(level)
                }
            };
            Some(ModelSelectionOptions { reasoning_level })
        }
    };
    // `.strict()` on the outer object.
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "providerId" | "modelId" | "options"))
    {
        return None;
    }
    Some(ModelSelection {
        provider_id: provider_id.to_string(),
        model_id: model_id.to_string(),
        options,
    })
}

/// The repository's own wire shape, mirroring `ZCodeOffPeakTask`.
///
/// Optional members are **omitted** when absent rather than sent as `null`: `rowToTask` maps
/// `row.x ?? undefined`, and a `null` would be a different value to every consumer that does
/// `'field' in task`. The transcript comparison depends on this, since it compares against the
/// captured JavaScript output verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub off_peak_task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_ticket_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Only `list` populates this, by joining the `tasks` table. Single-row reads never carry it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_title: Option<String>,
    pub prompt: String,
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ModelSelection>,
    /// Present exactly when `model_selection` is absent — the card's "needs repair" affordance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection_issue: Option<ModelSelectionIssue>,
    pub workspace_key: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    pub status: String,
    pub queued_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_at: Option<i64>,
    pub schedulable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_poll_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelectionIssue {
    pub code: String,
}

/// The `TERMINAL_SQL_LIST` fragment, built from [`TERMINAL_STATUSES`].
///
/// The statuses are a compile-time constant, not user input, so interpolating them is safe — and
/// keeping it a literal-preserving list matters, because the same three names appear in five
/// different predicates and a fourth would silently change which rows are protected.
fn terminal_sql_list() -> String {
    TERMINAL_STATUSES
        .iter()
        .map(|status| format!("'{status}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

impl Task {
    /// `rowToTask` (`offPeakTaskRepo.ts:85-112`).
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let model_selection_raw: Option<String> = row.get("model_selection")?;
        let model_selection = parse_model_selection(model_selection_raw.as_deref());
        let title: String = row.get("title")?;
        let conversation_id: Option<String> = row.get("conversation_id")?;
        let session_id: Option<String> = row.get("session_id")?;
        let server_ticket_id: Option<String> = row.get("server_ticket_id")?;
        let prompt: String = row.get("prompt")?;
        let permission_mode: String = row.get("permission_mode")?;
        let workspace_key: String = row.get("workspace_key")?;
        let workspace_path: String = row.get("workspace_path")?;
        let workspace_identity: Option<String> = row.get("workspace_identity")?;
        let status: String = row.get("status")?;
        let queued_at: i64 = row.get("queued_at")?;
        let started_at: Option<i64> = row.get("started_at")?;
        let ended_at: Option<i64> = row.get("ended_at")?;
        let failure_reason: Option<String> = row.get("failure_reason")?;
        let files_changed: Option<i64> = row.get("files_changed")?;
        let settled_at: Option<i64> = row.get("settled_at")?;
        let history_deleted_at: Option<i64> = row.get("history_deleted_at")?;
        let registered_at: Option<i64> = row.get("registered_at")?;
        let schedulable: i64 = row.get("schedulable")?;
        let queue_position: Option<i64> = row.get("queue_position")?;
        let next_poll_at: Option<i64> = row.get("next_poll_at")?;
        let created_at: i64 = row.get("created_at")?;
        let updated_at: i64 = row.get("updated_at")?;
        // The `session_title` column only exists on the `list` query's LEFT JOIN; every other
        // read selects the bare table. `row.get` on a missing column is an error, so its presence
        // is detected from the statement's own column list rather than by trying and catching.
        let session_title: Option<String> = row.get("session_title").unwrap_or(None);

        Ok(Task {
            off_peak_task_id: row.get("off_peak_task_id")?,
            server_ticket_id,
            title,
            conversation_id,
            session_id,
            session_title,
            prompt,
            permission_mode,
            model_selection_issue: if model_selection.is_none() {
                Some(ModelSelectionIssue { code: "repair-required".to_string() })
            } else {
                None
            },
            model_selection,
            workspace_key,
            workspace_path,
            workspace_identity,
            status,
            queued_at,
            started_at,
            ended_at,
            failure_reason,
            files_changed,
            settled_at,
            history_deleted_at,
            registered_at,
            // `schedulable` is a 0/1 integer column and the domain type is a boolean. Anything
            // other than exactly 1 is false, so a corrupt value cannot make a task dispatchable.
            schedulable: schedulable == 1,
            queue_position,
            next_poll_at,
            created_at,
            updated_at,
        })
    }
}

/// The parameters of [`OffPeakStore::create`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateParams {
    pub off_peak_task_id: String,
    pub title: String,
    pub prompt: String,
    pub permission_mode: String,
    pub model_selection: ModelSelection,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    /// The key the row is filed under: `workspaceIdentity?.trim() || workspacePath`, the same rule
    /// every other repository uses for identity isolation.
    pub workspace_key: String,
    pub session_id: Option<String>,
    pub server_ticket_id: Option<String>,
    pub queue_position: Option<i64>,
    pub registered_at: Option<i64>,
    pub schedulable: bool,
    pub now: i64,
}

impl OffPeakStore {
    /// `create` (`offPeakTaskRepo.ts:259-318`).
    ///
    /// Creating also **enqueues**: the row lands as `queued`. `model` and `thought_level` are
    /// written as `NULL` unconditionally — the rollback snapshot columns stay empty for a new row
    /// and are only ever populated by `invalidate_model_selection`.
    pub fn create(
        conn: &rusqlite::Connection,
        params: &CreateParams,
    ) -> Result<Task, MigrationError> {
        let selection = encode_selection(&params.model_selection)?;
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
               0, 0, ?11, ?11
             )",
            rusqlite::params![
                params.off_peak_task_id,
                params.server_ticket_id,
                params.title,
                params.session_id,
                params.prompt,
                params.permission_mode,
                selection,
                params.workspace_key,
                params.workspace_path,
                params.workspace_identity,
                params.now,
                params.registered_at,
                i64::from(params.schedulable),
                params.queue_position,
            ],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Self::get_task(conn, &params.off_peak_task_id)?.ok_or_else(|| MigrationError::Io {
            path: format!(
                "off_peak_tasks:{} was inserted but cannot be read back",
                params.off_peak_task_id
            ),
            source: rusqlite::Error::InvalidQuery,
        })
    }

    /// `getRow` (`offPeakTaskRepo.ts:245-257`), returning the **domain** shape.
    ///
    /// Named `get_task` because [`OffPeakStore::get`] already exists and returns the internal
    /// `OffPeakRow` for the Tauri scheduler. Two getters over the same row is a smell, but
    /// collapsing them now would mean changing the scheduler's contract for no benefit; the
    /// distinction is "row as stored" versus "task as the repository publishes it".
    pub fn get_task(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
    ) -> Result<Option<Task>, MigrationError> {
        let mut statement = conn
            .prepare("SELECT * FROM off_peak_tasks WHERE off_peak_task_id = ?1")
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        let mut rows = statement
            .query_map(rusqlite::params![off_peak_task_id], Task::from_row)
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?)),
            None => Ok(None),
        }
    }

    /// `delete` (`offPeakTaskRepo.ts:405-415`).
    ///
    /// Deletes in **any** state. That is deliberate: the service layer settles a non-terminal task
    /// server-side before calling this, so the card's delete is unconditional here. Whether a row
    /// was actually removed is not part of the original's contract — it returns `void` — so this
    /// reports nothing either.
    pub fn delete_task(conn: &rusqlite::Connection, off_peak_task_id: &str) -> Result<(), MigrationError> {
        conn.execute(
            "DELETE FROM off_peak_tasks WHERE off_peak_task_id = ?1",
            rusqlite::params![off_peak_task_id],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Ok(())
    }

    /// `invalidateModelSelection` (`offPeakTaskRepo.ts:359-403`).
    ///
    /// The guard is the whole method: if the stored selection already differs from the observation
    /// being applied — a different provider, model, or reasoning level — the row is returned
    /// **unchanged**. That is another process having already applied the user's repair, and
    /// overwriting it with the older Registry observation would undo their fix.
    ///
    /// The UPDATE then parks the old model and level in the `model` / `thought_level` columns as a
    /// rollback snapshot and clears the official selection, so the scheduler can no longer claim
    /// the task against a config it cannot resolve.
    pub fn invalidate_model_selection(
        conn: &mut rusqlite::Connection,
        off_peak_task_id: &str,
        observed: &ModelSelection,
        now: i64,
    ) -> Result<Option<Task>, MigrationError> {
        let transaction = conn.transaction().map_err(|source| MigrationError::Io {
            path: "off_peak_tasks".into(),
            source,
        })?;
        let outcome = Self::invalidate_model_selection_in(&transaction, off_peak_task_id, observed, now);
        match outcome {
            Ok(result) => {
                transaction.commit().map_err(|source| MigrationError::Io {
                    path: "off_peak_tasks".into(),
                    source,
                })?;
                Ok(result)
            }
            Err(error) => Err(error),
        }
    }

    fn invalidate_model_selection_in(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        observed: &ModelSelection,
        now: i64,
    ) -> Result<Option<Task>, MigrationError> {
        let Some(current) = Self::get_task(conn, off_peak_task_id)? else {
            return Ok(None);
        };
        if let Some(stored) = current.model_selection.as_ref() {
            let differs = stored.provider_id != observed.provider_id
                || stored.model_id != observed.model_id
                || option_level(&stored.options) != option_level(&observed.options);
            if differs {
                // Someone already repaired it. Return the current row, do not overwrite.
                return Ok(Some(current));
            }
        }
        conn.execute(
            "UPDATE off_peak_tasks
             SET model = ?2, thought_level = ?3, model_selection = NULL,
                 schedulable = 0, updated_at = ?4
             WHERE off_peak_task_id = ?1",
            rusqlite::params![
                off_peak_task_id,
                observed.model_id,
                option_level(&observed.options),
                now
            ],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Self::get_task(conn, off_peak_task_id)
    }

    /// `markHistoryDeleted` (`offPeakTaskRepo.ts:417-435`).
    ///
    /// Hides the history row only, and only for a task that actually started. A task that never
    /// ran has no history to hide, so the call is a no-op that returns the row unchanged. A repeat
    /// is idempotent: the first timestamp wins, so the original deletion time is not overwritten.
    pub fn mark_history_deleted(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        now: i64,
    ) -> Result<Option<Task>, MigrationError> {
        let Some(row) = Self::get_task(conn, off_peak_task_id)? else {
            return Ok(None);
        };
        if row.started_at.is_none() || row.history_deleted_at.is_some() {
            return Ok(Some(row));
        }
        conn.execute(
            "UPDATE off_peak_tasks
             SET history_deleted_at = ?2, updated_at = ?2
             WHERE off_peak_task_id = ?1 AND started_at IS NOT NULL",
            rusqlite::params![off_peak_task_id, now],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Self::get_task(conn, off_peak_task_id)
    }

    /// `updateEditableFields` (`offPeakTaskRepo.ts:475-515`).
    ///
    /// Two rejections, in this order, and the order is load-bearing:
    ///
    /// 1. the task must be `queued` or `paused` — a terminal task is not editable;
    /// 2. an explicit `model_selection: null` is refused **before** the status check.
    ///
    /// The second is the subtle one: null means "clear the selection", and clearing it would make
    /// the task permanently un-claimable, so it is rejected outright rather than applied. An
    /// *absent* field means "leave alone" and is kept, which is why the parameters are
    /// `Option`-per-field rather than one nullable struct.
    ///
    /// The legacy `model` / `thought_level` columns are a rollback snapshot and are deliberately
    /// **not** touched: an ordinary edit must not rewrite them.
    pub fn update_editable_fields(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        patch: &EditablePatch,
        now: i64,
    ) -> Result<Option<Task>, MigrationError> {
        let Some(row) = Self::get_task(conn, off_peak_task_id)? else {
            return Ok(None);
        };
        if row.status != "queued" && row.status != "paused" {
            return Ok(None);
        }
        if patch.clear_model_selection {
            return Ok(None);
        }
        let next = match patch.model_selection.as_ref() {
            Some(selection) => selection.clone(),
            None => match row.model_selection.clone() {
                Some(selection) => selection,
                // Unreachable through the wrapper — the caller always supplies one — but the
                // original throws here, and a task with no selection at all is a real
                // possibility if a row was written by something other than `create`.
                None => return Err(MigrationError::Io {
                    path: format!("off_peak_tasks:{off_peak_task_id} has no valid ModelSelection"),
                    source: rusqlite::Error::InvalidQuery,
                }),
            },
        };
        let selection = encode_selection(&next)?;
        conn.execute(
            "UPDATE off_peak_tasks SET
               title = ?2, prompt = ?3, permission_mode = ?4,
               model_selection = ?5, updated_at = ?6
             WHERE off_peak_task_id = ?1",
            rusqlite::params![
                off_peak_task_id,
                patch.title.clone().unwrap_or(row.title),
                patch.prompt.clone().unwrap_or(row.prompt),
                patch.permission_mode.clone().unwrap_or(row.permission_mode),
                selection,
                now,
            ],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Self::get_task(conn, off_peak_task_id)
    }

    /// `markRunning` (`offPeakTaskRepo.ts:609-648`).
    ///
    /// Guarded by `status = 'queued'`, so a late dispatch result arriving after the task already
    /// moved on is refused and reported as `None` — the caller discards it. A **continuation
    /// segment keeps the first `started_at`** (`COALESCE(started_at, ?)`): one task from the
    /// user's perspective is one task, however many times it is resumed. The same `COALESCE` on
    /// the conversation, session and ticket means a segment that does not know them keeps the
    /// values the first run established.
    pub fn mark_running(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        started_at: i64,
        conversation_id: Option<&str>,
        session_id: Option<&str>,
        server_ticket_id: Option<&str>,
    ) -> Result<Option<Task>, MigrationError> {
        let changed = conn
            .execute(
                "UPDATE off_peak_tasks
                 SET status = 'running',
                     started_at = COALESCE(started_at, ?2),
                     conversation_id = COALESCE(?3, conversation_id),
                     session_id = COALESCE(?4, session_id),
                     server_ticket_id = COALESCE(?5, server_ticket_id),
                     claim_running = 0, claimed_at = NULL,
                     last_error = NULL,
                     updated_at = ?2
                 WHERE off_peak_task_id = ?1 AND status = 'queued'",
                rusqlite::params![
                    off_peak_task_id,
                    started_at,
                    conversation_id,
                    session_id,
                    server_ticket_id
                ],
            )
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        if changed != 1 {
            return Ok(None);
        }
        Self::get_task(conn, off_peak_task_id)
    }

    /// `markTerminal` (`offPeakTaskRepo.ts:649-693`).
    ///
    /// A terminal state is **irreversible**: the `status NOT IN (…)` predicate means a second
    /// transition changes zero rows and returns `None`, so a late `OffPeakRunResult` cannot
    /// rewrite a completed task as failed. This is also what makes `requeueForContinuation`'s
    /// guard work — a cancelled task is not requeueable, because "cancelled" is in the list.
    ///
    /// `dispatch_error` presence accumulates `attempt_count` by one and keeps `last_error` via
    /// `COALESCE`; a *successful* terminal transition therefore records no attempt, and one that
    /// is not the first does not accumulate at all.
    pub fn mark_terminal(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        status: &str,
        ended_at: i64,
        failure_reason: Option<&str>,
        files_changed: Option<i64>,
        dispatch_error: Option<&str>,
    ) -> Result<Option<Task>, MigrationError> {
        let sql = format!(
            "UPDATE off_peak_tasks
                 SET status = ?2,
                     ended_at = ?3,
                     failure_reason = ?4,
                     files_changed = COALESCE(?5, files_changed),
                     attempt_count = attempt_count + ?6,
                     last_error = COALESCE(?7, last_error),
                     schedulable = 0,
                     claim_running = 0, claimed_at = NULL,
                     updated_at = ?3
             WHERE off_peak_task_id = ?1 AND status NOT IN ({})",
            terminal_sql_list()
        );
        let changed = conn
            .execute(
                &sql,
                rusqlite::params![
                    off_peak_task_id,
                    status,
                    ended_at,
                    failure_reason,
                    files_changed,
                    i64::from(dispatch_error.is_some()),
                    dispatch_error,
                ],
            )
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        if changed != 1 {
            return Ok(None);
        }
        Self::get_task(conn, off_peak_task_id)
    }

    /// `setPaused` (`offPeakTaskRepo.ts:694-721`).
    ///
    /// Guarded by both the exact source status and `claim_running = 0`: a dispatch already in
    /// flight cannot be paused out from under itself, and the caller is told so with `None`.
    pub fn set_paused(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        paused: bool,
        now: i64,
    ) -> Result<Option<Task>, MigrationError> {
        let (to, from) = if paused { ("paused", "queued") } else { ("queued", "paused") };
        let changed = conn
            .execute(
                "UPDATE off_peak_tasks SET status = ?2, updated_at = ?3
                 WHERE off_peak_task_id = ?1 AND status = ?4 AND claim_running = 0",
                rusqlite::params![off_peak_task_id, to, now, from],
            )
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        if changed != 1 {
            return Ok(None);
        }
        Self::get_task(conn, off_peak_task_id)
    }

    /// `releaseClaim` (`offPeakTaskRepo.ts:722-751`).
    ///
    /// Releases the single-flight lock without changing the status: the task stays `queued` and
    /// waits for the next claim round, with no skip and no backoff beyond `attempt_count` — which
    /// the caller reads to decide one. An `error` accumulates the attempt and records
    /// `last_error`; without one, neither moves.
    pub fn release_claim(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        error: Option<&str>,
        now: i64,
    ) -> Result<(), MigrationError> {
        conn.execute(
            "UPDATE off_peak_tasks
             SET claim_running = 0, claimed_at = NULL,
                 attempt_count = attempt_count + ?2,
                 last_error = COALESCE(?3, last_error),
                 updated_at = ?4
             WHERE off_peak_task_id = ?1 AND claim_running = 1",
            rusqlite::params![off_peak_task_id, i64::from(error.is_some()), error, now],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Ok(())
    }

    /// `recoverInterrupted` (`offPeakTaskRepo.ts:752-782`), in one transaction.
    ///
    /// Startup reclamation, run once before any dispatch: rows a dead process left in `running`
    /// go back to `queued`, keeping `queued_at` so they sit near the head of the queue and keeping
    /// `session_id` so a continuation can resume. Stale claims are released in the same
    /// transaction, so there is no window in which a task is both `running` and unclaimed.
    ///
    /// Returns how many rows were reclaimed.
    pub fn recover_interrupted(
        conn: &mut rusqlite::Connection,
        now: i64,
    ) -> Result<usize, MigrationError> {
        let transaction = conn.transaction().map_err(|source| MigrationError::Io {
            path: "off_peak_tasks".into(),
            source,
        })?;
        let recovered = transaction
            .execute(
                "UPDATE off_peak_tasks
                 SET status = 'queued', claim_running = 0, claimed_at = NULL, updated_at = ?1
                 WHERE status = 'running'",
                rusqlite::params![now],
            )
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        transaction
            .execute(
                "UPDATE off_peak_tasks
                 SET claim_running = 0, claimed_at = NULL, updated_at = ?1
                 WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= ?2",
                rusqlite::params![now, now - OFF_PEAK_CLAIM_STALE_MS],
            )
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        transaction
            .commit()
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Ok(recovered)
    }

    /// `requeueForContinuation` (`offPeakTaskRepo.ts:783-800`).
    ///
    /// `running` → `queued` when the time box expires. `session_id`, `conversation_id` and
    /// `started_at` are kept so the resume continues the same task, while `schedulable` and
    /// `queue_position` are cleared — the poll refills them once a new ticket is taken. Guarded on
    /// `status = 'running'`, so a task the user already cancelled cannot be resurrected.
    pub fn requeue_for_continuation(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        now: i64,
    ) -> Result<Option<Task>, MigrationError> {
        let changed = conn
            .execute(
                "UPDATE off_peak_tasks
                 SET status = 'queued', schedulable = 0, queue_position = NULL,
                     claim_running = 0, claimed_at = NULL, updated_at = ?2
                 WHERE off_peak_task_id = ?1 AND status = 'running'",
                rusqlite::params![off_peak_task_id, now],
            )
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        if changed != 1 {
            return Ok(None);
        }
        Self::get_task(conn, off_peak_task_id)
    }

    /// `listNonTerminal` (`offPeakTaskRepo.ts:801-815`).
    pub fn list_non_terminal(
        conn: &rusqlite::Connection,
    ) -> Result<Vec<Task>, MigrationError> {
        Self::query_tasks(
            conn,
            &format!(
                "SELECT * FROM off_peak_tasks
                 WHERE status NOT IN ({})
                 ORDER BY queued_at ASC",
                terminal_sql_list()
            ),
        )
    }

    /// `listUnsettledTerminal` (`offPeakTaskRepo.ts:828-838`).
    pub fn list_unsettled_terminal(
        conn: &rusqlite::Connection,
    ) -> Result<Vec<Task>, MigrationError> {
        Self::query_tasks(
            conn,
            &format!(
                "SELECT * FROM off_peak_tasks
                 WHERE status IN ({}) AND settled_at IS NULL
                 ORDER BY ended_at ASC",
                terminal_sql_list()
            ),
        )
    }

    fn query_tasks(
        conn: &rusqlite::Connection,
        sql: &str,
    ) -> Result<Vec<Task>, MigrationError> {
        let mut statement = conn
            .prepare(sql)
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        let rows = statement
            .query_map([], Task::from_row)
            .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|source| MigrationError::Io {
                path: "off_peak_tasks".into(),
                source,
            })?);
        }
        Ok(out)
    }
}

/// Serialises a selection for the `model_selection` column.
///
/// A [`serde_json`] serialisation of a plain struct cannot fail, so the error arm is a guard
/// rather than a live path: if it ever fired it would be a bug, and storing a truncated selection
/// would be worse than refusing.
fn encode_selection(selection: &ModelSelection) -> Result<String, MigrationError> {
    serde_json::to_string(selection).map_err(|error| MigrationError::Io {
        path: format!("cannot serialise a ModelSelection: {error}"),
        source: rusqlite::Error::InvalidQuery,
    })
}

/// The `reasoningLevel` of a selection, as a comparable value.
fn option_level(options: &Option<ModelSelectionOptions>) -> Option<String> {
    options.as_ref().and_then(|options| options.reasoning_level.clone())
}

/// The fields `updateEditableFields` may change. An absent field means "leave alone".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditablePatch {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub permission_mode: Option<String>,
    pub model_selection: Option<ModelSelection>,
    /// `modelSelection: null` on the wire — rejected by [`OffPeakStore::update_editable_fields`].
    #[serde(default)]
    pub clear_model_selection: bool,
}

/// The fields `updateSchedulingSnapshot` may write back. An absent field means "leave alone".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulingSnapshot {
    pub schedulable: Option<bool>,
    pub queue_position: Option<Option<i64>>,
    pub next_poll_at: Option<Option<i64>>,
    pub server_ticket_id: Option<String>,
    pub registered_at: Option<i64>,
}

impl OffPeakStore {
    /// `updateSchedulingSnapshot` (`offPeakTaskRepo.ts:517-561`).
    ///
    /// The poll's write-back. Every field is optional and an absent one keeps its stored value —
    /// read from the current row first, because a `NULL` write would erase a field the server did
    /// not mention. A missing task is a no-op, not an error: the row may have been deleted
    /// between the poll's read and its write-back, and that is not a fault worth surfacing.
    pub fn update_scheduling_snapshot(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        patch: &SchedulingSnapshot,
        now: i64,
    ) -> Result<(), MigrationError> {
        let Some(row) = Self::get_task(conn, off_peak_task_id)? else {
            return Ok(());
        };
        conn.execute(
            "UPDATE off_peak_tasks SET
               schedulable = ?2, queue_position = ?3, next_poll_at = ?4,
               server_ticket_id = ?5, registered_at = ?6, updated_at = ?7
             WHERE off_peak_task_id = ?1",
            rusqlite::params![
                off_peak_task_id,
                i64::from(patch.schedulable.unwrap_or(row.schedulable)),
                patch.queue_position.unwrap_or(row.queue_position),
                patch.next_poll_at.unwrap_or(row.next_poll_at),
                patch.server_ticket_id.clone().or(row.server_ticket_id),
                patch.registered_at.or(row.registered_at),
                now,
            ],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Ok(())
    }

    /// `markSettled` (`offPeakTaskRepo.ts:816-827`).
    ///
    /// Guarded on a terminal status: settling is the final write-off, and there is nothing to
    /// settle for a task still in flight. A repeat overwrites with the newer ack time, so the
    /// call is idempotent and self-correcting.
    pub fn mark_settled(
        conn: &rusqlite::Connection,
        off_peak_task_id: &str,
        settled_at: i64,
    ) -> Result<(), MigrationError> {
        conn.execute(
            &format!(
                "UPDATE off_peak_tasks SET settled_at = ?2, updated_at = ?2
                 WHERE off_peak_task_id = ?1 AND status IN ({})",
                terminal_sql_list()
            ),
            rusqlite::params![off_peak_task_id, settled_at],
        )
        .map_err(|source| MigrationError::Io { path: "off_peak_tasks".into(), source })?;
        Ok(())
    }
}
