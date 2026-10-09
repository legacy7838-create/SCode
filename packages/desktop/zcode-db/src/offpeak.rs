//! OffPeakTaskRepo read projection (slice 26). The repo is cron/timezone-free (only epoch-ms
//! timestamps), so its domain projection + single-row read port cleanly. The `list` (with a
//! `tasks` LEFT JOIN for a bound session title) and the claim/settle/poll state machine land in
//! later slices; they are not stubbed here — this module covers only what it fully implements.

use rusqlite::Connection;

use crate::automation::{read_serialized_model_selection, ModelSelection};

/// Port of `ZCodeOffPeakTask` (as produced by `rowToTask`). Optional fields are `None`/omitted to
/// match the TS spread semantics; `model_selection_issue` is present exactly when `model_selection`
/// is `None` (the `repair-required` marker).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffPeakTask {
    pub off_peak_task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_ticket_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_title: Option<String>,
    pub prompt: String,
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ModelSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection_issue: Option<serde_json::Value>,
    pub workspace_key: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    pub status: String,
    pub queued_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_at: Option<i64>,
    pub schedulable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_poll_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Named columns in the mapper's positional order — only the fields `rowToTask` reads (the claim /
/// attempt / lastError columns are not part of the domain output). Naming them keeps the mapping
/// stable across schema additions (a `SELECT *` would bind to table order).
const OFF_PEAK_COLUMNS: &str = "off_peak_task_id, server_ticket_id, title, conversation_id, \
     session_id, prompt, permission_mode, model_selection, workspace_key, workspace_path, \
     workspace_identity, status, queued_at, started_at, ended_at, failure_reason, files_changed, \
     settled_at, history_deleted_at, registered_at, schedulable, queue_position, next_poll_at, \
     created_at, updated_at";

fn str_or(r: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<String> {
    r.get::<_, Option<String>>(idx)
        .map(|v| v.unwrap_or_default())
}

/// Maps a row produced by `OFF_PEAK_COLUMNS` (25 positional columns). `title_idx` is the position of
/// the extra `session_title` column when the `tasks` LEFT-JOIN variant of `list` is used; `None`
/// (get / no-join list) leaves `session_title` absent, matching `rowToTask`.
fn map_off_peak_row(
    r: &rusqlite::Row<'_>,
    title_idx: Option<usize>,
) -> rusqlite::Result<OffPeakTask> {
    let model_selection =
        read_serialized_model_selection(r.get::<_, Option<String>>(7)?.as_deref());
    let model_selection_issue = model_selection
        .is_none()
        .then(|| serde_json::json!({ "code": "repair-required" }));
    let session_title = match title_idx {
        Some(i) => r.get::<_, Option<String>>(i)?,
        None => None,
    };
    Ok(OffPeakTask {
        off_peak_task_id: str_or(r, 0)?,
        server_ticket_id: r.get(1)?,
        title: str_or(r, 2)?,
        conversation_id: r.get(3)?,
        session_id: r.get(4)?,
        session_title,
        prompt: str_or(r, 5)?,
        permission_mode: str_or(r, 6)?,
        model_selection,
        model_selection_issue,
        workspace_key: str_or(r, 8)?,
        workspace_path: str_or(r, 9)?,
        workspace_identity: r.get(10)?,
        status: str_or(r, 11)?,
        queued_at: r.get(12)?,
        started_at: r.get(13)?,
        ended_at: r.get(14)?,
        failure_reason: r.get(15)?,
        files_changed: r.get(16)?,
        settled_at: r.get(17)?,
        history_deleted_at: r.get(18)?,
        registered_at: r.get(19)?,
        schedulable: r.get::<_, i64>(20).unwrap_or(0) == 1,
        queue_position: r.get(21)?,
        next_poll_at: r.get(22)?,
        created_at: r.get(23)?,
        updated_at: r.get(24)?,
    })
}

/// Port of `get` (via `getRow`): a single off-peak task by id, `None` when absent. `session_title`
/// stays absent (the join is only added by `list`).
pub fn get_off_peak(
    conn: &Connection,
    off_peak_task_id: &str,
) -> Result<Option<OffPeakTask>, String> {
    let sql = format!("SELECT {OFF_PEAK_COLUMNS} FROM off_peak_tasks WHERE off_peak_task_id = ?1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([off_peak_task_id], |r| map_off_peak_row(r, None))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(r) => r.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// The same 25 columns prefixed with the `t.` alias, for the LEFT-JOIN list variant (so `session_title`
/// at index 25 does not collide with `t.title` at index 2).
const OFF_PEAK_COLUMNS_T: &str = "t.off_peak_task_id, t.server_ticket_id, t.title, t.conversation_id, \
     t.session_id, t.prompt, t.permission_mode, t.model_selection, t.workspace_key, t.workspace_path, \
     t.workspace_identity, t.status, t.queued_at, t.started_at, t.ended_at, t.failure_reason, \
     t.files_changed, t.settled_at, t.history_deleted_at, t.registered_at, t.schedulable, \
     t.queue_position, t.next_poll_at, t.created_at, t.updated_at";

/// Port of `hasTasksIndexTable()`: whether the `tasks` table exists in this DB file. The off-peak
/// list only attaches `session_title` when the shared tasks-index table is present (a standalone
/// off-peak DB before migration has no `tasks` table).
pub fn has_tasks_index_table(conn: &Connection) -> Result<bool, String> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(found.is_some())
}

/// Port of `list`: all off-peak tasks (optionally scoped to one workspace key), `created_at DESC`.
/// When the `tasks` table exists, LEFT-JOINs the bound session title (`session_id → tasks.task_id`)
/// and sets `session_title`; otherwise the plain projection leaves it absent.
pub fn list_off_peak(
    conn: &Connection,
    workspace_key: Option<&str>,
) -> Result<Vec<OffPeakTask>, String> {
    let with_title = has_tasks_index_table(conn)?;
    let sql = if with_title {
        format!(
            "SELECT {OFF_PEAK_COLUMNS_T}, s.title AS session_title FROM off_peak_tasks t \
             LEFT JOIN tasks s ON s.workspace_key = t.workspace_key AND s.task_id = t.session_id \
             WHERE (@workspace_key IS NULL OR t.workspace_key = @workspace_key) \
             ORDER BY t.created_at DESC"
        )
    } else {
        format!(
            "SELECT {OFF_PEAK_COLUMNS} FROM off_peak_tasks \
             WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key) \
             ORDER BY created_at DESC"
        )
    };
    let wk = workspace_key
        .map(|s| rusqlite::types::Value::Text(s.to_string()))
        .unwrap_or(rusqlite::types::Value::Null);
    let params: Vec<(&str, &dyn rusqlite::types::ToSql)> = vec![("@workspace_key", &wk)];
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let title_idx = if with_title { Some(25) } else { None };
    let rows = stmt
        .query_map(params.as_slice(), |r| map_off_peak_row(r, title_idx))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn off_peak_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::adopt_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn get_off_peak_projects_fields_and_model_issue() {
        let conn = off_peak_db();
        conn.execute(
            "INSERT INTO off_peak_tasks (off_peak_task_id, title, prompt, permission_mode, \
             model_selection, workspace_key, workspace_path, status, queued_at, schedulable, \
             claim_running, attempt_count, created_at, updated_at) \
             VALUES ('o1','t','p','plan',?1,'wk','/w','queued',100,1,0,0,10,20)",
            rusqlite::params![r#"{"providerId":"account:zai","modelId":"GLM-5"}"#],
        )
        .unwrap();
        let t = get_off_peak(&conn, "o1").unwrap().unwrap();
        assert_eq!(t.off_peak_task_id, "o1");
        assert_eq!(t.permission_mode, "plan");
        assert!(t.schedulable);
        assert_eq!(t.status, "queued");
        assert_eq!(t.model_selection.as_ref().unwrap().model_id, "GLM-5");
        assert!(
            t.model_selection_issue.is_none(),
            "valid selection → no issue"
        );

        // An empty model_selection → no selection → repair-required issue attached.
        conn.execute(
            "INSERT INTO off_peak_tasks (off_peak_task_id, title, prompt, permission_mode, \
             workspace_key, workspace_path, status, queued_at, schedulable, claim_running, \
             attempt_count, created_at, updated_at) \
             VALUES ('o2','t','p','plan','wk','/w','queued',100,0,0,0,10,20)",
            [],
        )
        .unwrap();
        let t2 = get_off_peak(&conn, "o2").unwrap().unwrap();
        assert!(t2.model_selection.is_none());
        assert_eq!(
            t2.model_selection_issue,
            Some(serde_json::json!({ "code": "repair-required" }))
        );
        assert!(!t2.schedulable);
    }

    #[test]
    fn get_off_peak_missing_returns_none() {
        let conn = off_peak_db();
        assert!(get_off_peak(&conn, "ghost").unwrap().is_none());
    }

    fn insert_off_peak(
        conn: &Connection,
        id: &str,
        ws: &str,
        session_id: Option<&str>,
        created: i64,
    ) {
        conn.execute(
            "INSERT INTO off_peak_tasks (off_peak_task_id, title, prompt, permission_mode, \
             session_id, workspace_key, workspace_path, status, queued_at, schedulable, \
             claim_running, attempt_count, created_at, updated_at) \
             VALUES (?1,'t','p','plan',?2,?3,'/w','queued',100,0,0,0,?4,?4)",
            rusqlite::params![id, session_id, ws, created],
        )
        .unwrap();
    }

    #[test]
    fn list_off_peak_joins_session_title_and_filters_workspace() {
        let conn = off_peak_db();
        // tasks table present (adopt_schema) → join variant active.
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, created_at, updated_at, title) \
             VALUES ('wk','/w','sess1',1,2,'Bound Session')",
            [],
        )
        .unwrap();
        insert_off_peak(&conn, "o1", "wk", Some("sess1"), 30);
        insert_off_peak(&conn, "o2", "wk", Some("missing"), 10); // no matching tasks row
        insert_off_peak(&conn, "o3", "other", Some("sess1"), 20);

        let all = list_off_peak(&conn, None).unwrap();
        let by_id: std::collections::HashMap<_, _> = all
            .iter()
            .map(|t| (t.off_peak_task_id.clone(), t))
            .collect();
        assert_eq!(by_id.len(), 3);
        assert_eq!(by_id["o1"].session_title.as_deref(), Some("Bound Session"));
        assert_eq!(
            by_id["o2"].session_title, None,
            "LEFT JOIN miss → null title"
        );
        // created_at DESC → o1 (30) first.
        assert_eq!(all[0].off_peak_task_id, "o1");

        let scoped = list_off_peak(&conn, Some("wk")).unwrap();
        assert_eq!(scoped.len(), 2, "workspace filter excludes o3");
        assert!(scoped.iter().all(|t| t.workspace_key == "wk"));
    }
}
