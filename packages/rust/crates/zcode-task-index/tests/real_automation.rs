//! The automation facade against a copy of the real database.
//!
//! Spec: docs/specs/rust-native-task-index.md §4.5 step 4.
//!
//! This is the last `node:sqlite` user of `tasks-index.sqlite`, so it is the step that lets
//! the crate own the file. It runs against a copy of the live database because the unit tests
//! use a hand-transcribed schema, which is exactly what drifts.
//!
//! Everything writes to a copy.

use std::path::{Path, PathBuf};

use zcode_task_index::automation::{
    build_run_id, resolve_scheduled_at, AutomationRow, AutomationStore, CLAIM_STALE_MS,
};

fn real_database() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = Path::new(&home).join(".zcode/v2/tasks-index.sqlite");
    path.is_file().then_some(path)
}

fn copy_of_real_database(tag: &str) -> Option<PathBuf> {
    let source = real_database()?;
    let dir = std::env::temp_dir().join(format!("zcode-task-index-automation-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let destination = dir.join("tasks-index.sqlite");
    std::fs::copy(&source, &destination).ok()?;
    Some(destination)
}

fn skip(test: &str) {
    eprintln!(
        "[skipped] {test}: no real ~/.zcode/v2/tasks-index.sqlite, so the automation facade was \
         NOT verified against a real schema"
    );
}

fn insert(
    conn: &rusqlite::Connection,
    id: &str,
    next_run_at: Option<i64>,
    retry_at: Option<i64>,
    end_at: Option<i64>,
    enabled: i64,
) {
    conn.execute(
        "INSERT INTO automations
           (automation_id, cron_expr, prompt, workspace_key, workspace_path, next_run_at, retry_at,
            end_at, enabled, running, created_at, updated_at)
         VALUES (?1, '0 9 * * *', 'p', '/ws', '/ws', ?2, ?3, ?4, ?5, 0, 0, 0)",
        rusqlite::params![id, next_run_at, retry_at, end_at, enabled],
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

/// The claim statements must be accepted by the real engine and the compare-and-swap must
/// hold there.
#[test]
fn the_claim_runs_and_is_a_compare_and_swap_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("claim") else {
        return skip("the_claim_runs_and_is_a_compare_and_swap_on_the_real_schema");
    };
    let conn = rusqlite::Connection::open(&copy).expect("read-write");
    let id = format!("port-auto-claim-{}", std::process::id());
    insert(&conn, &id, Some(1), None, None, 1);

    assert!(AutomationStore::claim(&conn, &id, 100).expect("claim"));
    assert!(!AutomationStore::claim(&conn, &id, 100).expect("claim again"));

    let row = get(&conn, &id);
    assert_eq!(row.running, 1);
    assert_eq!(row.claimed_at, Some(100));
    assert!(
        AutomationStore::list_due(&conn, 1_000).expect("list").is_empty(),
        "a claimed automation must not be re-selectable"
    );
}

/// The backoff guard, on the real schema. A row in backoff keeps a stale `next_run_at`, and
/// treating the two conditions as interchangeable would retry it every tick.
#[test]
fn the_backoff_guard_holds_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("backoff") else {
        return skip("the_backoff_guard_holds_on_the_real_schema");
    };
    let conn = rusqlite::Connection::open(&copy).expect("read-write");
    let backing_off = format!("port-auto-backoff-{}", std::process::id());
    let retry_ready = format!("port-auto-retry-{}", std::process::id());

    // next_run_at long past, retry_at in the future -> not due.
    insert(&conn, &backing_off, Some(1), Some(9_000), None, 1);
    // retry_at expired -> due.
    insert(&conn, &retry_ready, Some(1), Some(500), None, 1);

    let ids: Vec<String> = AutomationStore::list_due(&conn, 1_000)
        .expect("list")
        .into_iter()
        .map(|row| row.automation_id)
        .collect();
    assert!(
        !ids.contains(&backing_off),
        "a row in backoff must not be due until retry_at expires"
    );
    assert!(
        ids.contains(&retry_ready),
        "retry_at expiry must make it due"
    );
}

/// The full transaction, including the expired-task retirement on the real schema.
#[test]
fn claim_due_runs_against_the_real_schema() {
    let Some(copy) = copy_of_real_database("claim-due") else {
        return skip("claim_due_runs_against_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");
    let due = format!("port-auto-due-{}", std::process::id());
    let expired = format!("port-auto-expired-{}", std::process::id());
    insert(&mut conn, &due, Some(500), None, None, 1);
    insert(&mut conn, &expired, Some(500), None, Some(100), 1);

    let claimed = AutomationStore::claim_due(&mut conn, 1_000).expect("claim due");
    let ids: Vec<&str> = claimed.iter().map(|row| row.automation_id.as_str()).collect();
    assert!(ids.contains(&due.as_str()), "the due automation must be claimed");
    assert!(
        !ids.contains(&expired.as_str()),
        "an expired automation must be retired before the claim pass"
    );

    let row = get(&conn, &expired);
    assert_eq!(row.enabled, 0, "an expired automation must be disabled");
    assert_eq!(row.next_run_at, None, "and its schedule cleared");
}

/// The run id must be stable across a retry, which is what makes a retry an upsert rather than
/// a duplicate run row.
#[test]
fn the_run_id_survives_entering_backoff_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("run-id") else {
        return skip("the_run_id_survives_entering_backoff_on_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");
    let id = format!("port-auto-runid-{}", std::process::id());
    insert(&mut conn, &id, Some(1_000), None, None, 1);

    let before = get(&conn, &id);
    let first = build_run_id(&id, resolve_scheduled_at(&before, 500));
    assert_eq!(first, format!("{id}:1000"));

    // Enter backoff. `next_run_at` is deliberately untouched, so the id must not move.
    conn.execute(
        "UPDATE automations SET retry_at = 9000, running = 0, claimed_at = NULL WHERE automation_id = ?1",
        [&id],
    )
    .expect("enter backoff");
    let during = get(&conn, &id);
    assert!(during.is_retrying(), "the row must now be in backoff");
    assert_eq!(during.next_run_at, Some(1_000), "next_run_at must not move in backoff");
    assert_eq!(
        build_run_id(&id, resolve_scheduled_at(&during, 9_500)),
        first,
        "a retry must reuse the run id"
    );
}

/// A crashed claimer must not hold an automation forever.
#[test]
fn a_zombie_claim_is_reclaimed_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("zombie") else {
        return skip("a_zombie_claim_is_reclaimed_on_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");
    let id = format!("port-auto-zombie-{}", std::process::id());
    insert(&mut conn, &id, Some(1), None, None, 1);
    conn.execute(
        "UPDATE automations SET running = 1, claimed_at = 5 WHERE automation_id = ?1",
        [&id],
    )
    .expect("take a claim");

    assert_eq!(AutomationStore::release_zombie_claims(&conn, 1_000).expect("release"), 0);
    let later = 1_000 + CLAIM_STALE_MS + 1;
    assert_eq!(AutomationStore::release_zombie_claims(&conn, later).expect("release"), 1);
    let claimed = AutomationStore::claim_due(&mut conn, later).expect("claim due");
    assert!(
        claimed.iter().any(|row| row.automation_id == id),
        "a reclaimed automation must be claimable again"
    );
}

/// Every `lifecycle_status` and `dispatch_status` in the live data must be one the crate
/// knows, or a status comparison would silently treat a row as something it is not.
#[test]
fn the_statuses_in_the_real_data_are_all_known() {
    let Some(path) = real_database() else {
        return skip("the_statuses_in_the_real_data_are_all_known");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");

    for (column, known) in [
        ("lifecycle_status", vec!["active", "completed", "cancelled", "paused"]),
        ("dispatch_status", vec!["idle", "claimed", "dispatched", "failed", "skipped"]),
    ] {
        let mut statement = conn
            .prepare(&format!("SELECT DISTINCT {column} FROM automations"))
            .expect("prepare");
        let values = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .map(|row| row.expect("row"))
            .collect::<Vec<_>>();
        for value in values {
            assert!(
                known.contains(&value.as_str()),
                "the real data has {column}={value:?}, which the crate does not know about"
            );
        }
    }
}

/// The row shape the crate reads must exist on the real table, column for column. A missing
/// column would make every claim fail at runtime rather than in a test.
#[test]
fn every_column_the_crate_reads_exists_on_the_real_table() {
    let Some(path) = real_database() else {
        return skip("every_column_the_crate_reads_exists_on_the_real_table");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");

    for column in [
        "automation_id",
        "workspace_key",
        "next_run_at",
        "retry_at",
        "end_at",
        "enabled",
        "running",
        "claimed_at",
        "scheduled_run_count",
        "run_count",
    ] {
        let found: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('automations') WHERE name = ?1",
                [column],
                |row| row.get(0),
            )
            .expect("table info");
        assert_eq!(found, 1, "the real automations table has no `{column}` column");
    }
}
