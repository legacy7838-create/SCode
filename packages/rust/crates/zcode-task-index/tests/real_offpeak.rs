//! The off-peak facade against a copy of the real database.
//!
//! Spec: docs/specs/rust-native-task-index.md §4.5 step 5.
//!
//! The unit tests use the schema transcribed by hand, which is exactly the kind of thing
//! that drifts. These run against a copy of the live file, so a column or index the crate
//! assumes but the product does not have shows up here.
//!
//! Everything writes to a copy. The user's own database is never touched.

use std::path::{Path, PathBuf};

use zcode_task_index::offpeak::{
    model_selection_is_valid, OffPeakStore, TERMINAL_STATUSES,
};

fn real_database() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = Path::new(&home).join(".zcode/v2/tasks-index.sqlite");
    path.is_file().then_some(path)
}

fn copy_of_real_database(tag: &str) -> Option<PathBuf> {
    let source = real_database()?;
    let dir = std::env::temp_dir().join(format!("zcode-task-index-offpeak-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let destination = dir.join("tasks-index.sqlite");
    std::fs::copy(&source, &destination).ok()?;
    Some(destination)
}

fn skip(test: &str) {
    eprintln!(
        "[skipped] {test}: no real ~/.zcode/v2/tasks-index.sqlite, so the off-peak facade was \
         NOT verified against a real schema"
    );
}

fn valid_selection() -> &'static str {
    r#"{"providerId":"zai","modelId":"glm-4.6"}"#
}

fn insert(
    conn: &rusqlite::Connection,
    id: &str,
    status: &str,
    schedulable: i64,
    model_selection: Option<&str>,
    queued_at: i64,
) {
    conn.execute(
        "INSERT INTO off_peak_tasks
           (off_peak_task_id, session_id, prompt, permission_mode, model_selection, workspace_key,
            workspace_path, status, queued_at, schedulable, claim_running, created_at, updated_at)
         VALUES (?1, ?2, 'p', 'default', ?3, '/ws', '/ws', ?4, ?5, ?6, 0, ?5, ?5)",
        rusqlite::params![id, id, model_selection, status, queued_at, schedulable],
    )
    .expect("insert");
}

/// The counters must read the **real** table, including whatever rows the live file already
/// holds. The absolute numbers depend on the machine, so the assertion is relational: the
/// non-terminal count is the active count plus any non-terminal-but-unschedulable rows.
#[test]
fn the_counters_agree_with_a_direct_query_on_the_real_schema() {
    let Some(path) = real_database() else {
        return skip("the_counters_agree_with_a_direct_query_on_the_real_schema");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");

    let terminal = TERMINAL_STATUSES
        .iter()
        .map(|status| format!("'{status}'"))
        .collect::<Vec<_>>()
        .join(",");
    let expected_non_terminal: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM off_peak_tasks WHERE status NOT IN ({terminal})"),
            [],
            |row| row.get(0),
        )
        .expect("count");
    let expected_active: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM off_peak_tasks WHERE status NOT IN ({terminal}) AND schedulable = 1"
            ),
            [],
            |row| row.get(0),
        )
        .expect("count");

    assert_eq!(
        OffPeakStore::count_non_terminal(&conn).expect("count"),
        expected_non_terminal
    );
    assert_eq!(OffPeakStore::count_active(&conn).expect("count"), expected_active);
}

/// The claim statement must be accepted by the real engine, and the compare-and-swap must hold
/// there — a guarded update that SQLite rejects would take the whole scheduler down.
#[test]
fn the_claim_runs_and_is_a_compare_and_swap_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("claim") else {
        return skip("the_claim_runs_and_is_a_compare_and_swap_on_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");

    let id = format!("port-probe-{}", std::process::id());
    insert(&mut conn, &id, "queued", 1, Some(valid_selection()), 1);

    // Stale-claim release is a no-op on a fresh row.
    assert_eq!(OffPeakStore::release_stale_claims(&conn, 10).expect("release"), 0);

    // First claimer wins.
    assert!(OffPeakStore::claim(&conn, &id, 100).expect("claim"));
    // Second loses.
    assert!(!OffPeakStore::claim(&conn, &id, 100).expect("claim again"));

    let row = OffPeakStore::get(&conn, &id).expect("read").expect("present");
    assert_eq!(row.claim_running, 1);
    assert_eq!(row.claimed_at, Some(100));
    assert!(model_selection_is_valid(&row));

    // A row that is already claimed is not eligible.
    assert!(
        OffPeakStore::list_due(&conn).expect("list").is_empty(),
        "a claimed row must not be re-selectable"
    );
}

/// The full `claim_due` transaction, on the real schema and alongside whatever the live file
/// already contains.
#[test]
fn claim_due_runs_against_the_real_schema() {
    let Some(copy) = copy_of_real_database("claim-due") else {
        return skip("claim_due_runs_against_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");

    let good = format!("port-good-{}", std::process::id());
    let bad = format!("port-bad-{}", std::process::id());
    insert(&mut conn, &good, "queued", 1, Some(valid_selection()), 1);
    insert(&mut conn, &bad, "queued", 1, None, 2);

    let claimed = OffPeakStore::claim_due(&mut conn, 500).expect("claim due");
    let ids: Vec<&str> = claimed.iter().map(|r| r.off_peak_task_id.as_str()).collect();
    assert!(ids.contains(&good.as_str()), "the usable row must be claimed");
    assert!(
        !ids.contains(&bad.as_str()),
        "a row with no model selection must be skipped"
    );

    // The skipped row is still there, for repair.
    let skipped = OffPeakStore::get(&conn, &bad).expect("read").expect("present");
    assert_eq!(skipped.claim_running, 0, "a skipped row must not be claimed");
    assert!(!model_selection_is_valid(&skipped));
}

/// The unique index must behave on the real schema, since the one-active-task-per-session
/// rule depends on it rather than on application code.
#[test]
fn the_bound_active_index_behaves_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("bound") else {
        return skip("the_bound_active_index_behaves_on_the_real_schema");
    };
    let conn = rusqlite::Connection::open(&copy).expect("read-write");
    let id = format!("port-bind-{}", std::process::id());
    insert(&conn, &id, "running", 1, Some(valid_selection()), 1);

    assert!(OffPeakStore::has_active_bound_task(&conn, "/ws", &id).expect("probe"));
    assert!(!OffPeakStore::has_active_bound_task(&conn, "/ws", "other").expect("probe"));

    conn.execute(
        "UPDATE off_peak_tasks SET status = 'completed' WHERE off_peak_task_id = ?1",
        [&id],
    )
    .expect("finish");
    assert!(
        !OffPeakStore::has_active_bound_task(&conn, "/ws", &id).expect("probe"),
        "finishing the task must free the binding"
    );
}

/// The terminal-status set must match what the live data uses, or the counters drift.
#[test]
fn the_terminal_statuses_cover_every_status_in_the_real_data() {
    let Some(path) = real_database() else {
        return skip("the_terminal_statuses_cover_every_status_in_the_real_data");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");
    let mut statement = conn
        .prepare("SELECT DISTINCT status FROM off_peak_tasks")
        .expect("prepare");
    let statuses = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .map(|row| row.expect("row"))
        .collect::<Vec<_>>();

    for status in &statuses {
        // Any status that is not terminal must be something the count treats as live; that is
        // only true if the three terminal names are the ones the code knows.
        let known = ["queued", "running"]
            .iter()
            .chain(TERMINAL_STATUSES.iter())
            .any(|known| *known == status.as_str());
        assert!(
            known,
            "the real data has a status {status:?} the crate does not know about, so the \
             non-terminal count would be wrong"
        );
    }
}
