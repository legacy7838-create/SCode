//! Faithful port of `TaskIndexRepo.queryGroupedTaskView` — the grouped-list view read.
//!
//! This surface is NOT a pure read: like the TS it runs the one-shot workspace-group bootstrap and
//! the two lazy order-normalization writes (member + top-level) during the query, then assembles the
//! nested node list. Everything is deterministic given an injected `now` so the port is testable.
//!
//! Parity contract: identical SQL predicates, identical ordering rules, identical `BEGIN IMMEDIATE`
//! write boundaries, identical `node_key` encodings (JSON for view-node orders, NUL-joined for member
//! maps), and the same bootstrap global marker semantics.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

use crate::grouping::{TaskGroup, row_to_task_group, task_order_node_key};
use crate::{
    CRON_DEFAULT_GROUP_ID, GROUPED_TASK_ORDER_STEP, TASK_INDEX_ROW_COLUMNS, WorkspaceScope,
    map_task_index_row, row_to_meta, workspace_key, TaskIndexRow, TaskMeta,
};

/// Bootstrap group colors — TS `WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS`.
const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS: [&str; 6] =
    ["red", "orange", "yellow", "green", "blue", "purple"];
/// Global one-shot marker row — TS `GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY`.
const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY: &str =
    "__zcode_internal_grouped_workspace_bootstrap_once__";

/// A group member row projected for ordering (subset of the columns the assembly reads).
struct Member {
    group_id: String,
    workspace_key: String,
    task_id: String,
    sort_order: Option<i64>,
    added_at: i64,
}

/// One node's mutable assembly state before serialization.
#[allow(clippy::large_enum_variant)] // transient in-memory assembly type; boxing adds churn with no
                                      // benefit (both variants are immediately converted on return).
enum ViewNode {
    Group {
        group: TaskGroup,
        tasks: Vec<TaskMeta>,
        sort_order: Option<i64>,
    },
    Task {
        task: TaskMeta,
        sort_order: Option<i64>,
    },
}

impl ViewNode {
    /// `{nodeType, nodeKey, mapKey}` — TS `groupedTopNodeOrderRef`.
    fn order_ref(&self) -> (&'static str, String, String) {
        match self {
            ViewNode::Group { group, .. } => {
                ("group", group.id.clone(), format!("group:{}", group.id))
            }
            ViewNode::Task { task, .. } => {
                let nk = task_order_node_key(
                    &workspace_key(&task.workspace_path, task.workspace_identity.as_deref()),
                    &task.task_id,
                );
                ("task", nk.clone(), format!("task:{nk}"))
            }
        }
    }
    /// The `created_at` used for the top-order normalization tie-break.
    fn created_at(&self) -> i64 {
        match self {
            ViewNode::Group { group, .. } => group.created_at,
            ViewNode::Task { task, .. } => task.created_at,
        }
    }
    fn set_sort_order(&mut self, v: i64) {
        match self {
            ViewNode::Group { sort_order, .. } | ViewNode::Task { sort_order, .. } => {
                *sort_order = Some(v);
            }
        }
    }
}

/// `sha256(key)` as lowercase hex.
fn sha256_hex(key: &str) -> String {
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// TS `workspaceGroupId`.
fn workspace_group_id(target_workspace_key: &str) -> String {
    format!("workspace-group-{}", &sha256_hex(target_workspace_key)[..24])
}

/// TS `workspaceGroupTitle` — last non-empty path segment (slashes stripped), trimmed, fallback.
fn workspace_group_title(workspace_path: &str) -> String {
    let normalized = workspace_path.trim_end_matches(['/', '\\']);
    let mut leaf: Option<&str> = None;
    for seg in normalized.split(['/', '\\']) {
        if !seg.is_empty() {
            leaf = Some(seg);
        }
    }
    match leaf.map(str::trim).filter(|s| !s.is_empty()) {
        Some(l) => l.to_string(),
        None => {
            let t = normalized.trim();
            if t.is_empty() {
                "Workspace".to_string()
            } else {
                t.to_string()
            }
        }
    }
}

/// TS `workspaceGroupColor` — first digest byte mod palette length.
fn workspace_group_color(target_workspace_key: &str) -> &'static str {
    let mut h = Sha256::new();
    h.update(target_workspace_key.as_bytes());
    let byte = h.finalize()[0];
    WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS
        [(byte as usize) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.len()]
}

/// A candidate workspace scope for the bootstrap (resolved key + path). Membership rows carry the
/// task's own identity (from the row), so the scope's identity is only used to resolve the key above.
struct BootstrapScope {
    workspace_key: String,
    workspace_path: String,
}

/// The grouped top-order + member normalization is locale-aware in TS (`localeCompare`). For the
/// ASCII workspace/task keys this ordering matches Rust's byte comparison; the parity harness guards
/// against non-ASCII divergence. See `locale_cmp`.
fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.cmp(b)
}

/// TS `taskNodeKey` — resolved workspace key NUL-joined with the task id (member-map key form).
fn task_node_key(task: &TaskMeta) -> String {
    format!(
        "{}\u{0}{}",
        workspace_key(&task.workspace_path, task.workspace_identity.as_deref()),
        task.task_id
    )
}

/// Query the active (visible, non-deleted/archived/pinned) task rows for the view.
fn query_active_task_rows(
    conn: &Connection,
    scopes: &[WorkspaceScope],
    include_all: bool,
    provider: Option<&str>,
) -> Result<Vec<TaskIndexRow>, String> {
    let keys: Vec<String> = if include_all {
        Vec::new()
    } else {
        scopes
            .iter()
            .map(|s| workspace_key(&s.workspace_path, s.workspace_identity.as_deref()))
            .filter(|k| !k.trim().is_empty())
            .collect()
    };
    if !include_all && keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = format!(
        "SELECT {TASK_INDEX_ROW_COLUMNS} FROM tasks WHERE deleted = 0 AND archived = 0 AND pinned = 0"
    );
    let mut binds: Vec<String> = Vec::new();
    if !include_all {
        let ph: Vec<String> = (0..keys.len()).map(|i| format!("?{}", i + 1)).collect();
        sql.push_str(&format!(" AND workspace_key IN ({})", ph.join(", ")));
        binds = keys.clone();
    }
    if let Some(p) = provider {
        sql.push_str(&format!(" AND provider = ?{}", binds.len() + 1));
        binds.push(p.to_string());
    }
    sql.push_str(" ORDER BY updated_at DESC, created_at DESC, task_id DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn rusqlite::types::ToSql> =
        binds.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt
        .query_map(refs.as_slice(), map_task_index_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Whether the global workspace-bootstrap has already run.
fn has_bootstrap_run(conn: &Connection) -> Result<bool, String> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM task_group_workspace_bootstraps LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.is_some())
}

/// One-shot workspace-group bootstrap (TS `bootstrapWorkspaceGroupsForActiveTasks`). Creates a
/// per-workspace group from the current tasks, rebuilding membership (newest-first), and stamps the
/// global marker. No-op when the marker exists.
fn bootstrap_workspace_groups(
    conn: &Connection,
    scopes: &[BootstrapScope],
    active_tasks: &[TaskIndexRow],
    now: i64,
) -> Result<(), String> {
    if scopes.is_empty() || has_bootstrap_run(conn)? {
        return Ok(());
    }
    let mut by_ws: HashMap<String, Vec<&TaskIndexRow>> = HashMap::new();
    for row in active_tasks {
        by_ws.entry(row.workspace_key.clone()).or_default().push(row);
    }
    let mark_sql = "INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at) VALUES (?1, NULL, ?2, ?3) ON CONFLICT(workspace_key) DO UPDATE SET updated_at = excluded.updated_at";
    if by_ws.is_empty() {
        conn.execute(mark_sql, params![GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let mut existing_group_order_keys: HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'group'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())?
    };
    let max_order: i64 = conn
        .query_row(
            "SELECT MAX(sort_order) FROM task_group_view_node_orders",
            [],
            |r| r.get::<_, Option<i64>>(0).map(|v| v.unwrap_or(0)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let mut next_group_sort = max_order;

    conn.execute("BEGIN IMMEDIATE", []).map_err(|e| e.to_string())?;
    let run = (|| -> Result<(), String> {
        conn.execute(mark_sql, params![GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now])
            .map_err(|e| e.to_string())?;
        for scope in scopes {
            let rows = match by_ws.get(&scope.workspace_key) {
                Some(r) => r,
                None => continue,
            };
            // Newest first (updated_at DESC, created_at DESC, task_id ASC) — TS groupedRows.sort.
            let mut grouped: Vec<&TaskIndexRow> = rows.clone();
            grouped.sort_by(|l, r| {
                r.updated_at
                    .cmp(&l.updated_at)
                    .then(r.created_at.cmp(&l.created_at))
                    .then_with(|| locale_cmp(&l.task_id, &r.task_id))
            });
            if grouped.is_empty() {
                continue;
            }
            let gid = workspace_group_id(&scope.workspace_key);
            conn.execute(
                "INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![gid, workspace_group_title(&scope.workspace_path), workspace_group_color(&scope.workspace_key), now, now],
            )
            .map_err(|e| e.to_string())?;
            if !existing_group_order_keys.contains(&gid) {
                next_group_sort += GROUPED_TASK_ORDER_STEP;
                conn.execute(
                    "INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) VALUES ('group', ?1, ?2, ?3, ?4)",
                    params![gid, next_group_sort, now, now],
                )
                .map_err(|e| e.to_string())?;
                existing_group_order_keys.insert(gid.clone());
            }
            for (idx, row) in grouped.iter().enumerate() {
                conn.execute(
                    "DELETE FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2",
                    params![row.workspace_key, row.task_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, workspace_identity, task_id, sort_order, added_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(workspace_key, task_id) DO UPDATE SET group_id = excluded.group_id, workspace_path = excluded.workspace_path, workspace_identity = excluded.workspace_identity, sort_order = excluded.sort_order, updated_at = excluded.updated_at",
                    params![gid, row.workspace_key, row.workspace_path, row.workspace_identity, row.task_id, (idx as i64 + 1) * GROUPED_TASK_ORDER_STEP, now, now, now],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?1",
                    params![task_order_node_key(&row.workspace_key, &row.task_id)],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute(
                "INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workspace_key) DO UPDATE SET group_id = excluded.group_id, updated_at = excluded.updated_at",
                params![scope.workspace_key, gid, now, now],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "DELETE FROM task_groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM task_group_members)",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM task_group_view_node_orders WHERE node_type = 'group' AND node_key NOT IN (SELECT group_id FROM task_groups)",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match run {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// A serialized grouped-view node (mirror of `ZCodeGroupedTaskViewNode`).
#[derive(Serialize)]
#[serde(tag = "type")]
#[allow(clippy::large_enum_variant)] // serialized output mirror of the TS union; not a hot path.
pub enum GroupedTaskViewNode {
    #[serde(rename = "group", rename_all = "camelCase")]
    Group {
        group: TaskGroup,
        tasks: Vec<TaskMeta>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sort_order: Option<i64>,
    },
    #[serde(rename = "task", rename_all = "camelCase")]
    Task {
        task: TaskMeta,
        #[serde(skip_serializing_if = "Option::is_none")]
        sort_order: Option<i64>,
    },
}

/// The grouped view payload — mirror of `ZCodeGroupedTaskView`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedTaskView {
    pub nodes: Vec<GroupedTaskViewNode>,
}

/// TS `normalizeGroupMemberOrders` — assign a sort_order to group members that are members but have
/// a null sort (added before ordering existed), newest-added first, inside one `BEGIN IMMEDIATE`.
/// Also mutates the in-memory member map so the subsequent group sort sees the new values.
fn normalize_group_member_orders(
    conn: &Connection,
    group_id: &str,
    tasks: &[TaskMeta],
    member_by_task_key: &mut HashMap<String, Member>,
    now: i64,
) -> Result<(), String> {
    let mut missing: Vec<&TaskMeta> = tasks
        .iter()
        .filter(|t| {
            member_by_task_key
                .get(&task_node_key(t))
                .map(|m| m.sort_order.is_none())
                .unwrap_or(false)
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    missing.sort_by(|l, r| {
        let la = member_by_task_key
            .get(&task_node_key(l))
            .map(|m| m.added_at)
            .unwrap_or(l.created_at);
        let ra = member_by_task_key
            .get(&task_node_key(r))
            .map(|m| m.added_at)
            .unwrap_or(r.created_at);
        ra.cmp(&la).then_with(|| locale_cmp(&task_node_key(l), &task_node_key(r)))
    });
    let max: i64 = conn
        .query_row(
            "SELECT MAX(sort_order) FROM task_group_members WHERE group_id = ?1",
            params![group_id],
            |r| r.get::<_, Option<i64>>(0).map(|v| v.unwrap_or(0)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let mut next = max;
    conn.execute("BEGIN IMMEDIATE", []).map_err(|e| e.to_string())?;
    let run = (|| -> Result<(), String> {
        for t in &missing {
            let key = task_node_key(t);
            let member = match member_by_task_key.get(&key) {
                Some(m) => m,
                None => continue,
            };
            next += GROUPED_TASK_ORDER_STEP;
            conn.execute(
                "UPDATE task_group_members SET sort_order = ?1, updated_at = ?2 WHERE workspace_key = ?3 AND task_id = ?4",
                params![next, now, member.workspace_key, member.task_id],
            )
            .map_err(|e| e.to_string())?;
            if let Some(m) = member_by_task_key.get_mut(&key) {
                m.sort_order = Some(next);
            }
        }
        Ok(())
    })();
    match run {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// TS `normalizeGroupedTopNodeOrders` — back-fill a top-order row for any visible node lacking one,
/// by createdAt DESC (then mapKey), inside one `BEGIN IMMEDIATE`; updates the in-memory order map and
/// each node's `sort_order` so the final sort uses them.
fn normalize_grouped_top_node_orders(
    conn: &Connection,
    nodes: &mut [ViewNode],
    order_by_map_key: &mut HashMap<String, i64>,
    now: i64,
) -> Result<(), String> {
    let mut missing: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| !order_by_map_key.contains_key(&n.order_ref().2))
        .map(|(i, _)| i)
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    missing.sort_by(|&li, &ri| {
        let l = &nodes[li];
        let r = &nodes[ri];
        r.created_at()
            .cmp(&l.created_at())
            .then_with(|| locale_cmp(&l.order_ref().2, &r.order_ref().2))
    });
    let max: i64 = conn
        .query_row(
            "SELECT MAX(sort_order) FROM task_group_view_node_orders",
            [],
            |r| r.get::<_, Option<i64>>(0).map(|v| v.unwrap_or(0)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let mut next = max;
    conn.execute("BEGIN IMMEDIATE", []).map_err(|e| e.to_string())?;
    let run = (|| -> Result<(), String> {
        for &i in &missing {
            next += GROUPED_TASK_ORDER_STEP;
            let (nt, nk, mk) = nodes[i].order_ref();
            conn.execute(
                "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![nt, nk, next, now, now],
            )
            .map_err(|e| e.to_string())?;
            order_by_map_key.insert(mk, next);
            nodes[i].set_sort_order(next);
        }
        Ok(())
    })();
    match run {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Port of `queryGroupedTaskView`: bootstrap workspace groups (one-shot), read the grouping tables,
/// assemble the nested group + ungrouped-task nodes with the same ordering rules, run the two lazy
/// order normalizations (writes), and return the sorted node list. `now` is injected.
pub fn query_grouped_task_view(
    conn: &Connection,
    scopes: &[WorkspaceScope],
    include_all: bool,
    provider: Option<&str>,
    now: i64,
) -> Result<GroupedTaskView, String> {
    let active_rows = query_active_task_rows(conn, scopes, include_all, provider)?;

    // Bootstrap scopes: the requested ones, or (includeAll) distinct workspaces of the active tasks.
    let bootstrap_scopes: Vec<BootstrapScope> = if include_all {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for r in &active_rows {
            if seen.insert(r.workspace_key.clone()) {
                out.push(BootstrapScope {
                    workspace_key: r.workspace_key.clone(),
                    workspace_path: r.workspace_path.clone(),
                });
            }
        }
        out
    } else {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for s in scopes {
            let k = workspace_key(&s.workspace_path, s.workspace_identity.as_deref());
            if k.trim().is_empty() {
                continue;
            }
            if seen.insert(k.clone()) {
                out.push(BootstrapScope {
                    workspace_key: k,
                    workspace_path: s.workspace_path.clone(),
                });
            }
        }
        out
    };
    bootstrap_workspace_groups(conn, &bootstrap_scopes, &active_rows, now)?;

    // group_id → bootstrap workspace_key (for visibility).
    let bootstrap_ws_by_group: HashMap<String, String> = {
        let mut stmt = conn
            .prepare(
                "SELECT workspace_key, group_id FROM task_group_workspace_bootstraps WHERE group_id IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(|e| e.to_string())?
    };

    let visible_ws_keys: HashSet<String> = if include_all {
        active_rows.iter().map(|r| r.workspace_key.clone()).collect()
    } else {
        scopes
            .iter()
            .map(|s| workspace_key(&s.workspace_path, s.workspace_identity.as_deref()))
            .collect()
    };

    let groups: Vec<TaskGroup> = {
        let mut stmt = conn
            .prepare(
                "SELECT group_id, title, color, created_at, updated_at FROM task_groups",
            )
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
        let mut out = Vec::new();
        for row in rows {
            let (gid, title, color, created_at, updated_at) = row.map_err(|e| e.to_string())?;
            if let Some(ws) = bootstrap_ws_by_group.get(&gid) {
                if !visible_ws_keys.contains(ws) {
                    continue;
                }
            }
            out.push(row_to_task_group(gid, title, color, created_at, updated_at));
        }
        out
    };

    // members → maps.
    let mut member_by_task_key: HashMap<String, Member> = HashMap::new();
    let mut members_by_group: HashMap<String, Vec<(String, String)>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT group_id, workspace_key, task_id, sort_order, added_at FROM task_group_members",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Member {
                    group_id: r.get(0)?,
                    workspace_key: r.get(1)?,
                    task_id: r.get(2)?,
                    sort_order: r.get(3)?,
                    added_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let m = row.map_err(|e| e.to_string())?;
            let key = format!("{}\u{0}{}", m.workspace_key, m.task_id);
            members_by_group
                .entry(m.group_id.clone())
                .or_default()
                .push((m.workspace_key.clone(), m.task_id.clone()));
            member_by_task_key.insert(key, m);
        }
    }

    // view-node orders → map keyed "type:key".
    let mut order_by_map_key: HashMap<String, i64> = HashMap::new();
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
            let (nt, nk, so) = row.map_err(|e| e.to_string())?;
            order_by_map_key.insert(format!("{nt}:{nk}"), so);
        }
    }

    // active task metas keyed by task node key (rowToTaskListItem with search=null == the meta).
    let active_by_key: HashMap<String, TaskMeta> = active_rows
        .iter()
        .map(|r| {
            let meta = row_to_meta(r);
            (task_node_key(&meta), meta)
        })
        .collect();

    let mut nodes: Vec<ViewNode> = Vec::new();
    let mut grouped_visible_keys: HashSet<String> = HashSet::new();
    for group in groups {
        let mut group_tasks: Vec<TaskMeta> = members_by_group
            .get(&group.id)
            .map(|refs| {
                refs.iter()
                    .filter_map(|(ws, tid)| {
                        let key = format!("{ws}\u{0}{tid}");
                        active_by_key.get(&key).cloned()
                    })
                    .collect()
            })
            .unwrap_or_default();
        if group.id == CRON_DEFAULT_GROUP_ID {
            group_tasks.sort_by(|l, r| {
                r.created_at
                    .cmp(&l.created_at)
                    .then_with(|| locale_cmp(&task_node_key(r), &task_node_key(l)))
            });
        } else {
            normalize_group_member_orders(conn, &group.id, &group_tasks, &mut member_by_task_key, now)?;
            group_tasks.sort_by(|l, r| {
                let lo = member_by_task_key
                    .get(&task_node_key(l))
                    .and_then(|m| m.sort_order)
                    .unwrap_or(0);
                let ro = member_by_task_key
                    .get(&task_node_key(r))
                    .and_then(|m| m.sort_order)
                    .unwrap_or(0);
                lo.cmp(&ro).then_with(|| locale_cmp(&task_node_key(l), &task_node_key(r)))
            });
        }
        for t in &group_tasks {
            grouped_visible_keys.insert(task_node_key(t));
        }
        let sort_order = group_sort_of(&group.id, &order_by_map_key);
        nodes.push(ViewNode::Group {
            group,
            tasks: group_tasks,
            sort_order,
        });
    }

    for meta in active_by_key.values() {
        let key = task_node_key(meta);
        if member_by_task_key.contains_key(&key) || grouped_visible_keys.contains(&key) {
            continue;
        }
        let nk = task_order_node_key(
            &workspace_key(&meta.workspace_path, meta.workspace_identity.as_deref()),
            &meta.task_id,
        );
        let sort_order = order_by_map_key.get(&format!("task:{nk}")).copied();
        nodes.push(ViewNode::Task {
            task: meta.clone(),
            sort_order,
        });
    }

    normalize_grouped_top_node_orders(conn, &mut nodes, &mut order_by_map_key, now)?;

    nodes.sort_by(|l, r| {
        let lo = l.sort_order_of().unwrap_or(0);
        let ro = r.sort_order_of().unwrap_or(0);
        lo.cmp(&ro).then_with(|| locale_cmp(&l.order_ref().2, &r.order_ref().2))
    });

    Ok(GroupedTaskView {
        nodes: nodes.into_iter().map(into_serialized).collect(),
    })
}

impl ViewNode {
    fn sort_order_of(&self) -> Option<i64> {
        match self {
            ViewNode::Group { sort_order, .. } | ViewNode::Task { sort_order, .. } => *sort_order,
        }
    }
}

fn group_sort_of(group_id: &str, orders: &HashMap<String, i64>) -> Option<i64> {
    orders.get(&format!("group:{group_id}")).copied()
}

fn into_serialized(node: ViewNode) -> GroupedTaskViewNode {
    match node {
        ViewNode::Group {
            group,
            tasks,
            sort_order,
        } => GroupedTaskViewNode::Group {
            group,
            tasks,
            sort_order,
        },
        ViewNode::Task { task, sort_order } => GroupedTaskViewNode::Task { task, sort_order },
    }
}
