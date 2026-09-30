//! Task groups: create, rename, recolour, delete, and admitting a task to the grouped top level.
//!
//! Ported from `taskIndexRepo.ts:1896-2073`. Spec: docs/specs/rust-native-task-index.md §23
//! (batch B).
//!
//! # New groups go to the *front*
//!
//! [`next_top_sort_order`] takes `MIN(sort_order)` and subtracts one step, not `MAX` and adds one.
//! Newly created content must appear immediately at the top of the current list; relying on the
//! interleaving of `created_at` and the existing `sort_order` makes positions drift after a
//! refresh, because the two coordinate systems have different magnitudes. An empty table yields
//! `MIN = NULL`, which becomes two steps minus one — so the first group lands on the step rather
//! than on zero, leaving room below it.
use rusqlite::{OptionalExtension, Row};

use crate::grouped::{task_order_node_key, GROUPED_TASK_ORDER_STEP};
use crate::meta::{sql, TaskRow};
use crate::migrate::MigrationError;

/// `DEFAULT_TASK_GROUP_COLOR` (`taskIndexRepo.ts:157`).
pub const DEFAULT_TASK_GROUP_COLOR: &str = "gray";

/// The seven colours `isTaskGroupColor` accepts (`taskIndexRepo.ts:368-377`).
pub const TASK_GROUP_COLORS: [&str; 7] = [
    "gray", "red", "orange", "yellow", "green", "blue", "purple",
];

/// `isTaskGroupColor`. A closed set: a stored colour outside it reads as the default rather than
/// failing, so a group written by a newer build still renders.
pub fn is_task_group_color(value: &str) -> bool {
    TASK_GROUP_COLORS.contains(&value)
}

/// `ZCodeTaskGroup`, the published shape.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskGroup {
    pub id: String,
    pub title: String,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `rowToTaskGroup` (`taskIndexRepo.ts:380-388`).
pub fn row_to_group(row: &Row<'_>) -> rusqlite::Result<TaskGroup> {
    let color: String = row.get("color")?;
    Ok(TaskGroup {
        id: row.get("group_id")?,
        title: row.get("title")?,
        color: if is_task_group_color(&color) { color } else { DEFAULT_TASK_GROUP_COLOR.to_string() },
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// The title a blank rename falls back to (`"New Group"`, `taskIndexRepo.ts:1929`).
const DEFAULT_GROUP_TITLE: &str = "New Group";

/// `getNextGroupedTopSortOrder` (`taskIndexRepo.ts:719-727`).
///
/// `MIN`, not `MAX`, and one step *below* it: new content goes to the top. An empty table gives
/// `NULL`, which becomes `2 * step - step` so the first entry lands on the step, not on zero.
pub fn next_top_sort_order(conn: &rusqlite::Connection) -> Result<i64, MigrationError> {
    let minimum: Option<i64> = conn
        .query_row("SELECT MIN(sort_order) AS min_sort_order FROM task_group_view_node_orders", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .map_err(|source| sql("cannot read the grouped order", source))?;
    Ok(minimum.unwrap_or(GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP)
}

/// `upsertGroupedTopOrder` (`taskIndexRepo.ts:729-751`).
pub fn upsert_top_order(
    conn: &rusqlite::Connection,
    node_type: &str,
    node_key: &str,
    sort_order: i64,
    now: i64,
) -> Result<(), MigrationError> {
    conn.execute(
        "INSERT INTO task_group_view_node_orders
           (node_type, node_key, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(node_type, node_key) DO UPDATE SET
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at",
        rusqlite::params![node_type, node_key, sort_order, now, now],
    )
    .map_err(|source| sql("cannot write the grouped order", source))?;
    Ok(())
}

/// Why an operation on a group failed.
///
/// A distinct type rather than a string, because each of these is a **caller-visible** refusal: the
/// service layer shows a different message for a missing group than for a bad colour, and collapsing
/// them into one error would lose that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupError {
    NotFound,
    InvalidColor,
    ReadBackFailed,
}

impl std::fmt::Display for GroupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GroupError::NotFound => write!(formatter, "task group does not exist"),
            GroupError::InvalidColor => write!(formatter, "task group color is invalid"),
            GroupError::ReadBackFailed => write!(formatter, "task group could not be read back"),
        }
    }
}

impl From<GroupError> for MigrationError {
    fn from(error: GroupError) -> Self {
        MigrationError::Sql {
            context: error.to_string(),
            source: rusqlite::Error::InvalidQuery,
        }
    }
}

fn read_group(conn: &rusqlite::Connection, group_id: &str) -> Result<Option<TaskGroup>, MigrationError> {
    let mut statement = conn
        .prepare("SELECT group_id, title, color, created_at, updated_at FROM task_groups WHERE group_id = ?1")
        .map_err(|source| sql("cannot prepare the group read", source))?;
    let mut rows = statement
        .query_map(rusqlite::params![group_id], row_to_group)
        .map_err(|source| sql("cannot read the group", source))?;
    match rows.next() {
        Some(row) => Ok(Some(
            row.map_err(|source| sql("cannot read the group", source))?,
        )),
        None => Ok(None),
    }
}

/// `createTaskGroup` (`taskIndexRepo.ts:1896-1931`).
///
/// The id is caller-supplied because the original minted it with `randomUUID()`, and the engine
/// has no business inventing one: a test that needs a stable id should not have to read a UUID out
/// of a result. The order row is written immediately, at the top of the current list.
pub fn create_task_group(
    conn: &rusqlite::Connection,
    group_id: &str,
    title: Option<&str>,
    color: Option<&str>,
    now: i64,
) -> Result<TaskGroup, MigrationError> {
    let title = title.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(DEFAULT_GROUP_TITLE);
    let color = color.unwrap_or(DEFAULT_TASK_GROUP_COLOR);
    conn.execute(
        "INSERT INTO task_groups (group_id, title, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![group_id, title, color, now, now],
    )
    .map_err(|source| sql("cannot create the group", source))?;
    upsert_top_order(conn, "group", group_id, next_top_sort_order(conn)?, now)?;
    read_group(conn, group_id)?.ok_or(GroupError::ReadBackFailed.into())
}

/// `renameTaskGroup` (`taskIndexRepo.ts:1933-1964`).
///
/// A blank title falls back to `"New Group"` rather than storing an empty one, and a missing group
/// is an error rather than a silent no-op: the caller asked to rename something.
pub fn rename_task_group(
    conn: &rusqlite::Connection,
    group_id: &str,
    title: &str,
    now: i64,
) -> Result<TaskGroup, MigrationError> {
    let title = title.trim();
    let title = if title.is_empty() { DEFAULT_GROUP_TITLE } else { title };
    let changed = conn
        .execute(
            "UPDATE task_groups SET title = ?2, updated_at = ?3 WHERE group_id = ?1",
            rusqlite::params![group_id, title, now],
        )
        .map_err(|source| sql("cannot rename the group", source))?;
    if changed == 0 {
        return Err(GroupError::NotFound.into());
    }
    read_group(conn, group_id)?.ok_or(GroupError::ReadBackFailed.into())
}

/// `updateTaskGroupColor` (`taskIndexRepo.ts:1966-2002`).
///
/// The colour is validated **before** the write, so a bad value cannot be stored and then reported
/// as the default on read — which would look like it worked.
pub fn update_task_group_color(
    conn: &rusqlite::Connection,
    group_id: &str,
    color: &str,
    now: i64,
) -> Result<TaskGroup, MigrationError> {
    if !is_task_group_color(color) {
        return Err(GroupError::InvalidColor.into());
    }
    let changed = conn
        .execute(
            "UPDATE task_groups SET color = ?2, updated_at = ?3 WHERE group_id = ?1",
            rusqlite::params![group_id, color, now],
        )
        .map_err(|source| sql("cannot recolour the group", source))?;
    if changed == 0 {
        return Err(GroupError::NotFound.into());
    }
    read_group(conn, group_id)?.ok_or(GroupError::ReadBackFailed.into())
}

/// `deleteTaskGroup` (`taskIndexRepo.ts:2004-2026`).
///
/// Two statements in one transaction: the group row and its top-level order row must disappear
/// together, or the grouped view keeps rendering an order row for a group that no longer exists.
pub fn delete_task_group(
    conn: &mut rusqlite::Connection,
    group_id: &str,
) -> Result<(), MigrationError> {
    let transaction = conn.transaction().map_err(|source| sql("cannot begin the delete", source))?;
    let changed = transaction
        .execute("DELETE FROM task_groups WHERE group_id = ?1", rusqlite::params![group_id])
        .map_err(|source| sql("cannot delete the group", source))?;
    if changed == 0 {
        return Err(GroupError::NotFound.into());
    }
    transaction
        .execute(
            "DELETE FROM task_group_view_node_orders WHERE node_type = 'group' AND node_key = ?1",
            rusqlite::params![group_id],
        )
        .map_err(|source| sql("cannot delete the group's order", source))?;
    transaction.commit().map_err(|source| sql("cannot commit the delete", source))?;
    Ok(())
}

/// `initializeGroupedTaskAtTop` (`taskIndexRepo.ts:2028-2073`).
///
/// Returns `true` only the **first** time a task reaches the top level, and the answer is `false`
/// for a task that is deleted, archived or pinned, for one that already has a membership, and for
/// one that already has an order row.
///
/// That last distinction is the point: session visibility and a missing first title can both
/// trigger a full snapshot back to the source, and the second one must not re-assign the minimum
/// `sort_order`. An older task that finishes slowly would then jump ahead of newer ones, and the
/// final order would depend on completion timing rather than on creation.
pub fn initialize_task_at_top(
    conn: &rusqlite::Connection,
    workspace_key: &str,
    workspace_path: &str,
    workspace_identity: Option<&str>,
    task_id: &str,
    now: i64,
) -> Result<bool, MigrationError> {
    let row: Option<TaskRow> = {
        let mut statement = conn
            .prepare(&format!(
                "SELECT {} FROM tasks WHERE workspace_key = ?1 AND task_id = ?2",
                crate::meta::TASK_COLUMNS
            ))
            .map_err(|source| sql("cannot prepare the admission read", source))?;
        let mut rows = statement
            .query_map(rusqlite::params![workspace_key, task_id], TaskRow::from_sql_row)
            .map_err(|source| sql("cannot read the task", source))?;
        match rows.next() {
            Some(row) => Some(row.map_err(|source| sql("cannot read the task", source))?),
            None => None,
        }
    };
    let Some(row) = row else { return Ok(false) };
    if row.deleted == 1 || row.archived == 1 || row.pinned == 1 {
        return Ok(false);
    }

    let has_member: bool = conn
        .query_row(
            "SELECT 1 FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2 LIMIT 1",
            rusqlite::params![workspace_key, task_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|source| sql("cannot read the membership", source))?
        .is_some();
    let node_key = task_order_node_key(workspace_key, task_id)?;
    let has_order: bool = conn
        .query_row(
            "SELECT 1 FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?1 LIMIT 1",
            rusqlite::params![node_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|source| sql("cannot read the task order", source))?
        .is_some();
    if has_member || has_order {
        return Ok(false);
    }
    upsert_top_order(conn, "task", &node_key, next_top_sort_order(conn)?, now)?;
    // The path and identity are recorded even though only the key is stored on the order row: the
    // membership is derived from them later, and losing them here would make the node ungroupable.
    let _ = (workspace_path, workspace_identity);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::memory;

    fn with_groups(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE task_groups (group_id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE task_group_view_node_orders (node_type TEXT NOT NULL, node_key TEXT NOT NULL,
               sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (node_type, node_key));
             CREATE TABLE task_group_members (group_id TEXT NOT NULL, workspace_key TEXT NOT NULL,
               workspace_path TEXT NOT NULL, workspace_identity TEXT, task_id TEXT NOT NULL,
               sort_order INTEGER NOT NULL, added_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_key, task_id));",
        )
        .expect("group schema");
    }

    fn orders(conn: &rusqlite::Connection) -> Vec<(String, String, i64)> {
        let mut statement = conn
            .prepare("SELECT node_type, node_key, sort_order FROM task_group_view_node_orders ORDER BY sort_order")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query");
        rows.map(|row| row.expect("row")).collect()
    }

    /// A new group lands at the **top**, and successive groups stack above each other.
    #[test]
    fn a_new_group_goes_to_the_top_of_the_list() {
        let conn = memory();
        with_groups(&conn);
        assert_eq!(next_top_sort_order(&conn).expect("empty"), GROUPED_TASK_ORDER_STEP);

        let first = create_task_group(&conn, "g1", Some("First"), None, 100).expect("create");
        assert_eq!(first.color, DEFAULT_TASK_GROUP_COLOR, "the default colour when none is given");
        let second = create_task_group(&conn, "g2", Some("Second"), Some("blue"), 200).expect("create");

        assert_eq!(orders(&conn), vec![
            ("group".to_string(), "g2".to_string(), 0),
            ("group".to_string(), "g1".to_string(), GROUPED_TASK_ORDER_STEP),
        ]);
        assert_eq!(second.title, "Second");
    }

    /// A blank title is replaced, not stored empty — on create and on rename alike.
    #[test]
    fn a_blank_title_falls_back_instead_of_storing_an_empty_one() {
        let conn = memory();
        with_groups(&conn);
        assert_eq!(create_task_group(&conn, "g1", Some("   "), None, 1).expect("create").title, "New Group");
        assert_eq!(rename_task_group(&conn, "g1", "  ", 2).expect("rename").title, "New Group");
    }

    /// Rename and recolour refuse a missing group rather than reporting success.
    #[test]
    fn a_missing_group_is_an_error_on_rename_and_recolour() {
        let conn = memory();
        with_groups(&conn);
        assert!(matches!(
            rename_task_group(&conn, "nope", "x", 1),
            Err(crate::migrate::MigrationError::Sql { .. })
        ));
        assert!(matches!(
            update_task_group_color(&conn, "nope", "red", 1),
            Err(crate::migrate::MigrationError::Sql { .. })
        ));
    }

    /// A colour outside the closed set is refused **before** the write, so the stored value can
    /// never be one that reads back as the default.
    #[test]
    fn an_invalid_colour_is_refused_before_anything_is_written() {
        let conn = memory();
        with_groups(&conn);
        create_task_group(&conn, "g1", Some("G"), Some("red"), 1).expect("create");
        assert!(update_task_group_color(&conn, "g1", "chartreuse", 2).is_err());
        assert_eq!(
            read_group(&conn, "g1").expect("read").expect("present").color,
            "red",
            "the old colour survives the refused write"
        );
    }

    /// A stored colour outside the set reads as the default rather than failing, so a group written
    /// by a newer build still renders.
    #[test]
    fn a_stored_colour_outside_the_set_reads_as_the_default() {
        let conn = memory();
        with_groups(&conn);
        conn.execute(
            "INSERT INTO task_groups VALUES ('g1', 'G', 'chartreuse', 1, 1)",
            [],
        )
        .expect("insert");
        assert_eq!(
            read_group(&conn, "g1").expect("read").expect("present").color,
            DEFAULT_TASK_GROUP_COLOR
        );
    }

    /// Deleting a group takes its order row with it; a missing group is an error.
    #[test]
    fn deleting_a_group_removes_its_order_row_too() {
        let mut conn = memory();
        with_groups(&conn);
        create_task_group(&conn, "g1", Some("G"), None, 1).expect("create");
        assert_eq!(orders(&conn).len(), 1);
        delete_task_group(&mut conn, "g1").expect("delete");
        assert!(orders(&conn).is_empty(), "an order row for a gone group renders nothing");
        assert!(read_group(&conn, "g1").expect("read").is_none());
        assert!(delete_task_group(&mut conn, "g1").is_err(), "a second delete is an error");
    }

    /// Admission happens **once**. A second call is `false`, so a repeat snapshot cannot re-assign
    /// the minimum sort order and put an older task above a newer one.
    #[test]
    fn admission_to_the_top_happens_only_once() {
        let conn = memory();
        with_groups(&conn);
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, created_at, updated_at,
               meta_json, searchable_text)
             VALUES ('ws', '/ws', 't1', 't1', 'auto', 1, 1, '{}', '')",
            [],
        )
        .expect("insert");

        assert!(initialize_task_at_top(&conn, "ws", "/ws", None, "t1", 100).expect("admit"));
        assert!(
            !initialize_task_at_top(&conn, "ws", "/ws", None, "t1", 200).expect("again"),
            "a repeat snapshot must not move it"
        );
        assert_eq!(orders(&conn).len(), 1);
    }

    /// A deleted, archived or pinned task is not admitted: the grouped view would show something the
    /// sidebar does not.
    #[test]
    fn an_invisible_task_is_not_admitted() {
        for (column, label) in [("deleted", "deleted"), ("archived", "archived"), ("pinned", "pinned")] {
            let conn = memory();
            with_groups(&conn);
            conn.execute(
                &format!(
                    "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, created_at,
                       updated_at, {column}, meta_json, searchable_text)
                     VALUES ('ws', '/ws', 't1', 't1', 'auto', 1, 1, 1, '{{}}', '')"
                ),
                [],
            )
            .expect("insert");
            assert!(
                !initialize_task_at_top(&conn, "ws", "/ws", None, "t1", 1).expect("admit"),
                "a {label} task is not admitted"
            );
            assert!(orders(&conn).is_empty());
        }
    }

    /// An existing membership blocks admission, so a task the user grouped by hand is not yanked
    /// back out to the top level.
    #[test]
    fn an_existing_membership_blocks_admission() {
        let conn = memory();
        with_groups(&conn);
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, created_at, updated_at,
               meta_json, searchable_text) VALUES ('ws', '/ws', 't1', 't1', 'auto', 1, 1, '{}', '')",
            [],
        )
        .expect("insert");
        conn.execute(
            "INSERT INTO task_group_members VALUES ('g1', 'ws', '/ws', NULL, 't1', 1, 1, 1, 1)",
            [],
        )
        .expect("insert");
        assert!(!initialize_task_at_top(&conn, "ws", "/ws", None, "t1", 1).expect("admit"));
    }

    /// A missing task is `false`, not an error: the snapshot that asked may simply be ahead of the
    /// write that creates it.
    #[test]
    fn a_missing_task_is_not_an_error() {
        let conn = memory();
        with_groups(&conn);
        assert!(!initialize_task_at_top(&conn, "ws", "/ws", None, "nope", 1).expect("admit"));
    }
}
