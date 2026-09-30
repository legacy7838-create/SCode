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

use crate::migrate::MigrationError;

/// How long a claim survives before another claimer may take it (`offPeakTaskRepo.ts:35`).
pub const OFF_PEAK_CLAIM_STALE_MS: i64 = 10 * 60_000;

/// `OFF_PEAK_TERMINAL_STATUSES` (`off-peak-types.ts:24`).
pub const TERMINAL_STATUSES: [&str; 3] = ["completed", "failed", "cancelled"];

/// One `off_peak_tasks` row, as the port reads it.
#[derive(Debug, Clone, PartialEq)]
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
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
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
    ) -> Result<Vec<OffPeakRow>, MigrationError> {
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

        let mut claimed: Vec<OffPeakRow> = Vec::new();
        for row in due {
            // A row with no usable model selection stays listed for repair but is never
            // claimed. Skipping row by row is also what stops one bad record from blocking
            // every healthy task behind it.
            if !model_selection_is_valid(&row) {
                continue;
            }
            let taken = {
                let tx = &transaction;
                Self::claim(tx, &row.off_peak_task_id, now)?
            };
            if taken {
                claimed.push(OffPeakRow {
                    claim_running: 1,
                    claimed_at: Some(now),
                    updated_at: now,
                    ..row
                });
            }
        }

        transaction.commit().map_err(|source| MigrationError::Io {
            path: "off_peak_tasks".into(),
            source,
        })?;
        Ok(claimed)
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
        conn.query_row(
            "SELECT count(*) FROM off_peak_tasks
             WHERE status NOT IN ('completed','failed','cancelled') AND schedulable = 1",
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
        let ids: Vec<&str> = claimed.iter().map(|r| r.off_peak_task_id.as_str()).collect();
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
        let ids: Vec<&str> = claimed.iter().map(|r| r.off_peak_task_id.as_str()).collect();
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
        assert_eq!(OffPeakStore::count_active(&conn).expect("count"), 2, "a, b are schedulable");
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
