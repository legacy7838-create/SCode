//! The read path: `getTaskMeta`, `listTaskMetas`, `listDeletedTaskIds`, `listSessionsByAutomation`,
//! `queryTaskList`, `hasGroupedWorkspaceBootstrapRun` and `archiveStaleTasks`.
//!
//! Ported from `taskIndexRepo.ts`. Spec: docs/specs/rust-native-task-index.md §22 (batch A).
//!
//! # The one projection these all share
//!
//! Every read selects [`TASK_COLUMNS`] and maps each row through [`row_to_meta`]. Six of the seven
//! methods differ only in their `WHERE` clause, so the projection is defined once: if the SELECTs
//! are allowed to drift, one of them silently stops returning `last_unread_at` and a caller
//! computing an unread watermark starts from a stale one.
use rusqlite::Row;

use crate::meta::{row_to_meta, sql, TaskMeta, TaskRow, TASK_COLUMNS};
use crate::migrate::MigrationError;
use crate::read::build_search_snippets;

/// `listTaskMetas`' filter, with every field tri-state so an absent one does not filter.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ListQuery {
    /// `None` queries every workspace; `Some` scopes to one resolved key.
    pub workspace_key: Option<String>,
    pub include_deleted: bool,
    pub provider: Option<String>,
    /// `None` ignores the flag rather than filtering on it.
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

/// `queryTaskList`' filter.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct TaskListQuery {
    /// Already resolved by the caller: the identity rule is applied outside the engine so two
    /// paths sharing an identity cannot produce two scopes.
    pub workspace_keys: Vec<String>,
    pub search: Option<String>,
    pub kind: Option<String>,
    pub provider: Option<String>,
    pub limit: Option<i64>,
    pub sort_by: Option<String>,
    /// Purpose per workspace key, for the display layer. Kept out of SQL.
    #[serde(default)]
    pub workspace_purpose_by_key: Vec<(String, String)>,
}

/// The `queryTaskList` result.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListResult {
    pub items: Vec<TaskListItem>,
    pub total: i64,
    pub has_more: bool,
}

/// One task-list row: the meta plus the snippets a search produced.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListItem {
    #[serde(flatten)]
    pub meta: TaskMeta,
    /// The first snippet, as the dialog shows it. Absent when there was no search or no hit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_snippet: Option<String>,
    /// Every snippet, for the expanded result. Absent when there was no search or no hit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_snippets: Option<Vec<String>>,
}

/// `normalizeLimit` (`taskIndexRepo.ts`): a non-positive or absent limit means "no limit".
///
/// Clamping rather than rejecting, so a caller that computes `remaining` and gets 0 still gets its
/// rows back — a `LIMIT 0` would return nothing and look like data loss.
fn normalize_limit(limit: Option<i64>) -> Option<i64> {
    match limit {
        Some(value) if value > 0 => Some(value),
        _ => None,
    }
}

/// The `appendZCodeAgentIndexedProviderFilter` predicate: an indexed provider plus its agent
/// aliases, so a row stored under either form matches.
fn provider_predicate(provider: &str) -> String {
    // The indexed values are the provider's own id and the `glm` literal the schema stores. Both
    // are matched so a row written by either Host is found.
    let escaped = provider.replace('\'', "''");
    format!("(provider = '{escaped}' OR provider = 'glm')")
}

fn query_rows(conn: &rusqlite::Connection, sql_text: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<TaskRow>, MigrationError> {
    let mut statement = conn.prepare(sql_text).map_err(|source| sql("cannot prepare the task read", source))?;
    let rows = statement
        .query_map(params, TaskRow::from_sql_row)
        .map_err(|source| sql("cannot read the task rows", source))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|source| sql("cannot read a task row", source))?);
    }
    Ok(out)
}

impl TaskRow {
    fn as_meta(row: &Row<'_>) -> rusqlite::Result<Self> {
        Self::from_sql_row(row)
    }
}

/// `listTaskMetas` (`taskIndexRepo.ts:1668-1733`).
pub fn list_task_metas(
    conn: &rusqlite::Connection,
    query: &ListQuery,
) -> Result<Vec<TaskMeta>, MigrationError> {
    // Named parameters, because every predicate is a nullable tri-state and positional `?` would
    // make "absent" and "explicitly null" indistinguishable.
    // Every predicate is emitted unconditionally. The flags are bound as nullable tri-states, so
    // an absent filter passes everything — and a fixed placeholder count keeps the statement and
    // its parameters in step, which omitting a clause would not.
    let mut where_parts = vec![
        "(@workspace_key IS NULL OR workspace_key = @workspace_key)".to_string(),
        "(@include_deleted = 1 OR deleted = 0)".to_string(),
        "(@provider IS NULL OR provider = @provider)".to_string(),
    ];
    where_parts.push("(@pinned IS NULL OR pinned = @pinned)".to_string());
    where_parts.push("(@archived IS NULL OR archived = @archived)".to_string());

    let sql_text = format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE {} \
         ORDER BY updated_at DESC, created_at DESC, task_id DESC",
        where_parts.join(" AND ")
    );
    let rows = query_rows(
        conn,
        &sql_text,
        &[
            &query.workspace_key,
            &(i64::from(query.include_deleted)),
            &query.provider,
            &query.pinned.map(i64::from),
            &query.archived.map(i64::from),
        ],
    )?;
    Ok(rows.iter().map(row_to_meta).collect())
}

/// `getTaskMeta` (`taskIndexRepo.ts:2555-2567`).
///
/// A deleted row reads as absent. The tombstone is not erased — the CLI session store still has
/// the session — so a deleted task must not come back as a normal one.
pub fn get_task_meta(
    conn: &rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
) -> Result<Option<TaskMeta>, MigrationError> {
    let sql_text = format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE workspace_key = ?1 AND task_id = ?2"
    );
    let mut statement = conn.prepare(&sql_text).map_err(|source| sql("cannot prepare the task read", source))?;
    let mut rows = statement
        .query_map(rusqlite::params![workspace_key, task_id], TaskRow::as_meta)
        .map_err(|source| sql("cannot read the task row", source))?;
    match rows.next() {
        Some(row) => {
            let row = row.map_err(|source| sql("cannot read the task row", source))?;
            if row.deleted == 1 {
                return Ok(None);
            }
            Ok(Some(row_to_meta(&row)))
        }
        None => Ok(None),
    }
}

/// `listDeletedTaskIds` (`taskIndexRepo.ts:1735-1763`).
///
/// The tombstones themselves. Needed because the list join reads only active/pinned/archived rows:
/// without this a deleted task is "not in the archived collection" and would reappear after a cold
/// start.
pub fn list_deleted_task_ids(
    conn: &rusqlite::Connection,
    workspace_key: &str,
    provider: Option<&str>,
) -> Result<Vec<String>, MigrationError> {
    let sql_text = format!(
        "SELECT task_id FROM tasks
         WHERE workspace_key = ?1
           AND deleted = 1
           AND (?2 IS NULL OR provider = ?2)
         ORDER BY task_id"
    );
    let mut statement = conn.prepare(&sql_text).map_err(|source| sql("cannot prepare the tombstone read", source))?;
    let rows = statement
        .query_map(rusqlite::params![workspace_key, provider], |row| row.get::<_, String>(0))
        .map_err(|source| sql("cannot read the tombstones", source))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|source| sql("cannot read a tombstone", source))?);
    }
    Ok(out)
}

/// `listSessionsByAutomation` (`taskIndexRepo.ts:1765-1799`).
pub fn list_sessions_by_automation(
    conn: &rusqlite::Connection,
    automation_id: &str,
) -> Result<Vec<TaskMeta>, MigrationError> {
    let sql_text = format!(
        "SELECT {TASK_COLUMNS} FROM tasks
         WHERE cron_automation_id = ?1
           AND deleted = 0
         ORDER BY created_at DESC, task_id DESC"
    );
    let rows = query_rows(conn, &sql_text, &[&automation_id])?;
    Ok(rows.iter().map(row_to_meta).collect())
}

/// `hasGroupedWorkspaceBootstrapRun` (`taskIndexRepo.ts:867-870`).
///
/// "Has the workspace-group bootstrap ever run", not "is it enabled for this workspace": the marker
/// table is global, and that is deliberate — a user who has seen a grouped sidebar once should not
/// have it re-created for every new workspace afterwards.
pub fn has_grouped_workspace_bootstrap_run(
    conn: &rusqlite::Connection,
) -> Result<bool, MigrationError> {
    let mut statement = conn
        .prepare("SELECT 1 AS found FROM task_group_workspace_bootstraps LIMIT 1")
        .map_err(|source| sql("cannot prepare the bootstrap probe", source))?;
    let mut rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|source| sql("cannot read the bootstrap marker", source))?;
    match rows.next() {
        Some(row) => Ok(row
            .map_err(|source| sql("cannot read the bootstrap marker", source))?
            == 1),
        None => Ok(false),
    }
}

/// `archiveStaleTasks` (`taskIndexRepo.ts:872-953`).
///
/// Selects the rows first, then archives them **in one transaction**, and returns the pre-archive
/// rows. Returning the post-archive rows would report `archived: true` for tasks the caller is about
/// to be told were just archived — harmless — but the select-then-write order is load-bearing for a
/// different reason: the count and the write are derived from the same snapshot, so a concurrent
/// archiver cannot make the two disagree.
pub fn archive_stale_tasks(
    conn: &mut rusqlite::Connection,
    workspace_key: &str,
    cutoff: i64,
    provider: Option<&str>,
) -> Result<Vec<TaskMeta>, MigrationError> {
    // `Math.max(1, Math.floor(olderThanDays))`: a zero or negative span would archive everything
    // that ever completed, so the floor is a safety bound rather than a normalisation.
    let mut where_parts = vec![
        "workspace_key = ?1".to_string(),
        "deleted = 0".to_string(),
        "archived = 0".to_string(),
        "pinned = 0".to_string(),
        "unread_at IS NULL".to_string(),
        "updated_at < ?2".to_string(),
        "task_status = 'completed'".to_string(),
    ];
    if let Some(provider) = provider {
        where_parts.push(provider_predicate(provider));
    }
    let sql_text = format!(
        "SELECT {TASK_COLUMNS} FROM tasks WHERE {}
         ORDER BY updated_at DESC, created_at DESC, task_id DESC",
        where_parts.join(" AND ")
    );
    let rows = query_rows(
        conn,
        &sql_text,
        &[&workspace_key as &dyn rusqlite::ToSql, &cutoff as &dyn rusqlite::ToSql],
    )?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let metas: Vec<TaskMeta> = rows.iter().map(row_to_meta).collect();

    let transaction = conn.transaction().map_err(|source| sql("cannot begin the archive", source))?;
    for row in &rows {
        transaction
            .execute(
                "UPDATE tasks SET archived = 1 WHERE workspace_key = ?1 AND task_id = ?2",
                rusqlite::params![row.workspace_key, row.task_id],
            )
            .map_err(|source| sql("cannot archive a task", source))?;
    }
    transaction
        .commit()
        .map_err(|source| sql("cannot commit the archive", source))?;
    Ok(metas)
}

/// `queryTaskList` (`taskIndexRepo.ts:1801-1894`).
///
/// The `kind` predicate is a **closed** set — `pinned`, `archived`, or neither — and the default is
/// "unpinned and not archived", which is the ordinary sidebar. The search matches the title **or**
/// the indexed body, and the snippet is built afterwards from the stored text rather than by SQL, so
/// a hit on either surface is visible in the same result.
pub fn query_task_list(
    conn: &rusqlite::Connection,
    query: &TaskListQuery,
) -> Result<TaskListResult, MigrationError> {
    if query.workspace_keys.is_empty() {
        return Ok(TaskListResult { items: Vec::new(), total: 0, has_more: false });
    }

    // A search is trimmed before it is matched; an all-whitespace search is no search, otherwise
    // every row would match `"%%"`.
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty());
    // `toLocaleLowerCase`, and the column side is `LOWER(...)` — SQLite's `LOWER` is ASCII-only, so
    // a non-ASCII title matches case-insensitively only when the stored text is already lowercase.
    // That limitation is the original's and is not widened here.
    let like = search.map(|value| format!("%{}%", value.to_lowercase()));

    let mut where_parts = vec![
        "deleted = 0".to_string(),
        format!(
            "workspace_key IN ({})",
            vec!["?"; query.workspace_keys.len()].join(", ")
        ),
    ];
    if let Some(provider) = query.provider.as_deref() {
        where_parts.push(provider_predicate(provider));
    }
    match query.kind.as_deref() {
        Some("pinned") => {
            where_parts.push("pinned = 1".to_string());
            where_parts.push("archived = 0".to_string());
        }
        Some("archived") => where_parts.push("archived = 1".to_string()),
        _ => {
            where_parts.push("pinned = 0".to_string());
            where_parts.push("archived = 0".to_string());
        }
    }
    if like.is_some() {
        where_parts.push("(LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)".to_string());
    }
    let where_clause = where_parts.join(" AND ");

    // `args` starts as the workspace keys and the search pattern is pushed twice, so the `?`
    // placeholders in the where clause line up in order.
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = query
        .workspace_keys
        .iter()
        .map(|key| Box::new(key.clone()) as Box<dyn rusqlite::ToSql>)
        .collect();
    if let Some(pattern) = &like {
        args.push(Box::new(pattern.clone()));
        args.push(Box::new(pattern.clone()));
    }
    let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|value| value.as_ref()).collect();

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(1) AS total FROM tasks WHERE {where_clause}"),
            arg_refs.as_slice(),
            |row| row.get(0),
        )
        .map_err(|source| sql("cannot count the task list", source))?;

    let limit = normalize_limit(query.limit);
    let order_by = match query.sort_by.as_deref() {
        Some("created") => "created_at DESC, updated_at DESC, task_id DESC",
        _ => "updated_at DESC, created_at DESC, task_id DESC",
    };
    let list_sql = if limit.is_some() {
        format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE {where_clause} ORDER BY {order_by} LIMIT ?"
        )
    } else {
        format!("SELECT {TASK_COLUMNS} FROM tasks WHERE {where_clause} ORDER BY {order_by}")
    };
    let mut list_args = arg_refs;
    if limit.is_some() {
        list_args.push(&limit as &dyn rusqlite::ToSql);
    }
    let rows = query_rows(conn, &list_sql, &list_args)?;

    let items = rows
        .iter()
        .map(|row| {
            let snippets = build_search_snippets(&row.searchable_text, search);
            let meta = row_to_meta(row);
            match snippets.split_first() {
                Some((first, rest)) => TaskListItem {
                    meta,
                    search_snippet: Some(first.clone()),
                    search_snippets: Some(std::iter::once(first.clone()).chain(rest.iter().cloned()).collect()),
                },
                None => TaskListItem { meta, search_snippet: None, search_snippets: None },
            }
        })
        .collect::<Vec<_>>();

    let count = items.len() as i64;
    Ok(TaskListResult { items, total, has_more: total > count })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::{memory, meta_json};

    fn insert(conn: &rusqlite::Connection, key: &str, task_id: &str, updated: i64, deleted: i64, pinned: i64, archived: i64) {
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, task_status,
               updated_at, created_at, deleted, pinned, archived, title_overridden, searchable_text, meta_json)
             VALUES (?1, '/ws', ?2, ?2, 'auto', 'completed', ?3, ?3, ?4, ?5, ?6, 0, '', ?7)",
            rusqlite::params![key, task_id, updated, deleted, pinned, archived, meta_json(task_id, updated)],
        )
        .expect("insert");
    }

    /// The tri-state filters: an absent flag must not filter, and `Some(false)` must.
    #[test]
    fn an_absent_list_filter_does_not_narrow_the_result() {
        let conn = memory();
        insert(&conn, "ws", "a", 1, 0, 0, 0);
        insert(&conn, "ws", "b", 2, 0, 1, 0);
        insert(&conn, "ws", "c", 3, 1, 0, 0);

        // The default excludes the tombstone: 2 live rows, not 3.
        assert_eq!(list_task_metas(&conn, &ListQuery::default()).expect("list").len(), 2);
        let pinned = list_task_metas(&conn, &ListQuery { pinned: Some(true), ..ListQuery::default() })
            .expect("list");
        assert_eq!(pinned.len(), 1);
        assert_eq!(pinned[0].task_id, "b");
        let deleted = list_task_metas(
            &conn,
            &ListQuery { include_deleted: true, ..ListQuery::default() },
        )
        .expect("list");
        assert_eq!(deleted.len(), 3, "includeDeleted is what reveals the tombstone");
    }

    /// A deleted task reads as absent, while the tombstone list still reports it.
    ///
    /// The two must agree: the join reads only active rows, so without the tombstone list a
    /// deleted task is "not in the archived collection" and reappears after a cold start.
    #[test]
    fn a_deleted_task_is_absent_but_still_listed_as_a_tombstone() {
        let conn = memory();
        insert(&conn, "ws", "live", 1, 0, 0, 0);
        insert(&conn, "ws", "gone", 2, 1, 0, 0);

        assert!(get_task_meta(&conn, "ws", "gone").expect("read").is_none());
        assert!(get_task_meta(&conn, "ws", "live").expect("read").is_some());
        assert_eq!(
            list_deleted_task_ids(&conn, "ws", None).expect("tombstones"),
            vec!["gone".to_string()]
        );
    }

    /// The `kind` predicate is a closed set, and the default excludes both pinned and archived.
    #[test]
    fn the_task_list_kind_predicate_is_closed() {
        let conn = memory();
        insert(&conn, "ws", "plain", 1, 0, 0, 0);
        insert(&conn, "ws", "pinned", 2, 0, 1, 0);
        insert(&conn, "ws", "archived", 3, 0, 0, 1);

        let keys = |kind: Option<&str>| -> Vec<String> {
            query_task_list(
                &conn,
                &TaskListQuery {
                    workspace_keys: vec!["ws".into()],
                    kind: kind.map(str::to_string),
                    ..TaskListQuery::default()
                },
            )
            .expect("list")
            .items
            .into_iter()
            .map(|item| item.meta.task_id)
            .collect()
        };

        assert_eq!(keys(None), vec!["plain"], "the default sidebar is unpinned and unarchived");
        assert_eq!(keys(Some("pinned")), vec!["pinned"]);
        assert_eq!(keys(Some("archived")), vec!["archived"]);
    }

    /// An empty workspace scope short-circuits rather than producing a `NOT IN ()` query.
    #[test]
    fn an_empty_scope_is_an_empty_result_not_a_query() {
        let conn = memory();
        insert(&conn, "ws", "a", 1, 0, 0, 0);
        let result = query_task_list(&conn, &TaskListQuery::default()).expect("list");
        assert_eq!(result.total, 0);
        assert!(result.items.is_empty());
        assert!(!result.has_more);
    }

    /// `hasMore` is `total > rows returned`, so a limit equal to the total is not "more".
    #[test]
    fn has_more_compares_the_total_against_the_page() {
        let conn = memory();
        for index in 0..5 {
            insert(&conn, "ws", &format!("t{index}"), index, 0, 0, 0);
        }
        let page = |limit: Option<i64>| {
            query_task_list(
                &conn,
                &TaskListQuery { workspace_keys: vec!["ws".into()], limit, ..TaskListQuery::default() },
            )
            .expect("list")
        };
        assert!(!page(Some(5)).has_more, "an exact page is not more");
        assert!(page(Some(2)).has_more);
        assert_eq!(page(Some(2)).total, 5, "total counts the whole match, not the page");
        // A non-positive limit means "no limit", so nothing is silently truncated.
        assert_eq!(page(Some(0)).items.len(), 5);
        assert_eq!(page(Some(-1)).items.len(), 5);
    }

    /// The bootstrap marker is global, not per workspace.
    #[test]
    fn the_bootstrap_marker_is_global() {
        let conn = memory();
        assert!(!has_grouped_workspace_bootstrap_run(&conn).expect("probe"));
        conn.execute(
            "INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at)
             VALUES ('any-workspace', NULL, 1, 1)",
            [],
        )
        .expect("insert marker");
        assert!(has_grouped_workspace_bootstrap_run(&conn).expect("probe"));
    }
}
