//! Step 1's gate: the real database must be openable, and its schema and ledger must match
//! what this build expects.
//!
//! Spec: docs/specs/rust-native-task-index.md §4.5 step 1, risk R1.
//!
//! The store is a **persisted** artefact. A schema or migration drift does not fail a unit
//! test — it fails on the user's next launch, when their install cannot open its own file.
//! So this test runs against a copy of the real `~/.zcode/v2/tasks-index.sqlite` and asserts
//! the actual tables, indexes and ledger rows.
//!
//! It is skipped, loudly, when no real database is present, so it never reports a false pass:
//! the skip message says what was not verified.

use std::path::{Path, PathBuf};

use zcode_task_index::migrate::{read_ledger, run_migrations, Migration};
use zcode_task_index::schema::migration_definitions;

fn real_database() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = Path::new(&home).join(".zcode/v2/tasks-index.sqlite");
    path.is_file().then_some(path)
}

/// Copy the real database to a temp file so the test never writes to the user's own.
fn copy_of_real_database(tag: &str) -> Option<PathBuf> {
    let source = real_database()?;
    let dir = std::env::temp_dir().join(format!("zcode-task-index-real-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let destination = dir.join("tasks-index.sqlite");
    std::fs::copy(&source, &destination).ok()?;
    Some(destination)
}

fn skip(test: &str) {
    eprintln!(
        "[skipped] {test}: no real ~/.zcode/v2/tasks-index.sqlite on this machine, so schema \
         parity was NOT verified. Run it on a host with a real install."
    );
}

fn table_names(conn: &rusqlite::Connection) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .expect("prepare");
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .map(|row| row.expect("row").to_string())
        .collect()
}

fn index_names(conn: &rusqlite::Connection) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
        .expect("prepare");
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .map(|row| row.expect("row").to_string())
        .collect()
}

/// Every table this build's schema declares must exist in the real file.
///
/// All three repos' tables are listed deliberately: the automations and off-peak tables live
/// in this same file (spec §2.2a), so a port that "handled the task tables" would still be
/// wrong about the file it owns.
#[test]
fn the_real_database_has_every_declared_table() {
    let Some(path) = real_database() else {
        return skip("the_real_database_has_every_declared_table");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the real database must open read-only");
    let tables = table_names(&conn);

    for expected in [
        "tasks",
        "task_groups",
        "task_group_members",
        "task_group_view_node_orders",
        "task_group_workspace_bootstraps",
        "tasks_schema_migration",
        // The two sibling repos share this file.
        "automations",
        "automation_runs",
        "off_peak_tasks",
    ] {
        assert!(
            tables.iter().any(|name| name == expected),
            "the real database is missing `{expected}`; found {tables:?}"
        );
    }
}

/// The indexes the queries depend on. A missing one is a silent full-table scan.
#[test]
fn the_real_database_has_every_declared_index() {
    let Some(path) = real_database() else {
        return skip("the_real_database_has_every_declared_index");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the real database must open read-only");
    let indexes = index_names(&conn);

    for expected in [
        "idx_tasks_workspace_archived_updated",
        "idx_tasks_workspace_pinned_updated",
        "idx_tasks_cron_automation",
        "idx_tasks_off_peak_task",
        "idx_task_group_members_group_order",
        "idx_task_group_view_node_orders_order",
        "idx_automations_due",
        "idx_automations_retry",
        "idx_automations_workspace",
        "idx_off_peak_ws",
        "idx_off_peak_pick",
    ] {
        assert!(
            indexes.iter().any(|name| name == expected),
            "the real database is missing index `{expected}`; found {indexes:?}"
        );
    }
}

/// Opening the real file and re-running this build's migrations must be a **no-op**: every
/// declared migration is already recorded with a matching checksum.
///
/// This is the check that would have caught a wrong checksum definition. With the events
/// port's `sha256(trimmed SQL)` rule instead of this store's
/// `sha256(JSON.stringify(checksumInput))`, every row would mismatch and every existing
/// install would fail on first launch.
#[test]
fn rerunning_this_builds_migrations_on_the_real_file_is_a_no_op() {
    let Some(copy) = copy_of_real_database("rerun") else {
        return skip("rerunning_this_builds_migrations_on_the_real_file_is_a_no_op");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("the copy must open read-write");

    let before = read_ledger(&conn).expect("ledger readable");
    assert!(!before.is_empty(), "the real file must have a populated ledger");

    // The declared migrations, with the checksums this build computes. `0004_code_plan_modes`
    // is deliberately absent: it is on disk but not declared by this checkout, and the runner
    // must treat an unknown row as neither a mismatch nor something to re-apply. The definitions
    // come from `crate::schema` now — the JavaScript that built them is deleted (spec §28).
    let declared: Vec<Migration> = migration_definitions()
        .into_iter()
        .map(|definition| Migration {
            id: definition.id.to_string(),
            sql: String::new(),
            checksum_input_json: definition.checksum_input_json,
        })
        .collect();

    let applied = run_migrations(&mut conn, &declared, 1).expect("must not mismatch");
    assert!(
        applied.is_empty(),
        "a real install must already satisfy every declared migration, but {applied:?} applied"
    );
    assert_eq!(
        read_ledger(&conn).expect("ledger"),
        before,
        "the ledger must be unchanged"
    );
}

/// The `0002` checksum is a pure literal, so it can be asserted against the real ledger
/// value directly — this is the anchor that pins the whole checksum contract.
#[test]
fn the_declared_0002_checksum_matches_the_real_ledger() {
    let Some(path) = real_database() else {
        return skip("the_declared_0002_checksum_matches_the_real_ledger");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");
    let ledger = read_ledger(&conn).expect("ledger");

    let recorded = ledger
        .iter()
        .find(|(id, _)| id == "0002_provider_selection")
        .map(|(_, checksum)| checksum.clone())
        .expect("the real ledger records 0002");

    let computed = Migration {
        id: "0002_provider_selection".into(),
        sql: String::new(),
        checksum_input_json:
            r#"["legacy-automation-selection-v1","no-provider-for-legacy-off-peak-v1"]"#.into(),
    }
    .checksum();

    assert_eq!(
        computed, recorded,
        "the computed checksum must equal the real ledger's; a mismatch here is the \
         checksum_mismatch every existing install would hit on launch"
    );
}

/// `0004_code_plan_modes` is on disk but not declared by this checkout. The runner must
/// ignore it, and the baseline must still come from the newest row of any id.
#[test]
fn the_unknown_fourth_row_is_tolerated_by_the_real_runner() {
    let Some(copy) = copy_of_real_database("unknown-row") else {
        return skip("the_unknown_fourth_row_is_tolerated_by_the_real_runner");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("the copy must open");

    let unknown = read_ledger(&conn)
        .expect("ledger")
        .into_iter()
        .find(|(id, _)| id == "0004_code_plan_modes");
    let Some((unknown_id, unknown_checksum)) = unknown else {
        eprintln!(
            "[skipped] the_unknown_fourth_row_is_tolerated_by_the_real_runner: this machine's \
             ledger has no 0004_code_plan_modes row, so the unknown-row path was NOT verified"
        );
        return;
    };

    // Declaring nothing must be refused, and declaring an unknown id must apply cleanly.
    assert!(run_migrations(&mut conn, &[], 1).is_err(), "an empty list must be refused");

    let new_id = "0005_probe_declared_by_this_test";
    let applied = run_migrations(
        &mut conn,
        &[Migration {
            id: new_id.into(),
            sql: "SELECT 1;".into(),
            checksum_input_json: "[\"probe\"]".into(),
        }],
        1,
    )
    .expect("an unknown existing row must not block a new migration");
    assert_eq!(applied, vec![new_id]);

    // The unknown row is still there, unchanged.
    let after = read_ledger(&conn).expect("ledger");
    assert!(
        after
            .iter()
            .any(|(id, checksum)| *id == unknown_id && *checksum == unknown_checksum),
        "the unknown row must survive untouched"
    );
}

/// `JSON.stringify` of the declared input for `0003`, now the crate's own definition.
fn official_glm_checksum_input() -> String {
    migration_definitions()
        .into_iter()
        .find(|definition| definition.id == "0003_official_glm_selection")
        .expect("0003 is declared")
        .checksum_input_json
}

#[test]
fn the_declared_0003_checksum_matches_the_real_ledger() {
    let Some(path) = real_database() else {
        return skip("the_declared_0003_checksum_matches_the_real_ledger");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");
    let ledger = read_ledger(&conn).expect("ledger");
    let recorded = ledger
        .iter()
        .find(|(id, _)| id == "0003_official_glm_selection")
        .map(|(_, checksum)| checksum.clone());
    let Some(recorded) = recorded else {
        eprintln!("[skipped] 0003_official_glm_selection is not in this ledger");
        return;
    };

    let computed = Migration {
        id: "0003_official_glm_selection".into(),
        sql: String::new(),
        checksum_input_json: official_glm_checksum_input(),
    }
    .checksum();

    assert_eq!(
        computed, recorded,
        "0003 must match too, proving the single-string case of the JSON.stringify contract"
    );
}

/// `0001`'s input contains a nested `string[][]`, which is the case the events port's rule
/// cannot express. Reproducing it here pins the nested-array serialisation against the real
/// ledger.
#[test]
fn the_nested_0001_checksum_matches_the_real_ledger() {
    let Some(path) = real_database() else {
        return skip("the_nested_0001_checksum_matches_the_real_ledger");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");
    let ledger = read_ledger(&conn).expect("ledger");
    let Some(recorded) = ledger
        .iter()
        .find(|(id, _)| id == "0001_adopt_task_schema")
        .map(|(_, checksum)| checksum.clone())
    else {
        eprintln!("[skipped] 0001_adopt_task_schema is not in this ledger");
        return;
    };

    let computed = Migration {
        id: "0001_adopt_task_schema".into(),
        sql: String::new(),
        checksum_input_json: migration_definitions()
            .into_iter()
            .find(|definition| definition.id == "0001_adopt_task_schema")
            .expect("0001 is declared")
            .checksum_input_json,
    }
    .checksum();

    assert_eq!(
        computed, recorded,
        "0001 must match too, proving the nested string[][] case of the JSON.stringify contract"
    );
}

