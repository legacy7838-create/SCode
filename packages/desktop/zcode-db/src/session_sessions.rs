//! Session row reads (the Agent CLI `session` table): `getSession` + `listSessions`. The projection
//! mirrors `decodeSessionRow` (`codecs.ts`) exactly: fixed key order, `?? undefined` fields kept when
//! non-null (even `0`/`""`), truthy-checked fields omitted when null/empty, and the three JSON columns
//! parsed with `decodeJson` semantics (empty/absent → omit; invalid → error). Verified by
//! `harness/session_sessions_parity`.

use rusqlite::{Connection, OptionalExtension, types::ToSql};
use serde_json::{Map, Value, json};

/// The session columns in a stable read order (named access avoids `select *` column drift).
const SESSION_COLUMNS: &str = "id, project_id, workspace_id, parent_id, trace_id, task_type, slug, \
    directory, path, title, title_source, title_message_id, version, share_url, summary_additions, \
    summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, \
    time_title_updated, time_compacting, time_archived";

const SESSION_TASK_TYPES: &[&str] = &[
    "interactive",
    "fork",
    "selection_side_chat",
    "workflow_parent",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
];
const SESSION_TITLE_SOURCES: &[&str] = &["default", "first_input", "generated", "custom"];

fn decode_task_type(value: &str) -> &str {
    if SESSION_TASK_TYPES.contains(&value) { value } else { "interactive" }
}

fn decode_title_source(value: &str) -> &str {
    if SESSION_TITLE_SOURCES.contains(&value) { value } else { "first_input" }
}

/// `decodeJson(col)`: null/empty → `None` (omit); otherwise parse, propagating a parse error like JS
/// `JSON.parse` throwing on invalid content.
pub(crate) fn decode_json_col(raw: &Option<String>) -> Result<Option<Value>, String> {
    match raw {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => serde_json::from_str::<Value>(s).map(Some).map_err(|e| e.to_string()),
    }
}

/// Owned raw session row (rusqlite-native reads only); projection into JSON happens in `into_value`
/// so a JSON parse error propagates instead of being swallowed.
struct SessionRowData {
    id: String,
    project_id: String,
    workspace_id: Option<String>,
    parent_id: Option<String>,
    trace_id: Option<String>,
    task_type: String,
    slug: String,
    directory: String,
    path: Option<String>,
    title: String,
    title_source: String,
    title_message_id: Option<String>,
    version: String,
    share_url: Option<String>,
    summary_additions: Option<i64>,
    summary_deletions: Option<i64>,
    summary_files: Option<i64>,
    summary_diffs: Option<String>,
    revert: Option<String>,
    permission: Option<String>,
    time_created: i64,
    time_updated: i64,
    time_title_updated: Option<i64>,
    time_compacting: Option<i64>,
    time_archived: Option<i64>,
}

impl SessionRowData {
    /// Build the `SessionInfo` projection in `decodeSessionRow`'s exact key order.
    fn into_value(self) -> Result<Value, String> {
        let mut o = Map::new();
        o.insert("id".into(), json!(self.id));
        o.insert("projectID".into(), json!(self.project_id));
        // truthy-checked: omitted when null OR empty string.
        if let Some(v) = self.workspace_id.filter(|s| !s.is_empty()) {
            o.insert("workspaceID".into(), json!(v));
        }
        if let Some(v) = self.parent_id.filter(|s| !s.is_empty()) {
            o.insert("parentID".into(), json!(v));
        }
        if let Some(v) = self.trace_id.filter(|s| !s.is_empty()) {
            o.insert("traceID".into(), json!(v));
        }
        o.insert("taskType".into(), json!(decode_task_type(&self.task_type)));
        o.insert("slug".into(), json!(self.slug));
        o.insert("directory".into(), json!(self.directory));
        // `?? undefined`: kept when non-null, even if empty string.
        if let Some(v) = self.path {
            o.insert("path".into(), json!(v));
        }
        o.insert("title".into(), json!(self.title));
        o.insert("titleSource".into(), json!(decode_title_source(&self.title_source)));
        if let Some(v) = self.title_message_id.filter(|s| !s.is_empty()) {
            o.insert("titleMessageID".into(), json!(v));
        }
        o.insert("version".into(), json!(self.version));
        if let Some(v) = self.share_url {
            o.insert("shareURL".into(), json!(v));
        }
        if let Some(v) = self.summary_additions {
            o.insert("summaryAdditions".into(), json!(v));
        }
        if let Some(v) = self.summary_deletions {
            o.insert("summaryDeletions".into(), json!(v));
        }
        if let Some(v) = self.summary_files {
            o.insert("summaryFiles".into(), json!(v));
        }
        if let Some(v) = decode_json_col(&self.summary_diffs)? {
            o.insert("summaryDiffs".into(), v);
        }
        if let Some(v) = decode_json_col(&self.revert)? {
            o.insert("revert".into(), v);
        }
        if let Some(v) = decode_json_col(&self.permission)? {
            o.insert("permission".into(), v);
        }
        let mut t = Map::new();
        t.insert("created".into(), json!(self.time_created));
        t.insert("updated".into(), json!(self.time_updated));
        if let Some(v) = self.time_title_updated {
            t.insert("titleUpdated".into(), json!(v));
        }
        if let Some(v) = self.time_compacting {
            t.insert("compacting".into(), json!(v));
        }
        if let Some(v) = self.time_archived {
            t.insert("archived".into(), json!(v));
        }
        o.insert("time".into(), Value::Object(t));
        Ok(Value::Object(o))
    }
}

fn read_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRowData> {
    Ok(SessionRowData {
        id: row.get(0)?,
        project_id: row.get(1)?,
        workspace_id: row.get(2)?,
        parent_id: row.get(3)?,
        trace_id: row.get(4)?,
        task_type: row.get(5)?,
        slug: row.get(6)?,
        directory: row.get(7)?,
        path: row.get(8)?,
        title: row.get(9)?,
        title_source: row.get(10)?,
        title_message_id: row.get(11)?,
        version: row.get(12)?,
        share_url: row.get(13)?,
        summary_additions: row.get(14)?,
        summary_deletions: row.get(15)?,
        summary_files: row.get(16)?,
        summary_diffs: row.get(17)?,
        revert: row.get(18)?,
        permission: row.get(19)?,
        time_created: row.get(20)?,
        time_updated: row.get(21)?,
        time_title_updated: row.get(22)?,
        time_compacting: row.get(23)?,
        time_archived: row.get(24)?,
    })
}

/// Port of `getSession`: the session by id, or `null`.
pub fn get_session(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let sql = format!("select {} from session where id = ?1", SESSION_COLUMNS);
    let row = conn
        .query_row(&sql, [&session_id], read_session_row)
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(Value::Null),
        Some(r) => r.into_value(),
    }
}

/// Port of `listSessions`: dynamic WHERE/order/limit from a `ListSessionsInput` JSON filter.
pub fn list_sessions(conn: &Connection, filter: &Value) -> Result<Value, String> {
    let obj = match filter {
        Value::Null => Map::new(),
        Value::Object(m) => m.clone(),
        _ => return Err("listSessions filter must be an object or null".to_string()),
    };
    let mut clauses: Vec<String> = Vec::new();
    let mut vals: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(s) = obj.get("projectID").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        clauses.push("project_id = ?".to_string());
        vals.push(Box::new(s.to_string()));
    }
    if let Some(w) = obj.get("workspaceID") {
        if w.is_null() {
            clauses.push("workspace_id is null".to_string());
        } else if let Some(s) = w.as_str() {
            clauses.push("workspace_id = ?".to_string());
            vals.push(Box::new(s.to_string()));
        }
    }
    if let Some(s) = obj.get("directory").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        clauses.push("directory = ?".to_string());
        vals.push(Box::new(s.to_string()));
    }
    if let Some(p) = obj.get("path").and_then(Value::as_str) {
        if p.is_empty() {
            clauses.push("(path is null or path = '')".to_string());
        } else {
            clauses.push("(path = ? or path like ?)".to_string());
            vals.push(Box::new(p.to_string()));
            vals.push(Box::new(format!("{p}/%")));
        }
    }
    if obj.get("roots").and_then(Value::as_bool).unwrap_or(false) {
        clauses.push("parent_id is null".to_string());
    }
    if let Some(arr) = obj.get("taskTypes").and_then(Value::as_array) {
        let mut seen: Vec<String> = Vec::new();
        for t in arr.iter().filter_map(Value::as_str) {
            if SESSION_TASK_TYPES.contains(&t) && !seen.iter().any(|x| x == t) {
                seen.push(t.to_string());
            }
        }
        if !seen.is_empty() {
            clauses.push(format!(
                "task_type in ({})",
                seen.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
            ));
            for t in &seen {
                vals.push(Box::new(t.clone()));
            }
        }
    }
    if !obj.get("includeArchived").and_then(Value::as_bool).unwrap_or(false) {
        clauses.push("time_archived is null".to_string());
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" where {}", clauses.join(" and "))
    };
    let mut limit_sql = String::new();
    if let Some(l) = obj.get("limit").and_then(Value::as_i64).filter(|l| *l > 0) {
        limit_sql = " limit ?".to_string();
        vals.push(Box::new(l));
    }
    let sql = format!(
        "select {} from session{} order by time_updated desc, id desc{}",
        SESSION_COLUMNS, where_sql, limit_sql
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(refs), read_session_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(r.into_value()?);
    }
    Ok(Value::Array(out))
}
