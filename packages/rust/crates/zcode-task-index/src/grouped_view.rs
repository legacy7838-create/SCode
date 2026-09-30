//! The grouped view: the workspace bootstrap, the ordering comparators, and the two view reads.
//!
//! Ported from `taskIndexRepo.ts:390-482` (the key and comparator helpers), `:751-864` (the two
//! order normalisers) and `:940-1130` (the bootstrap). Spec: docs/specs/rust-native-task-index.md
//! §24 (batch C).
//!
//! # The two order keys, and why there are two
//!
//! A task's **membership key** is `workspaceKey\0taskId`, while its **order key** is
//! `JSON.stringify([workspaceKey, taskId])`. The second is not a stylistic choice: SQLite TEXT
//! cannot carry a NUL, so a `node_key` built with `\0` is truncated on read and stops matching the
//! grouped view after a sort is written back. The membership key is in-memory only and never
//! stored, so the NUL is safe there — and it is what makes a two-field key unambiguous when a
//! workspace key itself contains a separator-like character.
//!
//! # The bootstrap is one-time, and the marker is global
//!
//! `task_group_workspace_bootstraps` records that the workspace-group initialisation has run. The
//! marker key is a **constant**, not a workspace key: a user who has seen a grouped sidebar once
//! should not have one invented for every new workspace afterwards. That is also why the marker row
//! is written even when there is nothing to group — an empty pass still has to be recorded, or the
//! next query with a new workspace would trigger it again.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{OptionalExtension, Row};
use sha2::{Digest, Sha256};

use crate::grouped::{task_order_node_key, GROUPED_TASK_ORDER_STEP};
use crate::groups::TaskGroup;
use crate::meta::{row_to_meta, sql, TaskMeta, TaskRow, TASK_COLUMNS};
use crate::migrate::MigrationError;
use crate::read::build_search_snippets;

/// `CRON_DEFAULT_GROUP_ID` (`zcode-task-types.ts:46`).
pub const CRON_DEFAULT_GROUP_ID: &str = "zcode-default-group-cron";

/// `GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY` (`taskIndexRepo.ts:156`) — a **constant**, not a key.
pub const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY: &str = "__zcode_internal_grouped_workspace_bootstrap_once__";

/// `WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS` (`taskIndexRepo.ts:158-166`).
pub const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS: [&str; 7] = [
    "red", "orange", "yellow", "green", "blue", "purple", "gray",
];

/// The in-memory membership key: `workspaceKey\0taskId`.
///
/// Never persisted — it is the map key inside one query, where a NUL is fine and unambiguous.
pub fn task_node_key(workspace_key: &str, task_id: &str) -> String {
    format!("{workspace_key}\u{0}{task_id}")
}

/// `workspaceGroupId` (`taskIndexRepo.ts:390-393`): `workspace-group-` plus the first 24 hex digits
/// of the key's SHA-256.
///
/// 24 hex digits is 96 bits, so the collision probability across a user's workspaces is negligible,
/// and a **stable** id matters more than a short one: it is stored in `task_group_members` and in
/// the bootstrap marker, so regenerating it would orphan both.
pub fn workspace_group_id(workspace_key: &str) -> String {
    let digest = Sha256::digest(workspace_key.as_bytes());
    let hex: String = digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect();
    format!("workspace-group-{hex}")
}

/// `workspaceGroupTitle` (`taskIndexRepo.ts:395-398`): the path's last segment.
///
/// Trailing separators are stripped **before** splitting, so `/a/b/` yields `b` rather than an
/// empty final element. An empty or separator-only path falls back to the normalised text, then to
/// `"Workspace"`.
pub fn workspace_group_title(workspace_path: &str) -> String {
    let normalized = workspace_path.trim_end_matches(['/', '\\']);
    let leaf = normalized
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty());
    leaf.map(str::trim)
        .filter(|leaf| !leaf.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let trimmed = normalized.trim();
            if trimmed.is_empty() { "Workspace".to_string() } else { trimmed.to_string() }
        })
}

/// `workspaceGroupColor` (`taskIndexRepo.ts:400-405`): the first byte of the key's SHA-256 modulo
/// the palette length.
///
/// Derived from the key rather than assigned round-robin, so a workspace keeps its colour when a
/// second workspace is added — otherwise opening a new project would repaint the first one.
pub fn workspace_group_color(workspace_key: &str) -> String {
    let digest = Sha256::digest(workspace_key.as_bytes());
    let index = usize::from(digest[0]) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.len();
    WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS[index].to_string()
}

/// One `task_group_members` row. Crosses the boundary as JSON for the structure read.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupMember {
    pub group_id: String,
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub task_id: String,
    /// `NULL` means the order has not been persisted yet — a newly joined group, which the client
    /// backfills in memory by `addedAt` descending.
    pub sort_order: Option<i64>,
    pub added_at: i64,
}

impl GroupMember {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(GroupMember {
            group_id: row.get("group_id")?,
            workspace_key: row.get("workspace_key")?,
            workspace_path: row.get("workspace_path")?,
            workspace_identity: row.get("workspace_identity")?,
            task_id: row.get("task_id")?,
            sort_order: row.get("sort_order")?,
            added_at: row.get("added_at")?,
        })
    }
}

/// One `task_group_view_node_orders` row.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeOrder {
    pub node_type: String,
    pub node_key: String,
    pub sort_order: i64,
}

/// A top-level node of the grouped view, as the published shape: `type` plus the payload and an
/// **absent** `sortOrder` when the node has none.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum GroupedNode {
    #[serde(rename_all = "camelCase")]
    Group { group: TaskGroup, tasks: Vec<TaskMeta>, sort_order: Option<i64> },
    #[serde(rename_all = "camelCase")]
    Task { task: TaskMeta, sort_order: Option<i64> },
}

/// A workspace scope, with the key already resolved.
///
/// Deserialised because the scope list crosses the napi boundary, and the key is passed rather
/// than derived here: the identity rule is `identity?.trim() || path`, and resolving it in two
/// places is how a caller and the engine end up disagreeing about a scope.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceScope {
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
}

/// `queryGroupedTaskView`'s parameters.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct GroupedViewQuery {
    pub workspace_scopes: Vec<WorkspaceScope>,
    /// When true the workspace filter is dropped **entirely** — not widened to "all keys", so a
    /// caller that passes neither gets an empty view rather than the whole database.
    pub include_all_workspaces: bool,
    pub provider: Option<String>,
}

fn read_all<T>(
    conn: &rusqlite::Connection,
    sql_text: &str,
    read: impl Fn(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, MigrationError> {
    let mut statement = conn
        .prepare(sql_text)
        .map_err(|source| sql("cannot prepare the grouped read", source))?;
    let rows = statement
        .query_map([], read)
        .map_err(|source| sql("cannot read the grouped rows", source))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|source| sql("cannot read a grouped row", source))?);
    }
    Ok(out)
}

fn read_groups(conn: &rusqlite::Connection) -> Result<Vec<TaskGroup>, MigrationError> {
    read_all(conn, "SELECT group_id, title, color, created_at, updated_at FROM task_groups", crate::groups::row_to_group)
}

fn read_members(conn: &rusqlite::Connection) -> Result<Vec<GroupMember>, MigrationError> {
    read_all(
        conn,
        "SELECT group_id, workspace_key, workspace_path, workspace_identity, task_id, sort_order, added_at
         FROM task_group_members",
        GroupMember::from_row,
    )
}

fn read_orders(conn: &rusqlite::Connection) -> Result<Vec<NodeOrder>, MigrationError> {
    read_all(
        conn,
        "SELECT node_type, node_key, sort_order FROM task_group_view_node_orders",
        |row| {
            Ok(NodeOrder {
                node_type: row.get("node_type")?,
                node_key: row.get("node_key")?,
                sort_order: row.get("sort_order")?,
            })
        },
    )
}

/// `bootstrapWorkspaceGroupsForActiveTasks` (`taskIndexRepo.ts:940-1130`).
///
/// One-time, guarded by the global marker. For each workspace with active tasks it creates a
/// per-workspace group, files the tasks into it **newest first**, and removes each task's
/// top-level order row so it appears inside the group instead of twice.
///
/// Three members are collected first rather than inline, because a write happening mid-read would
/// otherwise make the delete and the insert disagree:
///
/// - `deleteEmptyGroups` removes any group with no members. Without it a workspace whose tasks were
///   all deleted would leave an empty group rendered in the sidebar forever.
/// - `deleteDanglingGroupOrders` removes a `group` order row whose group is gone. The same reason:
///   a node with no group renders as an empty entry.
/// - `insertGroupOrder` is `OR IGNORE` and guarded by `existingGroupOrderKeys`, so a re-run does
///   not push an existing group down the list.
pub fn bootstrap_workspace_groups(
    conn: &mut rusqlite::Connection,
    scopes: &[WorkspaceScope],
    active_tasks: &[TaskRow],
    now: i64,
) -> Result<(), MigrationError> {
    let already_run: bool = conn
        .query_row("SELECT 1 FROM task_group_workspace_bootstraps LIMIT 1", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()
        .map_err(|source| sql("cannot read the bootstrap marker", source))?
        .is_some();
    if scopes.is_empty() || already_run {
        return Ok(());
    }

    let mut by_workspace: BTreeMap<&str, Vec<&TaskRow>> = BTreeMap::new();
    for row in active_tasks {
        by_workspace.entry(row.workspace_key.as_str()).or_default().push(row);
    }

    let existing_group_orders: BTreeSet<String> = read_orders(conn)?
        .into_iter()
        .filter(|order| order.node_type == "group")
        .map(|order| order.node_key)
        .collect();
    let mut next_group_sort_order: i64 = conn
        .query_row("SELECT MAX(sort_order) FROM task_group_view_node_orders", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .optional()
        .map_err(|source| sql("cannot read the grouped order", source))?
        .flatten()
        .unwrap_or(0);

    let transaction = conn.transaction().map_err(|source| sql("cannot begin the bootstrap", source))?;

    // The global marker is written **first** and unconditionally, including when there is nothing
    // to group. An empty pass that did not record itself would fire again on the next query.
    transaction
        .execute(
            "INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at)
             VALUES (?1, NULL, ?2, ?2)
             ON CONFLICT(workspace_key) DO UPDATE SET updated_at = excluded.updated_at",
            rusqlite::params![GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now],
        )
        .map_err(|source| sql("cannot record the bootstrap marker", source))?;

    let mut seen_group_orders = existing_group_orders;
    for scope in scopes {
        let Some(rows) = by_workspace.get(scope.workspace_key.as_str()) else { continue };
        // Newest first, then by creation, then by id. The old group does not participate in the
        // ownership decision, so historical grouping cannot leave a task in a non-workspace group.
        let mut grouped: Vec<&&TaskRow> = rows.iter().collect();
        grouped.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| right.task_id.cmp(&left.task_id))
        });
        if grouped.is_empty() {
            continue;
        }

        let group_id = workspace_group_id(&scope.workspace_key);
        transaction
            .execute(
                "INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                rusqlite::params![
                    group_id,
                    workspace_group_title(&scope.workspace_path),
                    workspace_group_color(&scope.workspace_key),
                    now
                ],
            )
            .map_err(|source| sql("cannot create the workspace group", source))?;
        if seen_group_orders.insert(group_id.clone()) {
            next_group_sort_order += GROUPED_TASK_ORDER_STEP;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO task_group_view_node_orders
                       (node_type, node_key, sort_order, created_at, updated_at)
                     VALUES ('group', ?1, ?2, ?3, ?3)",
                    rusqlite::params![group_id, next_group_sort_order, now],
                )
                .map_err(|source| sql("cannot order the workspace group", source))?;
        }

        for (index, row) in grouped.iter().enumerate() {
            transaction
                .execute(
                    "DELETE FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2",
                    rusqlite::params![row.workspace_key, row.task_id],
                )
                .map_err(|source| sql("cannot clear the previous membership", source))?;
            transaction
                .execute(
                    "INSERT INTO task_group_members
                       (group_id, workspace_key, workspace_path, workspace_identity, task_id,
                        sort_order, added_at, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
                     ON CONFLICT(workspace_key, task_id) DO UPDATE SET
                       group_id = excluded.group_id,
                       workspace_path = excluded.workspace_path,
                       workspace_identity = excluded.workspace_identity,
                       sort_order = excluded.sort_order,
                       updated_at = excluded.updated_at",
                    rusqlite::params![
                        group_id,
                        row.workspace_key,
                        row.workspace_path,
                        row.workspace_identity,
                        row.task_id,
                        (index as i64 + 1) * GROUPED_TASK_ORDER_STEP,
                        now
                    ],
                )
                .map_err(|source| sql("cannot file the task into the workspace group", source))?;
            // The top-level order row goes, so the task appears inside the group rather than in
            // both places.
            let order_key = task_order_node_key(&row.workspace_key, &row.task_id)?;
            transaction
                .execute(
                    "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?1",
                    rusqlite::params![order_key],
                )
                .map_err(|source| sql("cannot clear the top-level order", source))?;
        }
        transaction
            .execute(
                "INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(workspace_key) DO UPDATE SET
                   group_id = excluded.group_id,
                   updated_at = excluded.updated_at",
                rusqlite::params![scope.workspace_key, group_id, now],
            )
            .map_err(|source| sql("cannot record the workspace bootstrap", source))?;
    }

    transaction
        .execute(
            "DELETE FROM task_groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM task_group_members)",
            [],
        )
        .map_err(|source| sql("cannot remove the empty groups", source))?;
    transaction
        .execute(
            "DELETE FROM task_group_view_node_orders
             WHERE node_type = 'group'
               AND node_key NOT IN (SELECT group_id FROM task_groups)",
            [],
        )
        .map_err(|source| sql("cannot remove the dangling group orders", source))?;
    transaction
        .commit()
        .map_err(|source| sql("cannot commit the bootstrap", source))?;
    Ok(())
}

/// `compareGroupedNodes` (`taskIndexRepo.ts:441-453`): order, then the map key.
///
/// The tiebreak is a **byte** comparison of `group:<id>` / `task:<key>`, not a locale-aware one:
/// a `localeCompare` over keys containing `\0` and `["…"]` is locale-dependent, and the two sides
/// would then order differently on different machines. Determinism matters more here than
/// linguistic nicety, because the result is persisted.
fn compare_grouped_nodes(left: &GroupedNode, right: &GroupedNode) -> std::cmp::Ordering {
    let left_order = left.sort_order().unwrap_or(0);
    let right_order = right.sort_order().unwrap_or(0);
    left_order
        .cmp(&right_order)
        .then_with(|| top_order_map_key(left).cmp(&top_order_map_key(right)))
}

/// `compareCronGroupTasks`: always newest first, by `addedAt`-independent creation time.
///
/// The user's manual `sort_order` is deliberately not consulted — a cron group is a system group,
/// and the latest scheduled result should always be at the top.
pub fn compare_cron_group_tasks(
    left: &(TaskMeta, String, Option<i64>),
    right: &(TaskMeta, String, Option<i64>),
) -> std::cmp::Ordering {
    right
        .0
        .created_at
        .cmp(&left.0.created_at)
        .then_with(|| right.1.cmp(&left.1))
}

/// `compareGroupTasks`: the membership's `sort_order`, then the node key.
pub fn compare_group_tasks(
    left: &(TaskMeta, String, Option<i64>),
    right: &(TaskMeta, String, Option<i64>),
) -> std::cmp::Ordering {
    left.2
        .unwrap_or(0)
        .cmp(&right.2.unwrap_or(0))
        .then_with(|| left.1.cmp(&right.1))
}

impl GroupedNode {
    pub fn sort_order(&self) -> Option<i64> {
        match self {
            GroupedNode::Group { sort_order, .. } | GroupedNode::Task { sort_order, .. } => *sort_order,
        }
    }
}

/// `groupedTopNodeOrderRef(...).mapKey`.
fn top_order_map_key(node: &GroupedNode) -> String {
    match node {
        GroupedNode::Group { group, .. } => format!("group:{}", group.id),
        GroupedNode::Task { task, .. } => match task_order_node_key(
            task.workspace_identity.as_deref().unwrap_or(&task.workspace_path),
            &task.task_id,
        ) {
            Ok(key) => format!("task:{key}"),
            // A key that cannot be built sorts under an empty key rather than panicking a read.
            Err(_) => "task:".to_string(),
        },
    }
}

/// `queryGroupedTaskView` (`taskIndexRepo.ts:2075-2261`).
///
/// The order is: read the active tasks, bootstrap, read the three group tables, assemble, then
/// **normalise and persist** the orders that do not exist yet. That writeback is not a cache — it is
/// what turns "sorted by `createdAt` for this query" into a stable order the user can then drag.
pub fn query_grouped_task_view(
    conn: &mut rusqlite::Connection,
    query: &GroupedViewQuery,
    now: i64,
) -> Result<Vec<GroupedNode>, MigrationError> {
    let workspace_keys: Vec<&str> = query
        .workspace_scopes
        .iter()
        .map(|scope| scope.workspace_key.as_str())
        .collect();
    let mut where_parts = vec![
        "deleted = 0".to_string(),
        "archived = 0".to_string(),
        "pinned = 0".to_string(),
    ];
    if !query.include_all_workspaces {
        where_parts.push(format!(
            "workspace_key IN ({})",
            vec!["?"; workspace_keys.len()].join(", ")
        ));
    }
    if query.provider.is_some() {
        // Grouped and plain lists are both ZCode Agent entries and share the provider filter;
        // without it, historical rows from other agents appear in grouped and nowhere else.
        where_parts.push("(provider = 'glm')".to_string());
    }
    let sql_text = format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE {}",
        where_parts.join(" AND ")
    );
    let active_tasks: Vec<TaskRow> = if !query.include_all_workspaces && workspace_keys.is_empty() {
        Vec::new()
    } else {
        let mut statement = conn
            .prepare(&sql_text)
            .map_err(|source| sql("cannot prepare the active task read", source))?;
        let args: Vec<Box<dyn rusqlite::ToSql>> = workspace_keys
            .iter()
            .map(|key| Box::new(key.to_string()) as Box<dyn rusqlite::ToSql>)
            .collect();
        let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|value| value.as_ref()).collect();
        let rows = statement
            .query_map(arg_refs.as_slice(), TaskRow::from_sql_row)
            .map_err(|source| sql("cannot read the active tasks", source))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|source| sql("cannot read an active task", source))?);
        }
        out
    };

    // With `includeAllWorkspaces` the scopes are derived from what actually has tasks, so the
    // bootstrap does not invent a group for a workspace with nothing in it.
    let scopes: Vec<WorkspaceScope> = if query.include_all_workspaces {
        let mut seen = BTreeSet::new();
        active_tasks
            .iter()
            .filter_map(|row| {
                seen.insert(row.workspace_key.clone()).then(|| WorkspaceScope {
                    workspace_key: row.workspace_key.clone(),
                    workspace_path: row.workspace_path.clone(),
                    workspace_identity: row.workspace_identity.clone(),
                })
            })
            .collect()
    } else {
        query.workspace_scopes.clone()
    };
    bootstrap_workspace_groups(conn, &scopes, &active_tasks, now)?;

    // A bootstrap group is only visible in the workspace it was built for, so a "show everything"
    // query does not scatter per-workspace groups across unrelated workspaces.
    let mut bootstrap_workspace_by_group: HashMap<String, String> = HashMap::new();
    for row in read_all(
        conn,
        "SELECT workspace_key, group_id FROM task_group_workspace_bootstraps WHERE group_id IS NOT NULL",
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )? {
        bootstrap_workspace_by_group.insert(row.1, row.0);
    }
    let visible_keys: BTreeSet<String> = if query.include_all_workspaces {
        active_tasks.iter().map(|row| row.workspace_key.clone()).collect()
    } else {
        workspace_keys.iter().map(|key| key.to_string()).collect()
    };

    let groups: Vec<TaskGroup> = read_groups(conn)?
        .into_iter()
        .filter(|group| match bootstrap_workspace_by_group.get(&group.id) {
            // A bootstrap group is scoped to its own workspace; every other group is global.
            Some(key) => visible_keys.contains(key),
            None => true,
        })
        .collect();
    let members = read_members(conn)?;
    let orders = read_orders(conn)?;

    let order_by_key: HashMap<String, i64> = orders
        .iter()
        .map(|order| (format!("{}:{}", order.node_type, order.node_key), order.sort_order))
        .collect();
    let member_by_task: HashMap<String, GroupMember> = members
        .iter()
        .map(|member| (task_node_key(&member.workspace_key, &member.task_id), member.clone()))
        .collect();
    let mut members_by_group: BTreeMap<String, Vec<&GroupMember>> = BTreeMap::new();
    for member in &members {
        members_by_group.entry(member.group_id.clone()).or_default().push(member);
    }
    let task_by_key: HashMap<String, &TaskRow> = active_tasks
        .iter()
        .map(|row| (task_node_key(&row.workspace_key, &row.task_id), row))
        .collect();

    let mut grouped_keys: BTreeSet<String> = BTreeSet::new();
    let mut nodes: Vec<GroupedNode> = Vec::new();
    for group in groups {
        let mut tasks: Vec<(TaskMeta, String, Option<i64>)> = members_by_group
            .get(&group.id)
            .map(|group_members| {
                group_members
                    .iter()
                    .filter_map(|member| {
                        task_by_key
                            .get(&task_node_key(&member.workspace_key, &member.task_id))
                            .map(|row| {
                                (
                                    row_to_meta(row),
                                    task_node_key(&member.workspace_key, &member.task_id),
                                    member.sort_order,
                                )
                            })
                    })
                    .collect()
            })
            .unwrap_or_default();

        if group.id == CRON_DEFAULT_GROUP_ID {
                tasks.sort_by(compare_cron_group_tasks);
        } else {
            normalize_group_member_orders(conn, &mut tasks, &member_by_task, now)?;
            tasks.sort_by(compare_group_tasks);
        }
        for (_, key, _) in &tasks {
            grouped_keys.insert(key.clone());
        }
        let sort_order = order_by_key.get(&format!("group:{}", group.id)).copied();
        nodes.push(GroupedNode::Group { group, tasks: tasks.into_iter().map(|(task, _, _)| task).collect(), sort_order });
    }

    // Whatever is neither a member nor already inside a group surfaces as a top-level task.
    for (key, row) in &task_by_key {
        if member_by_task.contains_key(key) || grouped_keys.contains(key) {
            continue;
        }
        let order_key = task_order_node_key(&row.workspace_key, &row.task_id)
            .map(|order| format!("task:{order}"))
            .unwrap_or_default();
        nodes.push(GroupedNode::Task {
            task: row_to_meta(row),
            sort_order: order_by_key.get(&order_key).copied(),
        });
    }

    normalize_grouped_top_orders(conn, &mut nodes, &order_by_key, now)?;
    nodes.sort_by(compare_grouped_nodes);
    Ok(nodes)
}

/// `normalizeGroupMemberOrders` (`taskIndexRepo.ts:810-864`): give every member without a
/// persisted order one, newest `addedAt` first, and write it back.
///
/// `sort_order IS NULL` is the "newly joined group" state the client backfills in memory. Writing
/// it back is what makes the order stable: without it every query re-derives it from `addedAt`, and
/// a task added a second later would jump ahead of one the user had already positioned.
///
/// Only members that **have** a row are considered, and the update is keyed on
/// `(workspace_key, task_id)` — the membership's own primary key — so a task that is not a member
/// is never touched.
pub fn normalize_group_member_orders(
    conn: &rusqlite::Connection,
    tasks: &mut [(TaskMeta, String, Option<i64>)],
    member_by_task: &HashMap<String, GroupMember>,
    now: i64,
) -> Result<(), MigrationError> {
    let mut missing: Vec<usize> = tasks
        .iter()
        .enumerate()
        .filter(|(_, (_, key, _))| {
            member_by_task
                .get(key.as_str())
                .is_some_and(|member| member.sort_order.is_none())
        })
        .map(|(index, _)| index)
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    // Newest `addedAt` first, so the most recently added member keeps the top position, and the
    // node key breaks a tie so two members added in the same millisecond still have one order.
    missing.sort_by(|left, right| {
        let left_added = member_by_task
            .get(&tasks[*left].1)
            .map(|member| member.added_at)
            .unwrap_or(tasks[*left].0.created_at);
        let right_added = member_by_task
            .get(&tasks[*right].1)
            .map(|member| member.added_at)
            .unwrap_or(tasks[*right].0.created_at);
        right_added
            .cmp(&left_added)
            .then_with(|| tasks[*left].1.cmp(&tasks[*right].1))
    });

    let mut next_sort_order: i64 = tasks
        .iter()
        .filter_map(|(_, _, order)| *order)
        .max()
        .unwrap_or(0);
    for index in missing {
        next_sort_order += GROUPED_TASK_ORDER_STEP;
        let (_, key, _) = &tasks[index];
        let Some(member) = member_by_task.get(key) else { continue };
        conn.execute(
            "UPDATE task_group_members SET sort_order = ?3, updated_at = ?4
             WHERE workspace_key = ?1 AND task_id = ?2",
            rusqlite::params![member.workspace_key, member.task_id, next_sort_order, now],
        )
        .map_err(|source| sql("cannot persist the member order", source))?;
        tasks[index].2 = Some(next_sort_order);
    }
    Ok(())
}

/// `normalizeGroupedTopNodeOrders` (`taskIndexRepo.ts:751-808`): give every node without a
/// persisted order one, newest first, and write it back.
///
/// The writeback is the point. Without it the order is recomputed from `createdAt` on every query,
/// so a user who drags a node has it snap back, and nothing the user does can be preserved.
pub fn normalize_grouped_top_orders(
    conn: &rusqlite::Connection,
    nodes: &mut [GroupedNode],
    order_by_key: &HashMap<String, i64>,
    now: i64,
) -> Result<(), MigrationError> {
    let mut missing: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| !order_by_key.contains_key(&top_order_map_key(node)))
        .map(|(index, _)| index)
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    // Newest first, so the most recently created node is the one that keeps the top position.
    missing.sort_by(|left, right| {
        let left_created = nodes[*left].created_at();
        let right_created = nodes[*right].created_at();
        right_created
            .cmp(&left_created)
            .then_with(|| top_order_map_key(&nodes[*left]).cmp(&top_order_map_key(&nodes[*right])))
    });

    let mut next_sort_order: i64 = conn
        .query_row("SELECT MAX(sort_order) FROM task_group_view_node_orders", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .optional()
        .map_err(|source| sql("cannot read the grouped order", source))?
        .flatten()
        .unwrap_or(0);

    let mut assigned: Vec<(String, i64)> = Vec::new();
    for index in &missing {
        next_sort_order += GROUPED_TASK_ORDER_STEP;
        assigned.push((top_order_map_key(&nodes[*index]), next_sort_order));
    }
    for (map_key, sort_order) in &assigned {
        let (node_type, node_key) = map_key
            .split_once(':')
            .ok_or_else(|| sql("malformed grouped order key", rusqlite::Error::InvalidQuery))?;
        conn.execute(
            "INSERT INTO task_group_view_node_orders
               (node_type, node_key, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(node_type, node_key) DO UPDATE SET
               sort_order = excluded.sort_order,
               updated_at = excluded.updated_at",
            rusqlite::params![node_type, node_key, sort_order, now],
        )
        .map_err(|source| sql("cannot persist the grouped order", source))?;
    }
    // Reflect the new orders in the returned nodes, so the caller renders the same order the next
    // query will read back rather than one query being stale.
    for (index, (_, sort_order)) in missing.iter().zip(assigned) {
        match &mut nodes[*index] {
            GroupedNode::Group { sort_order: slot, .. }
            | GroupedNode::Task { sort_order: slot, .. } => *slot = Some(sort_order),
        }
    }
    Ok(())
}

impl GroupedNode {
    pub fn created_at(&self) -> i64 {
        match self {
            GroupedNode::Group { group, .. } => group.created_at,
            GroupedNode::Task { task, .. } => task.created_at,
        }
    }
}

/// `queryGroupedTaskViewStructure` (`taskIndexRepo.ts:2264-2363`).
///
/// The **structure only** — groups, members and top-level orders, with no join to `tasks` and no
/// writeback. The task content comes from sessions-index and the client joins it, so this read
/// stays cheap and does not mutate anything. It is what replaced the joined view once the task data
/// source moved.
pub fn query_grouped_task_view_structure(
    conn: &rusqlite::Connection,
    workspace_scopes: &[WorkspaceScope],
) -> Result<GroupedStructure, MigrationError> {
    let visible_keys: BTreeSet<&str> = workspace_scopes
        .iter()
        .map(|scope| scope.workspace_key.as_str())
        .collect();
    let mut bootstrap_workspace_by_group: HashMap<String, String> = HashMap::new();
    for (workspace_key, group_id) in read_all(
        conn,
        "SELECT workspace_key, group_id FROM task_group_workspace_bootstraps WHERE group_id IS NOT NULL",
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )? {
        bootstrap_workspace_by_group.insert(group_id, workspace_key);
    }

    let groups: Vec<TaskGroup> = read_groups(conn)?
        .into_iter()
        .filter(|group| match bootstrap_workspace_by_group.get(&group.id) {
            Some(key) => visible_keys.contains(key.as_str()),
            None => true,
        })
        .collect();

    let members: Vec<GroupMember> = read_members(conn)?
        .into_iter()
        .filter(|member| visible_keys.contains(member.workspace_key.as_str()))
        .collect();

    // A task node key is `JSON.stringify([workspaceKey, taskId])`. A dirty key from history is
    // **skipped** rather than failing the read: the client fills the sequence in from `createdAt`
    // and a crash here would take the whole sidebar with it.
    let mut top_level_orders: Vec<TopOrder> = Vec::new();
    for order in read_orders(conn)? {
        if order.node_type == "group" {
            top_level_orders.push(TopOrder::Group { group_id: order.node_key, sort_order: order.sort_order });
            continue;
        }
        if let Some((workspace_key, task_id)) = parse_task_order_key(&order.node_key) {
            top_level_orders.push(TopOrder::Task { workspace_key, task_id, sort_order: order.sort_order });
        }
    }

    Ok(GroupedStructure { groups, members, top_level_orders })
}

/// A top-level order from the structure read, tagged by `type` the way the client expects.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TopOrder {
    Group { group_id: String, sort_order: i64 },
    Task { workspace_key: String, task_id: String, sort_order: i64 },
}

/// The structure read's result.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupedStructure {
    pub groups: Vec<TaskGroup>,
    pub members: Vec<GroupMember>,
    pub top_level_orders: Vec<TopOrder>,
}

/// `JSON.parse` of a task order key, which must be a two-string array.
fn parse_task_order_key(node_key: &str) -> Option<(String, String)> {
    let parsed: serde_json::Value = serde_json::from_str(node_key).ok()?;
    let array = parsed.as_array()?;
    if array.len() != 2 {
        return None;
    }
    let first = array.first()?.as_str()?.to_string();
    let second = array.get(1)?.as_str()?.to_string();
    Some((first, second))
}

/// The snippet builder, re-exported so the grouped view's list items match the flat list's.
pub fn task_list_item(row: &TaskRow, search: Option<&str>) -> TaskMeta {
    let _ = build_search_snippets(&row.searchable_text, search);
    row_to_meta(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::groups::is_task_group_color;
    use crate::test_support::{memory, meta_json};

    fn with_group_schema(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE task_groups (group_id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE task_group_members (group_id TEXT NOT NULL, workspace_key TEXT NOT NULL,
               workspace_path TEXT NOT NULL, workspace_identity TEXT, task_id TEXT NOT NULL,
               sort_order INTEGER, added_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_key, task_id));
             CREATE TABLE task_group_view_node_orders (node_type TEXT NOT NULL, node_key TEXT NOT NULL,
               sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (node_type, node_key));",
        )
        .expect("group schema");
    }

    fn insert_task(conn: &rusqlite::Connection, key: &str, task_id: &str, created: i64, updated: i64) {
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, created_at, updated_at,
               meta_json, searchable_text) VALUES (?1, '/ws', ?2, ?2, 'auto', ?3, ?4, ?5, '')",
            rusqlite::params![key, task_id, created, updated, meta_json(task_id, updated)],
        )
        .expect("insert");
    }

    fn member(conn: &rusqlite::Connection, group: &str, key: &str, task_id: &str, order: Option<i64>, added: i64) {
        conn.execute(
            "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, workspace_identity,
               task_id, sort_order, added_at, created_at, updated_at) VALUES (?1, ?2, '/ws', NULL, ?3, ?4, ?5, 1, 1)",
            rusqlite::params![group, key, task_id, order, added],
        )
        .expect("insert member");
    }

    /// The group id is **stable** and derived from the key, because it is stored in two tables.
    #[test]
    fn the_workspace_group_id_is_stable_and_24_hex_digits() {
        let id = workspace_group_id("ws-a");
        assert_eq!(id, workspace_group_id("ws-a"), "same key, same id");
        assert!(id.starts_with("workspace-group-"));
        assert_eq!(id.len(), "workspace-group-".len() + 24);
        assert_ne!(id, workspace_group_id("ws-b"));
    }

    /// The title is the path's last segment, with trailing separators handled.
    #[test]
    fn the_group_title_is_the_last_path_segment() {
        assert_eq!(workspace_group_title("/a/b/c"), "c");
        assert_eq!(workspace_group_title("/a/b/"), "b", "a trailing separator is not a segment");
        assert_eq!(workspace_group_title("C:\\Users\\me\\proj"), "proj");
        assert_eq!(workspace_group_title("/"), "Workspace", "a separator-only path falls back");
        assert_eq!(workspace_group_title("   "), "Workspace");
    }

    /// The colour comes from the key, so opening a second workspace does not repaint the first.
    #[test]
    fn the_group_colour_is_derived_from_the_key_not_assigned_in_order() {
        assert_eq!(workspace_group_color("ws-a"), workspace_group_color("ws-a"));
        for key in ["a", "b", "c", "d", "e"] {
            assert!(
                is_task_group_color(&workspace_group_color(key)),
                "{} must be inside the palette",
                key
            );
        }
    }

    /// The two order keys differ in separator, and the persisted one carries no NUL.
    #[test]
    fn the_persisted_order_key_carries_no_nul() {
        let member_key = task_node_key("ws", "t1");
        assert!(member_key.contains('\u{0}'), "the in-memory key is NUL-separated");
        let order_key = task_order_node_key("ws", "t1").expect("order key");
        assert!(!order_key.contains('\u{0}'), "a NUL would truncate in SQLite TEXT");
        assert_eq!(order_key, r#"["ws","t1"]"#);
    }

    /// The bootstrap groups a workspace's tasks newest-first and drops their top-level order rows.
    #[test]
    fn the_bootstrap_files_tasks_into_a_workspace_group_newest_first() {
        let mut conn = memory();
        with_group_schema(&conn);
        insert_task(&conn, "ws", "old", 1, 100);
        insert_task(&conn, "ws", "new", 3, 300);
        insert_task(&conn, "ws", "mid", 2, 200);
        let scopes = vec![WorkspaceScope {
            workspace_key: "ws".into(),
            workspace_path: "/ws".into(),
            workspace_identity: None,
        }];
        let active: Vec<TaskRow> = read_all(
            &conn,
            "SELECT workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
               provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
               off_peak_task_id, created_at, updated_at, unread_at, last_unread_at, pinned, archived,
               deleted, title_overridden, searchable_text, meta_json FROM tasks",
            TaskRow::from_sql_row,
        )
        .expect("read");
        bootstrap_workspace_groups(&mut conn, &scopes, &active, 500).expect("bootstrap");

        let members = read_members(&conn).expect("members");
        assert_eq!(members.len(), 3);
        assert!(
            members.iter().all(|member| member.group_id == workspace_group_id("ws")),
            "every task lands in the workspace group"
        );
        // The step is the **position**, so the newest task gets the *lowest* one. The members come
        // back in insertion order, which follows the sorted order, so this is newest-first.
        let orders: Vec<i64> = members.iter().map(|member| member.sort_order.expect("ordered")).collect();
        assert_eq!(orders, vec![1000, 2000, 3000], "newest first");
        let by_task: BTreeMap<&str, i64> = members
            .iter()
            .map(|member| (member.task_id.as_str(), member.sort_order.expect("ordered")))
            .collect();
        assert_eq!(by_task["new"], 1000, "the newest task is at the top");
        assert_eq!(by_task["old"], 3000, "the oldest is at the bottom");
    }

    /// The marker is written even with nothing to group, so an empty pass does not fire again.
    #[test]
    fn an_empty_bootstrap_still_records_the_marker() {
        let mut conn = memory();
        with_group_schema(&conn);
        let scopes = vec![WorkspaceScope {
            workspace_key: "ws".into(),
            workspace_path: "/ws".into(),
            workspace_identity: None,
        }];
        bootstrap_workspace_groups(&mut conn, &scopes, &[], 1).expect("bootstrap");
        let markers: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_group_workspace_bootstraps", [], |row| row.get(0))
            .expect("count");
        assert_eq!(markers, 1, "an unrecorded pass would fire again on the next query");
        // And a second call is a no-op.
        bootstrap_workspace_groups(&mut conn, &scopes, &[], 2).expect("again");
        let markers: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_group_workspace_bootstraps", [], |row| row.get(0))
            .expect("count");
        assert_eq!(markers, 1);
    }

    /// A group with no members, and an order row for a group that is gone, are both cleaned up —
    /// otherwise the sidebar shows entries with nothing in them.
    #[test]
    fn empty_groups_and_dangling_orders_are_cleaned_up() {
        let mut conn = memory();
        with_group_schema(&conn);
        conn.execute("INSERT INTO task_groups VALUES ('empty', 'Empty', 'gray', 1, 1)", [])
            .expect("insert group");
        conn.execute(
            "INSERT INTO task_group_view_node_orders VALUES ('group', 'empty', 100, 1, 1)",
            [],
        )
        .expect("insert order");
        conn.execute("INSERT INTO task_groups VALUES ('gone', 'Gone', 'gray', 1, 1)", [])
            .expect("insert group");
        conn.execute(
            "INSERT INTO task_group_view_node_orders VALUES ('group', 'ghost', 200, 1, 1)",
            [],
        )
        .expect("insert order");
        let scopes = vec![WorkspaceScope {
            workspace_key: "ws".into(),
            workspace_path: "/ws".into(),
            workspace_identity: None,
        }];
        bootstrap_workspace_groups(&mut conn, &scopes, &[], 1).expect("bootstrap");
        let groups = read_groups(&conn).expect("groups");
        assert!(!groups.iter().any(|group| group.id == "empty"), "an empty group is removed");
        let orders = read_orders(&conn).expect("orders");
        assert!(!orders.iter().any(|order| order.node_key == "ghost"), "a dangling order is removed");
    }

    /// The cron group is newest-first by creation, and ignores the user's member order.
    #[test]
    fn the_cron_group_is_newest_first_regardless_of_member_order() {
        let conn = memory();
        with_group_schema(&conn);
        // Written directly so `createdAt` really varies: the shared fixture pins it to 1, and the
        // comparator reads the document's value, not the column.
        for (task_id, created) in [("a", 100), ("b", 300), ("c", 200)] {
            conn.execute(
                "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, created_at,
                   updated_at, meta_json, searchable_text)
                 VALUES ('ws', '/ws', ?1, ?1, 'auto', ?2, 1, ?3, '')",
                rusqlite::params![
                    task_id,
                    created,
                    format!(
                        r#"{{"taskId":"{task_id}","traceId":"tr","title":"{task_id}","workspacePath":"/ws","createdAt":{created},"updatedAt":1,"mode":"auto"}}"#
                    )
                ],
            )
            .expect("insert");
        }
        // `a` is deliberately given the **largest** member order; the cron comparator ignores it.
        member(&conn, CRON_DEFAULT_GROUP_ID, "ws", "a", Some(9_000), 1);
        member(&conn, CRON_DEFAULT_GROUP_ID, "ws", "b", Some(1_000), 1);
        member(&conn, CRON_DEFAULT_GROUP_ID, "ws", "c", Some(5_000), 1);
        let members = read_members(&conn).expect("members");
        let by_key: HashMap<&str, &GroupMember> = members
            .iter()
            .map(|member| (member.task_id.as_str(), member))
            .collect();
        let row_of = |task_id: &str| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {TASK_COLUMNS} FROM tasks WHERE task_id = '{task_id}'"
                ))
                .expect("prepare");
            let row = statement.query_row([], TaskRow::from_sql_row).expect("row");
            (row_to_meta(&row), task_node_key("ws", task_id))
        };
        let mut tasks: Vec<(TaskMeta, String, Option<i64>)> = ["a", "b", "c"]
            .iter()
            .map(|task_id| {
                let (task, key) = row_of(task_id);
                (task, key, by_key[*task_id].sort_order)
            })
            .collect();
        tasks.sort_by(compare_cron_group_tasks);
        let ids: Vec<&str> = tasks.iter().map(|(_, key, _)| key.as_str()).collect();
        assert_eq!(ids, vec!["ws\u{0}b", "ws\u{0}c", "ws\u{0}a"], "newest creation first");
    }

    /// A member with no persisted order is ordered after every ordered one, and the tiebreak is
    /// the node key rather than insertion order.
    #[test]
    fn an_unordered_member_sorts_after_the_ordered_ones() {
        let conn = memory();
        with_group_schema(&conn);
        insert_task(&conn, "ws", "a", 1, 1);
        insert_task(&conn, "ws", "b", 1, 1);
        let row_of = |task_id: &str| {
            let mut statement = conn
                .prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE task_id = '{task_id}'"))
                .expect("prepare");
            let row = statement.query_row([], TaskRow::from_sql_row).expect("row");
            (row_to_meta(&row), task_node_key("ws", task_id))
        };
        let (task_a, key_a) = row_of("a");
        let (task_b, key_b) = row_of("b");
        let right = (task_b, key_b, Some(2_000));
        let ordered = compare_group_tasks(&(task_a.clone(), key_a.clone(), Some(1_000)), &right);
        assert_eq!(ordered, std::cmp::Ordering::Less, "the smaller order comes first");
        // A missing order is treated as 0, so it lands **before** an ordered member, matching the
        // `?? 0` in the original.
        let unordered = compare_group_tasks(&(task_a, key_a, None), &right);
        assert_eq!(unordered, std::cmp::Ordering::Less);
    }

    /// A dirty order key is skipped, not fatal: the client backfills from `createdAt`.
    #[test]
    fn a_dirty_task_order_key_is_skipped_rather_than_failing_the_read() {
        assert_eq!(parse_task_order_key(r#"["ws","t1"]"#), Some(("ws".into(), "t1".into())));
        assert_eq!(parse_task_order_key("not json"), None);
        assert_eq!(parse_task_order_key("[1,2]"), None, "non-strings are not a task key");
        assert_eq!(parse_task_order_key(r#"["only-one"]"#), None, "the array must have two members");
    }

    /// The structure read filters a bootstrap group to its own workspace and does not mutate.
    #[test]
    fn the_structure_read_scopes_a_bootstrap_group_to_its_workspace() {
        let conn = memory();
        with_group_schema(&conn);
        conn.execute("INSERT INTO task_groups VALUES ('g1', 'Manual', 'gray', 1, 1)", [])
            .expect("insert");
        conn.execute(
            "INSERT INTO task_groups VALUES (?, 'Bootstrapped', 'red', 1, 1)",
            rusqlite::params![workspace_group_id("ws-a")],
        )
        .expect("insert");
        conn.execute(
            "INSERT INTO task_group_workspace_bootstraps VALUES ('ws-a', ?, 1, 1)",
            rusqlite::params![workspace_group_id("ws-a")],
        )
        .expect("insert");
        member(&conn, "g1", "ws-a", "t1", Some(1_000), 1);

        let structure = query_grouped_task_view_structure(
            &conn,
            &[WorkspaceScope {
                workspace_key: "ws-b".into(),
                workspace_path: "/ws-b".into(),
                workspace_identity: None,
            }],
        )
        .expect("structure");
        let ids: Vec<&str> = structure.groups.iter().map(|group| group.id.as_str()).collect();
        assert!(ids.contains(&"g1"), "a manual group is global");
        assert!(
            !ids.iter().any(|id| id.starts_with("workspace-group")),
            "another workspace's bootstrap group is not visible here"
        );
        assert!(structure.members.is_empty(), "and its members follow the same scope");
    }
}

/// `applyGroupedTaskViewOrder` (`taskIndexRepo.ts:2365-2553`): the drag-and-drop save.
///
/// Two validations run **before** anything is written, and they are the whole reason this is not a
/// blind write:
///
/// - a task outside the current scope, or one that is deleted/archived/pinned, is an **error**;
/// - a task whose stored provider differs is **skipped**, not an error. Grouped is written back
///   into the package with no provider boundary in front of it, so refusing would strand a whole
///   workspace; skipping treats the old gemini/codex/claude references as invisible legacy data.
///
/// The write is one transaction and the order is submitted **once**, rather than per group: a
/// partial write leaves the grouped view showing a menu edit or an ungrouping that was never saved.
pub fn apply_grouped_task_view_order(
    conn: &mut rusqlite::Connection,
    workspace_scopes: &[WorkspaceScope],
    provider: Option<&str>,
    top_level_nodes: &[TopLevelNode],
    groups: &[(String, Vec<GroupedTaskRef>)],
    now: i64,
) -> Result<Vec<GroupedNode>, MigrationError> {
    let workspace_keys: BTreeSet<String> = workspace_scopes
        .iter()
        .map(|scope| scope.workspace_key.clone())
        .collect();

    let known_groups: BTreeSet<String> = read_all(
        conn,
        "SELECT group_id FROM task_groups",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .collect();

    // A node the caller sent that names a group which does not exist is a hard error: silently
    // dropping it would leave the user having dragged a card into nothing.
    for node in top_level_nodes {
        if let TopLevelNode::Group { group_id } = node {
            if !known_groups.contains(group_id) {
                return Err(sql(
                    "grouped task order contains a group that does not exist",
                    rusqlite::Error::InvalidQuery,
                ));
            }
        }
    }
    for (group_id, _) in groups {
        if !known_groups.contains(group_id) {
            return Err(sql(
                "grouped task order contains a group that does not exist",
                rusqlite::Error::InvalidQuery,
            ));
        }
    }

    let validate = |task: &GroupedTaskRef| -> Result<Option<String>, MigrationError> {
        if !workspace_keys.contains(&task.workspace_key) {
            return Err(sql(
                "grouped task order contains a task outside the current scope",
                rusqlite::Error::InvalidQuery,
            ));
        }
        let Some(row) = read_task_row(conn, &task.workspace_key, &task.task_id)? else {
            return Err(sql(
                "grouped task order contains an invisible task",
                rusqlite::Error::InvalidQuery,
            ));
        };
        if row.deleted == 1 || row.archived == 1 || row.pinned == 1 {
            return Err(sql(
                "grouped task order contains an invisible task",
                rusqlite::Error::InvalidQuery,
            ));
        }
        // Not an error: legacy provider references are skipped rather than blocking the save.
        if let Some(provider) = provider {
            if row.provider.as_deref() != Some(provider) {
                return Ok(None);
            }
        }
        Ok(Some(task.workspace_key.clone()))
    };

    let mut top_level_task_keys: BTreeSet<String> = BTreeSet::new();
    let mut visible_top_level: Vec<TopLevelNode> = Vec::new();
    for node in top_level_nodes {
        match node {
            TopLevelNode::Group { .. } => visible_top_level.push(node.clone()),
            TopLevelNode::Task { task } => {
                if validate(task)?.is_some() {
                    top_level_task_keys.insert(task_node_key(&task.workspace_key, &task.task_id));
                    visible_top_level.push(node.clone());
                }
            }
        }
    }

    let mut grouped_task_keys: BTreeSet<String> = BTreeSet::new();
    let mut visible_groups: Vec<(String, Vec<GroupedTaskRef>)> = Vec::new();
    for (group_id, task_refs) in groups {
        let mut visible: Vec<GroupedTaskRef> = Vec::new();
        for task_ref in task_refs {
            if validate(task_ref)?.is_none() {
                continue;
            }
            let key = task_node_key(&task_ref.workspace_key, &task_ref.task_id);
            if !grouped_task_keys.insert(key) {
                return Err(sql(
                    "grouped task order cannot put the same task into multiple groups",
                    rusqlite::Error::InvalidQuery,
                ));
            }
            visible.push(task_ref.clone());
        }
        visible_groups.push((group_id.clone(), visible));
    }

    // Every task in scope, so their top-level orders can be cleared. Scoped on purpose: clearing
    // every task would delete the mixed ordering of a remote or unexpanded workspace.
    let mut scoped_task_order_keys: Vec<String> = Vec::new();
    if !workspace_keys.is_empty() {
        let placeholders = vec!["?"; workspace_keys.len()].join(", ");
        let sql_text = format!(
            "SELECT workspace_key, task_id FROM tasks WHERE workspace_key IN ({placeholders})"
        );
        let args: Vec<Box<dyn rusqlite::ToSql>> = workspace_keys
            .iter()
            .map(|key| Box::new(key.clone()) as Box<dyn rusqlite::ToSql>)
            .collect();
        let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|value| value.as_ref()).collect();
        let mut statement = conn.prepare(&sql_text).map_err(|source| sql("cannot read the scoped tasks", source))?;
        let rows = statement
            .query_map(arg_refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|source| sql("cannot read the scoped tasks", source))?;
        for row in rows {
            let (workspace_key, task_id) = row.map_err(|source| sql("cannot read a scoped task", source))?;
            scoped_task_order_keys.push(task_node_key(&workspace_key, &task_id));
        }
    }

    let transaction = conn
        .transaction()
        .map_err(|source| sql("cannot begin the order save", source))?;
    let outcome = (|| -> Result<(), MigrationError> {
        // Once the user has saved an order, the workspace bootstrap must not fire again for a new
        // workspace — otherwise their arrangement is undone behind their back.
        transaction
            .execute(
                "INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at)
                 VALUES (?1, NULL, ?2, ?2)
                 ON CONFLICT(workspace_key) DO UPDATE SET updated_at = excluded.updated_at",
                rusqlite::params![GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now],
            )
            .map_err(|source| sql("cannot disable the workspace bootstrap", source))?;

        // A task that is now top-level loses whatever group it was in.
        for key in &top_level_task_keys {
            let (workspace_key, task_id) = key
                .split_once('\u{0}')
                .ok_or_else(|| sql("grouped task order has an invalid top-level task key", rusqlite::Error::InvalidQuery))?;
            transaction
                .execute(
                    "DELETE FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2",
                    rusqlite::params![workspace_key, task_id],
                )
                .map_err(|source| sql("cannot clear the membership", source))?;
        }
        for (group_id, task_refs) in &visible_groups {
            for (index, task_ref) in task_refs.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO task_group_members
                           (group_id, workspace_key, workspace_path, workspace_identity, task_id,
                            sort_order, added_at, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
                         ON CONFLICT(workspace_key, task_id) DO UPDATE SET
                           group_id = excluded.group_id,
                           workspace_path = excluded.workspace_path,
                           workspace_identity = excluded.workspace_identity,
                           sort_order = excluded.sort_order,
                           updated_at = excluded.updated_at",
                        rusqlite::params![
                            group_id,
                            task_ref.workspace_key,
                            task_ref.workspace_path,
                            task_ref.workspace_identity,
                            task_ref.task_id,
                            (index as i64 + 1) * GROUPED_TASK_ORDER_STEP,
                            now
                        ],
                    )
                    .map_err(|source| sql("cannot write the membership", source))?;
            }
        }

        // Submitted once: the whole order, not one group at a time.
        transaction
            .execute("DELETE FROM task_group_view_node_orders WHERE node_type = 'group'", [])
            .map_err(|source| sql("cannot clear the group orders", source))?;
        for key in &scoped_task_order_keys {
            let Some((workspace_key, task_id)) = key.split_once('\u{0}') else { continue };
            let order_key = task_order_node_key(workspace_key, task_id)?;
            transaction
                .execute(
                    "DELETE FROM task_group_view_node_orders
                     WHERE node_type = 'task' AND (node_key = ?1 OR node_key = ?2)",
                    rusqlite::params![order_key, workspace_key],
                )
                .map_err(|source| sql("cannot clear the task orders", source))?;
        }
        for (index, node) in visible_top_level.iter().enumerate() {
            let (node_type, node_key) = match node {
                TopLevelNode::Group { group_id } => ("group", group_id.clone()),
                TopLevelNode::Task { task } => ("task", task_order_node_key(&task.workspace_key, &task.task_id)?),
            };
            transaction
                .execute(
                    "INSERT INTO task_group_view_node_orders
                       (node_type, node_key, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    rusqlite::params![node_type, node_key, (index as i64 + 1) * GROUPED_TASK_ORDER_STEP, now],
                )
                .map_err(|source| sql("cannot write the order", source))?;
        }
        Ok(())
    })();

    match outcome {
        Ok(()) => {
            transaction
                .commit()
                .map_err(|source| sql("cannot commit the order save", source))?;
        }
        Err(error) => {
            let _ = transaction.rollback();
            return Err(error);
        }
    }

    // The caller gets the view as it now reads, so it renders what was saved rather than what it
    // hoped for.
    query_grouped_task_view(
        conn,
        &GroupedViewQuery {
            workspace_scopes: workspace_scopes.to_vec(),
            include_all_workspaces: false,
            provider: provider.map(str::to_string),
        },
        now,
    )
}

/// A task reference as the order save receives it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupedTaskRef {
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub task_id: String,
}

/// A top-level node as the order save receives it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum TopLevelNode {
    #[serde(rename = "group")]
    Group { group_id: String },
    #[serde(rename = "task")]
    Task { task: GroupedTaskRef },
}

fn read_task_row(
    conn: &rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
) -> Result<Option<TaskRow>, MigrationError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE workspace_key = ?1 AND task_id = ?2"
        ))
        .map_err(|source| sql("cannot prepare the task read", source))?;
    let mut rows = statement
        .query_map(rusqlite::params![workspace_key, task_id], TaskRow::from_sql_row)
        .map_err(|source| sql("cannot read the task", source))?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|source| sql("cannot read the task", source))?)),
        None => Ok(None),
    }
}
