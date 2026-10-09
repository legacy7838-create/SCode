//! Node-API addon exposing the Rust DB read path (slice 2). The TS callers will `require` the built
//! `.node` and call these; the SQL runs entirely in Rust (rusqlite), no JS in the DB path.
//!
//! READ-ONLY for now — the write path + migration/locking parity are later slices (PORTING-DB.md).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};

fn open_readonly(path: &str) -> Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Error::from_reason(format!("open {path}: {e}")))
}

/// Count rows in `tasks`.
#[napi]
pub fn tasks_count(db_path: String) -> Result<u32> {
    let conn = open_readonly(&db_path)?;
    let n: i64 = conn
        .query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(n as u32)
}

/// A task row projected for the UI.
#[napi(object)]
pub struct TaskRow {
    pub workspace_key: String,
    pub task_id: String,
    pub mode: String,
    pub title: String,
}

/// Most-recent tasks (parity with the TS `queryTaskList` ordering, read path).
#[napi]
pub fn list_recent_tasks(db_path: String, limit: u32) -> Result<Vec<TaskRow>> {
    let conn = open_readonly(&db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT workspace_key, task_id, mode, title FROM tasks ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(TaskRow {
                workspace_key: row.get(0)?,
                task_id: row.get(1)?,
                mode: row.get(2)?,
                title: row.get(3)?,
            })
        })
        .map_err(|e| Error::from_reason(e.to_string()))?;
    rows.map(|r| r.map_err(|e| Error::from_reason(e.to_string())))
        .collect()
}

/// Faithful port of the TS `listTaskMetas` DB query for a single workspace: exclude tombstones
/// (`deleted = 0`) and order by `updated_at DESC, created_at DESC, task_id DESC`. Returns the raw
/// rows; the `meta_json` → `ZCodeTaskMeta` transform (`rowToMeta`) is a later slice.
pub fn query_tasks_by_workspace(
    conn: &Connection,
    workspace_key: &str,
) -> std::result::Result<Vec<TaskRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT workspace_key, task_id, mode, title
         FROM tasks
         WHERE workspace_key = ?1 AND deleted = 0
         ORDER BY updated_at DESC, created_at DESC, task_id DESC",
    )?;
    let rows = stmt.query_map([workspace_key], |row| {
        Ok(TaskRow {
            workspace_key: row.get(0)?,
            task_id: row.get(1)?,
            mode: row.get(2)?,
            title: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// N-API wrapper: tasks for one workspace (read-only).
#[napi]
pub fn list_tasks_by_workspace(db_path: String, workspace_key: String) -> Result<Vec<TaskRow>> {
    let conn = open_readonly(&db_path)?;
    query_tasks_by_workspace(&conn, &workspace_key).map_err(|e| Error::from_reason(e.to_string()))
}

/// Input for an upsert of one task row (subset of the TS `syncTaskMeta` write path).
#[derive(Clone)]
#[napi(object)]
pub struct NewTask {
    pub workspace_key: String,
    pub task_id: String,
    pub title: String,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Insert or update a task row (write building block for the `syncTaskMeta` port). Uses SQLite
/// upsert so repeated calls are idempotent on `(workspace_key, task_id)` — matching the TS repo's
/// upsert semantics. Returns the number of affected rows.
pub fn upsert_task(
    conn: &Connection,
    task: &NewTask,
) -> std::result::Result<usize, rusqlite::Error> {
    conn.execute(
        "INSERT INTO tasks (workspace_key, task_id, title, mode, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET
           title = excluded.title, mode = excluded.mode, updated_at = excluded.updated_at",
        rusqlite::params![
            task.workspace_key,
            task.task_id,
            task.title,
            task.mode,
            task.created_at,
            task.updated_at,
        ],
    )
}

// ---- rowToMeta / meta model (faithful port of TS ZCodeTaskMeta read projection) ----

/// Valid `mode` values — mirrors `zcodeTaskModeSchema`.
const VALID_MODES: [&str; 6] = ["yolo", "plan", "edit", "auto", "autoEdit", "build"];
/// Valid persisted `status` values — mirrors `zcodeTaskPersistStatusSchema`.
const VALID_STATUS: [&str; 3] = ["running", "completed", "error"];
/// Valid `workspacePurpose` values — mirrors `zcodeTaskMetaSchema.workspacePurpose`.
const VALID_PURPOSE: [&str; 2] = ["project", "conversation"];
/// The only accepted agent provider — mirrors `zcodeAgentProviderSchema = z.literal("glm")`.
const ZCODE_AGENT_PROVIDER: &str = "glm";
/// Valid `migrationSource` values — mirrors `zcodeTaskMigrationSourceSchema`.
const VALID_MIGRATION: [&str; 1] = ["claudeCode"];

/// Rust mirror of TS `ZCodeTaskMeta`. `skip_serializing_if = Option::is_none` reproduces
/// `JSON.stringify` dropping `undefined` keys, and serde ignoring unknown keys reproduces zod's
/// default strip of extra `meta_json` fields — so the read projection matches TS key-for-key.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMeta {
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub trace_id: String,
    #[serde(default)]
    pub title: String,
    pub title_overridden: bool,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_purpose: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_epoch: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forked_from_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron_automation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub off_peak_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    // PARITY GAP: nested lastError/changeSummary/target are carried as opaque JSON. Their inner
    // zod shape validation (which can force TS safeParse to reject and fall back) is not yet
    // reproduced; a malformed nested object is accepted here but rejected by TS.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_summary: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<serde_json::Value>,
}

/// Un-validated `meta_json` capture. Required schema fields are `Option` so absence is detectable
/// (an `Option` field is `None` for both a missing key and a JSON `null`, and zod rejects both for
/// these scalars). Optional scalars default to `None`; serde ignores unknown keys (zod-strip parity).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaInput {
    task_id: Option<String>,
    trace_id: Option<String>,
    title: Option<String>,
    workspace_path: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    mode: Option<String>,
    #[serde(default)]
    workspace_purpose: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    thought_level: Option<String>,
    #[serde(default)]
    runtime_epoch: Option<i64>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    migration_source: Option<String>,
    #[serde(default)]
    forked_from_task_id: Option<String>,
    #[serde(default)]
    cron_automation_id: Option<String>,
    #[serde(default)]
    off_peak_task_id: Option<String>,
    #[serde(default)]
    unread_at: Option<i64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    last_error: Option<serde_json::Value>,
    #[serde(default)]
    change_summary: Option<serde_json::Value>,
    #[serde(default)]
    target: Option<serde_json::Value>,
}

/// The `tasks` row projection `rowToMeta` consumes — the columns `listTaskMetas` selects that the
/// transform actually reads (pinned/archived/deleted/searchable_text are filtered, not projected).
#[derive(Debug, Clone)]
pub struct TaskIndexRow {
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub task_id: String,
    pub title: String,
    pub task_status: Option<String>,
    pub provider: Option<String>,
    pub mode: String,
    pub model: Option<String>,
    pub migration_source: Option<String>,
    pub forked_from_task_id: Option<String>,
    pub cron_automation_id: Option<String>,
    pub off_peak_task_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub unread_at: Option<i64>,
    pub title_overridden: i64,
    pub meta_json: String,
}

/// Port of TS `isRemoteWorkspaceIdentity`: true when `identity` is a well-formed `remote:` key.
/// Mirrors `parseRemoteWorkspaceIdentity`'s structural walk (prefix → kind → authority segments →
/// WSL optional-user → path startswith "/"); authority detail is intentionally not extracted.
pub fn is_remote_workspace_identity(identity: &str) -> bool {
    const PREFIX: &str = "remote:";
    let rest = match identity.strip_prefix(PREFIX) {
        Some(r) => r,
        None => return false,
    };
    let kind_end = match rest.find(':') {
        Some(pos) if pos > 0 => pos,
        _ => return false,
    };
    let kind = &rest[..kind_end];
    let segments = match kind {
        "ssh" => 3,
        "wsl" | "docker" => 1,
        _ => return false,
    };
    let mut cursor = kind_end + 1;
    for _ in 0..segments {
        match rest[cursor..].find(':') {
            Some(rel) if cursor + rel > cursor => cursor = cursor + rel + 1,
            _ => return false,
        }
    }
    // WSL carries an optional explicit-user segment; a non-'/' next char means it is present.
    if kind == "wsl" && rest.as_bytes().get(cursor) != Some(&b'/') {
        match rest[cursor..].find(':') {
            Some(rel) if cursor + rel > cursor => cursor = cursor + rel + 1,
            _ => return false,
        }
    }
    rest[cursor..].starts_with('/')
}

/// Port of TS `resolveTaskIndexRowWorkspaceIdentity`. The column identity is only trusted when it
/// equals `workspace_key`; otherwise a uniform-format remote `workspace_key` wins; else undefined.
fn resolve_workspace_identity(row: &TaskIndexRow) -> Option<String> {
    let column_identity = row.workspace_identity.as_deref().map(|s| s.trim());
    if column_identity == Some(row.workspace_key.as_str()) {
        return column_identity.map(|s| s.to_string());
    }
    if is_remote_workspace_identity(&row.workspace_key) {
        return Some(row.workspace_key.clone());
    }
    None
}

/// A `nonEmptyStringSchema.optional()` value is present but must be non-empty; empty rejects the
/// whole parse (matching zod), so it forces the column fallback rather than being dropped.
fn reject_if_empty(v: &Option<String>) -> bool {
    matches!(v, Some(s) if s.is_empty())
}

/// Gate a parsed `meta_json` against `zcodeTaskMetaSchema`. Returns `None` when TS `safeParse`
/// would fail (missing/empty required field, out-of-enum scalar, negative int, float-for-int type
/// mismatch — the last surfaces as a serde error before we ever get here).
fn gate_valid_meta(
    m: &MetaInput,
    row: &TaskIndexRow,
    identity: Option<String>,
) -> Option<TaskMeta> {
    m.task_id.as_deref().filter(|s| !s.is_empty())?;
    let trace_id = m.trace_id.clone().filter(|s| !s.is_empty())?;
    let title = m.title.clone()?;
    m.workspace_path.as_deref().filter(|s| !s.is_empty())?;
    // createdAt/updatedAt: z.number().int().nonnegative(). They exist as typed i64 or the meta is
    // invalid — serde only fills Some when the JSON value was a whole number (float rejects at
    // parse), so `?` handles absence and the `< 0` check handles the nonnegative bound.
    let created_at = m.created_at?;
    let updated_at = m.updated_at?;
    if created_at < 0 || updated_at < 0 {
        return None;
    }
    let mode = m.mode.as_deref()?;
    if !VALID_MODES.contains(&mode) {
        return None;
    }
    if let Some(p) = m.workspace_purpose.as_deref() {
        if !VALID_PURPOSE.contains(&p) {
            return None;
        }
    }
    if let Some(s) = m.status.as_deref() {
        if !VALID_STATUS.contains(&s) {
            return None;
        }
    }
    if let Some(p) = m.provider.as_deref() {
        if p != ZCODE_AGENT_PROVIDER {
            return None;
        }
    }
    if let Some(ms) = m.migration_source.as_deref() {
        if !VALID_MIGRATION.contains(&ms) {
            return None;
        }
    }
    if reject_if_empty(&m.thought_level)
        || reject_if_empty(&m.cron_automation_id)
        || reject_if_empty(&m.off_peak_task_id)
        || reject_if_empty(&m.forked_from_task_id)
    {
        return None;
    }
    if m.runtime_epoch.is_some_and(|e| e < 0) || m.unread_at.is_some_and(|u| u < 0) {
        return None;
    }

    // Valid path: spread parsed.data, then overlay. created/updated/traceId/title/mode/model/… come
    // from the meta; taskId/workspacePath/unreadAt/titleOverridden are overridden by columns; cron/
    // offPeak prefer meta then column; identity comes from the column-key resolver.
    Some(TaskMeta {
        task_id: row.task_id.clone(),
        trace_id,
        title,
        title_overridden: row.title_overridden == 1,
        workspace_path: row.workspace_path.clone(),
        workspace_identity: identity,
        workspace_purpose: m.workspace_purpose.clone(),
        created_at,
        updated_at,
        mode: mode.to_string(),
        model: m.model.clone(),
        thought_level: m.thought_level.clone(),
        runtime_epoch: m.runtime_epoch,
        provider: m.provider.clone(),
        migration_source: m.migration_source.clone(),
        forked_from_task_id: m.forked_from_task_id.clone(),
        cron_automation_id: m
            .cron_automation_id
            .clone()
            .or_else(|| row.cron_automation_id.clone()),
        off_peak_task_id: m
            .off_peak_task_id
            .clone()
            .or_else(|| row.off_peak_task_id.clone()),
        unread_at: row.unread_at,
        status: m.status.clone(),
        last_error: m.last_error.clone(),
        change_summary: m.change_summary.clone(),
        target: m.target.clone(),
    })
}

/// Column fallback (matches TS: invalid/missing `meta_json` → build entirely from scalar columns,
/// synthesizing `traceId = "zcode-<taskId>"`). Nested/target fields and workspacePurpose/thoughtLevel
/// are absent here, exactly as the TS fallback literal omits them.
fn fallback_meta(row: &TaskIndexRow, identity: Option<String>) -> TaskMeta {
    TaskMeta {
        task_id: row.task_id.clone(),
        trace_id: format!("zcode-{}", row.task_id),
        title: row.title.clone(),
        title_overridden: row.title_overridden == 1,
        workspace_path: row.workspace_path.clone(),
        workspace_identity: identity,
        workspace_purpose: None,
        created_at: row.created_at,
        updated_at: row.updated_at,
        mode: row.mode.clone(),
        model: row.model.clone(),
        thought_level: None,
        runtime_epoch: None,
        provider: row
            .provider
            .as_ref()
            .filter(|p| p.as_str() == ZCODE_AGENT_PROVIDER)
            .cloned(),
        migration_source: row.migration_source.clone(),
        forked_from_task_id: row.forked_from_task_id.clone(),
        cron_automation_id: row.cron_automation_id.clone(),
        off_peak_task_id: row.off_peak_task_id.clone(),
        unread_at: row.unread_at,
        status: row.task_status.clone(),
        last_error: None,
        change_summary: None,
        target: None,
    }
}

/// Faithful port of TS `rowToMeta`: attempt schema-gated meta projection, else column fallback.
pub fn row_to_meta(row: &TaskIndexRow) -> TaskMeta {
    let identity = resolve_workspace_identity(row);
    serde_json::from_str::<MetaInput>(&row.meta_json)
        .ok()
        .and_then(|m| gate_valid_meta(&m, row, identity.clone()))
        .unwrap_or_else(|| fallback_meta(row, identity))
}

/// Select the full `TaskIndexRow` column set for one workspace, matching the TS `listTaskMetas`
/// query (`deleted = 0`, `ORDER BY updated_at DESC, created_at DESC, task_id DESC`). Nullable
/// columns fall back to the TS-equivalent defaults so `row_to_meta` sees a complete row.
pub fn query_task_index_rows(
    conn: &Connection,
    workspace_key: &str,
) -> std::result::Result<Vec<TaskIndexRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
                provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
                off_peak_task_id, created_at, updated_at, unread_at, title_overridden, meta_json
         FROM tasks
         WHERE workspace_key = ?1 AND deleted = 0
         ORDER BY updated_at DESC, created_at DESC, task_id DESC",
    )?;
    let rows = stmt.query_map([workspace_key], |r| {
        Ok(TaskIndexRow {
            workspace_key: r.get(0)?,
            workspace_path: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            workspace_identity: r.get(2)?,
            task_id: r.get(3)?,
            title: r.get(4)?,
            task_status: r.get(5)?,
            provider: r.get(6)?,
            mode: r
                .get::<_, Option<String>>(7)?
                .unwrap_or_else(|| "build".to_string()),
            model: r.get(8)?,
            migration_source: r.get(9)?,
            forked_from_task_id: r.get(10)?,
            cron_automation_id: r.get(11)?,
            off_peak_task_id: r.get(12)?,
            created_at: r.get(13)?,
            updated_at: r.get(14)?,
            unread_at: r.get(15)?,
            title_overridden: r.get::<_, Option<i64>>(16)?.unwrap_or(0),
            meta_json: r
                .get::<_, Option<String>>(17)?
                .unwrap_or_else(|| "{}".to_string()),
        })
    })?;
    rows.collect()
}

/// N-API: full Rust read path for one workspace — query rows, project each through `row_to_meta`,
/// return the `TaskMeta[]` as JSON. This is the `listTaskMetas` DB+projection equivalent, run
/// entirely in Rust (rusqlite + serde), for golden-parity comparison against the TS repo.
#[napi]
pub fn list_task_metas_json(db_path: String, workspace_key: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let metas: Vec<TaskMeta> = query_task_index_rows(&conn, &workspace_key)
        .map_err(|e| Error::from_reason(e.to_string()))?
        .iter()
        .map(row_to_meta)
        .collect();
    serde_json::to_string(&metas).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: return the raw `meta_json` string for one task (parse it in Rust via `row_to_meta`).
#[napi]
pub fn read_task_meta_json(
    db_path: String,
    workspace_key: String,
    task_id: String,
) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let mut stmt = conn
        .prepare("SELECT meta_json FROM tasks WHERE workspace_key = ?1 AND task_id = ?2")
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let mut rows = stmt
        .query_map(rusqlite::params![workspace_key, task_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(|e| Error::from_reason(e.to_string()))?;
    match rows.next() {
        Some(r) => r.map_err(|e| Error::from_reason(e.to_string())),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT, workspace_identity TEXT,
               task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT,
               provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, cron_automation_id TEXT,
               off_peak_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               unread_at INTEGER, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
               deleted INTEGER DEFAULT 0, title_overridden INTEGER DEFAULT 0,
               searchable_text TEXT, meta_json TEXT DEFAULT '{}',
               PRIMARY KEY (workspace_key, task_id));",
        )
        .unwrap();
        // ws-A: three tasks with distinct updated_at + one tombstone (deleted=1) that must be excluded.
        let ins = |ws: &str, id: &str, upd: i64, del: i64, title: &str| {
            conn.execute(
                "INSERT INTO tasks (workspace_key, task_id, mode, title, created_at, updated_at, deleted)
                 VALUES (?1, ?2, 'build', ?3, ?4, ?4, ?5)",
                rusqlite::params![ws, id, title, upd, del],
            )
            .unwrap();
        };
        ins("ws-A", "t-old", 100, 0, "old");
        ins("ws-A", "t-new", 300, 0, "new");
        ins("ws-A", "t-mid", 200, 0, "mid");
        ins("ws-A", "t-dead", 400, 1, "deleted");
        ins("ws-B", "other", 500, 0, "other-ws");
        conn
    }

    #[test]
    fn upsert_inserts_then_updates_idempotently() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               mode TEXT NOT NULL DEFAULT 'build', created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0,
               PRIMARY KEY (workspace_key, task_id));",
        )
        .unwrap();
        let t = NewTask {
            workspace_key: "ws".into(),
            task_id: "id1".into(),
            title: "first".into(),
            mode: "build".into(),
            created_at: 10,
            updated_at: 10,
        };
        assert_eq!(upsert_task(&conn, &t).unwrap(), 1, "insert affects 1 row");
        // Same key, new title/updated_at => UPDATE (not a second row).
        let t2 = NewTask {
            title: "second".into(),
            updated_at: 20,
            ..t.clone()
        };
        assert_eq!(
            upsert_task(&conn, &t2).unwrap(),
            1,
            "update affects the same 1 row"
        );
        let rows = conn
            .prepare(
                "SELECT title, updated_at FROM tasks WHERE workspace_key='ws' AND task_id='id1'",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 1, "still one row (upsert, not duplicate)");
        assert_eq!(rows[0], ("second".to_string(), 20));
    }

    #[test]
    fn filters_deleted_and_orders_desc() {
        let conn = fixture_db();
        let rows = query_tasks_by_workspace(&conn, "ws-A").unwrap();
        // Excludes t-dead (deleted) and other-ws (different workspace); ordered by updated_at DESC.
        let ids: Vec<&str> = rows.iter().map(|r| r.task_id.as_str()).collect();
        assert_eq!(ids, vec!["t-new", "t-mid", "t-old"]);
    }

    #[test]
    fn excludes_other_workspace() {
        let conn = fixture_db();
        let rows = query_tasks_by_workspace(&conn, "ws-B").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, "other");
    }

    fn row(meta_json: &str) -> TaskIndexRow {
        TaskIndexRow {
            workspace_key: "/local/proj".into(),
            workspace_path: "/local/proj".into(),
            workspace_identity: None,
            task_id: "t1".into(),
            title: "col-title".into(),
            task_status: Some("completed".into()),
            provider: None,
            mode: "build".into(),
            model: Some("col-model".into()),
            migration_source: None,
            forked_from_task_id: None,
            cron_automation_id: None,
            off_peak_task_id: None,
            created_at: 1,
            updated_at: 2,
            unread_at: None,
            title_overridden: 0,
            meta_json: meta_json.into(),
        }
    }

    #[test]
    fn valid_meta_projects_schema_with_column_overlays() {
        // Real-shape meta: createdAt/updatedAt live in the meta (valid path must NOT read columns).
        let m = row_to_meta(&row(
            r#"{"taskId":"meta-id","traceId":"zcode-meta-id","title":"hey","workspacePath":"/mp","createdAt":100,"updatedAt":200,"mode":"plan","model":"m","thoughtLevel":"high","status":"completed"}"#,
        ));
        assert_eq!(m.trace_id, "zcode-meta-id");
        assert_eq!(m.title, "hey");
        assert_eq!(m.mode, "plan");
        assert_eq!(m.model.as_deref(), Some("m"));
        assert_eq!(m.thought_level.as_deref(), Some("high"));
        assert_eq!(
            m.status.as_deref(),
            Some("completed"),
            "valid-path status from meta"
        );
        // Times come from the meta, not the row columns (1/2) — matches TS not overriding them.
        assert_eq!(m.created_at, 100);
        assert_eq!(m.updated_at, 200);
        // Overlays from columns: taskId/workspacePath win over the meta's own values.
        assert_eq!(m.task_id, "t1");
        assert_eq!(m.workspace_path, "/local/proj");
    }

    #[test]
    fn invalid_enum_status_falls_back_to_columns() {
        // zcodeTaskPersistStatusSchema only allows running|completed|error; "idle" rejects.
        let m = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":100,"updatedAt":200,"mode":"build","status":"idle"}"#,
        ));
        assert_eq!(m.trace_id, "zcode-t1", "fallback synthesizes traceId");
        assert_eq!(
            m.created_at, 1,
            "fallback uses column created_at, not meta 100"
        );
        assert_eq!(
            m.updated_at, 2,
            "fallback uses column updated_at, not meta 200"
        );
        assert_eq!(m.title, "col-title", "fallback uses column title");
        assert_eq!(
            m.status.as_deref(),
            Some("completed"),
            "fallback status from column"
        );
        assert_eq!(m.mode, "build", "fallback mode from column");
    }

    #[test]
    fn invalid_mode_falls_back_to_columns() {
        // mode "default" (observed live divergence) is outside the mode enum → fallback.
        let m = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":100,"updatedAt":200,"mode":"default"}"#,
        ));
        assert_eq!(
            m.mode, "build",
            "fallback mode from column, not meta's invalid 'default'"
        );
        assert_eq!(m.created_at, 1);
    }

    #[test]
    fn missing_or_unparseable_meta_falls_back() {
        assert_eq!(row_to_meta(&row("")).trace_id, "zcode-t1");
        assert_eq!(row_to_meta(&row("not json")).trace_id, "zcode-t1");
        // '{}' parses but lacks required fields → TS safeParse fails → fallback.
        let m = row_to_meta(&row("{}"));
        assert_eq!(m.title, "col-title");
    }

    #[test]
    fn float_created_at_is_type_mismatch_and_falls_back() {
        // z.number().int() rejects 1.5; serde i64 rejects the float → parse error → fallback.
        let m = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":1.5,"updatedAt":2,"mode":"build"}"#,
        ));
        assert_eq!(
            m.created_at, 1,
            "fallback: float meta createdAt rejected, column wins"
        );
    }

    #[test]
    fn fallback_provider_gated_to_agent() {
        let mut r = row("");
        r.provider = Some("openai".into());
        assert_eq!(
            row_to_meta(&r).provider,
            None,
            "non-glm provider column is dropped (TS ternary)"
        );
        r.provider = Some("glm".into());
        assert_eq!(row_to_meta(&r).provider.as_deref(), Some("glm"));
    }

    #[test]
    fn cron_and_offpeak_prefer_meta_then_column() {
        let mut r = row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":1,"updatedAt":2,"mode":"build","cronAutomationId":"c-meta"}"#,
        );
        r.cron_automation_id = Some("c-col".into());
        assert_eq!(
            row_to_meta(&r).cron_automation_id.as_deref(),
            Some("c-meta")
        );
        // meta without cron → column fills it.
        let mut r2 = row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":1,"updatedAt":2,"mode":"build"}"#,
        );
        r2.cron_automation_id = Some("c-col".into());
        assert_eq!(
            row_to_meta(&r2).cron_automation_id.as_deref(),
            Some("c-col")
        );
    }

    #[test]
    fn empty_cron_rejects_meta_entirely() {
        // nonEmptyStringSchema.optional(): present-but-empty cron fails zod → full fallback.
        let m = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":100,"updatedAt":200,"mode":"build","cronAutomationId":""}"#,
        ));
        assert_eq!(m.created_at, 1, "fallback selected, not valid path");
        assert_eq!(m.title, "col-title");
    }

    #[test]
    fn workspace_identity_resolution() {
        // Local workspace_key: identity undefined unless the column equals the key.
        let mut r = row("");
        assert_eq!(row_to_meta(&r).workspace_identity, None);
        r.workspace_identity = Some("/local/proj".into());
        assert_eq!(
            row_to_meta(&r).workspace_identity.as_deref(),
            Some("/local/proj"),
            "column identity accepted when it equals workspace_key"
        );
        // Remote key: identity adopted from workspace_key even when column mismatches.
        let mut rem = row("");
        rem.workspace_key = "remote:ssh:host.example:22:user:/home/u".into();
        rem.workspace_identity = Some("stale".into());
        assert_eq!(
            row_to_meta(&rem).workspace_identity.as_deref(),
            Some("remote:ssh:host.example:22:user:/home/u")
        );
    }

    #[test]
    fn query_task_index_rows_feeds_row_to_meta_end_to_end() {
        // Fixture rows have meta_json default '{}' → every projection takes the column fallback.
        let conn = fixture_db();
        let metas: Vec<TaskMeta> = query_task_index_rows(&conn, "ws-A")
            .unwrap()
            .iter()
            .map(row_to_meta)
            .collect();
        let projected: Vec<(String, String)> =
            metas.into_iter().map(|m| (m.task_id, m.title)).collect();
        assert_eq!(
            projected,
            vec![
                ("t-new".to_string(), "new".to_string()),
                ("t-mid".to_string(), "mid".to_string()),
                ("t-old".to_string(), "old".to_string()),
            ],
            "ordered by updated_at DESC, titles from columns, tombstone excluded"
        );
    }

    #[test]
    fn is_remote_identity_parsing_parity() {
        assert!(is_remote_workspace_identity("remote:ssh:h:22:u:/p"));
        assert!(is_remote_workspace_identity("remote:docker:ctr:/p"));
        assert!(is_remote_workspace_identity("remote:wsl:distro:/p"));
        assert!(is_remote_workspace_identity("remote:wsl:distro:user:/p"));
        assert!(!is_remote_workspace_identity("/local/proj"));
        assert!(!is_remote_workspace_identity("remote:ftp:h:/p")); // unknown kind
        assert!(!is_remote_workspace_identity("remote:ssh:h:22:u:p")); // path without leading /
        assert!(!is_remote_workspace_identity("remote:ssh:h:22")); // missing segments
    }

    #[test]
    fn meta_json_roundtrip_strips_unknown_keys() {
        // zod strips unknown keys; serde (no flatten) ignores them. A valid meta with an extra key
        // serializes back WITHOUT that key — proving the projection is TS-identical, not lossy-extra.
        let m = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":1,"updatedAt":2,"mode":"build","someZodStrippedKey":123}"#,
        ));
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("someZodStrippedKey"));
        assert!(json.contains("\"traceId\":\"z1\""));
        // Absent optional fields must not serialize (JSON.stringify drops undefined).
        assert!(!json.contains("lastError"));
        assert!(!json.contains("workspacePurpose"));
    }
}
