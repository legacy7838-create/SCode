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

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .expect("crates/zcode-task-index is four levels below the repo root")
        .to_path_buf()
}

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
    // must treat an unknown row as neither a mismatch nor something to re-apply.
    let declared = vec![
        Migration {
            id: "0002_provider_selection".into(),
            sql: String::new(),
            checksum_input_json:
                r#"["legacy-automation-selection-v1","no-provider-for-legacy-off-peak-v1"]"#
                    .into(),
        },
        Migration {
            id: "0003_official_glm_selection".into(),
            sql: String::new(),
            checksum_input_json: official_glm_checksum_input(),
        },
    ];

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

/// `JSON.stringify` of the declared input for `0003`, read from the real TypeScript so the
/// test cannot drift from it.
fn official_glm_checksum_input() -> String {
    let source = repo_root().join("packages/services/src/session/tasksDatabase/official-glm-selection-v3.ts");
    let text = std::fs::read_to_string(&source)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", source.display()));
    // The constant is a template literal; the migration hashes the string it evaluates to.
    let start = text
        .find("OFFICIAL_GLM_SELECTION_MIGRATION_SQL = `")
        .map(|index| index + "OFFICIAL_GLM_SELECTION_MIGRATION_SQL = `".len())
        .unwrap_or_else(|| {
            panic!("OFFICIAL_GLM_SELECTION_MIGRATION_SQL not found in {}", source.display())
        });
    let end = text[start..]
        .find('`')
        .map(|index| start + index)
        .unwrap_or_else(|| panic!("unterminated template literal in {}", source.display()));
    let sql = &text[start..end];
    // JSON.stringify of a one-element array containing that string.
    serde_json::to_string(&serde_json::Value::Array(vec![
        serde_json::Value::String(sql.to_string()),
    ]))
    .expect("serialise")
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
        checksum_input_json: first_migration_checksum_input().expect("0001 input is readable"),
    }
    .checksum();

    assert_eq!(
        computed, recorded,
        "0001 must match too, proving the nested string[][] case of the JSON.stringify contract"
    );
}

/// `JSON.stringify(migration.checksumInput)` for `0001`, reproduced from the real
/// TypeScript sources: three schema constants, the nested `columns` tuples, the index blob,
/// the bound index, and the backfill marker.
fn first_migration_checksum_input() -> Option<String> {
    use serde_json::{json, Value};

    let base = repo_root().join("packages/services/src/session/tasksDatabase");
    let read = |name: &str| std::fs::read_to_string(base.join(name)).ok();

    // Template-literal constants are taken verbatim from their source.
    let template_literal = |text: &str, const_name: &str| -> Option<String> {
        let marker = format!("{const_name} = `");
        let start = text.find(&marker)? + marker.len();
        let end = start + text[start..].find('`')?;
        Some(text[start..end].to_string())
    };

    let schema = read("schema-v1.ts")?;
    let migrations_src = read("migrations.ts")?;

    let schema_value = |name: &str| -> Option<String> {
        template_literal(&schema, name).or_else(|| {
            // The last two schemas are built with interpolation; reconstruct by reading the
            // template and substituting the one local constant it uses.
            let raw = template_literal(&schema, name)?;
            let terminal = "'completed','failed','cancelled'";
            Some(raw.replace("${terminalStatuses}", terminal))
        })
    };

    let task_index = schema_value("TASK_INDEX_SCHEMA")?;
    let automation = schema_value("AUTOMATION_SCHEMA")?;
    let off_peak = schema_value("OFF_PEAK_SCHEMA")?;
    let indexes = template_literal(&migrations_src, "const indexes")?;
    let bound_index = format!(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON \
         off_peak_tasks(workspace_key,session_id) WHERE session_id IS NOT NULL AND status NOT IN \
         ('completed','failed','cancelled')"
    );

    // `columns` is an array of tuples, so it contributes a nested array.
    let mut columns: Vec<Value> = Vec::new();
    let block = migrations_src
        .split_once("const columns = [")?
        .1
        .split_once("\n] as const;")?
        .0;
    for line in block.lines() {
        let parts: Vec<&str> = line
            .trim()
            .trim_start_matches('[')
            .trim_end_matches("],")
            .split(',')
            .map(|part| part.trim().trim_matches('"'))
            .collect();
        if parts.len() == 3 {
            columns.push(json!([parts[0], parts[1], parts[2]]));
        }
    }
    if columns.is_empty() {
        return None;
    }

    Some(
        serde_json::to_string(&json!([
            task_index,
            automation,
            off_peak,
            Value::Array(columns),
            indexes,
            bound_index,
            "scheduled-count-backfill-v1",
        ]))
        .expect("serialise"),
    )
}
