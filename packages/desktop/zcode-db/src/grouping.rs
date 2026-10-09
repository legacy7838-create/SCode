//! Task-grouping write + grouped-view ordering port of the `*TaskGroup*` / grouped methods in
//! `packages/services/src/session/taskIndexRepo.ts`. The table DDL (`task_groups`,
//! `task_group_members`, `task_group_view_node_orders`, `task_group_workspace_bootstraps`) and the
//! `getNextGroupedTopSortOrder` / `ensureSystemGroupMembership` / `TaskRef` primitives already live
//! in [`crate`]; this module reuses them and adds the user-facing group CRUD + the ordering writes
//! (create/rename/color/delete, `initializeGroupedTaskAtTop`, `applyGroupedTaskViewOrder`).
//!
//! Parity contract: same SQL semantics, same `BEGIN IMMEDIATE` boundaries where the TS wraps a
//! mutation, same idempotent `INSERT OR IGNORE` / `ON CONFLICT DO UPDATE` behaviour, same `node_key`
//! JSON form. `now` (epoch ms) is injected at every call site rather than read from the clock, so
//! the port stays deterministic and testable (TS uses `Date.now()`).

use rusqlite::{Connection, OptionalExtension};
use uuid::Uuid;

use crate::workspace_key;

/// Default group color — mirrors TS `DEFAULT_TASK_GROUP_COLOR`.
const DEFAULT_TASK_GROUP_COLOR: &str = "gray";

/// The one-time grouped-workspace-bootstrap marker row key — mirrors TS
/// `GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY`. Writing it disables the migration-style automatic
/// workspace-group init once the user has explicitly saved an ordering.
const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY: &str =
    "__zcode_internal_grouped_workspace_bootstrap_once__";

/// Port of `isTaskGroupColor`: the accepted color set (gray/red/orange/yellow/green/blue/purple).
///
/// # Arguments
///
/// * `value` - a candidate color string as stored/accepted by the TS union `ZCodeTaskGroupColor`.
pub fn is_task_group_color(value: &str) -> bool {
    matches!(
        value,
        "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple"
    )
}

/// Rust mirror of TS `ZCodeTaskGroup`. `color` is the raw stored value; [`row_to_task_group`] applies
/// the TS `isTaskGroupColor` fallback so a legacy/invalid color projects to `gray` exactly as TS does.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    pub id: String,
    pub title: String,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Port of `rowToTaskGroup`: an invalid stored color falls back to the default (`gray`).
pub(crate) fn row_to_task_group(
    group_id: String,
    title: String,
    color: String,
    created_at: i64,
    updated_at: i64,
) -> TaskGroup {
    TaskGroup {
        id: group_id,
        title,
        color: if is_task_group_color(&color) {
            color
        } else {
            DEFAULT_TASK_GROUP_COLOR.to_string()
        },
        created_at,
        updated_at,
    }
}

/// `task_group_view_node_orders.node_key` for a task node — mirrors TS `taskOrderNodeKey`, the JSON
/// of `[workspaceKey, taskId]`. The NUL-delimited form is deliberately NOT used here (node:sqlite
/// truncates TEXT after a NUL, so the ordering write/query would miss the row); the comment in the
/// TS source records exactly that hazard.
pub fn task_order_node_key(workspace_key: &str, task_id: &str) -> String {
    format!(
        "[{},{}]",
        serde_json::Value::String(workspace_key.to_string()),
        serde_json::Value::String(task_id.to_string())
    )
}

/// Port of `upsertGroupedTopOrder`: `INSERT ... ON CONFLICT(node_type, node_key) DO UPDATE SET
/// sort_order = excluded.sort_order, updated_at = excluded.updated_at`. A brand-new node keeps its
/// `created_at`; only `sort_order`/`updated_at` change on conflict — matching TS.
pub fn upsert_grouped_top_order(
    conn: &Connection,
    node_type: &str,
    node_key: &str,
    sort_order: i64,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO task_group_view_node_orders (\
           node_type, node_key, sort_order, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(node_type, node_key) DO UPDATE SET \
           sort_order = excluded.sort_order, updated_at = excluded.updated_at",
        rusqlite::params![node_type, node_key, sort_order, now, now],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Read a `task_groups` row and project it through [`row_to_task_group`]. `None` when absent.
fn fetch_task_group(conn: &Connection, group_id: &str) -> Result<Option<TaskGroup>, String> {
    conn.query_row(
        "SELECT group_id, title, color, created_at, updated_at FROM task_groups WHERE group_id = ?1",
        [group_id],
        |row| {
            Ok(row_to_task_group(
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Port of `createTaskGroup`: generate `task-group-${uuid}`, insert the group row, then give it a
/// top grouped-view order (`upsertGroupedTopOrder` at `getNextGroupedTopSortOrder`). `title` is
/// trimmed with a `"New Group"` fallback; `color` is written as-supplied WITHOUT validation (mirrors
/// the TS, which only validates color in `updateTaskGroupColor`). The two statements are individual
/// autocommit writes (no explicit transaction) — exactly as TS.
///
/// # Arguments
///
/// * `conn` - read-write connection with `PRAGMA foreign_keys = ON` (for later cascade semantics).
/// * `title` - optional raw title (trimmed; blank → `"New Group"`).
/// * `color` - optional color; when `None`, the default `gray` is used.
/// * `now` - epoch ms for both timestamps (TS `Date.now()`).
///
/// # Returns
///
/// The created [`TaskGroup`] (color as stored, i.e. unvalidated — parity with TS's returned object).
pub fn create_task_group(
    conn: &Connection,
    title: Option<&str>,
    color: Option<&str>,
    now: i64,
) -> Result<TaskGroup, String> {
    let id = format!("task-group-{}", Uuid::new_v4());
    let title = match title.map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => "New Group".to_string(),
    };
    let color = color.unwrap_or(DEFAULT_TASK_GROUP_COLOR);

    conn.execute(
        "INSERT INTO task_groups (group_id, title, color, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, title, color, now, now],
    )
    .map_err(|e| e.to_string())?;

    let sort_order = crate::get_next_grouped_top_sort_order(conn).map_err(|e| e.to_string())?;
    upsert_grouped_top_order(conn, "group", &id, sort_order, now)?;

    // The returned object mirrors TS: color is what was stored, title the trimmed value.
    Ok(TaskGroup {
        id,
        title,
        color: color.to_string(),
        created_at: now,
        updated_at: now,
    })
}

/// Port of `renameTaskGroup`: trim title (blank → `"New Group"`), guarded `UPDATE`; if no row matched
/// (`changes == 0`) error like TS ("不存在，无法重命名"), then re-read and project. No transaction.
pub fn rename_task_group(
    conn: &Connection,
    group_id: &str,
    title: &str,
    now: i64,
) -> Result<TaskGroup, String> {
    let title = {
        let t = title.trim();
        if t.is_empty() {
            "New Group".to_string()
        } else {
            t.to_string()
        }
    };
    let changes = conn
        .execute(
            "UPDATE task_groups SET title = ?1, updated_at = ?2 WHERE group_id = ?3",
            rusqlite::params![title, now, group_id],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return Err("Task group 不存在，无法重命名".to_string());
    }
    fetch_task_group(conn, group_id)?.ok_or_else(|| "Task group 重命名后读取失败".to_string())
}

/// Port of `updateTaskGroupColor`: validate the color (`isTaskGroupColor`) FIRST — an invalid color
/// errors before any write ("颜色无效"). Guarded `UPDATE`; `changes == 0` → "不存在，无法更新颜色".
/// Re-read + project. No transaction.
pub fn update_task_group_color(
    conn: &Connection,
    group_id: &str,
    color: &str,
    now: i64,
) -> Result<TaskGroup, String> {
    if !is_task_group_color(color) {
        return Err("Task group 颜色无效".to_string());
    }
    let changes = conn
        .execute(
            "UPDATE task_groups SET color = ?1, updated_at = ?2 WHERE group_id = ?3",
            rusqlite::params![color, now, group_id],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return Err("Task group 不存在，无法更新颜色".to_string());
    }
    fetch_task_group(conn, group_id)?.ok_or_else(|| "Task group 更新颜色后读取失败".to_string())
}

/// Port of `deleteTaskGroup`: one `BEGIN IMMEDIATE` wrapping the group-row delete (error if it
/// matched nothing) and the `group`-node view-order delete. Member rows cascade via the schema's
/// `ON DELETE CASCADE` FK (needs `PRAGMA foreign_keys = ON`, matching the TS connection). ROLLBACK +
/// rethrow on any failure.
pub fn delete_task_group(conn: &Connection, group_id: &str) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    match delete_task_group_inner(conn, group_id) {
        Ok(()) => conn
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

fn delete_task_group_inner(conn: &Connection, group_id: &str) -> Result<(), String> {
    let changes = conn
        .execute("DELETE FROM task_groups WHERE group_id = ?1", [group_id])
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return Err("Task group 不存在，无法删除".to_string());
    }
    conn.execute(
        "DELETE FROM task_group_view_node_orders WHERE node_type = 'group' AND node_key = ?1",
        [group_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// A task reference for the grouped ordering inputs — mirror of TS `ZCodeGroupedTaskRef`. The
/// resolved `workspaceKey` is computed from `workspacePath`/`workspaceIdentity` (never stored).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupedTaskRef {
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub task_id: String,
}

impl GroupedTaskRef {
    /// TS `workspaceKey(task)` — the resolved key used for lookups and node/order keys.
    pub fn resolved_key(&self) -> String {
        workspace_key(&self.workspace_path, self.workspace_identity.as_deref())
    }
}

/// A top-level node reference in an ordering input — mirror of `ZCodeGroupedTaskViewTopLevelNodeRef`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TopLevelNodeRef {
    #[serde(rename = "group")]
    Group { group_id: String },
    #[serde(rename = "task")]
    Task { task: GroupedTaskRef },
}

/// A group's ordered member list — mirror of the `groups[]` element of `ZCodeGroupedTaskViewOrderInput`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupOrder {
    pub group_id: String,
    pub task_refs: Vec<GroupedTaskRef>,
}

/// Input to [`apply_grouped_task_view_order`] — mirror of
/// `ZCodeGroupedTaskViewOrderInput & { provider?: ZCodeProvider }`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupedTaskViewOrderInput {
    pub workspace_scopes: Vec<crate::WorkspaceScope>,
    pub top_level_nodes: Vec<TopLevelNodeRef>,
    pub groups: Vec<GroupOrder>,
    pub provider: Option<String>,
}

/// TS `normalizeWorkspaceKeys`: distinct resolved keys of the scopes, blank ones dropped. The sort
/// TS applies is irrelevant here (consumed only as a membership set), so this returns a `HashSet`.
fn normalize_workspace_keys(scopes: &[crate::WorkspaceScope]) -> std::collections::HashSet<String> {
    scopes
        .iter()
        .map(|s| workspace_key(&s.workspace_path, s.workspace_identity.as_deref()))
        .filter(|k| !k.trim().is_empty())
        .collect()
}

/// Port of the inline `validateTaskRef` closure in `applyGroupedTaskViewOrder`: throws (`Err`) when
/// the task is out of scope or invisible (missing / deleted / archived / pinned); returns
/// `Ok(None)` (skip) when a provider filter is set and the row's provider differs; `Ok(Some(key))`
/// otherwise. `key` is the resolved workspace key.
fn validate_task_ref(
    conn: &Connection,
    workspace_keys: &std::collections::HashSet<String>,
    provider: Option<&str>,
    task: &GroupedTaskRef,
) -> Result<Option<String>, String> {
    let key = task.resolved_key();
    if !workspace_keys.contains(&key) {
        return Err("Grouped task order 包含当前 scope 外的 task".to_string());
    }
    let row = crate::get_task_index_row(conn, &key, &task.task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Grouped task order 包含不可见 task".to_string())?;
    if row.deleted == 1 || row.archived == 1 || row.pinned == 1 {
        return Err("Grouped task order 包含不可见 task".to_string());
    }
    if provider.is_some() && row.provider.as_deref() != provider {
        return Ok(None);
    }
    Ok(Some(key))
}

/// Port of `applyGroupedTaskViewOrder`: validate and de-duplicate the requested order against the
/// live scope/visibility/provider, then atomically rewrite `task_group_members` (top-level tasks
/// removed, group members upserted with `(index+1)*STEP` order), disable the workspace bootstrap
/// marker, and rebuild `task_group_view_node_orders` (all `group` nodes deleted, scoped `task` nodes
/// deleted, visible top-level nodes re-inserted at `(index+1)*STEP`).
///
/// DEFERRED: the TS method ends by returning `queryGroupedTaskView(...)`, a heavy read that depends
/// on the (un-ported) bootstrap/normalize read projection and provider-filtered `ZCodeTaskListItem`
/// list. This port faithfully reproduces every WRITE inside the transaction and returns `Ok(())`;
/// the trailing read is left for the read-subsystem slice. Do not treat the return value as the
/// post-order view.
///
/// # Arguments
///
/// * `conn` - read-write connection with `PRAGMA foreign_keys = ON`.
/// * `input` - the requested order (see [`GroupedTaskViewOrderInput`]).
/// * `now` - epoch ms for all touched timestamps.
pub fn apply_grouped_task_view_order(
    conn: &Connection,
    input: &GroupedTaskViewOrderInput,
    now: i64,
) -> Result<(), String> {
    let workspace_keys = normalize_workspace_keys(&input.workspace_scopes);

    let group_ids: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT group_id FROM task_groups")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter().collect()
    };

    // Build the validated visible top-level nodes + top-level task keys (dedup via ordered sets to
    // match the TS `Set` insertion order used later when assigning sort_order).
    let mut visible_top_level_nodes: Vec<TopLevelNodeRef> = Vec::new();
    let mut top_level_task_keys: Vec<(String, String)> = Vec::new();
    let mut top_level_task_seen: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();

    for node in &input.top_level_nodes {
        match node {
            TopLevelNodeRef::Group { group_id } => {
                if !group_ids.contains(group_id) {
                    return Err("Grouped task order 包含不存在的 group".to_string());
                }
                visible_top_level_nodes.push(node.clone());
            }
            TopLevelNodeRef::Task { task } => {
                let key = match validate_task_ref(
                    conn,
                    &workspace_keys,
                    input.provider.as_deref(),
                    task,
                )? {
                    Some(k) => k,
                    None => continue,
                };
                let pair = (key, task.task_id.clone());
                if top_level_task_seen.insert(pair.clone()) {
                    top_level_task_keys.push(pair);
                }
                visible_top_level_nodes.push(node.clone());
            }
        }
    }

    let mut visible_groups: Vec<(String, Vec<GroupedTaskRef>)> = Vec::new();
    let mut grouped_task_keys: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for group in &input.groups {
        if !group_ids.contains(&group.group_id) {
            return Err("Grouped task order 包含不存在的 group".to_string());
        }
        let mut visible_refs = Vec::new();
        for task_ref in &group.task_refs {
            let key = match validate_task_ref(
                conn,
                &workspace_keys,
                input.provider.as_deref(),
                task_ref,
            )? {
                Some(k) => k,
                None => continue,
            };
            let pair = (key, task_ref.task_id.clone());
            if grouped_task_keys.contains(&pair) {
                return Err("Grouped task order 不能让同一个 task 进入多个 group".to_string());
            }
            grouped_task_keys.insert(pair);
            visible_refs.push(task_ref.clone());
        }
        visible_groups.push((group.group_id.clone(), visible_refs));
    }

    // Only task ordering rows inside the current workspace scope get cleared; remote/other workspaces
    // keep their interleaved position. (TS builds `${ws}\0${taskId}` strings then re-splits; keeping
    // the (ws, taskId) tuples is behaviourally identical and avoids the NUL round-trip.)
    let scoped_task_keys: Vec<(String, String)> = if workspace_keys.is_empty() {
        Vec::new()
    } else {
        let keys: Vec<String> = workspace_keys.iter().cloned().collect();
        let placeholders = vec!["?"; keys.len()].join(", ");
        let sql = format!(
            "SELECT workspace_key, task_id FROM tasks WHERE workspace_key IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(keys.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let result = apply_grouped_task_view_order_inner(
        conn,
        now,
        &top_level_task_keys,
        &visible_groups,
        &scoped_task_keys,
        &visible_top_level_nodes,
    );
    match result {
        Ok(()) => conn
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

fn apply_grouped_task_view_order_inner(
    conn: &Connection,
    now: i64,
    top_level_task_keys: &[(String, String)],
    visible_groups: &[(String, Vec<GroupedTaskRef>)],
    scoped_task_keys: &[(String, String)],
    visible_top_level_nodes: &[TopLevelNodeRef],
) -> Result<(), String> {
    // The user has explicitly saved an order, so the migration-style automatic workspace-group init
    // must never fire again: record the global marker (upsert so its `updated_at` bumps on re-save).
    conn.execute(
        "INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at) \
         VALUES (?1, NULL, ?2, ?3) \
         ON CONFLICT(workspace_key) DO UPDATE SET updated_at = excluded.updated_at",
        rusqlite::params![GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())?;

    // A task promoted to top level leaves any group; recompute its membership per group below.
    for (ws, task_id) in top_level_task_keys {
        conn.execute(
            "DELETE FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2",
            rusqlite::params![ws, task_id],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())?;
    }

    let step = crate::GROUPED_TASK_ORDER_STEP;
    for (group_id, refs) in visible_groups {
        for (index, task_ref) in refs.iter().enumerate() {
            conn.execute(
                "INSERT INTO task_group_members (\
                   group_id, workspace_key, workspace_path, workspace_identity, task_id, \
                   sort_order, added_at, created_at, updated_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                 ON CONFLICT(workspace_key, task_id) DO UPDATE SET \
                   group_id = excluded.group_id, workspace_path = excluded.workspace_path, \
                   workspace_identity = excluded.workspace_identity, sort_order = excluded.sort_order, \
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    group_id,
                    task_ref.resolved_key(),
                    task_ref.workspace_path,
                    task_ref.workspace_identity,
                    task_ref.task_id,
                    (index as i64 + 1) * step,
                    now,
                    now,
                    now
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())?;
        }
    }

    // One atomic rebuild of the top-level ordering: drop every group node, drop the in-scope task
    // nodes, then re-insert the visible sequence at (index+1)*STEP.
    conn.execute(
        "DELETE FROM task_group_view_node_orders WHERE node_type = 'group'",
        [],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())?;

    for (ws, task_id) in scoped_task_keys {
        conn.execute(
            "DELETE FROM task_group_view_node_orders \
             WHERE node_type = 'task' AND (node_key = ?1 OR node_key = ?2)",
            rusqlite::params![task_order_node_key(ws, task_id), ws],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())?;
    }

    for (index, node) in visible_top_level_nodes.iter().enumerate() {
        let (node_type, node_key) = match node {
            TopLevelNodeRef::Group { group_id } => ("group", group_id.clone()),
            TopLevelNodeRef::Task { task } => (
                "task",
                task_order_node_key(&task.resolved_key(), &task.task_id),
            ),
        };
        conn.execute(
            "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![node_type, node_key, (index as i64 + 1) * step, now, now],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Port of `initializeGroupedTaskAtTopReady`: prepend a freshly-visible root task to the top of the
/// grouped view, ONCE. Returns `false` (and writes nothing) when the task row is missing or
/// deleted/archived/pinned, or when it already has a membership row or a `task` view-order row — the
/// guard that keeps a slow duplicate snapshot from grabbing the minimum sort order after newer tasks
/// (see the TS comment). The insert is a single autocommit `upsertGroupedTopOrder` (no transaction).
pub fn initialize_grouped_task_at_top(
    conn: &Connection,
    task: &GroupedTaskRef,
    now: i64,
) -> Result<bool, String> {
    let ws = task.resolved_key();
    let row =
        match crate::get_task_index_row(conn, &ws, &task.task_id).map_err(|e| e.to_string())? {
            Some(r) => r,
            None => return Ok(false),
        };
    if row.deleted == 1 || row.archived == 1 || row.pinned == 1 {
        return Ok(false);
    }

    let existing_member: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2 LIMIT 1",
            rusqlite::params![ws, task.task_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let node_key = task_order_node_key(&ws, &task.task_id);
    let existing_top_order: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?1 LIMIT 1",
            [&node_key],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing_member.is_some() || existing_top_order.is_some() {
        return Ok(false);
    }

    let sort_order = crate::get_next_grouped_top_sort_order(conn).map_err(|e| e.to_string())?;
    upsert_grouped_top_order(conn, "task", &node_key, sort_order, now)?;
    Ok(true)
}

// ---- Grouped-view structure read (no task join, no bootstrap/normalize side effects) ----

/// A member row projected for [`query_grouped_task_view_structure`] — mirror of
/// `ZCodeGroupedTaskViewStructureMember` (camelCase, `workspaceIdentity` omitted when absent).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureMember {
    pub group_id: String,
    pub workspace_key: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    pub task_id: String,
    pub sort_order: Option<i64>,
    pub added_at: i64,
}

/// A top-level ordering node — mirror of the `ZCodeGroupedTaskViewStructureTopOrder` discriminated
/// union (`{ type: "group" } | { type: "task" }`). Serialized with `type` as the tag.
///
/// Note: the enum container's `rename_all` renames only the variant NAMES; the struct-variant FIELDS
/// need their own `rename_all = "camelCase"` per variant (else they serialize snake_case and diverge
/// from the TS camelCase payload — caught by the read parity harness).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type")]
pub enum StructureTopOrder {
    #[serde(rename = "group", rename_all = "camelCase")]
    Group { group_id: String, sort_order: i64 },
    #[serde(rename = "task", rename_all = "camelCase")]
    Task {
        workspace_key: String,
        task_id: String,
        sort_order: i64,
    },
}

/// The full structure payload — mirror of `ZCodeGroupedTaskViewStructure`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedTaskViewStructure {
    pub groups: Vec<TaskGroup>,
    pub members: Vec<StructureMember>,
    pub top_level_orders: Vec<StructureTopOrder>,
}

/// Port of `queryGroupedTaskViewStructure`: read the three grouping tables and project them, WITHOUT
/// touching `tasks` and WITHOUT the bootstrap/normalize write-back that `queryGroupedTaskView` does.
/// Group visibility follows the same rule — a bootstrapped workspace group is shown only when its
/// workspace is in `scopes`. Task `node_key`s are parsed from their JSON `[workspaceKey, taskId]`
/// form; a dirty/non-conforming key is skipped (the client re-sorts by createdAt in memory).
///
/// Iteration order is the raw table order (no `ORDER BY`), matching the TS `.all()` calls; two DBs
/// seeded identically yield identical ordering.
pub fn query_grouped_task_view_structure(
    conn: &Connection,
    scopes: &[crate::WorkspaceScope],
) -> Result<GroupedTaskViewStructure, String> {
    let visible = normalize_workspace_keys(scopes);

    // group_id → bootstrap workspace_key (only rows with a non-null group id).
    let mut bootstrap_map = std::collections::HashMap::<String, String>::new();
    {
        let mut stmt = conn
            .prepare("SELECT workspace_key, group_id FROM task_group_workspace_bootstraps WHERE group_id IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (ws, gid) = row.map_err(|e| e.to_string())?;
            bootstrap_map.insert(gid, ws);
        }
    }

    let mut groups = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT group_id, title, color, created_at, updated_at FROM task_groups")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (group_id, title, color, created_at, updated_at) = row.map_err(|e| e.to_string())?;
            // A bootstrapped group is visible only when its workspace is in scope.
            if let Some(ws) = bootstrap_map.get(&group_id) {
                if !visible.contains(ws) {
                    continue;
                }
            }
            groups.push(row_to_task_group(group_id, title, color, created_at, updated_at));
        }
    }

    let mut members = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT group_id, workspace_key, workspace_path, workspace_identity, task_id, \
                 sort_order, added_at FROM task_group_members",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(StructureMember {
                    group_id: r.get(0)?,
                    workspace_key: r.get(1)?,
                    workspace_path: r.get(2)?,
                    workspace_identity: r.get(3)?,
                    task_id: r.get(4)?,
                    sort_order: r.get(5)?,
                    added_at: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            members.push(row.map_err(|e| e.to_string())?);
        }
    }

    let mut top_level_orders = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT node_type, node_key, sort_order FROM task_group_view_node_orders")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (node_type, node_key, sort_order) = row.map_err(|e| e.to_string())?;
            if node_type == "group" {
                top_level_orders.push(StructureTopOrder::Group {
                    group_id: node_key,
                    sort_order,
                });
                continue;
            }
            // task node_key is the JSON of [workspaceKey, taskId]; skip any dirty/non-conforming key.
            if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(&node_key) {
                if arr.len() == 2 {
                    if let (Some(ws), Some(tid)) = (arr[0].as_str(), arr[1].as_str()) {
                        top_level_orders.push(StructureTopOrder::Task {
                            workspace_key: ws.to_string(),
                            task_id: tid.to_string(),
                            sort_order,
                        });
                    }
                }
            }
        }
    }

    Ok(GroupedTaskViewStructure {
        groups,
        members,
        top_level_orders,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::adopt_schema;
    use rusqlite::Connection;

    /// In-memory DB with the full adopted schema and the FK pragma the TS connection sets, so
    /// `ON DELETE CASCADE` behaves identically.
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        adopt_schema(&conn).expect("adopt schema");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("fk on");
        conn
    }

    fn insert_task(
        conn: &Connection,
        ws: &str,
        task_id: &str,
        deleted: i64,
        archived: i64,
        pinned: i64,
    ) {
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, mode, created_at, updated_at, \
             deleted, archived, pinned) VALUES (?1, ?2, ?3, 'build', 1, 1, ?4, ?5, ?6)",
            rusqlite::params![ws, ws, task_id, deleted, archived, pinned],
        )
        .expect("insert task");
    }

    fn node_order(conn: &Connection, node_key: &str) -> Option<i64> {
        conn.query_row(
            "SELECT sort_order FROM task_group_view_node_orders WHERE node_key = ?1",
            [node_key],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .expect("query")
    }

    #[test]
    fn is_task_group_color_set() {
        for c in ["gray", "red", "orange", "yellow", "green", "blue", "purple"] {
            assert!(is_task_group_color(c), "{c}");
        }
        assert!(!is_task_group_color("pink"));
        assert!(!is_task_group_color(""));
    }

    #[test]
    fn task_order_node_key_is_json_pair() {
        assert_eq!(
            task_order_node_key("/ws", "t1"),
            r#"["/ws","t1"]"#,
            "node_key is the JSON of [workspaceKey, taskId] (not NUL-joined)"
        );
    }

    #[test]
    fn create_group_inserts_row_and_top_order() {
        let conn = setup();
        let g = create_task_group(&conn, Some("  Work  "), Some("blue"), 100).unwrap();
        // Id mirrors TS `task-group-${randomUUID()}`: prefix + a 36-char v4 UUID.
        let uuid_part =
            g.id.strip_prefix("task-group-")
                .expect("task-group- prefix");
        assert_eq!(uuid_part.len(), 36);
        assert_eq!(uuid_part.matches('-').count(), 4);
        assert_eq!(g.title, "Work", "title trimmed");
        assert_eq!(g.color, "blue");
        assert_eq!(g.created_at, 100);

        // Group node exists with the top sort order (empty table → 1000).
        let stored = node_order(&conn, &g.id).expect("group node order row");
        assert_eq!(stored, 1000);

        let row = fetch_task_group(&conn, &g.id).unwrap().unwrap();
        assert_eq!(row.title, "Work");
    }

    #[test]
    fn create_group_defaults_title_and_color() {
        let conn = setup();
        let g = create_task_group(&conn, Some("   "), None, 5).unwrap();
        assert_eq!(g.title, "New Group");
        assert_eq!(g.color, "gray");
    }

    #[test]
    fn create_group_prepends_relative_to_existing_min() {
        let conn = setup();
        let first = create_task_group(&conn, Some("A"), None, 1).unwrap();
        assert_eq!(node_order(&conn, &first.id), Some(1000));
        let second = create_task_group(&conn, Some("B"), None, 2).unwrap();
        assert_eq!(
            node_order(&conn, &second.id),
            Some(0),
            "next top = min(1000) - 1000 = 0, so the newest group sorts first"
        );
    }

    #[test]
    fn rename_and_update_color_are_guarded() {
        let conn = setup();
        let g = create_task_group(&conn, Some("Old"), Some("gray"), 1).unwrap();
        let r = rename_task_group(&conn, &g.id, "  Fresh  ", 9).unwrap();
        assert_eq!(r.title, "Fresh");
        assert_eq!(r.updated_at, 9);

        let c = update_task_group_color(&conn, &g.id, "green", 10).unwrap();
        assert_eq!(c.color, "green");

        assert!(rename_task_group(&conn, "missing", "x", 1).is_err());
        assert!(update_task_group_color(&conn, "missing", "green", 1).is_err());
        assert!(update_task_group_color(&conn, &g.id, "chartreuse", 1).is_err());
    }

    #[test]
    fn row_to_group_falls_back_for_bad_stored_color() {
        let conn = setup();
        conn.execute(
            "INSERT INTO task_groups (group_id, title, color, created_at, updated_at) VALUES ('g1','t','pink',1,1)",
            [],
        )
        .unwrap();
        let g = fetch_task_group(&conn, "g1").unwrap().unwrap();
        assert_eq!(
            g.color, "gray",
            "invalid stored color projects to default (parity with TS)"
        );
    }

    #[test]
    fn delete_group_cascades_members_and_drops_node() {
        let conn = setup();
        let g = create_task_group(&conn, Some("Del"), None, 1).unwrap();
        insert_task(&conn, "/ws", "t1", 0, 0, 0);
        conn.execute(
            "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, task_id, sort_order, added_at, created_at, updated_at) \
             VALUES (?1, '/ws', '/ws', 't1', 1000, 1, 1, 1)",
            [&g.id],
        )
        .unwrap();
        assert!(node_order(&conn, &g.id).is_some());

        delete_task_group(&conn, &g.id).unwrap();
        assert!(fetch_task_group(&conn, &g.id).unwrap().is_none());
        assert!(
            node_order(&conn, &g.id).is_none(),
            "group view-order node removed"
        );
        let members: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_group_members WHERE group_id = ?1",
                [&g.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 0, "membership rows cascade on group delete");

        assert!(delete_task_group(&conn, "missing").is_err());
    }

    #[test]
    fn initialize_at_top_prepends_once() {
        let conn = setup();
        insert_task(&conn, "/ws", "t1", 0, 0, 0);
        let task = GroupedTaskRef {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            task_id: "t1".to_string(),
        };
        assert!(initialize_grouped_task_at_top(&conn, &task, 1).unwrap());
        let key = task_order_node_key("/ws", "t1");
        assert_eq!(node_order(&conn, &key), Some(1000));

        // Idempotent: a second call finds the existing task node and does nothing.
        assert!(!initialize_grouped_task_at_top(&conn, &task, 2).unwrap());
        assert_eq!(node_order(&conn, &key), Some(1000));
    }

    #[test]
    fn initialize_at_top_skips_invisible_tasks() {
        let conn = setup();
        // Missing row.
        let missing = GroupedTaskRef {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            task_id: "nope".to_string(),
        };
        assert!(!initialize_grouped_task_at_top(&conn, &missing, 1).unwrap());

        for (id, d, a, p) in [("del", 1, 0, 0), ("arch", 0, 1, 0), ("pin", 0, 0, 1)] {
            insert_task(&conn, "/ws", id, d, a, p);
            let task = GroupedTaskRef {
                workspace_path: "/ws".to_string(),
                workspace_identity: None,
                task_id: id.to_string(),
            };
            assert!(
                !initialize_grouped_task_at_top(&conn, &task, 1).unwrap(),
                "deleted/archived/pinned tasks are not prepended"
            );
        }
    }

    #[test]
    fn apply_order_rewrites_membership_and_top_order() {
        let conn = setup();
        let ga = create_task_group(&conn, Some("A"), None, 1).unwrap();
        let gb = create_task_group(&conn, Some("B"), None, 2).unwrap();
        insert_task(&conn, "/ws", "t1", 0, 0, 0);
        insert_task(&conn, "/ws", "t2", 0, 0, 0);
        // t2 starts as a member of gb (so promoting it to top must delete that membership).
        conn.execute(
            "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, task_id, sort_order, added_at, created_at, updated_at) \
             VALUES (?1, '/ws', '/ws', 't2', 5000, 1, 1, 1)",
            [&gb.id],
        )
        .unwrap();

        let scope = crate::WorkspaceScope {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            workspace_purpose: None,
        };
        let t1 = GroupedTaskRef {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            task_id: "t1".to_string(),
        };
        let t2 = GroupedTaskRef {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            task_id: "t2".to_string(),
        };
        let input = GroupedTaskViewOrderInput {
            workspace_scopes: vec![scope],
            // Sequence: gb, then t1 at top level, then ga; group gb holds t1 as first member.
            top_level_nodes: vec![
                TopLevelNodeRef::Group {
                    group_id: gb.id.clone(),
                },
                TopLevelNodeRef::Task { task: t2.clone() },
                TopLevelNodeRef::Group {
                    group_id: ga.id.clone(),
                },
            ],
            groups: vec![GroupOrder {
                group_id: gb.id.clone(),
                task_refs: vec![t1.clone()],
            }],
            provider: None,
        };

        apply_grouped_task_view_order(&conn, &input, 100).unwrap();

        // Top-level nodes re-inserted at (index+1)*STEP: gb=1000, t2=2000, ga=3000.
        assert_eq!(node_order(&conn, &gb.id), Some(1000));
        assert_eq!(
            node_order(&conn, &task_order_node_key("/ws", "t2")),
            Some(2000)
        );
        assert_eq!(node_order(&conn, &ga.id), Some(3000));

        // t2 promoted to top → its gb membership row is gone.
        let t2_member: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_group_members WHERE task_id='t2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(t2_member, 0);

        // t1 upserted into gb with sort_order = (0+1)*STEP = 1000.
        let (gid, so): (String, i64) = conn
            .query_row(
                "SELECT group_id, sort_order FROM task_group_members WHERE task_id='t1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(gid, gb.id);
        assert_eq!(so, 1000);

        // Bootstrap marker written (workspace_group auto-init disabled after an explicit save).
        let marker: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_group_workspace_bootstraps WHERE workspace_key = ?1",
                [GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marker, 1);
    }

    #[test]
    fn apply_order_rejects_unknown_group_and_invisible_task() {
        let conn = setup();
        let scope = crate::WorkspaceScope {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            workspace_purpose: None,
        };
        let unknown_group = GroupedTaskViewOrderInput {
            workspace_scopes: vec![scope.clone()],
            top_level_nodes: vec![TopLevelNodeRef::Group {
                group_id: "ghost".to_string(),
            }],
            groups: vec![],
            provider: None,
        };
        assert!(apply_grouped_task_view_order(&conn, &unknown_group, 1).is_err());

        insert_task(&conn, "/ws", "gone", 1, 0, 0);
        let invisible_task = GroupedTaskViewOrderInput {
            workspace_scopes: vec![scope],
            top_level_nodes: vec![TopLevelNodeRef::Task {
                task: GroupedTaskRef {
                    workspace_path: "/ws".to_string(),
                    workspace_identity: None,
                    task_id: "gone".to_string(),
                },
            }],
            groups: vec![],
            provider: None,
        };
        assert!(apply_grouped_task_view_order(&conn, &invisible_task, 1).is_err());
    }

    #[test]
    fn apply_order_rejects_same_task_in_two_groups() {
        let conn = setup();
        let g1 = create_task_group(&conn, Some("1"), None, 1).unwrap();
        let g2 = create_task_group(&conn, Some("2"), None, 2).unwrap();
        insert_task(&conn, "/ws", "t1", 0, 0, 0);
        let task = GroupedTaskRef {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            task_id: "t1".to_string(),
        };
        let input = GroupedTaskViewOrderInput {
            workspace_scopes: vec![crate::WorkspaceScope {
                workspace_path: "/ws".to_string(),
                workspace_identity: None,
                workspace_purpose: None,
            }],
            top_level_nodes: vec![],
            groups: vec![
                GroupOrder {
                    group_id: g1.id,
                    task_refs: vec![task.clone()],
                },
                GroupOrder {
                    group_id: g2.id,
                    task_refs: vec![task],
                },
            ],
            provider: None,
        };
        assert!(apply_grouped_task_view_order(&conn, &input, 1).is_err());
    }

    #[test]
    fn apply_order_provider_mismatch_skips_task_without_error() {
        let conn = setup();
        let g = create_task_group(&conn, Some("G"), None, 1).unwrap();
        // Row provider is NULL; a glm filter → validateTaskRef returns skip (Ok(None)).
        insert_task(&conn, "/ws", "t1", 0, 0, 0);
        let input = GroupedTaskViewOrderInput {
            workspace_scopes: vec![crate::WorkspaceScope {
                workspace_path: "/ws".to_string(),
                workspace_identity: None,
                workspace_purpose: None,
            }],
            top_level_nodes: vec![TopLevelNodeRef::Task {
                task: GroupedTaskRef {
                    workspace_path: "/ws".to_string(),
                    workspace_identity: None,
                    task_id: "t1".to_string(),
                },
            }],
            groups: vec![GroupOrder {
                group_id: g.id,
                task_refs: vec![GroupedTaskRef {
                    workspace_path: "/ws".to_string(),
                    workspace_identity: None,
                    task_id: "t1".to_string(),
                }],
            }],
            provider: Some("glm".to_string()),
        };
        apply_grouped_task_view_order(&conn, &input, 10).unwrap();
        // The skipped task must not appear as a member or a top-level node.
        let members: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_group_members WHERE task_id='t1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 0);
        assert!(node_order(&conn, &task_order_node_key("/ws", "t1")).is_none());
    }

    #[test]
    fn apply_order_rolls_back_on_error() {
        // A task that belongs to two groups throws AFTER group membership writes begin, so the
        // BEGIN IMMEDIATE must roll the whole mutation back (task still has no membership).
        let conn = setup();
        let g1 = create_task_group(&conn, Some("1"), None, 1).unwrap();
        let g2 = create_task_group(&conn, Some("2"), None, 2).unwrap();
        insert_task(&conn, "/ws", "t1", 0, 0, 0);
        // Give t1 an initial membership in g1; a failed apply must leave it untouched.
        conn.execute(
            "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, task_id, sort_order, added_at, created_at, updated_at) \
             VALUES (?1, '/ws', '/ws', 't1', 1000, 1, 1, 1)",
            [&g1.id],
        )
        .unwrap();

        let task = GroupedTaskRef {
            workspace_path: "/ws".to_string(),
            workspace_identity: None,
            task_id: "t1".to_string(),
        };
        let input = GroupedTaskViewOrderInput {
            workspace_scopes: vec![crate::WorkspaceScope {
                workspace_path: "/ws".to_string(),
                workspace_identity: None,
                workspace_purpose: None,
            }],
            top_level_nodes: vec![],
            groups: vec![
                GroupOrder {
                    group_id: g2.id,
                    task_refs: vec![task.clone()],
                },
                GroupOrder {
                    group_id: g1.id.clone(),
                    task_refs: vec![task],
                },
            ],
            provider: None,
        };
        assert!(apply_grouped_task_view_order(&conn, &input, 50).is_err());
        // Pre-existing membership (group g1, sort_order 1000) survived the rollback.
        let (gid, so): (String, i64) = conn
            .query_row(
                "SELECT group_id, sort_order FROM task_group_members WHERE task_id='t1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(gid, g1.id);
        assert_eq!(so, 1000);
    }

    #[test]
    fn apply_order_deletes_in_scope_task_order_rows_only() {
        let conn = setup();
        insert_task(&conn, "/ws", "t1", 0, 0, 0);
        insert_task(&conn, "/other", "t9", 0, 0, 0);
        // Pre-existing task order rows for both workspaces.
        conn.execute(
            "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) \
             VALUES ('task', ?1, 7000, 1, 1)",
            [task_order_node_key("/ws", "t1")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) \
             VALUES ('task', ?1, 8000, 1, 1)",
            [task_order_node_key("/other", "t9")],
        )
        .unwrap();

        let input = GroupedTaskViewOrderInput {
            workspace_scopes: vec![crate::WorkspaceScope {
                workspace_path: "/ws".to_string(),
                workspace_identity: None,
                workspace_purpose: None,
            }],
            top_level_nodes: vec![],
            groups: vec![],
            provider: None,
        };
        apply_grouped_task_view_order(&conn, &input, 1).unwrap();
        assert!(
            node_order(&conn, &task_order_node_key("/ws", "t1")).is_none(),
            "in-scope task order row cleared"
        );
        assert_eq!(
            node_order(&conn, &task_order_node_key("/other", "t9")),
            Some(8000),
            "out-of-scope task order row preserved"
        );
    }
}
