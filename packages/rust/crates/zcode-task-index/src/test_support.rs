//! The schema the unit tests build, in one place.
//!
//! Four modules need a `tasks` table, and each one previously declared its own. That is how the
//! read path ends up with a projection a fixture does not have: a column missing from the test
//! schema is a column whose `row.get` failure only appears against the real database.
#![cfg(test)]

use rusqlite::Connection;

/// The `tasks` table, matching `TASK_INDEX_SCHEMA` closely enough for the read path.
pub const TASKS_SCHEMA: &str = "CREATE TABLE tasks (
   workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
   task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
   mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT,
   forked_from_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
   unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
   pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
   deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
   meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '',
   cron_automation_id TEXT, off_peak_task_id TEXT,
   PRIMARY KEY (workspace_key, task_id));";

/// The `task_group_workspace_bootstraps` marker table.
pub const BOOTSTRAP_SCHEMA: &str = "CREATE TABLE task_group_workspace_bootstraps (
   workspace_key TEXT PRIMARY KEY, group_id TEXT,
   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)";

/// An in-memory database with the read path's tables.
pub fn memory() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory");
    conn.execute_batch(TASKS_SCHEMA).expect("tasks schema");
    conn.execute_batch(BOOTSTRAP_SCHEMA).expect("bootstrap schema");
    conn
}

/// A `meta_json` that validates, for a task whose document is not the thing under test.
pub fn meta_json(task_id: &str, updated_at: i64) -> String {
    format!(
        r#"{{"taskId":"{task_id}","traceId":"tr","title":"{task_id}","workspacePath":"/ws","createdAt":1,"updatedAt":{updated_at},"mode":"auto"}}"#
    )
}
