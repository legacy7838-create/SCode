//! The write path against a copy of the real database.
//!
//! Spec: docs/specs/rust-native-task-index.md §4.5 step 2, §5.1, §5.2.
//!
//! Step 1 proved the real file can be *opened*. This proves it can be *written* — a schema that
//! parses is not a schema the upsert agrees with, and the difference only shows up when the
//! statement runs.
//!
//! Everything runs on a copy. The user's own database is never written to.

use std::path::{Path, PathBuf};

use zcode_task_index::grouped::{
    apply_batch, normalize_grouped_top_node_orders, read_node_orders, task_order_node_key,
    GroupMemberOrder, TaskWrite, ViewNodeOrder, WriteBatch,
};

fn real_database() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = Path::new(&home).join(".zcode/v2/tasks-index.sqlite");
    path.is_file().then_some(path)
}

/// A fresh copy per test, so a failing test cannot contaminate the next.
fn copy_of_real_database(tag: &str) -> Option<PathBuf> {
    let source = real_database()?;
    let dir = std::env::temp_dir().join(format!("zcode-task-index-write-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let destination = dir.join("tasks-index.sqlite");
    std::fs::copy(&source, &destination).ok()?;
    Some(destination)
}

fn skip(test: &str) {
    eprintln!(
        "[skipped] {test}: no real ~/.zcode/v2/tasks-index.sqlite, so the write path was NOT \
         verified against a real schema"
    );
}

fn sample_write(task_id: &str, searchable_text: Option<Option<String>>) -> TaskWrite {
    TaskWrite {
        workspace_key: "/tmp/port-test".into(),
        workspace_path: "/tmp/port-test".into(),
        workspace_identity: Some("port-test-identity".into()),
        task_id: task_id.into(),
        title: "port test task".into(),
        task_status: Some("running".into()),
        provider: Some("test".into()),
        mode: "build".into(),
        model: Some("test-model".into()),
        migration_source: None,
        forked_from_task_id: None,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_001_000,
        unread_at: None,
        last_unread_at: Some(0),
        pinned: Some(0),
        meta_json: "{}".into(),
        searchable_text,
        cron_automation_id: None,
        off_peak_task_id: None,
    }
}

/// The upsert must run against the **real** schema, not a hand-written one.
///
/// Every test below writes to a copy of the live file, so a column-name or type drift between
/// this crate and the store the product actually opens shows up here rather than on a user's
/// machine.
#[test]
fn the_upsert_runs_against_the_real_schema() {
    let Some(copy) = copy_of_real_database("upsert") else {
        return skip("the_upsert_runs_against_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("the copy must open read-write");

    let before: i64 = conn
        .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
        .expect("count");
    assert!(before > 0, "the real database should already have tasks to write alongside");

    let written = apply_batch(
        &mut conn,
        &WriteBatch {
            tasks: vec![sample_write("sess_port_probe", Some(Some("needle in a haystack".into())))],
            ..Default::default()
        },
        1_700_000_002_000,
    )
    .expect("the upsert must succeed against the real schema");
    assert_eq!(written, 1);

    // The row is really there, with the real columns populated.
    let (title, text, mode): (String, String, String) = conn
        .query_row(
            "SELECT title, searchable_text, mode FROM tasks WHERE task_id = 'sess_port_probe'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("the written row must be readable");
    assert_eq!(title, "port test task");
    assert_eq!(text, "needle in a haystack");
    assert_eq!(mode, "build");

    // And the pre-existing rows are untouched.
    let after: i64 = conn
        .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
        .expect("count");
    assert_eq!(after, before + 1);
}

/// The silent-data-loss guard, against the real schema: omitting `searchable_text` must
/// leave the stored text alone.
#[test]
fn omitting_searchable_text_preserves_it_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("keep-text") else {
        return skip("omitting_searchable_text_preserves_it_on_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");

    apply_batch(
        &mut conn,
        &WriteBatch {
            tasks: vec![sample_write("sess_keep", Some(Some("original text".into())))],
            ..Default::default()
        },
        1_700_000_002_000,
    )
    .expect("seed");
    let seeded: String = conn
        .query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_keep'", [], |r| r.get(0))
        .expect("read");

    // Update without the field.
    apply_batch(
        &mut conn,
        &WriteBatch {
            tasks: vec![sample_write("sess_keep", None)],
            ..Default::default()
        },
        1_700_000_003_000,
    )
    .expect("update");

    let stored: String = conn
        .query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_keep'", [], |r| r.get(0))
        .expect("read");
    assert_eq!(
        stored, seeded,
        "an omitted searchable_text must not clear the stored value"
    );
}

/// The other two states, against the real schema.
#[test]
fn setting_and_clearing_searchable_text_work_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("set-clear") else {
        return skip("setting_and_clearing_searchable_text_work_on_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");
    let read = |conn: &rusqlite::Connection| -> String {
        conn.query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_sc'", [], |r| r.get(0))
            .expect("read")
    };

    apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write("sess_sc", Some(Some("v1".into())))], ..Default::default() }, 1).unwrap();
    assert_eq!(read(&conn), "v1");

    apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write("sess_sc", Some(Some("v2".into())))], ..Default::default() }, 2).unwrap();
    assert_eq!(read(&conn), "v2", "an explicit set must replace");

    apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write("sess_sc", Some(None))], ..Default::default() }, 3).unwrap();
    assert_eq!(read(&conn), "", "an explicit clear must empty it");
}

/// The `node_key` the crate writes must be the format the **existing rows already use**.
///
/// If it drifted, the new row would simply never match: no error, and the task appears in the
/// wrong place in the grouped view forever. So this compares a freshly-written key against a
/// key read out of the real file.
#[test]
fn a_written_node_key_matches_the_format_of_the_existing_rows() {
    let Some(copy) = copy_of_real_database("node-key") else {
        return skip("a_written_node_key_matches_the_format_of_the_existing_rows");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");

    let existing: Vec<String> = read_node_orders(&conn)
        .expect("the real file must have readable node orders")
        .into_iter()
        .map(|order| order.node_key)
        .collect();
    if existing.is_empty() {
        eprintln!(
            "[skipped] the real file has no task_group_view_node_orders rows, so the key format \
             could not be compared against an existing one"
        );
        return;
    }

    // Take a real key apart and rebuild it with our own function.
    let (workspace_key, task_id) =
        zcode_task_index::grouped::parse_task_order_node_key(&existing[0]).expect("a real key must parse");
    let rebuilt = task_order_node_key(&workspace_key, &task_id).expect("rebuild");
    assert_eq!(
        rebuilt, existing[0],
        "our key builder must reproduce the on-disk format byte for byte"
    );

    // And writing one must not disturb the others.
    let new_key = task_order_node_key("/tmp/port-test", "sess_new").expect("key");
    apply_batch(
        &mut conn,
        &WriteBatch {
            node_orders: vec![ViewNodeOrder {
                node_type: "task".into(),
                node_key: new_key.clone(),
                sort_order: 0,
            }],
            ..Default::default()
        },
        1_700_000_002_000,
    )
    .expect("node order write");

    let after = read_node_orders(&conn).expect("read back");
    assert_eq!(after.len(), existing.len() + 1, "exactly one row added");
    for key in existing {
        assert!(
            after.iter().any(|order| order.node_key == key),
            "an existing key {key:?} must survive the write"
        );
    }
    assert!(after.iter().any(|order| order.node_key == new_key));
}

/// The order normalisation applied to the **real** rows must be a stable densification, and
/// re-applying it must be a fixed point — otherwise every snapshot would renumber the list.
#[test]
fn normalising_the_real_rows_is_stable_and_idempotent() {
    let Some(path) = real_database() else {
        return skip("normalising_the_real_rows_is_stable_and_idempotent");
    };
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only");
    let rows = read_node_orders(&conn).expect("read");
    if rows.is_empty() {
        eprintln!("[skipped] the real file has no node orders to normalise");
        return;
    }

    let once = normalize_grouped_top_node_orders(rows.clone());
    let twice = normalize_grouped_top_node_orders(once.clone());

    assert_eq!(
        once.iter().map(|o| o.node_key.clone()).collect::<Vec<_>>(),
        twice.iter().map(|o| o.node_key.clone()).collect::<Vec<_>>(),
        "normalisation must be a fixed point, or every snapshot renumbers the list"
    );
    assert_eq!(
        once.iter().map(|o| o.sort_order).collect::<Vec<_>>(),
        twice.iter().map(|o| o.sort_order).collect::<Vec<_>>()
    );

    // Dense and monotonic from zero.
    let orders: Vec<i64> = once.iter().map(|o| o.sort_order).collect();
    assert_eq!(orders.first().copied(), Some(0), "must start at zero");
    for pair in orders.windows(2) {
        assert!(
            pair[1] - pair[0] == zcode_task_index::grouped::GROUPED_TASK_ORDER_STEP,
            "orders must be dense by the step: {orders:?}"
        );
    }
}

/// A batch touching all three tables commits together on the real schema.
///
/// The rollback proof lives in the unit test (`a_failing_batch_rolls_back_completely`),
/// because forcing a failure on the real file means inventing a constraint violation, and the
/// obvious candidate — an empty `node_type` — is a *valid* empty TEXT value, not a NOT NULL
/// breach. Rather than assert something weaker than intended, this checks the property that
/// actually matters here: all three tables reflect the batch together, so the grouped view can
/// never be observed half-written.
#[test]
fn a_three_table_batch_commits_together_on_the_real_schema() {
    let Some(copy) = copy_of_real_database("three-table") else {
        return skip("a_three_table_batch_commits_together_on_the_real_schema");
    };
    let mut conn = rusqlite::Connection::open(&copy).expect("read-write");

    // Seed a group and a member so the member update has a row to affect.
    conn.execute_batch(
        "INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
         VALUES ('g_port_probe', 'probe', 'gray', 1, 1);
         INSERT OR IGNORE INTO task_group_members
           (group_id, workspace_key, workspace_path, workspace_identity, task_id, sort_order,
            added_at, created_at, updated_at)
         VALUES ('g_port_probe', '/tmp/port-test', '/tmp/port-test', 'port-test-identity',
                 'sess_batch', 9999, 1, 1, 1);",
    )
    .expect("seed the group and its member");

    let key = task_order_node_key("/tmp/port-test", "sess_batch").expect("key");
    apply_batch(
        &mut conn,
        &WriteBatch {
            tasks: vec![sample_write("sess_batch", Some(Some("batched text".into())))],
            node_orders: vec![ViewNodeOrder {
                node_type: "task".into(),
                node_key: key.clone(),
                sort_order: 0,
            }],
            group_members: vec![GroupMemberOrder {
                group_id: "g_port_probe".into(),
                task_id: "sess_batch".into(),
                sort_order: Some(0),
            }],
        },
        1_700_000_002_000,
    )
    .expect("the three-table batch must commit");

    // All three landed.
    let text: String = conn
        .query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_batch'", [], |r| r.get(0))
        .expect("task row");
    assert_eq!(text, "batched text");

    let order: i64 = conn
        .query_row("SELECT sort_order FROM task_group_view_node_orders WHERE node_key=?1", [&key], |r| r.get(0))
        .expect("node order");
    assert_eq!(order, 0);

    let member_order: Option<i64> = conn
        .query_row(
            "SELECT sort_order FROM task_group_members WHERE task_id='sess_batch'",
            [],
            |r| r.get(0),
        )
        .expect("member");
    assert_eq!(
        member_order,
        Some(0),
        "the member's order must be updated, not left at the seeded 9999"
    );
}
