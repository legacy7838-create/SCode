//! Node-API addon exposing the Rust DB read path (slice 2). The TS callers will `require` the built
//! `.node` and call these; the SQL runs entirely in Rust (rusqlite), no JS in the DB path.
//!
//! READ-ONLY for now — the write path + migration/locking parity are later slices (PORTING-DB.md).

pub mod automation;
pub mod automation_write;
pub mod cron_engine;
pub mod grouping;
pub mod grouped_view;
pub mod migrations;
pub mod model_selection;
pub mod session_bootstrap;
pub mod session_debug;
pub mod session_entries;
pub mod session_journal;
pub mod session_journal_read;
pub mod session_messages;
pub mod session_migrations;
pub mod session_sessions;
pub mod session_store;
pub mod session_usage;
pub mod session_workflow;
pub mod offpeak;
pub mod offpeak_write;

// >>> SESSION-WRITE OPS MODULES <<<
// Parallel write-port agents: add EXACTLY ONE `pub mod session_write_<group>;` line directly below
// this marker, keep it in your own new module file `src/session_write_<group>.rs`, and put your
// `#[napi]` wrappers in that same module (do NOT edit any other part of lib.rs). This keeps the only
// shared-file touch to one line, so the integrator can merge independent branches without conflict.
pub mod session_write_create_session;
pub mod session_write_entry;
pub mod session_write_fork_bundles;
pub mod session_write_history;
pub mod session_write_inputs;
pub mod session_write_link_permission;
pub mod session_write_local_settings;
pub mod session_write_messages;
pub mod session_write_promotion;
pub mod session_write_repairs;
pub mod session_write_session_update;
pub mod session_write_shared_context;
pub mod session_write_target;
pub mod session_write_target_run;
pub mod session_write_todos;
pub mod session_write_usage;
pub mod session_write_workflow_def;
pub mod session_write_workflow_run;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};

/// Busy timeout injected on every addon connection. The flipped repos open a fresh short-lived
/// connection per call (the addon is stateless), so without this a concurrent writer would return
/// `SQLITE_BUSY` immediately instead of waiting. Matches the TS shared-connection `busy_timeout`.
pub(crate) const DB_BUSY_TIMEOUT_MS: i64 = 5000;

/// `busy_timeout` alone on a read connection; WAL readers rarely block, but a small wait makes the
/// stateless-connection model robust under concurrent writers.
fn open_readonly(path: &str) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Error::from_reason(format!("open {path}: {e}")))?;
    conn
        .busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS as u64))
        .map_err(|e| Error::from_reason(format!("busy_timeout {path}: {e}")))?;
    Ok(conn)
}

/// Open for read-write (no create) — the write-path boundary for the N-API wrappers. Applies the
/// same per-connection PRAGMAs the TS shared connection set (`foreign_keys`, WAL, synchronous) so
/// FK-cascade writes and the busy-wait behave identically to the `node:sqlite` path.
fn open_readwrite(path: &str) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| Error::from_reason(format!("open rw {path}: {e}")))?;
    let apply = || -> std::result::Result<(), rusqlite::Error> {
        conn.busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS as u64))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    };
    apply().map_err(|e| Error::from_reason(format!("pragmas {path}: {e}")))?;
    Ok(conn)
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
pub(crate) const VALID_MODES: [&str; 6] = ["yolo", "plan", "edit", "auto", "autoEdit", "build"];
/// Valid persisted `status` values — mirrors `zcodeTaskPersistStatusSchema`.
const VALID_STATUS: [&str; 3] = ["running", "completed", "error"];
/// Valid `workspacePurpose` values — mirrors `zcodeTaskMetaSchema.workspacePurpose`.
const VALID_PURPOSE: [&str; 2] = ["project", "conversation"];
/// The only accepted agent provider — mirrors `zcodeAgentProviderSchema = z.literal("glm")`.
const ZCODE_AGENT_PROVIDER: &str = "glm";
/// Valid `migrationSource` values — mirrors `zcodeTaskMigrationSourceSchema`.
const VALID_MIGRATION: [&str; 1] = ["claudeCode"];
/// `searchable_text` size cap in UTF-16 code units — mirrors TS `TASK_SEARCH_TEXT_MAX_CHARS`.
const TASK_SEARCH_TEXT_MAX_CHARS: usize = 200_000;
/// Grouped-view ordering step — mirrors TS `GROUPED_TASK_ORDER_STEP`.
pub(crate) const GROUPED_TASK_ORDER_STEP: i64 = 1000;
/// Search-snippet window params — mirror the TS `TASK_SEARCH_SNIPPET_*` constants.
const SNIPPET_PREFIX_RADIUS: usize = 20;
const SNIPPET_SUFFIX_RADIUS: usize = 72;
const SNIPPET_MAX_CHARS: usize = 140;
const SNIPPET_LIMIT: usize = 4;

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
    // Optional in the zod schema (`titleOverridden?.optional()`); default so an input meta that
    // omits it still parses. Always serialized on output.
    #[serde(default)]
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

/// Deserialize a `Nullable`/optional JSON passthrough field so key PRESENCE is preserved: an
/// explicit `"target": null` becomes `Some(Value::Null)` (serde's normal `Option<T>` would collapse
/// null→None and drop it, diverging from zod which keeps a nullable field's explicit null).
fn some_json_value<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    Ok(Some(serde_json::Value::deserialize(deserializer)?))
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
    #[serde(default, deserialize_with = "some_json_value")]
    last_error: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "some_json_value")]
    change_summary: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "some_json_value")]
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
    pub pinned: i64,
    pub archived: i64,
    pub deleted: i64,
    pub last_unread_at: i64,
    pub searchable_text: String,
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
    // `lastError`/`changeSummary` are optional but NOT nullable — a present `null` fails zod and
    // forces the column fallback. `target` IS nullable, so its explicit null is kept below.
    if matches!(m.last_error, Some(serde_json::Value::Null))
        || matches!(m.change_summary, Some(serde_json::Value::Null))
    {
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

/// Map a `TaskIndexRow` column projection (positional, matching the `listTaskMetas` SELECT) onto
/// a `TaskIndexRow`. Nullable columns fall back to the TS-equivalent defaults so `row_to_meta` sees
/// a complete row. Shared by the list query and the single-row re-read after a write.
pub(crate) fn map_task_index_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskIndexRow> {
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
        pinned: r.get::<_, Option<i64>>(18)?.unwrap_or(0),
        archived: r.get::<_, Option<i64>>(19)?.unwrap_or(0),
        deleted: r.get::<_, Option<i64>>(20)?.unwrap_or(0),
        last_unread_at: r.get::<_, Option<i64>>(21)?.unwrap_or(0),
        searchable_text: r.get::<_, Option<String>>(22)?.unwrap_or_default(),
    })
}

pub(crate) const TASK_INDEX_ROW_COLUMNS: &str =
    "workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider, \
     mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id, \
     created_at, updated_at, unread_at, title_overridden, meta_json, pinned, archived, deleted, \
     last_unread_at, searchable_text";

/// Select the full `TaskIndexRow` column set for one workspace, matching the TS `listTaskMetas`
/// query (`deleted = 0`, `ORDER BY updated_at DESC, created_at DESC, task_id DESC`).
pub fn query_task_index_rows(
    conn: &Connection,
    workspace_key: &str,
) -> std::result::Result<Vec<TaskIndexRow>, rusqlite::Error> {
    let sql = format!(
        "SELECT {TASK_INDEX_ROW_COLUMNS} FROM tasks WHERE workspace_key = ?1 AND deleted = 0 \
         ORDER BY updated_at DESC, created_at DESC, task_id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([workspace_key], map_task_index_row)?;
    rows.collect()
}

/// Port of `hasGroupedWorkspaceBootstrapRunSync`: whether any workspace has already run the
/// grouped-workspace bootstrap (a global one-shot guard, read from `task_group_workspace_bootstraps`).
pub fn has_grouped_workspace_bootstrap_run(conn: &Connection) -> std::result::Result<bool, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT 1 FROM task_group_workspace_bootstraps LIMIT 1")?;
    let mut rows = stmt.query([])?;
    Ok(rows.next()?.is_some())
}

/// Port of `listDeletedTaskIds`: task ids tombstoned (`deleted = 1`) in one workspace, optionally
/// scoped to a runtime provider, ordered by id.
pub fn list_deleted_task_ids(
    conn: &Connection,
    workspace_key: &str,
    provider: Option<&str>,
) -> std::result::Result<Vec<String>, rusqlite::Error> {
    let sql = "SELECT task_id FROM tasks WHERE workspace_key = ?1 AND deleted = 1 \
               AND (?2 IS NULL OR provider = ?2) ORDER BY task_id";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(rusqlite::params![workspace_key, provider], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Port of `listSessionsByAutomation`: the cron sessions an automation produced (non-deleted),
/// newest first. Reuses the canonical row projection so `row_to_meta` sees the same columns as TS.
pub fn list_sessions_by_automation(
    conn: &Connection,
    automation_id: &str,
) -> std::result::Result<Vec<TaskMeta>, rusqlite::Error> {
    let sql = format!(
        "SELECT {TASK_INDEX_ROW_COLUMNS} FROM tasks WHERE cron_automation_id = ?1 AND deleted = 0 \
         ORDER BY created_at DESC, task_id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([automation_id], map_task_index_row)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?.iter().map(row_to_meta).collect())
}

/// Port of `archiveStaleTasks`: archive completed, non-pinned, non-archived, read tasks older than
/// `cutoff` in one workspace (optionally provider-scoped). The flag writes run under one
/// `BEGIN IMMEDIATE`, matching TS; returns the metas that were archived (already `archived = 1`).
/// `cutoff` is injected (`Date.now() - days`) so the adapter controls the clock.
pub fn archive_stale_tasks(
    conn: &Connection,
    workspace_key: &str,
    cutoff: i64,
    provider: Option<&str>,
) -> std::result::Result<Vec<TaskMeta>, rusqlite::Error> {
    let provider_scoped = provider.is_some();
    let mut sql = String::from(
        "SELECT workspace_key, workspace_path, workspace_identity, task_id, title, task_status, \
         provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, \
         off_peak_task_id, created_at, updated_at, unread_at, title_overridden, meta_json, pinned, \
         archived, deleted, last_unread_at, searchable_text \
         FROM tasks WHERE workspace_key = ?1 AND deleted = 0 AND archived = 0 AND pinned = 0 \
         AND unread_at IS NULL AND updated_at < ?2 AND task_status = 'completed'",
    );
    if provider_scoped {
        sql.push_str(" AND provider = ?3");
    }
    sql.push_str(" ORDER BY updated_at DESC, created_at DESC, task_id DESC");

    let rows: Vec<TaskIndexRow> = {
        let mut stmt = conn.prepare(&sql)?;
        let mapped = if provider_scoped {
            stmt.query_map(
                rusqlite::params![workspace_key, cutoff, provider],
                map_task_index_row,
            )?
        } else {
            stmt.query_map(rusqlite::params![workspace_key, cutoff], map_task_index_row)?
        };
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    conn.execute("BEGIN IMMEDIATE", [])?;
    let archive = |conn: &Connection| -> std::result::Result<(), rusqlite::Error> {
        for row in &rows {
            conn.execute(
                "UPDATE tasks SET archived = 1 WHERE workspace_key = ?1 AND task_id = ?2",
                rusqlite::params![row.workspace_key, row.task_id],
            )?;
        }
        Ok(())
    };
    match archive(conn) {
        Ok(()) => {
            conn.execute("COMMIT", [])?;
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            return Err(e);
        }
    }
    // TS projects the pre-update rows it read (it maps `rowToMeta` over `rows`, not a re-read),
    // so the returned metas carry the pre-archive column state; only the raw `archived` flag flips.
    Ok(rows.iter().map(row_to_meta).collect())
}


/// Read one `TaskIndexRow` by primary key (`workspace_key`, `task_id`), the re-read TS `writeRecord`
/// performs via `getTaskRow` to return the persisted projection. Tombstones are included (a write
/// can re-read a soft-deleted row), matching `getTaskRow` semantics rather than the list filter.
pub(crate) fn get_task_index_row(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
) -> std::result::Result<Option<TaskIndexRow>, rusqlite::Error> {
    let sql = format!(
        "SELECT {TASK_INDEX_ROW_COLUMNS} FROM tasks WHERE workspace_key = ?1 AND task_id = ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(
        rusqlite::params![workspace_key, task_id],
        map_task_index_row,
    )?;
    match rows.next() {
        Some(r) => r.map(Some),
        None => Ok(None),
    }
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

/// Filter options for the TS `listTaskMetas` full query. `None` on a scalar means "don't filter"
/// (matches the `@x IS NULL OR x=@x` predicates); `workspace_key: None` = across all workspaces.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListFilter {
    pub workspace_key: Option<String>,
    pub include_deleted: bool,
    pub provider: Option<String>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

/// Faithful port of the TS `listTaskMetas` SELECT (filter predicates + the same
/// `updated_at/created_at/task_id DESC` ordering), projected through `row_to_meta`.
pub fn query_task_metas_filtered(
    conn: &Connection,
    filter: &ListFilter,
) -> std::result::Result<Vec<TaskMeta>, rusqlite::Error> {
    let sql = format!(
        "SELECT {TASK_INDEX_ROW_COLUMNS} FROM tasks \
         WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key) \
           AND (@include_deleted = 1 OR deleted = 0) \
           AND (@provider IS NULL OR provider = @provider) \
           AND (@pinned IS NULL OR pinned = @pinned) \
           AND (@archived IS NULL OR archived = @archived) \
         ORDER BY updated_at DESC, created_at DESC, task_id DESC"
    );
    let include_deleted: i64 = filter.include_deleted.into();
    let pinned: Option<i64> = filter.pinned.map(i64::from);
    let archived: Option<i64> = filter.archived.map(i64::from);
    let params: [(&str, &dyn rusqlite::types::ToSql); 5] = [
        ("@workspace_key", &filter.workspace_key),
        ("@include_deleted", &include_deleted),
        ("@provider", &filter.provider),
        ("@pinned", &pinned),
        ("@archived", &archived),
    ];
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(&params, map_task_index_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows.iter().map(row_to_meta).collect())
}

/// N-API: the full filtered `listTaskMetas` as JSON (read-only). `filter_json` maps to `ListFilter`.
#[napi]
pub fn list_task_metas_filtered_json(db_path: String, filter_json: String) -> Result<String> {
    let filter: ListFilter =
        serde_json::from_str(&filter_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readonly(&db_path)?;
    let metas =
        query_task_metas_filtered(&conn, &filter).map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&metas).map_err(|e| Error::from_reason(e.to_string()))
}

/// UTF-16 code-unit truncation matching JS `String.prototype.slice(0, max)`. Counting by `char`
/// would over-keep astral (emoji) text, since JS counts a surrogate pair as 2 units but Rust's
/// `char` counts it as 1 — so we must accumulate `encode_utf16` units and cut on a boundary.
fn truncate_utf16(s: &str, max_units: usize) -> String {
    let mut units = 0usize;
    let mut byte_len = 0usize;
    for ch in s.chars() {
        let used = ch.len_utf16();
        if units + used > max_units {
            break;
        }
        units += used;
        byte_len += ch.len_utf8();
    }
    s[..byte_len].to_string()
}

/// A write payload for `write_record` — mirrors the TS `TaskIndexWriteRecord` columns. `meta_json`
/// is pre-serialized by the caller (TS `serializeMetaJson` uses `JSON.stringify`, whose key order
/// is not canonical even across TS writes, so the parity contract is the *semantic* projection, not
/// raw bytes). `searchable_text = None` means "keep the existing indexed text" (TS `undefined`).
#[derive(Debug, Clone)]
pub struct WriteRecord {
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
    /// TS `writeUnreadAt`: when false the conflict branch preserves the existing `unread_at`.
    pub write_unread_at: bool,
    pub pinned: bool,
    pub archived: bool,
    pub deleted: bool,
    pub title_overridden: bool,
    pub searchable_text: Option<String>,
    pub meta_json: String,
}

/// Port of TS `writeRecord`: the full-column `tasks` upsert. Preserves `unread_at` unless
/// `write_unread_at`, advances `last_unread_at` via `MAX(...)`, keeps existing `searchable_text`
/// when none is supplied, then re-reads and returns the persisted projection via `row_to_meta`.
pub fn write_record(
    conn: &Connection,
    record: &WriteRecord,
) -> std::result::Result<TaskMeta, rusqlite::Error> {
    let searchable_text = match record.searchable_text.as_deref() {
        Some(s) => truncate_utf16(s, TASK_SEARCH_TEXT_MAX_CHARS),
        None => {
            let existing: Option<String> = conn
                .query_row(
                    "SELECT searchable_text FROM tasks WHERE workspace_key = ?1 AND task_id = ?2",
                    rusqlite::params![record.workspace_key, record.task_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .unwrap_or(None);
            existing.unwrap_or_default()
        }
    };

    let last_unread_at = record.unread_at.unwrap_or(0);
    let write_unread_at: i64 = record.write_unread_at.into();
    let pinned: i64 = record.pinned.into();
    let archived: i64 = record.archived.into();
    let deleted: i64 = record.deleted.into();
    let title_overridden: i64 = record.title_overridden.into();
    let params: Vec<(&str, &dyn rusqlite::types::ToSql)> = vec![
        ("@workspace_key", &record.workspace_key),
        ("@workspace_path", &record.workspace_path),
        ("@workspace_identity", &record.workspace_identity),
        ("@task_id", &record.task_id),
        ("@title", &record.title),
        ("@task_status", &record.task_status),
        ("@provider", &record.provider),
        ("@mode", &record.mode),
        ("@model", &record.model),
        ("@migration_source", &record.migration_source),
        ("@forked_from_task_id", &record.forked_from_task_id),
        ("@cron_automation_id", &record.cron_automation_id),
        ("@off_peak_task_id", &record.off_peak_task_id),
        ("@created_at", &record.created_at),
        ("@updated_at", &record.updated_at),
        ("@unread_at", &record.unread_at),
        ("@last_unread_at", &last_unread_at),
        ("@write_unread_at", &write_unread_at),
        ("@pinned", &pinned),
        ("@archived", &archived),
        ("@deleted", &deleted),
        ("@title_overridden", &title_overridden),
        ("@searchable_text", &searchable_text),
        ("@meta_json", &record.meta_json),
    ];

    conn.execute(
        "INSERT INTO tasks (
          workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
          provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
          off_peak_task_id, created_at, updated_at, unread_at, last_unread_at, pinned, archived,
          deleted, title_overridden, searchable_text, meta_json
        ) VALUES (
          @workspace_key, @workspace_path, @workspace_identity, @task_id, @title, @task_status,
          @provider, @mode, @model, @migration_source, @forked_from_task_id, @cron_automation_id,
          @off_peak_task_id, @created_at, @updated_at, @unread_at, @last_unread_at, @pinned,
          @archived, @deleted, @title_overridden, @searchable_text, @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = CASE
            WHEN @write_unread_at = 1 THEN excluded.unread_at
            ELSE tasks.unread_at
          END,
          last_unread_at = MAX(
            tasks.last_unread_at,
            COALESCE(tasks.unread_at, 0),
            CASE WHEN @write_unread_at = 1 THEN excluded.last_unread_at ELSE 0 END
          ),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json",
        params.as_slice(),
    )?;

    let persisted = get_task_index_row(conn, &record.workspace_key, &record.task_id)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok(row_to_meta(&persisted))
}

// ---- syncTaskMeta merge core (pure business rules, ported before DB/group plumbing) ----

/// TS `isTerminalTaskStatus`: `completed` / `error` are terminal (a snapshot must not downgrade
/// them back to `running`).
fn is_terminal_status(status: Option<&str>) -> bool {
    matches!(status, Some("completed") | Some("error"))
}

/// Port of `shouldPreserveNewerTerminalStatus`: keep the existing terminal status only when the
/// existing row is terminal, the incoming status is missing/`running` (JS truthiness: an empty
/// string is falsy, so it does not block preservation), and the existing row is strictly newer.
pub fn should_preserve_newer_terminal_status(
    existing: Option<&TaskMeta>,
    incoming: &TaskMeta,
) -> bool {
    let existing = match existing {
        Some(e) => e,
        None => return false,
    };
    if !is_terminal_status(existing.status.as_deref()) {
        return false;
    }
    if let Some(s) = incoming.status.as_deref() {
        if !s.is_empty() && s != "running" {
            return false;
        }
    }
    existing.updated_at > incoming.updated_at
}

/// Sync-level params for `syncTaskMeta`, distinct from the meta fields. `None` means the caller
/// omitted it, so the existing row's value is kept (TS `params.x ?? existing…`).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncParams {
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub deleted: Option<bool>,
    pub title_overridden: Option<bool>,
    /// Whether the incoming meta had an OWN `target` key (TS `hasOwnProperty`). Present-but-null
    /// still wins over the existing target; only a truly absent key defers to the existing one.
    pub incoming_target_present: bool,
}

/// Existing-row scalar flags `syncTaskMeta` reads from the raw row (not the meta) as `??` fallbacks.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExistingRowFlags {
    pub title_overridden: bool,
    pub pinned: bool,
    pub archived: bool,
    pub deleted: bool,
}

/// The merged outcome of `syncTaskMeta`'s decision step: the effective `meta` to write, the
/// `writeRecord` flags, and the two "first appearance" triggers that later drive system-group
/// membership (`ensureCronGroupMembership` / `ensureOffPeakGroupMembership`).
#[derive(Debug, Clone)]
pub struct SyncDecision {
    pub meta: TaskMeta,
    pub pinned: bool,
    pub archived: bool,
    pub deleted: bool,
    pub title_overridden: bool,
    pub newly_cron: bool,
    pub newly_off_peak: bool,
}

/// Pure port of the `syncTaskMetaWithGroupedAdmission` merge block: the correctness-critical
/// preservation rules (monotonic `updatedAt`, user-title keep, terminal-status keep, identity/
/// migration/unread fallbacks, `target` presence) isolated from the transaction/queue/group I/O.
pub fn merge_sync_task_meta(
    incoming: &TaskMeta,
    existing: Option<&TaskMeta>,
    existing_flags: ExistingRowFlags,
    params: &SyncParams,
) -> SyncDecision {
    let title_overridden = params
        .title_overridden
        .unwrap_or(existing_flags.title_overridden);
    let updated_at = incoming
        .updated_at
        .max(existing.map(|e| e.updated_at).unwrap_or(0));
    let preserve_terminal = should_preserve_newer_terminal_status(existing, incoming);

    let mut meta = incoming.clone();
    meta.title = match (title_overridden, existing) {
        (true, Some(e)) => e.title.clone(),
        _ => incoming.title.clone(),
    };
    meta.title_overridden = title_overridden;
    meta.status = if preserve_terminal {
        existing.and_then(|e| e.status.clone())
    } else {
        incoming.status.clone()
    };
    meta.last_error = if preserve_terminal {
        existing.and_then(|e| e.last_error.clone())
    } else {
        incoming.last_error.clone()
    };
    meta.target = if params.incoming_target_present {
        incoming.target.clone()
    } else {
        existing.and_then(|e| e.target.clone())
    };
    meta.migration_source = incoming
        .migration_source
        .clone()
        .or_else(|| existing.and_then(|e| e.migration_source.clone()));
    meta.cron_automation_id = incoming
        .cron_automation_id
        .clone()
        .or_else(|| existing.and_then(|e| e.cron_automation_id.clone()));
    meta.off_peak_task_id = incoming
        .off_peak_task_id
        .clone()
        .or_else(|| existing.and_then(|e| e.off_peak_task_id.clone()));
    meta.unread_at = incoming
        .unread_at
        .or_else(|| existing.and_then(|e| e.unread_at));
    meta.updated_at = updated_at;

    let existing_had_cron = existing.is_some_and(|e| e.cron_automation_id.is_some());
    let existing_had_off_peak = existing.is_some_and(|e| e.off_peak_task_id.is_some());
    let newly_cron = meta.cron_automation_id.is_some() && !existing_had_cron;
    let newly_off_peak = meta.off_peak_task_id.is_some() && !existing_had_off_peak;

    SyncDecision {
        meta,
        pinned: params.pinned.unwrap_or(existing_flags.pinned),
        archived: params.archived.unwrap_or(existing_flags.archived),
        deleted: params.deleted.unwrap_or(existing_flags.deleted),
        title_overridden,
        newly_cron,
        newly_off_peak,
    }
}

/// Build the `writeRecord` payload from a merge decision + the resolved `workspace_key` + the
/// caller-supplied searchable body. `write_unread_at` is false, matching TS `syncTaskMeta` (which
/// does not flag the `unread_at` column on conflict; the merged value still lands in `meta_json`).
/// Row-level (non-meta) columns a `writeRecord` supplies alongside the meta. Bundled so the write
/// builder stays within the argument budget and call sites read as intent, not positional booleans.
#[derive(Debug, Clone, Copy, Default)]
struct RowFlags {
    pinned: bool,
    archived: bool,
    deleted: bool,
    title_overridden: bool,
    write_unread_at: bool,
}

/// Shared `WriteRecord` builder: copies the scalar columns from `meta` and applies the row-level
/// flags + `meta_json` serialization. Every `tasks`-row write funnels through this one path.
fn record_from_meta(
    workspace_key: &str,
    meta: &TaskMeta,
    flags: RowFlags,
    searchable_text: Option<String>,
) -> WriteRecord {
    WriteRecord {
        workspace_key: workspace_key.to_string(),
        workspace_path: meta.workspace_path.clone(),
        workspace_identity: meta.workspace_identity.clone(),
        task_id: meta.task_id.clone(),
        title: meta.title.clone(),
        task_status: meta.status.clone(),
        provider: meta.provider.clone(),
        mode: meta.mode.clone(),
        model: meta.model.clone(),
        migration_source: meta.migration_source.clone(),
        forked_from_task_id: meta.forked_from_task_id.clone(),
        cron_automation_id: meta.cron_automation_id.clone(),
        off_peak_task_id: meta.off_peak_task_id.clone(),
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        unread_at: meta.unread_at,
        write_unread_at: flags.write_unread_at,
        pinned: flags.pinned,
        archived: flags.archived,
        deleted: flags.deleted,
        title_overridden: flags.title_overridden,
        searchable_text,
        meta_json: serde_json::to_string(meta).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn decision_to_write_record(
    workspace_key: &str,
    decision: &SyncDecision,
    searchable_text: Option<String>,
) -> WriteRecord {
    record_from_meta(
        workspace_key,
        &decision.meta,
        RowFlags {
            pinned: decision.pinned,
            archived: decision.archived,
            deleted: decision.deleted,
            title_overridden: decision.title_overridden,
            // syncTaskMeta never flags the unread column on conflict (see the TS writeRecord call).
            write_unread_at: false,
        },
        searchable_text,
    )
}

/// Port of the `syncTaskMeta` core for the normal (non-grouped-top) path: read the existing row,
/// project it (`rowToMeta`), merge with the incoming meta, persist via `write_record`, and return
/// the persisted projection + the merge decision. The TS normal path issues NO explicit `BEGIN`
/// (a single atomic upsert, serialized by the in-process write queue), so none is taken here.
/// Group-membership for a first `cron`/`offPeak` id is driven by the caller from
/// `decision.newly_cron` / `decision.newly_off_peak` (a separate slice over the `task_groups`
/// subsystem) — this returns, rather than silently skips, those triggers so nothing is faked.
pub fn sync_task_meta(
    conn: &Connection,
    workspace_key: &str,
    incoming: &TaskMeta,
    params: &SyncParams,
    searchable_text: Option<String>,
) -> std::result::Result<(TaskMeta, SyncDecision), rusqlite::Error> {
    let existing_row = get_task_index_row(conn, workspace_key, &incoming.task_id)?;
    let existing_meta = existing_row.as_ref().map(row_to_meta);
    let existing_flags = existing_row
        .as_ref()
        .map(|r| ExistingRowFlags {
            title_overridden: r.title_overridden == 1,
            pinned: r.pinned == 1,
            archived: r.archived == 1,
            deleted: r.deleted == 1,
        })
        .unwrap_or_default();

    let decision = merge_sync_task_meta(incoming, existing_meta.as_ref(), existing_flags, params);
    let record = decision_to_write_record(workspace_key, &decision, searchable_text);
    let persisted = write_record(conn, &record)?;
    Ok((persisted, decision))
}

/// Port of `seedTaskMetaIfMissing`: write baseline metadata ONLY when the index row is absent. An
/// existing row (including a soft-deleted shell) is returned unchanged so its product-shell state
/// (pin/archive/unread/manual title) is never clobbered by a late first snapshot.
pub fn seed_task_meta_if_missing(
    conn: &Connection,
    workspace_key: &str,
    incoming: &TaskMeta,
) -> std::result::Result<TaskMeta, rusqlite::Error> {
    if let Some(row) = get_task_index_row(conn, workspace_key, &incoming.task_id)? {
        return Ok(row_to_meta(&row));
    }
    let record = record_from_meta(
        workspace_key,
        incoming,
        RowFlags {
            title_overridden: incoming.title_overridden,
            ..Default::default()
        },
        None,
    );
    write_record(conn, &record)
}

/// Port of `clearTaskUnreadIfMatches`, held under ONE `BEGIN IMMEDIATE`: the compare and the write
/// share the same write transaction so a late phone-read cannot wipe a newer `unreadAt` produced
/// after the click (the exact race the TS comment guards). Errors (`QueryReturnedNoRows`) on a
/// missing or deleted row. Returns `(persistedMeta, cleared)`.
pub fn clear_task_unread_if_matches(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
    expected_unread_at: i64,
) -> std::result::Result<(TaskMeta, bool), rusqlite::Error> {
    conn.execute("BEGIN IMMEDIATE", [])?;
    match clear_task_unread_inner(conn, workspace_key, task_id, expected_unread_at) {
        Ok(v) => {
            conn.execute("COMMIT", [])?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

fn clear_task_unread_inner(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
    expected_unread_at: i64,
) -> std::result::Result<(TaskMeta, bool), rusqlite::Error> {
    let row = get_task_index_row(conn, workspace_key, task_id)?
        .filter(|r| r.deleted != 1)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let current = row_to_meta(&row);
    if current.unread_at != Some(expected_unread_at) {
        return Ok((current, false));
    }
    let mut next = current.clone();
    next.unread_at = None;
    let record = record_from_meta(
        workspace_key,
        &next,
        RowFlags {
            pinned: row.pinned == 1,
            archived: row.archived == 1,
            deleted: false,
            title_overridden: row.title_overridden == 1,
            write_unread_at: true,
        },
        None,
    );
    let persisted = write_record(conn, &record)?;
    Ok((persisted, true))
}

// ---- updateTaskState + grouping-reference cleanup ----

/// A patch field that distinguishes "absent (keep current)" from "present (use, even if null)".
/// Mirrors the `"x" in patch` checks in TS `updateTaskState`.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum PatchField<T> {
    #[default]
    Unset,
    Set(T),
}

/// `unreadAt` patch operation: `Clear` (key present, value undefined → mark read) or `Allocate`
/// (key present with a requested number). Absence keeps the current value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UnreadOp {
    Clear,
    Allocate(i64),
}

/// Port of `TaskIndexStatePatch`. Options use `??` fallbacks; `unreadAt` / `lastError` / `target`
/// need the present-vs-absent distinction, so they use `PatchField`.
#[derive(Debug, Clone, Default)]
pub struct StatePatch {
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub deleted: Option<bool>,
    pub title: Option<String>,
    pub title_overridden: Option<bool>,
    pub model: Option<String>,
    pub status: Option<String>,
    pub updated_at: Option<i64>,
    pub unread_at: PatchField<UnreadOp>,
    pub last_error: PatchField<Option<serde_json::Value>>,
    pub target: PatchField<Option<serde_json::Value>>,
}

/// Port of `deleteTaskGroupingReferencesReady`: remove a task from its group membership and drop
/// its `task`-node ordering rows. Runs inside the caller's transaction so a tombstone and the group
/// edit commit atomically.
fn delete_task_grouping_references(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
) -> std::result::Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2",
        rusqlite::params![workspace_key, task_id],
    )?;
    // node_key for a task node is the JSON of [workspace_key, task_id]; the extra OR matches the
    // legacy bare-workspace key form. Serializing two strings cannot fail, so build it directly.
    let json_key = format!(
        "[{},{}]",
        serde_json::Value::String(workspace_key.to_string()),
        serde_json::Value::String(task_id.to_string())
    );
    conn.execute(
        "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND (node_key = ?1 OR node_key = ?2)",
        rusqlite::params![json_key, workspace_key],
    )?;
    Ok(())
}

fn update_task_state_inner(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
    patch: &StatePatch,
) -> std::result::Result<TaskMeta, rusqlite::Error> {
    let row = get_task_index_row(conn, workspace_key, task_id)?
        .filter(|r| r.deleted != 1)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let current = row_to_meta(&row);

    // Strictly-increasing unread marker: allocate above a watermark drawn from the persisted
    // `last_unread_at` (which never resets on clear) so two same-ms marks and a clear→re-unread
    // cycle cannot collide — exactly why TS reads it inside the write lock.
    let mutating_unread = matches!(patch.unread_at, PatchField::Set(_));
    let watermark = row
        .last_unread_at
        .max(row.unread_at.unwrap_or(0))
        .max(current.unread_at.unwrap_or(0));
    let unread_at = match patch.unread_at {
        PatchField::Set(UnreadOp::Allocate(req)) => Some(req.max(watermark + 1)),
        PatchField::Set(UnreadOp::Clear) => None,
        PatchField::Unset => current.unread_at,
    };

    let mut next = current.clone();
    next.title = patch.title.clone().unwrap_or_else(|| current.title.clone());
    next.title_overridden = patch.title_overridden.unwrap_or(current.title_overridden);
    next.model = patch.model.clone().or_else(|| current.model.clone());
    next.updated_at = patch.updated_at.unwrap_or(current.updated_at);
    next.status = patch.status.clone().or_else(|| current.status.clone());
    next.unread_at = unread_at;
    next.last_error = match &patch.last_error {
        PatchField::Set(v) => Some(v.clone().unwrap_or(serde_json::Value::Null)),
        PatchField::Unset => current.last_error.clone(),
    };
    next.target = match &patch.target {
        // A present-but-null `lastError`/`target` writes an explicit JSON null (TS "x in patch" →
        // uses the value even when null); only an absent key keeps the current value.
        PatchField::Set(v) => Some(v.clone().unwrap_or(serde_json::Value::Null)),
        PatchField::Unset => current.target.clone(),
    };

    let deleting = patch.deleted == Some(true);
    let record = record_from_meta(
        workspace_key,
        &next,
        RowFlags {
            pinned: patch.pinned.unwrap_or(row.pinned == 1),
            archived: patch.archived.unwrap_or(row.archived == 1),
            deleted: patch.deleted.unwrap_or(row.deleted == 1),
            title_overridden: patch.title_overridden.unwrap_or(row.title_overridden == 1),
            write_unread_at: mutating_unread,
        },
        None,
    );
    let persisted = write_record(conn, &record)?;
    if deleting {
        delete_task_grouping_references(conn, workspace_key, task_id)?;
    }
    Ok(persisted)
}

/// Port of `updateTaskState`: apply a state patch to an existing (non-deleted) row. The delete or
/// unread-mutation paths run under one `BEGIN IMMEDIATE` so the tombstone + grouping cleanup and
/// the monotonic unread marker commit atomically; other patches are single-upsert writes. Errors
/// (`QueryReturnedNoRows`) if the row is missing or already deleted.
pub fn update_task_state(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
    patch: &StatePatch,
) -> std::result::Result<TaskMeta, rusqlite::Error> {
    let transactional =
        patch.deleted == Some(true) || matches!(patch.unread_at, PatchField::Set(_));
    if !transactional {
        return update_task_state_inner(conn, workspace_key, task_id, patch);
    }
    conn.execute("BEGIN IMMEDIATE", [])?;
    match update_task_state_inner(conn, workspace_key, task_id, patch) {
        Ok(v) => {
            conn.execute("COMMIT", [])?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Subset of the TS `TaskIndexStatePatch` that `applyAgentPatch` consumes: only the agent-owned
/// fields. `lastError`/`target` keep the tri-state `PatchField` so a present-`null` (clear) is
/// distinguished from an absent key (keep), exactly as the TS `"x" in patch` check does.
pub struct AgentPatch {
    pub title: Option<String>,
    pub status: Option<String>,
    pub updated_at: Option<i64>,
    pub last_error: PatchField<Option<serde_json::Value>>,
    pub target: PatchField<Option<serde_json::Value>>,
}

/// Port of `applyAgentPatch`: merge an agent-supplied patch onto a live (non-deleted) row. The agent
/// `title` is only accepted while the row is NOT user-title-overridden; the row-level flags
/// (`pinned`/`archived`/`deleted`) and the unread marker are never touched. Like the TS normal
/// single-upsert path it opens no explicit transaction (serialization is the caller's write queue).
/// Returns `Ok(None)` when the row is missing or already deleted (TS returns `null`).
pub fn apply_agent_patch(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
    patch: &AgentPatch,
) -> std::result::Result<Option<TaskMeta>, rusqlite::Error> {
    let row = match get_task_index_row(conn, workspace_key, task_id)? {
        Some(r) if r.deleted != 1 => r,
        _ => return Ok(None),
    };
    let current = row_to_meta(&row);
    let title_overridden = row.title_overridden == 1;

    let mut next = current.clone();
    // `canAcceptAgentTitle && params.patch.title` — falsy (absent OR empty) keeps the current title.
    next.title = match (title_overridden, patch.title.as_deref()) {
        (false, Some(t)) if !t.is_empty() => t.to_string(),
        _ => current.title.clone(),
    };
    next.title_overridden = title_overridden;
    next.updated_at = patch.updated_at.unwrap_or(current.updated_at);
    next.status = patch.status.clone().or_else(|| current.status.clone());
    next.last_error = match &patch.last_error {
        PatchField::Set(v) => Some(v.clone().unwrap_or(serde_json::Value::Null)),
        PatchField::Unset => current.last_error.clone(),
    };
    next.target = match &patch.target {
        PatchField::Set(v) => Some(v.clone().unwrap_or(serde_json::Value::Null)),
        PatchField::Unset => current.target.clone(),
    };

    let record = record_from_meta(
        workspace_key,
        &next,
        RowFlags {
            pinned: row.pinned == 1,
            archived: row.archived == 1,
            // The row is guaranteed non-deleted above; the tombstone path is `deleteArchivedTask`.
            deleted: false,
            title_overridden,
            write_unread_at: false,
        },
        None,
    );
    Ok(Some(write_record(conn, &record)?))
}

/// Port of `deleteArchivedTask`: inside one `BEGIN IMMEDIATE`, re-check the row is archived and
/// still live (the confirm dialog may have been overtaken by another end restoring it), then
/// tombstone it (`write_record` with `archived`/`deleted` set) and drop its grouping references
/// atomically. Returns `Ok(None)` — COMMITting the transaction — when the row is missing, already
/// deleted, or not archived, matching the TS guard.
pub fn delete_archived_task(
    conn: &Connection,
    workspace_key: &str,
    task_id: &str,
) -> std::result::Result<Option<TaskMeta>, rusqlite::Error> {
    conn.execute("BEGIN IMMEDIATE", [])?;
    let outcome: std::result::Result<Option<TaskMeta>, rusqlite::Error> = (|| {
        let row = match get_task_index_row(conn, workspace_key, task_id)? {
            Some(r) if r.deleted != 1 && r.archived == 1 => r,
            _ => return Ok(None),
        };
        let meta = row_to_meta(&row);
        let record = record_from_meta(
            workspace_key,
            &meta,
            RowFlags {
                pinned: row.pinned == 1,
                archived: true,
                deleted: true,
                title_overridden: row.title_overridden == 1,
                write_unread_at: false,
            },
            None,
        );
        let persisted = write_record(conn, &record)?;
        delete_task_grouping_references(conn, workspace_key, task_id)?;
        Ok(Some(persisted))
    })();
    match outcome {
        Ok(v) => {
            conn.execute("COMMIT", [])?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}
/// group lands at the top. Empty table → `step*2 - step` (i.e. `1000`).
pub fn get_next_grouped_top_sort_order(
    conn: &Connection,
) -> std::result::Result<i64, rusqlite::Error> {
    let min: Option<i64> = conn
        .query_row(
            "SELECT MIN(sort_order) FROM task_group_view_node_orders",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten();
    Ok(min.unwrap_or(GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP)
}

/// A task's identity for grouping (a borrowed `TaskRef` to keep the port's signature tidy).
#[derive(Debug, Clone, Copy)]
pub struct TaskRef<'a> {
    pub workspace_key: &'a str,
    pub workspace_path: &'a str,
    pub workspace_identity: Option<&'a str>,
    pub task_id: &'a str,
}

/// A system group's identity (cron/off-peak): fixed id, display title, color.
#[derive(Debug, Clone, Copy)]
pub struct SystemGroup<'a> {
    pub group_id: &'a str,
    pub title: &'a str,
    pub color: &'a str,
}

/// Port of `ensureSystemGroupMembership`: idempotently create the system group row, give it a
/// grouped-view order (only if absent, so re-running never reshuffles), and add the task as a
/// member (`INSERT OR IGNORE` so a user's manual grouping is preserved). `now` is injected so the
/// port is deterministic and testable (TS uses `Date.now()`).
pub fn ensure_system_group_membership(
    conn: &Connection,
    task: &TaskRef<'_>,
    group: &SystemGroup<'_>,
    now: i64,
) -> std::result::Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![group.group_id, group.title, group.color, now, now],
    )?;
    let sort = get_next_grouped_top_sort_order(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) \
         VALUES ('group', ?1, ?2, ?3, ?4)",
        rusqlite::params![group.group_id, sort, now, now],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO task_group_members (group_id, workspace_key, workspace_path, workspace_identity, task_id, sort_order, added_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8)",
        rusqlite::params![
            group.group_id,
            task.workspace_key,
            task.workspace_path,
            task.workspace_identity,
            task.task_id,
            now,
            now,
            now
        ],
    )?;
    Ok(())
}

/// System-group ids — mirror the shared `CRON_DEFAULT_GROUP_ID` / `OFF_PEAK_DEFAULT_GROUP_ID`.
pub(crate) const CRON_DEFAULT_GROUP_ID: &str = "zcode-default-group-cron";
pub(crate) const OFF_PEAK_DEFAULT_GROUP_ID: &str = "zcode-default-group-off-peak";

/// Port of `ensureCronGroupMembership` — a cron session joins the fixed cron group.
pub fn ensure_cron_group_membership(
    conn: &Connection,
    task: &TaskRef<'_>,
    now: i64,
) -> std::result::Result<(), rusqlite::Error> {
    ensure_system_group_membership(
        conn,
        task,
        &SystemGroup {
            group_id: CRON_DEFAULT_GROUP_ID,
            title: "cron",
            color: "blue",
        },
        now,
    )
}

/// Port of `ensureOffPeakGroupMembership`. Off-peak does not support remote workspaces, so a
/// remote identity short-circuits without grouping (matches the TS guard).
pub fn ensure_off_peak_group_membership(
    conn: &Connection,
    task: &TaskRef<'_>,
    now: i64,
) -> std::result::Result<(), rusqlite::Error> {
    if task
        .workspace_identity
        .is_some_and(is_remote_workspace_identity)
    {
        return Ok(());
    }
    ensure_system_group_membership(
        conn,
        task,
        &SystemGroup {
            group_id: OFF_PEAK_DEFAULT_GROUP_ID,
            title: "off-peak",
            color: "purple",
        },
        now,
    )
}

/// Full `syncTaskMeta` write path: run the core merge+persist, then, on a FIRST cron/off-peak
/// identity, add the session to its system group (the `newly_*` triggers from the merge decision).
/// `now` is injected for the group timestamps (TS `Date.now()`). Returns the persisted projection.
pub fn sync_task_meta_with_grouping(
    conn: &Connection,
    workspace_key: &str,
    incoming: &TaskMeta,
    params: &SyncParams,
    searchable_text: Option<String>,
    now: i64,
) -> std::result::Result<TaskMeta, rusqlite::Error> {
    let (persisted, decision) =
        sync_task_meta(conn, workspace_key, incoming, params, searchable_text)?;
    let task = TaskRef {
        workspace_key,
        workspace_path: &decision.meta.workspace_path,
        workspace_identity: decision.meta.workspace_identity.as_deref(),
        task_id: &decision.meta.task_id,
    };
    if decision.newly_cron {
        ensure_cron_group_membership(conn, &task, now)?;
    }
    if decision.newly_off_peak {
        ensure_off_peak_group_membership(conn, &task, now)?;
    }
    Ok(persisted)
}

/// Port of `syncTaskMetaAtGroupedTop`: the SAME merge + cron/off-peak grouping as
/// [`sync_task_meta_with_grouping`], but wrapped in one `BEGIN IMMEDIATE` so the task row and its
/// first grouped top-order are committed atomically (a root draft published between two separate
/// writes would let the Renderer append it to the tail). Returns the persisted meta and whether a
/// new top-order row was initialized (false when the task was ineligible or already ordered).
pub fn sync_task_meta_at_grouped_top(
    conn: &Connection,
    workspace_key: &str,
    incoming: &TaskMeta,
    params: &SyncParams,
    searchable_text: Option<String>,
    now: i64,
) -> std::result::Result<(TaskMeta, bool), String> {
    conn.execute("BEGIN IMMEDIATE", []).map_err(|e| e.to_string())?;
    let outcome: std::result::Result<(TaskMeta, bool), String> = (|| {
        let persisted = sync_task_meta_with_grouping(conn, workspace_key, incoming, params, searchable_text, now)
            .map_err(|e| e.to_string())?;
        let task = grouping::GroupedTaskRef {
            workspace_path: persisted.workspace_path.clone(),
            workspace_identity: persisted.workspace_identity.clone(),
            task_id: persisted.task_id.clone(),
        };
        let initialized = grouping::initialize_grouped_task_at_top(conn, &task, now)?;
        Ok((persisted, initialized))
    })();
    match outcome {
        Ok(v) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// N-API: `TaskIndexRepo.syncTaskMetaAtGroupedTop` (read-write). Returns
/// `{ meta, initializedGroupedOrder }` JSON. Same inputs as [`sync_task_meta_json`] plus the atomic
/// grouped-top init.
#[napi]
pub fn sync_task_meta_at_grouped_top_json(
    db_path: String,
    workspace_key: String,
    incoming_json: String,
    params_json: String,
    searchable_text: Option<String>,
    now: f64,
) -> Result<String> {
    let incoming: TaskMeta =
        serde_json::from_str(&incoming_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let params: SyncParams =
        serde_json::from_str(&params_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readwrite(&db_path)?;
    let (meta, initialized) = sync_task_meta_at_grouped_top(
        &conn,
        &workspace_key,
        &incoming,
        &params,
        searchable_text,
        now as i64,
    )
    .map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&serde_json::json!({ "meta": meta, "initializedGroupedOrder": initialized }))
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.seedTaskMetaIfMissing` (read-write). Returns the existing projection when
/// the row is present, else the newly written one. `incoming_json` = `TaskMeta`.
#[napi]
pub fn seed_task_meta_if_missing_json(
    db_path: String,
    workspace_key: String,
    incoming_json: String,
) -> Result<String> {
    let incoming: TaskMeta =
        serde_json::from_str(&incoming_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readwrite(&db_path)?;
    let meta =
        seed_task_meta_if_missing(&conn, &workspace_key, &incoming).map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&meta).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API write boundary: run the full `syncTaskMeta` write path against a read-write DB, taking the
/// incoming meta + sync params as JSON and returning the persisted projection as JSON. This is the
/// callable surface a TS adapter replaces `node:sqlite` with. `now` is a JS number (epoch ms).
#[napi]
pub fn sync_task_meta_json(
    db_path: String,
    workspace_key: String,
    incoming_json: String,
    params_json: String,
    searchable_text: Option<String>,
    now: f64,
) -> Result<String> {
    let incoming: TaskMeta =
        serde_json::from_str(&incoming_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let params: SyncParams =
        serde_json::from_str(&params_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readwrite(&db_path)?;
    let persisted =
        sync_task_meta_with_grouping(&conn, &workspace_key, &incoming, &params, searchable_text, now as i64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&persisted).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: verify the migration ledger of an existing DB (read-only) against this crate's frozen
/// checksums. `true` means the Rust DB layer can safely adopt this file; a checksum mismatch
/// surfaces as a thrown error (mirrors the TS runner). Extra migrations from newer builds (e.g.
/// `0004`) are simply outside this crate's frozen set and are ignored, exactly like the TS check.
#[napi]
pub fn are_migrations_applied(db_path: String) -> Result<bool> {
    let conn = open_readonly(&db_path)?;
    migrations::are_tasks_migrations_applied(&conn).map_err(Error::from_reason)
}

/// N-API: open (RW/CREATE), set WAL/`busy_timeout`, and apply migrations to a tasks-index DB.
/// Returns the migration kind (`"initialize"`/`"upgrade"`/`"none"`). Post-migration repo repair
/// steps are a caller concern (see `bootstrap_tasks_index` scope note).
#[napi]
pub fn bootstrap_tasks_index(db_path: String, deadline_ms: i64) -> Result<String> {
    migrations::bootstrap_tasks_index(&db_path, deadline_ms)
        .map(|kind| kind.to_string())
        .map_err(Error::from_reason)
}

/// N-API: create/open the Agent CLI session-store DB (`~/.zcode/cli/db/db.sqlite`), apply the frozen
/// migration ledger, and return the `DatabaseMigrationFacts` JSON. The CLI facade calls this on open,
/// replacing `runSqliteSessionMigrations` — no `node:sqlite` remains in the session-store path.
#[napi]
pub fn bootstrap_session_store_json(
    db_path: String,
    deadline_ms: i64,
    now: f64,
) -> Result<String> {
    let facts = session_bootstrap::bootstrap_session_store(&db_path, deadline_ms, now as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&facts).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: read-only check whether the session-store DB is fully migrated (no pending, no checksum
/// drift). A missing file reports `false` (it still needs `bootstrapSessionStoreJson`).
#[napi]
pub fn are_session_migrations_applied(db_path: String) -> Result<bool> {
    let Ok(conn) = open_readonly(&db_path) else {
        return Ok(false);
    };
    session_bootstrap::inspect_session_migration_kind(&conn)
        .map(|kind| kind == "none")
        .map_err(Error::from_reason)
}

/// N-API: `readTodos` port. Returns a JSON array of `{content,status,priority}` ordered by position.
#[napi]
pub fn read_todos_json(db_path: String, session_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_store::read_todos(&conn, &session_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listSessionInputs` port. `status` is optional (null/undefined → all), ordered by
/// `admitted_sequence`. Returns a JSON array of `SessionInputRecord` projections.
#[napi]
pub fn list_session_inputs_json(
    db_path: String,
    session_id: String,
    status: Option<String>,
) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_store::list_session_inputs(&conn, &session_id, status.as_deref())
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getSessionInputById` port. Returns the record JSON or `"null"`.
#[napi]
pub fn get_session_input_by_id_json(db_path: String, id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_store::get_session_input_by_id(&conn, &id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getProjectPermission` port. Returns the parsed ruleset JSON or `"null"`.
#[napi]
pub fn get_project_permission_json(db_path: String, project_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_store::get_project_permission(&conn, &project_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getProjectPermissionMode` port. Returns a mode string JSON (`"yolo"`) or `"null"`.
#[napi]
pub fn get_project_permission_mode_json(db_path: String, project_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_store::get_project_permission_mode(&conn, &project_id)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getSession` port. Returns the `SessionInfo` JSON or `"null"`.
#[napi]
pub fn get_session_json(db_path: String, session_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_sessions::get_session(&conn, &session_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listSessions` port. `filter_json` is a `ListSessionsInput` JSON (`"null"`/`"{}"` = none).
#[napi]
pub fn list_sessions_json(db_path: String, filter_json: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let filter: serde_json::Value = serde_json::from_str(&filter_json)
        .map_err(|e| Error::from_reason(format!("invalid filter json: {e}")))?;
    let value = session_sessions::list_sessions(&conn, &filter).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `sessionEntries` port. `type` is optional (null/undefined → all). Returns a JSON array.
#[napi]
pub fn session_entries_json(
    db_path: String,
    session_id: String,
    entry_type: Option<String>,
) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value =
        session_entries::session_entries(&conn, &session_id, entry_type.as_deref())
            .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `messages` port. Returns a JSON array of `{info, parts}`.
#[napi]
pub fn messages_json(db_path: String, session_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_messages::messages(&conn, &session_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `messageWithParts` port. Returns `{info, parts}` JSON or `"null"`.
#[napi]
pub fn message_with_parts_json(db_path: String, session_id: String, message_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_messages::message_with_parts(&conn, &session_id, &message_id)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `readTarget` port. Returns the `SessionGoal` JSON or `"null"`.
#[napi]
pub fn read_target_json(db_path: String, session_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_store::read_target(&conn, &session_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `recallPreviousInputHistory` port. Returns the entry JSON or `"null"`. `skip` = offset.
#[napi]
pub fn recall_previous_input_history_json(db_path: String, project_id: String, skip: f64) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_store::recall_previous_input_history(&conn, &project_id, skip as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getScriptWorkflowRun` port. Returns the run JSON or `"null"`.
#[napi]
pub fn get_script_workflow_run_json(db_path: String, run_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_workflow::get_script_workflow_run(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listScriptWorkflowRuns` port. `filter_json` = `{ cwd?, statuses?, limit? }`.
#[napi]
pub fn list_script_workflow_runs_json(db_path: String, filter_json: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let filter: serde_json::Value = serde_json::from_str(&filter_json)
        .map_err(|e| Error::from_reason(format!("invalid filter json: {e}")))?;
    let value = session_workflow::list_script_workflow_runs(&conn, &filter).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listScriptWorkflowActivities` port. Returns a JSON array of activity records.
#[napi]
pub fn list_script_workflow_activities_json(db_path: String, run_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_workflow::list_script_workflow_activities(&conn, &run_id)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listScriptWorkflowEvents` port. `limit` <= 0 or null → all (ascending); otherwise the
/// newest N re-ascending. Returns a JSON array.
#[napi]
pub fn list_script_workflow_events_json(
    db_path: String,
    run_id: String,
    limit: Option<f64>,
) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let lim = limit.filter(|l| *l > 0.0).map(|l| l as i64);
    let value = session_workflow::list_script_workflow_events(&conn, &run_id, lim)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `queryTaskUsage` port. Returns the `TaskUsageQueryResult` JSON.
#[napi]
pub fn query_task_usage_json(db_path: String, session_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_usage::query_task_usage(&conn, &session_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `queryAppUsage` port. Returns the `AppUsageQueryResult` JSON.
#[napi]
pub fn query_app_usage_json(
    db_path: String,
    since: f64,
    until: f64,
    tz_offset_ms: f64,
) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let value = session_usage::query_app_usage(&conn, since as i64, until as i64, tz_offset_ms as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// Port of `normalizeSearchSnippetText`: collapse whitespace runs to a single space, trim, cap at
/// `SNIPPET_MAX_CHARS`. `split_whitespace` + join matches JS `.replace(/\s+/g, " ").trim()`.
fn normalize_search_snippet_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(SNIPPET_MAX_CHARS)
        .collect()
}

/// Position of `needle` within `haystack` (char slices), or `None`. JS `indexOf` analogue.
fn find_char_subslice(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Port of `buildSearchSnippets`: case-insensitive windows around each match (max 4, de-overlapped);
/// falls back to one whole-text snippet when the body has no match (title-only hits). Indices are
/// computed on the lowercased text and applied to the original, exactly as TS does.
///
/// PARITY GAPS (declared, not silent): matching uses `char` units (JS uses UTF-16 units) and
/// `to_lowercase` (JS `toLocaleLowerCase`); these differ only for astral-plane boundary splits and
/// locale-specific casing, which don't arise for typical indexed text.
pub fn build_search_snippets(searchable_text: &str, search: Option<&str>) -> Vec<String> {
    let Some(search) = search.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    if searchable_text.trim().is_empty() {
        return Vec::new();
    }
    let normalized_search: Vec<char> = search.to_lowercase().chars().collect();
    let normalized_text: Vec<char> = searchable_text.to_lowercase().chars().collect();
    let source: Vec<char> = searchable_text.chars().collect();
    let needle_len = normalized_search.len();
    let mut snippets: Vec<String> = Vec::new();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut search_start = 0usize;

    while snippets.len() < SNIPPET_LIMIT && search_start < normalized_text.len() {
        let Some(rel) = find_char_subslice(&normalized_text[search_start..], &normalized_search)
        else {
            break;
        };
        let match_index = search_start + rel;
        let start = match_index.saturating_sub(SNIPPET_PREFIX_RADIUS);
        let end = source
            .len()
            .min(match_index + needle_len + SNIPPET_SUFFIX_RADIUS);
        let prefix = if start > 0 { "..." } else { "" };
        let suffix = if end < source.len() { "..." } else { "" };
        let window: String = source[start..end].iter().collect();
        let snippet = normalize_search_snippet_text(&format!("{prefix}{window}{suffix}"));
        let overlaps = ranges
            .iter()
            .any(|(rs, re)| (*re).min(end).saturating_sub((*rs).max(start)) > 0);
        if !snippet.is_empty() && !overlaps {
            snippets.push(snippet);
            ranges.push((start, end));
        }
        search_start = match_index + needle_len;
    }

    if snippets.is_empty() {
        let fallback = normalize_search_snippet_text(searchable_text);
        if fallback.is_empty() {
            return Vec::new();
        }
        return vec![fallback];
    }
    snippets
}

// ---- queryTaskList (multi-workspace, kind, search, pagination) ----

/// TS `resolveWorkspaceKey`: trimmed identity, else the raw path.
pub(crate) fn workspace_key(path: &str, identity: Option<&str>) -> String {
    identity
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

/// A workspace scope input for the list query.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceScope {
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub workspace_purpose: Option<String>,
}

/// Query options mirroring `ZCodeTaskListQuery`. `kind`: "pinned" | "archived" | anything-else
/// (default = unpinned+unarchived). `sort_by`: "created" | anything-else (updated).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskListQuery {
    pub workspace_scopes: Vec<WorkspaceScope>,
    pub provider: Option<String>,
    pub kind: Option<String>,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    pub limit: Option<i64>,
}

/// A list item: the projected meta, plus search snippets when present (matches `rowToTaskListItem`,
/// which only attaches the snippet fields on a non-empty result).
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskListItem {
    #[serde(flatten)]
    pub meta: TaskMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_snippets: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskListResult {
    pub items: Vec<TaskListItem>,
    pub total: i64,
    pub has_more: bool,
}

/// Port of `queryTaskList`: de-dup + sort workspace keys, build the dynamic WHERE (deleted, key IN,
/// provider, kind, case-insensitive title/body LIKE), COUNT for `total`, ordered (+LIMIT) SELECT,
/// then attach snippets + workspacePurpose. Empty scope set short-circuits to an empty result.
pub fn query_task_list(
    conn: &Connection,
    q: &TaskListQuery,
) -> std::result::Result<TaskListResult, String> {
    // normalizeWorkspaceKeys: unique, non-blank, localeCompare-sorted (Rust ordinal sort is a close
    // stand-in for the ASCII/absolute-path keys here).
    let mut keys: Vec<String> = Vec::new();
    for scope in &q.workspace_scopes {
        let key = workspace_key(&scope.workspace_path, scope.workspace_identity.as_deref());
        if !key.trim().is_empty() && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys.sort();
    if keys.is_empty() {
        return Ok(TaskListResult {
            items: vec![],
            total: 0,
            has_more: false,
        });
    }

    let purpose_by_key: std::collections::HashMap<String, String> = q
        .workspace_scopes
        .iter()
        .filter(|s| s.workspace_purpose.is_some())
        .map(|s| {
            (
                workspace_key(&s.workspace_path, s.workspace_identity.as_deref()),
                s.workspace_purpose.clone().unwrap(),
            )
        })
        .collect();

    let placeholders = vec!["?"; keys.len()].join(", ");
    let mut where_parts = vec![
        "deleted = 0".to_string(),
        format!("workspace_key IN ({placeholders})"),
    ];
    let mut args: Vec<rusqlite::types::Value> = keys
        .iter()
        .map(|k| rusqlite::types::Value::Text(k.clone()))
        .collect();

    if let Some(provider) = &q.provider {
        where_parts.push("provider = ?".to_string());
        args.push(rusqlite::types::Value::Text(provider.clone()));
    }
    match q.kind.as_deref() {
        Some("pinned") => {
            where_parts.extend(["pinned = 1".to_string(), "archived = 0".to_string()])
        }
        Some("archived") => where_parts.push("archived = 1".to_string()),
        _ => where_parts.extend(["pinned = 0".to_string(), "archived = 0".to_string()]),
    }

    let trimmed_search = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(search) = &trimmed_search {
        where_parts.push("(LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)".to_string());
        let like = rusqlite::types::Value::Text(format!("%{}%", search.to_lowercase()));
        args.push(like.clone());
        args.push(like);
    }
    let where_clause = where_parts.join(" AND ");

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(1) FROM tasks WHERE {where_clause}"),
            rusqlite::params_from_iter(args.clone()),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let order_by = if q.sort_by.as_deref() == Some("created") {
        "created_at DESC, updated_at DESC, task_id DESC"
    } else {
        "updated_at DESC, created_at DESC, task_id DESC"
    };
    let mut list_args = args.clone();
    let limit_clause = match q.limit.filter(|l| *l > 0) {
        Some(l) => {
            list_args.push(rusqlite::types::Value::Integer(l));
            " LIMIT ?"
        }
        None => "",
    };
    let list_sql = format!(
        "SELECT {TASK_INDEX_ROW_COLUMNS} FROM tasks WHERE {where_clause} ORDER BY {order_by}{limit_clause}"
    );
    let mut stmt = conn.prepare(&list_sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(list_args), map_task_index_row)
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let count = rows.len() as i64;
    let items = rows
        .iter()
        .map(|row| {
            let mut meta = row_to_meta(row);
            if let Some(purpose) = purpose_by_key.get(&row.workspace_key) {
                meta.workspace_purpose = Some(purpose.clone());
            }
            let snippets = build_search_snippets(&row.searchable_text, trimmed_search.as_deref());
            let (snippet, all) = if snippets.is_empty() {
                (None, None)
            } else {
                (Some(snippets[0].clone()), Some(snippets))
            };
            TaskListItem {
                meta,
                search_snippet: snippet,
                search_snippets: all,
            }
        })
        .collect();

    Ok(TaskListResult {
        items,
        total,
        has_more: total > count,
    })
}

/// N-API: run `queryTaskList` (read-only) and return `{items,total,hasMore}` JSON. `query_json`
/// maps to `TaskListQuery`.
#[napi]
pub fn query_task_list_json(db_path: String, query_json: String) -> Result<String> {
    let q: TaskListQuery =
        serde_json::from_str(&query_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readonly(&db_path)?;
    let result = query_task_list(&conn, &q).map_err(Error::from_reason)?;
    serde_json::to_string(&result).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: read a single task's projected meta (`getTaskMeta`) — `null` when the row is absent.
/// Uses `getTaskRow` semantics (includes tombstones), matching the TS single-read path.
#[napi]
pub fn get_task_meta_json(
    db_path: String,
    workspace_key: String,
    task_id: String,
) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let row = get_task_index_row(&conn, &workspace_key, &task_id)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    // `getTaskMeta` returns null for a deleted row (the CLI seed path can re-materialize one), so
    // filter the tombstone here rather than exposing a `deleted` flag the meta projection lacks.
    Ok(row
        .filter(|r| r.deleted != 1)
        .as_ref()
        .map(row_to_meta)
        .map(|m| serde_json::to_string(&m).unwrap_or_default()))
}

/// N-API: list automations (read-only) as JSON, optionally filtered by workspace key.
#[napi]
pub fn list_automations_json(db_path: String, workspace_key: Option<String>) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let rows = automation::list_automations(&conn, workspace_key.as_deref())
        .map_err(Error::from_reason)?;
    serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: read a single automation (read-only) as JSON, or `null` when absent.
#[napi]
pub fn get_automation_json(
    db_path: String,
    automation_id: String,
    workspace_key: Option<String>,
) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let row = automation::get_automation(&conn, &automation_id, workspace_key.as_deref())
        .map_err(Error::from_reason)?;
    Ok(row.map(|a| serde_json::to_string(&a).unwrap_or_default()))
}

/// N-API: read a single off-peak task (read-only) as JSON, or `null` when absent.
#[napi]
pub fn get_off_peak_json(db_path: String, off_peak_task_id: String) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let row = offpeak::get_off_peak(&conn, &off_peak_task_id).map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

/// Parse a JSON object into a `StatePatch`, reproducing TS `updateTaskState`'s two field
/// semantics: `??`-fields (`pinned/archived/deleted/title/titleOverridden/model/status/updatedAt`)
/// treat a present-`null` the same as absent (keep current), while `"x" in patch`-fields
/// (`unreadAt/lastError/target`) distinguish present from absent and apply even when `null`.
fn parse_state_patch(obj: &serde_json::Map<String, serde_json::Value>) -> StatePatch {
    let opt_bool = |k: &str| obj.get(k).and_then(serde_json::Value::as_bool);
    let opt_str = |k: &str| {
        obj.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let opt_i64 = |k: &str| obj.get(k).and_then(serde_json::Value::as_i64);
    // `"x" in patch` nullable-value field: absent → Unset; present → Set(Some(value)) unless null.
    let in_field = |k: &str| -> PatchField<Option<serde_json::Value>> {
        match obj.get(k) {
            None => PatchField::Unset,
            Some(v) if v.is_null() => PatchField::Set(None),
            Some(v) => PatchField::Set(Some(v.clone())),
        }
    };
    let unread_at = match obj.get("unreadAt") {
        None => PatchField::Unset,
        Some(v) => match v.as_i64() {
            Some(n) => PatchField::Set(UnreadOp::Allocate(n)),
            None => PatchField::Set(UnreadOp::Clear),
        },
    };
    StatePatch {
        pinned: opt_bool("pinned"),
        archived: opt_bool("archived"),
        deleted: opt_bool("deleted"),
        title: opt_str("title"),
        title_overridden: opt_bool("titleOverridden"),
        model: opt_str("model"),
        status: opt_str("status"),
        updated_at: opt_i64("updatedAt"),
        unread_at,
        last_error: in_field("lastError"),
        target: in_field("target"),
    }
}

/// N-API: apply `updateTaskState` (read-write DB). Returns the persisted meta JSON, or `null` when
/// the row is missing/already-deleted (the TS throws there; the adapter can surface the `null`).
#[napi]
pub fn update_task_state_json(
    db_path: String,
    workspace_key: String,
    task_id: String,
    patch_json: String,
) -> Result<Option<String>> {
    let value: serde_json::Value =
        serde_json::from_str(&patch_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let obj = value
        .as_object()
        .ok_or_else(|| Error::from_reason("patch must be a JSON object"))?;
    let patch = parse_state_patch(obj);
    let conn = open_readwrite(&db_path)?;
    match update_task_state(&conn, &workspace_key, &task_id, &patch) {
        Ok(meta) => Ok(Some(serde_json::to_string(&meta).unwrap_or_default())),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(Error::from_reason(e.to_string())),
    }
}

/// N-API: apply `clearTaskUnreadIfMatches` (read-write DB) → JSON `{ meta, cleared }`. The compare
/// + write is one `BEGIN IMMEDIATE`; a stale `expectedUnreadAt` returns `cleared:false` unchanged.
#[napi]
pub fn clear_task_unread_json(
    db_path: String,
    workspace_key: String,
    task_id: String,
    expected_unread_at: f64,
) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let (meta, cleared) =
        clear_task_unread_if_matches(&conn, &workspace_key, &task_id, expected_unread_at as i64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&serde_json::json!({ "meta": meta, "cleared": cleared }))
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: list off-peak tasks (read-only), optionally scoped to one workspace key, as JSON.
#[napi]
pub fn list_off_peak_json(db_path: String, workspace_key: Option<String>) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let rows =
        offpeak::list_off_peak(&conn, workspace_key.as_deref()).map_err(Error::from_reason)?;
    serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))
}

// ---- OffPeakTaskRepo state-machine N-API (deterministic, seeded-by-id transitions) ----
//
// These mirror the Automation write wrappers: open a read-write connection, call the ported
// transition, and project the resulting row (or `null` when the state-machine guard rejects it)
// as JSON. `now`/`started_at`/`ended_at` are injected so the TS adapter and the differential
// harness share one clock instead of reading `Date.now()` inside Rust.

fn parse_offpeak_terminal_status(
    s: &str,
) -> std::result::Result<offpeak_write::OffPeakTerminalStatus, Error> {
    match s {
        "completed" => Ok(offpeak_write::OffPeakTerminalStatus::Completed),
        "failed" => Ok(offpeak_write::OffPeakTerminalStatus::Failed),
        "cancelled" => Ok(offpeak_write::OffPeakTerminalStatus::Cancelled),
        other => Err(Error::from_reason(format!("invalid terminal status: {other}"))),
    }
}

/// N-API: `OffPeakTaskRepo.markRunning` (queued → running). Returns the updated row, or `null`
/// when the row is not in `queued` (the guard is the state-machine invariant).
#[napi]
pub fn offpeak_mark_running_json(
    db_path: String,
    id: String,
    started_at: f64,
    conversation_id: Option<String>,
    session_id: Option<String>,
    server_ticket_id: Option<String>,
) -> Result<Option<String>> {
    let conn = open_readwrite(&db_path)?;
    let row = offpeak_write::mark_running(
        &conn,
        &id,
        started_at as i64,
        conversation_id.as_deref(),
        session_id.as_deref(),
        server_ticket_id.as_deref(),
    )
    .map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

/// N-API: `OffPeakTaskRepo.markTerminal` (→ completed/failed/cancelled). Returns the updated row,
/// or `null` when the row is already terminal (irreversible-transition guard).
#[napi]
pub fn offpeak_mark_terminal_json(
    db_path: String,
    id: String,
    status: String,
    ended_at: f64,
    failure_reason: Option<String>,
    files_changed: Option<f64>,
    dispatch_error: Option<String>,
) -> Result<Option<String>> {
    let st = parse_offpeak_terminal_status(&status)?;
    let conn = open_readwrite(&db_path)?;
    let row = offpeak_write::mark_terminal(
        &conn,
        &id,
        st,
        ended_at as i64,
        failure_reason.as_deref(),
        files_changed.map(|v| v as i64),
        dispatch_error.as_deref(),
    )
    .map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

/// N-API: `OffPeakTaskRepo.setPaused` (queued ⇄ paused). Returns the updated row, or `null` when
/// the row is not in the expected `from` status or is mid-dispatch.
#[napi]
pub fn offpeak_set_paused_json(
    db_path: String,
    id: String,
    paused: bool,
    now: f64,
) -> Result<Option<String>> {
    let conn = open_readwrite(&db_path)?;
    let row =
        offpeak_write::set_paused(&conn, &id, paused, now as i64).map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

/// N-API: `OffPeakTaskRepo.releaseClaim` — reset the single-flight lock. TS returns void; the
/// guarded UPDATE is idempotent, so the harness verifies the transition by re-reading the row.
#[napi]
pub fn offpeak_release_claim_json(
    db_path: String,
    id: String,
    error: Option<String>,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    offpeak_write::release_claim(&conn, &id, error.as_deref(), now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.recoverInterrupted` — release stale running claims. Returns affected count.
#[napi]
pub fn offpeak_recover_interrupted_json(db_path: String, now: f64) -> Result<i64> {
    let conn = open_readwrite(&db_path)?;
    offpeak_write::recover_interrupted(&conn, now as i64).map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.claimDue` — atomically claim due queued tasks. Returns claimed rows JSON.
#[napi]
pub fn offpeak_claim_due_json(db_path: String, now: f64) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let rows =
        offpeak_write::claim_due(&conn, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `OffPeakTaskRepo.markSettled` — backfill settled_at on a terminal row.
#[napi]
pub fn offpeak_mark_settled_json(db_path: String, id: String, settled_at: f64) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    offpeak_write::mark_settled(&conn, &id, settled_at as i64).map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.countNonTerminal` (read-only).
#[napi]
pub fn offpeak_count_non_terminal_json(db_path: String) -> Result<i64> {
    let conn = open_readonly(&db_path)?;
    offpeak_write::count_non_terminal(&conn).map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.hasActiveBoundTask` (read-only).
#[napi]
pub fn offpeak_has_active_bound_task_json(
    db_path: String,
    workspace_key: String,
    session_id: String,
) -> Result<bool> {
    let conn = open_readonly(&db_path)?;
    offpeak_write::has_active_bound_task(&conn, &workspace_key, &session_id)
        .map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.listNonTerminal` (read-only) as JSON.
#[napi]
pub fn offpeak_list_non_terminal_json(db_path: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let rows = offpeak_write::list_non_terminal(&conn).map_err(Error::from_reason)?;
    serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `OffPeakTaskRepo.listUnsettledTerminal` (read-only) as JSON.
#[napi]
pub fn offpeak_list_unsettled_terminal_json(db_path: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let rows = offpeak_write::list_unsettled_terminal(&conn).map_err(Error::from_reason)?;
    serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `OffPeakTaskRepo.countActive` (read-only) — running-task count (keep-awake signal).
#[napi]
pub fn offpeak_count_active_json(db_path: String) -> Result<i64> {
    let conn = open_readonly(&db_path)?;
    offpeak::count_running_off_peak(&conn).map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.requeueForContinuation` (read-write). Returns the requeued row JSON, or
/// `null` when the row is not in `running`.
#[napi]
pub fn offpeak_requeue_for_continuation_json(
    db_path: String,
    id: String,
    now: f64,
) -> Result<Option<String>> {
    let conn = open_readwrite(&db_path)?;
    let row = offpeak_write::requeue_for_continuation(&conn, &id, now as i64)
        .map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

// ---- OffPeakTaskRepo create / invalidate / editable / scheduling / delete N-API ----

/// Parse a required `modelSelection` JSON value through the same strict zod path the create/update
/// writes use; `None` (invalid) is surfaced as an error the caller can raise like the TS schema.
fn parse_model_selection_required(
    v: Option<&serde_json::Value>,
) -> std::result::Result<automation::ModelSelection, Error> {
    let v = v.ok_or_else(|| Error::from_reason("modelSelection is required"))?;
    automation::read_serialized_model_selection(Some(&v.to_string()))
        .ok_or_else(|| Error::from_reason("invalid modelSelection"))
}

/// N-API: `OffPeakTaskRepo.create` (read-write). `offPeakTaskId` in `options_json` lets the caller
/// pin the id (TS external-mint path) so the write is deterministic; absent → a uuid `offpeak-…`.
#[napi]
pub fn offpeak_create_json(
    db_path: String,
    params_json: String,
    options_json: String,
    now: f64,
) -> Result<String> {
    let pv: serde_json::Value =
        serde_json::from_str(&params_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let ov: serde_json::Value =
        serde_json::from_str(&options_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let p_obj = pv
        .as_object()
        .ok_or_else(|| Error::from_reason("params must be an object"))?;
    let o_obj = ov
        .as_object()
        .ok_or_else(|| Error::from_reason("options must be an object"))?;
    let params = offpeak_write::OffPeakCreateParams {
        workspace_path: two_str(p_obj, "workspacePath").unwrap_or_default(),
        workspace_identity: two_str(p_obj, "workspaceIdentity"),
        title: two_str(p_obj, "title").unwrap_or_default(),
        prompt: two_str(p_obj, "prompt").unwrap_or_default(),
        permission_mode: two_str(p_obj, "permissionMode").unwrap_or_default(),
        model_selection: parse_model_selection_required(p_obj.get("modelSelection"))?,
        bound_session_id: two_str(p_obj, "boundSessionId"),
    };
    let options = offpeak_write::OffPeakCreateOptions {
        off_peak_task_id: two_str(o_obj, "offPeakTaskId"),
        server_ticket_id: two_str(o_obj, "serverTicketId"),
        queue_position: o_obj.get("queuePosition").and_then(serde_json::Value::as_i64),
        registered_at: o_obj.get("registeredAt").and_then(serde_json::Value::as_i64),
        schedulable: opt_bool(o_obj, "schedulable").unwrap_or(false),
    };
    let conn = open_readwrite(&db_path)?;
    let row =
        offpeak_write::create_off_peak(&conn, &params, &options, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&row).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `OffPeakTaskRepo.invalidateModelSelection` (read-write). `selection_json` is the observed
/// (possibly stale) selection; applied only when it still matches the stored row.
#[napi]
pub fn offpeak_invalidate_model_selection_json(
    db_path: String,
    id: String,
    selection_json: String,
    now: f64,
) -> Result<Option<String>> {
    let sv: serde_json::Value =
        serde_json::from_str(&selection_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let sel = parse_model_selection_required(Some(&sv))?;
    let conn = open_readwrite(&db_path)?;
    let row =
        offpeak_write::invalidate_model_selection(&conn, &id, &sel, now as i64).map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

/// N-API: `OffPeakTaskRepo.updateEditableFields` (read-write). `patch_json` = EditableFields
/// (`title`/`prompt`/`permissionMode` via `??`, `modelSelection` tri-state).
#[napi]
pub fn offpeak_update_editable_fields_json(
    db_path: String,
    id: String,
    patch_json: String,
    now: f64,
) -> Result<Option<String>> {
    let v: serde_json::Value =
        serde_json::from_str(&patch_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let obj = v
        .as_object()
        .ok_or_else(|| Error::from_reason("patch must be an object"))?;
    let patch = offpeak_write::EditableFields {
        title: two_str(obj, "title"),
        prompt: two_str(obj, "prompt"),
        permission_mode: two_str(obj, "permissionMode"),
        model_selection: tri_model(obj, "modelSelection"),
    };
    let conn = open_readwrite(&db_path)?;
    let row = offpeak_write::update_editable_fields(&conn, &id, &patch, now as i64)
        .map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

/// N-API: `OffPeakTaskRepo.updateSchedulingSnapshot` (read-write). `patch_json` = SchedulingPatch
/// (queuePosition/nextPollAt tri-state; schedulable/serverTicketId/registeredAt plain).
#[napi]
pub fn offpeak_update_scheduling_snapshot_json(
    db_path: String,
    id: String,
    patch_json: String,
    now: f64,
) -> Result<()> {
    let v: serde_json::Value =
        serde_json::from_str(&patch_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let obj = v
        .as_object()
        .ok_or_else(|| Error::from_reason("patch must be an object"))?;
    let patch = offpeak_write::SchedulingPatch {
        schedulable: opt_bool(obj, "schedulable"),
        queue_position: tri_i64(obj, "queuePosition"),
        next_poll_at: tri_i64(obj, "nextPollAt"),
        server_ticket_id: two_str(obj, "serverTicketId"),
        registered_at: obj.get("registeredAt").and_then(serde_json::Value::as_i64),
    };
    let conn = open_readwrite(&db_path)?;
    offpeak_write::update_scheduling_snapshot(&conn, &id, &patch, now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.delete` (read-write). TS returns void.
#[napi]
pub fn offpeak_delete_json(db_path: String, id: String) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    offpeak_write::delete_off_peak(&conn, &id).map_err(Error::from_reason)
}

/// N-API: `OffPeakTaskRepo.markHistoryDeleted` (read-write). Returns the post-write row JSON, or
/// `null` when the row is absent.
#[napi]
pub fn offpeak_mark_history_deleted_json(
    db_path: String,
    id: String,
    now: f64,
) -> Result<Option<String>> {
    let conn = open_readwrite(&db_path)?;
    let row = offpeak_write::mark_history_deleted(&conn, &id, now as i64).map_err(Error::from_reason)?;
    Ok(row.map(|t| serde_json::to_string(&t).unwrap_or_default()))
}

/// N-API: `AutomationRepo.create` (read-write). `params_json` = AutomationCreateParams, `options_json`
/// = `{nextRunAt?, lifecycleStatus?}`, `now` injected. The automation id is a uuid `automation-…`
/// (mirrors TS); the differential harness normalizes it. Enforces the create-limit count guard.
#[napi]
pub fn automation_create_json(
    db_path: String,
    params_json: String,
    options_json: String,
    now: f64,
) -> Result<String> {
    let pv: serde_json::Value =
        serde_json::from_str(&params_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let ov: serde_json::Value =
        serde_json::from_str(&options_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let p_obj = pv
        .as_object()
        .ok_or_else(|| Error::from_reason("params must be an object"))?;
    let o_obj = ov
        .as_object()
        .ok_or_else(|| Error::from_reason("options must be an object"))?;
    let params = automation::AutomationCreateParams {
        workspace_path: two_str(p_obj, "workspacePath").unwrap_or_default(),
        workspace_identity: two_str(p_obj, "workspaceIdentity"),
        title: two_str(p_obj, "title").unwrap_or_default(),
        cron_expr: two_str(p_obj, "cronExpr").unwrap_or_default(),
        prompt: two_str(p_obj, "prompt").unwrap_or_default(),
        model_selection: tri_model(p_obj, "modelSelection").flatten(),
        mode: two_str(p_obj, "mode"),
        target_task_id: two_str(p_obj, "targetTaskId"),
        bot_delivery_target: p_obj.get("botDeliveryTarget").cloned(),
        recurring: opt_bool(p_obj, "recurring").unwrap_or(true),
        max_runs: p_obj.get("maxRuns").and_then(serde_json::Value::as_i64),
        end_at: p_obj.get("endAt").and_then(serde_json::Value::as_i64),
        schedule_rule: p_obj.get("scheduleRule").cloned(),
    };
    let options = automation::AutomationCreateOptions {
        next_run_at: o_obj.get("nextRunAt").and_then(serde_json::Value::as_i64),
        lifecycle_status: two_str(o_obj, "lifecycleStatus"),
    };
    let conn = open_readwrite(&db_path)?;
    let created = automation::create_automation(&conn, &params, &options, now as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&created).map_err(|e| Error::from_reason(e.to_string()))
}

// ---- AutomationRepo write N-API (deterministic ops: update / delete) ----

fn two_str(obj: &serde_json::Map<String, serde_json::Value>, k: &str) -> Option<String> {
    obj.get(k)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}
fn opt_bool(obj: &serde_json::Map<String, serde_json::Value>, k: &str) -> Option<bool> {
    obj.get(k).and_then(serde_json::Value::as_bool)
}
/// Tri-state i64: absent→None (keep), present-null→Some(None) (clear), number→Some(Some(n)).
fn tri_i64(obj: &serde_json::Map<String, serde_json::Value>, k: &str) -> Option<Option<i64>> {
    obj.get(k)
        .map(|v| if v.is_null() { None } else { v.as_i64() })
}
fn tri_str(obj: &serde_json::Map<String, serde_json::Value>, k: &str) -> Option<Option<String>> {
    obj.get(k).map(|v| v.as_str().map(str::to_string))
}
fn tri_value(
    obj: &serde_json::Map<String, serde_json::Value>,
    k: &str,
) -> Option<Option<serde_json::Value>> {
    obj.get(k)
        .map(|v| if v.is_null() { None } else { Some(v.clone()) })
}
fn tri_model(
    obj: &serde_json::Map<String, serde_json::Value>,
    k: &str,
) -> Option<Option<automation::ModelSelection>> {
    obj.get(k).map(|v| {
        if v.is_null() {
            None
        } else {
            automation::read_serialized_model_selection(Some(&v.to_string()))
        }
    })
}

fn parse_automation_update_params(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> automation_write::AutomationUpdateParams {
    automation_write::AutomationUpdateParams {
        title: two_str(obj, "title"),
        cron_expr: two_str(obj, "cronExpr"),
        prompt: two_str(obj, "prompt"),
        model_selection: tri_model(obj, "modelSelection"),
        mode: tri_str(obj, "mode"),
        recurring: opt_bool(obj, "recurring"),
        max_runs: tri_i64(obj, "maxRuns"),
        end_at: tri_i64(obj, "endAt"),
        schedule_rule: tri_value(obj, "scheduleRule"),
        schedule_edited_by_user: opt_bool(obj, "scheduleEditedByUser"),
    }
}

fn parse_automation_update_options(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> automation_write::AutomationUpdateOptions {
    automation_write::AutomationUpdateOptions {
        next_run_at: tri_i64(obj, "nextRunAt"),
        lifecycle_status: two_str(obj, "lifecycleStatus"),
        reset_retry: opt_bool(obj, "resetRetry").unwrap_or(false),
    }
}

/// N-API: `AutomationRepo.update` (read-write). Returns the merged projected row JSON, or `null`
/// when the row is missing. `params_json`/`options_json` are JSON objects; tri-state fields are
/// read via the same absent-vs-null distinction as the TS.
#[napi]
pub fn update_automation_json(
    db_path: String,
    automation_id: String,
    params_json: String,
    options_json: String,
    workspace_key: Option<String>,
    now: f64,
) -> Result<Option<String>> {
    let pv: serde_json::Value =
        serde_json::from_str(&params_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let ov: serde_json::Value =
        serde_json::from_str(&options_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let params = parse_automation_update_params(
        pv.as_object()
            .ok_or_else(|| Error::from_reason("params must be an object"))?,
    );
    let options = parse_automation_update_options(
        ov.as_object()
            .ok_or_else(|| Error::from_reason("options must be an object"))?,
    );
    let conn = open_readwrite(&db_path)?;
    let result = automation_write::update(
        &conn,
        &automation_id,
        &params,
        &options,
        workspace_key.as_deref(),
        now as i64,
    )
    .map_err(Error::from_reason)?;
    Ok(result.map(|a| serde_json::to_string(&a).unwrap_or_default()))
}

/// N-API: `AutomationRepo.delete` (read-write); returns whether a row was removed.
#[napi]
pub fn delete_automation_json(
    db_path: String,
    automation_id: String,
    workspace_key: Option<String>,
) -> Result<bool> {
    let conn = open_readwrite(&db_path)?;
    automation_write::delete(&conn, &automation_id, workspace_key.as_deref())
        .map_err(Error::from_reason)
}

// ---- AutomationRepo dispatch / claim / run-ledger N-API ----
//
// All take an injected `now`/`dispatched_at`/`failed_at` clock, so the adapter and the differential
// harness share one time source. The run ledger fns accept an explicit `runId` (the TS callers
// already mint the id before the write), except `runNow`, whose random suffix is normalized in the
// harness. Model-selection inputs reuse `read_serialized_model_selection` — the same strict zod path.

fn parse_dispatch_failure_kind(s: &str) -> std::result::Result<automation_write::DispatchFailureKind, Error> {
    match s {
        "transient" => Ok(automation_write::DispatchFailureKind::Transient),
        "permanent" => Ok(automation_write::DispatchFailureKind::Permanent),
        other => Err(Error::from_reason(format!(
            "invalid dispatch failure kind: {other}"
        ))),
    }
}

/// Owned form of `RunIdentity` (borrows would not outlive the JSON parse); `as_borrowed` re-borrows
/// it for the ported call.
struct RunIdentityOwned {
    run_id: String,
    automation_id: String,
    workspace_key: String,
    scheduled_at: Option<i64>,
    trigger: String,
}

impl RunIdentityOwned {
    fn as_borrowed(&self) -> automation_write::RunIdentity<'_> {
        automation_write::RunIdentity {
            run_id: &self.run_id,
            automation_id: &self.automation_id,
            workspace_key: &self.workspace_key,
            scheduled_at: self.scheduled_at,
            trigger: &self.trigger,
        }
    }
}

fn parse_run_identity(json: &str) -> std::result::Result<RunIdentityOwned, Error> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| Error::from_reason(e.to_string()))?;
    let o = v
        .as_object()
        .ok_or_else(|| Error::from_reason("run identity must be an object"))?;
    Ok(RunIdentityOwned {
        run_id: two_str(o, "runId").unwrap_or_default(),
        automation_id: two_str(o, "automationId").unwrap_or_default(),
        workspace_key: two_str(o, "workspaceKey").unwrap_or_default(),
        scheduled_at: o.get("scheduledAt").and_then(serde_json::Value::as_i64),
        trigger: two_str(o, "trigger").unwrap_or_default(),
    })
}

fn parse_model_selection_opt(json: Option<&str>) -> Option<automation::ModelSelection> {
    automation::read_serialized_model_selection(json)
}

/// N-API: `AutomationRepo.setEnabled` (read-write).
#[napi]
pub fn automation_set_enabled_json(
    db_path: String,
    automation_id: String,
    enabled: bool,
    workspace_key: Option<String>,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::set_enabled(
        &conn,
        &automation_id,
        enabled,
        workspace_key.as_deref(),
        now as i64,
    )
    .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.restart` (read-write). `next_run_at` is tri-state: absent→`None` arg
/// meaning "keep computed", but the ported fn treats a passed `None` as "no next run" — so the
/// adapter must always pass an explicit value (TS recomputes nextRunAt before calling). Here a
/// present number is used, `null`/absent becomes `None`.
#[napi]
pub fn automation_restart_json(
    db_path: String,
    automation_id: String,
    next_run_at: Option<f64>,
    workspace_key: Option<String>,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::restart(
        &conn,
        &automation_id,
        next_run_at.map(|v| v as i64),
        workspace_key.as_deref(),
        now as i64,
    )
    .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.claimDue` — atomically claim due automations. Returns claimed rows JSON.
#[napi]
pub fn automation_claim_due_json(db_path: String, now: f64) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let rows = automation_write::claim_due(&conn, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `AutomationRepo.markDispatched` (read-write).
#[napi]
pub fn automation_mark_dispatched_json(
    db_path: String,
    automation_id: String,
    dispatched_at: f64,
    next_run_at: Option<f64>,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::mark_dispatched(
        &conn,
        &automation_id,
        dispatched_at as i64,
        next_run_at.map(|v| v as i64),
    )
    .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.markDispatchFailed` (read-write). `kind` is `transient`/`permanent`.
#[napi]
pub fn automation_mark_dispatch_failed_json(
    db_path: String,
    automation_id: String,
    failed_at: f64,
    error: String,
    kind: String,
    next_run_at: Option<f64>,
) -> Result<()> {
    let k = parse_dispatch_failure_kind(&kind)?;
    let conn = open_readwrite(&db_path)?;
    automation_write::mark_dispatch_failed(
        &conn,
        &automation_id,
        failed_at as i64,
        &error,
        k,
        next_run_at.map(|v| v as i64),
    )
    .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.releaseClaim` (read-write).
#[napi]
pub fn automation_release_claim_json(db_path: String, automation_id: String, now: f64) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::release_claim(&conn, &automation_id, now as i64).map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.releaseManualClaim` (read-write).
#[napi]
pub fn automation_release_manual_claim_json(
    db_path: String,
    automation_id: String,
    workspace_key: String,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::release_manual_claim(&conn, &automation_id, &workspace_key, now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.touchManualClaim` (read-write).
#[napi]
pub fn automation_touch_manual_claim_json(
    db_path: String,
    automation_id: String,
    workspace_key: String,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::touch_manual_claim(&conn, &automation_id, &workspace_key, now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.getScheduledRunCount` (read-only). Returns `null` when the row is absent.
#[napi]
pub fn automation_scheduled_run_count_json(
    db_path: String,
    automation_id: String,
    workspace_key: Option<String>,
) -> Result<Option<i64>> {
    let conn = open_readonly(&db_path)?;
    automation_write::get_scheduled_run_count(&conn, &automation_id, workspace_key.as_deref())
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.hasTaskBinding` (read-only).
#[napi]
pub fn automation_has_task_binding_json(
    db_path: String,
    workspace_key: String,
    target_task_id: String,
) -> Result<bool> {
    let conn = open_readonly(&db_path)?;
    automation_write::has_task_binding(&conn, &workspace_key, &target_task_id)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.getModelSelectionForDispatch` (read-only) as JSON, or `null`.
#[napi]
pub fn automation_model_selection_for_dispatch_json(
    db_path: String,
    automation_id: String,
    workspace_key: String,
) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let sel = automation_write::get_model_selection_for_dispatch(&conn, &automation_id, &workspace_key)
        .map_err(Error::from_reason)?;
    Ok(sel.map(|m| serde_json::to_string(&m).unwrap_or_default()))
}

/// N-API: `AutomationRepo.getBotDeliveryTarget` raw-column read (read-only). Returns the raw
/// `bot_delivery_target` text, or `null` when the row is absent OR the column is SQL NULL (the
/// caller zod-parses and treats invalid/unset as `undefined`, matching the TS exactly).
#[napi]
pub fn automation_get_bot_delivery_target_json(
    db_path: String,
    automation_id: String,
    workspace_key: Option<String>,
) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT bot_delivery_target FROM automations WHERE automation_id = ?1 \
             AND (?2 IS NULL OR workspace_key = ?2)",
        )
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let mut rows = stmt
        .query_map(rusqlite::params![automation_id, workspace_key], |r| {
            r.get::<_, Option<String>>(0)
        })
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(match rows.next() {
        Some(Ok(v)) => v,
        _ => None,
    })
}

/// N-API: raw dispatch-selection read as `{"exists":bool,"column":string|null}` (read-only). The TS
/// `getModelSelectionForDispatch` has THREE distinct outcomes the adapter must reproduce faithfully:
/// throw when the row is missing (`exists=false`), return `undefined` when the column is the literal
/// `"null"` string (follows-workspace), and throw on any other non-parseable value. `column` is the
/// raw `model_selection` text (SQL NULL → `null`). The `get_model_selection_for_dispatch` parse path
/// collapses "follows" and "corrupt", so this raw view is what lets the adapter keep that distinction.
#[napi]
pub fn automation_get_model_selection_column_json(
    db_path: String,
    automation_id: String,
    workspace_key: Option<String>,
) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT model_selection FROM automations WHERE automation_id = ?1 \
             AND (?2 IS NULL OR workspace_key = ?2)",
        )
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let mut rows = stmt
        .query_map(rusqlite::params![automation_id, workspace_key], |r| {
            r.get::<_, Option<String>>(0)
        })
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let obj = match rows.next() {
        Some(Ok(col)) => serde_json::json!({ "exists": true, "column": col }),
        _ => serde_json::json!({ "exists": false, "column": serde_json::Value::Null }),
    };
    serde_json::to_string(&obj).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `AutomationRepo.listRuns` (read-only) as JSON.
#[napi]
pub fn automation_list_runs_json(
    db_path: String,
    automation_id: String,
    workspace_key: Option<String>,
) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let rows =
        automation_write::list_runs(&conn, &automation_id, workspace_key.as_deref())
            .map_err(Error::from_reason)?;
    serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `AutomationRepo.getRun` (read-only) as JSON, or `null`.
#[napi]
pub fn automation_get_run_json(db_path: String, run_id: String) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let row = automation_write::get_run(&conn, &run_id).map_err(Error::from_reason)?;
    Ok(row.map(|r| serde_json::to_string(&r).unwrap_or_default()))
}

/// N-API: `AutomationRepo.deleteRun` (read-write).
#[napi]
pub fn automation_delete_run_json(
    db_path: String,
    run_id: String,
    workspace_key: Option<String>,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::delete_run(&conn, &run_id, workspace_key.as_deref()).map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.pruneRuns` (read-write). Returns the pruned count.
#[napi]
pub fn automation_prune_runs_json(db_path: String, max_age_ms: f64, now: f64) -> Result<i64> {
    let conn = open_readwrite(&db_path)?;
    let n = automation_write::prune_runs(&conn, max_age_ms as i64, now as i64)
        .map_err(Error::from_reason)?;
    Ok(n as i64)
}

/// N-API: `AutomationRepo.ensureRunClaimed` (read-write). `identity_json` = `{runId,automationId,workspaceKey,scheduledAt?,trigger}`.
#[napi]
pub fn automation_ensure_run_claimed_json(
    db_path: String,
    identity_json: String,
    now: f64,
) -> Result<()> {
    let id = parse_run_identity(&identity_json)?;
    let conn = open_readwrite(&db_path)?;
    automation_write::ensure_run_claimed(&conn, &id.as_borrowed(), now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.upsertRunClaimed` (read-write). `selection_json` optional; parsed via the
/// strict zod path (an unparseable object yields `None`, matching `readSerializedModelSelection`).
#[napi]
pub fn automation_upsert_run_claimed_json(
    db_path: String,
    identity_json: String,
    selection_json: Option<String>,
    now: f64,
) -> Result<()> {
    let id = parse_run_identity(&identity_json)?;
    let sel = parse_model_selection_opt(selection_json.as_deref());
    let conn = open_readwrite(&db_path)?;
    automation_write::upsert_run_claimed(&conn, &id.as_borrowed(), sel.as_ref(), now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.fixRunModelSelection` (read-write). Returns the persisted selection JSON.
#[napi]
pub fn automation_fix_run_model_selection_json(
    db_path: String,
    run_id: String,
    selection_json: String,
    now: f64,
) -> Result<String> {
    let sel = automation::read_serialized_model_selection(Some(&selection_json))
        .ok_or_else(|| Error::from_reason("invalid model selection"))?;
    let conn = open_readwrite(&db_path)?;
    let result =
        automation_write::fix_run_model_selection(&conn, &run_id, &sel, now as i64)
            .map_err(Error::from_reason)?;
    serde_json::to_string(&result).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `AutomationRepo.markRunDispatch` (read-write).
#[napi]
pub fn automation_mark_run_dispatch_json(
    db_path: String,
    run_id: String,
    dispatch_status: String,
    session_id: Option<String>,
    error: Option<String>,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::mark_run_dispatch(
        &conn,
        &run_id,
        &dispatch_status,
        session_id.as_deref(),
        error.as_deref(),
        now as i64,
    )
    .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.markRunOutcome` (read-write).
#[napi]
pub fn automation_mark_run_outcome_json(
    db_path: String,
    run_id: String,
    outcome: String,
    error: Option<String>,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    automation_write::mark_run_outcome(&conn, &run_id, &outcome, error.as_deref(), now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.recordSkippedRun` (read-write).
#[napi]
pub fn automation_record_skipped_run_json(
    db_path: String,
    identity_json: String,
    reason: String,
    now: f64,
) -> Result<()> {
    let id = parse_run_identity(&identity_json)?;
    let conn = open_readwrite(&db_path)?;
    automation_write::record_skipped_run(&conn, &id.as_borrowed(), &reason, now as i64)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.claimManualRuns` (read-write) as JSON `[{automation,run}, ...]`.
#[napi]
pub fn automation_claim_manual_runs_json(db_path: String, now: f64) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let rows = automation_write::claim_manual_runs(&conn, now as i64).map_err(Error::from_reason)?;
    let json: Vec<serde_json::Value> = rows
        .iter()
        .map(|m| serde_json::json!({ "automation": m.automation, "run": m.run }))
        .collect();
    serde_json::to_string(&json).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `AutomationRepo.markManualRunDispatched` (read-write). Returns whether a row matched.
#[napi]
pub fn automation_mark_manual_run_dispatched_json(
    db_path: String,
    run_id: String,
    session_id: Option<String>,
    dispatched_at: f64,
) -> Result<bool> {
    let conn = open_readwrite(&db_path)?;
    automation_write::mark_manual_run_dispatched(&conn, &run_id, session_id.as_deref(), dispatched_at as i64)
        .map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.skipAndReschedule` (read-write). `params_json` mirrors
/// `SkipAndRescheduleParams` (`finalize` marks a pure one-shot terminal).
#[napi]
pub fn automation_skip_and_reschedule_json(
    db_path: String,
    params_json: String,
    now: f64,
) -> Result<()> {
    let v: serde_json::Value =
        serde_json::from_str(&params_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let o = v
        .as_object()
        .ok_or_else(|| Error::from_reason("params must be an object"))?;
    let p = automation_write::SkipAndRescheduleParams {
        automation_id: two_str(o, "automationId").unwrap_or_default(),
        run_id: two_str(o, "runId").unwrap_or_default(),
        workspace_key: two_str(o, "workspaceKey").unwrap_or_default(),
        scheduled_at: o.get("scheduledAt").and_then(serde_json::Value::as_i64),
        reason: two_str(o, "reason").unwrap_or_default(),
        next_run_at: o.get("nextRunAt").and_then(serde_json::Value::as_i64),
        finalize: opt_bool(o, "finalize").unwrap_or(false),
    };
    let conn = open_readwrite(&db_path)?;
    automation_write::skip_and_reschedule(&conn, &p, now as i64).map_err(Error::from_reason)
}

/// N-API: `AutomationRepo.runNow` (read-write) as JSON `{automation,run}` or `null`. The run id's
/// random uuid suffix is generated in Rust (mirrors TS `crypto.randomUUID()`); the differential
/// harness normalizes it.
#[napi]
pub fn automation_run_now_json(
    db_path: String,
    automation_id: String,
    workspace_key: Option<String>,
    now: f64,
) -> Result<Option<String>> {
    let conn = open_readwrite(&db_path)?;
    let claimed =
        automation_write::run_now(&conn, &automation_id, workspace_key.as_deref(), now as i64)
            .map_err(Error::from_reason)?;
    Ok(claimed.map(|m| {
        serde_json::to_string(&serde_json::json!({ "automation": m.automation, "run": m.run }))
            .unwrap_or_default()
    }))
}

// ---- TaskGroup write + grouped-view ordering N-API ----
//
// Grouping inputs (`GroupedTaskRef`, `GroupedTaskViewOrderInput`) derive `Deserialize` with the
// same camelCase shape the TS emits, so they parse straight from JSON. All stamp an injected `now`.

/// N-API: `TaskIndexRepo.createTaskGroup` (read-write). Returns the created `TaskGroup` JSON.
#[napi]
pub fn grouping_create_task_group_json(
    db_path: String,
    title: Option<String>,
    color: Option<String>,
    now: f64,
) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let group = grouping::create_task_group(
        &conn,
        title.as_deref(),
        color.as_deref(),
        now as i64,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&group).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.renameTaskGroup` (read-write). Returns the re-read `TaskGroup` JSON.
#[napi]
pub fn grouping_rename_task_group_json(
    db_path: String,
    group_id: String,
    title: String,
    now: f64,
) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let group =
        grouping::rename_task_group(&conn, &group_id, &title, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&group).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.updateTaskGroupColor` (read-write). Returns the re-read `TaskGroup` JSON.
#[napi]
pub fn grouping_update_task_group_color_json(
    db_path: String,
    group_id: String,
    color: String,
    now: f64,
) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let group = grouping::update_task_group_color(&conn, &group_id, &color, now as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&group).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.deleteTaskGroup` (read-write).
#[napi]
pub fn grouping_delete_task_group_json(db_path: String, group_id: String) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    grouping::delete_task_group(&conn, &group_id).map_err(Error::from_reason)
}

/// N-API: `TaskIndexRepo.upsertGroupedTopOrder` (read-write) — insert/update one mixed-list node slot.
#[napi]
pub fn grouping_upsert_top_order_json(
    db_path: String,
    node_type: String,
    node_key: String,
    sort_order: f64,
    now: f64,
) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    grouping::upsert_grouped_top_order(
        &conn,
        &node_type,
        &node_key,
        sort_order as i64,
        now as i64,
    )
    .map_err(Error::from_reason)
}

/// N-API: `TaskIndexRepo.initializeGroupedTaskAtTop` (read-write). `task_json` = `GroupedTaskRef`.
/// Returns whether a new order row was created (false when one already exists / task ineligible).
#[napi]
pub fn grouping_initialize_at_top_json(db_path: String, task_json: String, now: f64) -> Result<bool> {
    let task: grouping::GroupedTaskRef =
        serde_json::from_str(&task_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readwrite(&db_path)?;
    grouping::initialize_grouped_task_at_top(&conn, &task, now as i64).map_err(Error::from_reason)
}

/// N-API: `TaskIndexRepo.applyGroupedTaskViewOrder` (read-write). `input_json` = the full order input.
#[napi]
pub fn grouping_apply_view_order_json(db_path: String, input_json: String, now: f64) -> Result<()> {
    let input: grouping::GroupedTaskViewOrderInput =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readwrite(&db_path)?;
    grouping::apply_grouped_task_view_order(&conn, &input, now as i64).map_err(Error::from_reason)
}

/// N-API: `TaskIndexRepo.queryGroupedTaskViewStructure` (read-only). `scopes_json` = the array of
/// `{workspacePath, workspaceIdentity?}` scopes controlling bootstrapped-group visibility. Returns
/// the `{groups, members, topLevelOrders}` structure JSON.
#[napi]
pub fn grouping_query_view_structure_json(db_path: String, scopes_json: String) -> Result<String> {
    let scopes: Vec<WorkspaceScope> =
        serde_json::from_str(&scopes_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readonly(&db_path)?;
    let structure = grouping::query_grouped_task_view_structure(&conn, &scopes)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&structure).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.queryGroupedTaskView` (READ-WRITE — it runs the one-shot workspace-group
/// bootstrap and the two lazy order normalizations, matching the TS). `scopes_json` = scope array;
/// `include_all` = across all workspaces; `provider` optional runtime filter; `now` injected clock.
/// Returns `{ nodes: [...] }` JSON.
#[napi]
pub fn grouping_query_view_json(
    db_path: String,
    scopes_json: String,
    include_all: bool,
    provider: Option<String>,
    now: f64,
) -> Result<String> {
    let scopes: Vec<WorkspaceScope> =
        serde_json::from_str(&scopes_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = open_readwrite(&db_path)?;
    let view = grouped_view::query_grouped_task_view(
        &conn,
        &scopes,
        include_all,
        provider.as_deref(),
        now as i64,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&view).map_err(|e| Error::from_reason(e.to_string()))
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

/// N-API: `TaskIndexRepo.applyAgentPatch` (read-write). `patch_json` is an object with the
/// agent-owned subset (`title`/`status`/`updatedAt` via `??`, `lastError`/`target` via `"x" in`).
/// Returns the persisted meta JSON, or `null` when the row is missing/deleted.
#[napi]
pub fn apply_agent_patch_json(
    db_path: String,
    workspace_key: String,
    task_id: String,
    patch_json: String,
) -> Result<Option<String>> {
    let value: serde_json::Value =
        serde_json::from_str(&patch_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let obj = value
        .as_object()
        .ok_or_else(|| Error::from_reason("patch must be a JSON object"))?;
    let in_field = |k: &str| -> PatchField<Option<serde_json::Value>> {
        match obj.get(k) {
            None => PatchField::Unset,
            Some(v) if v.is_null() => PatchField::Set(None),
            Some(v) => PatchField::Set(Some(v.clone())),
        }
    };
    let patch = AgentPatch {
        title: obj.get("title").and_then(serde_json::Value::as_str).map(str::to_string),
        status: obj.get("status").and_then(serde_json::Value::as_str).map(str::to_string),
        updated_at: obj.get("updatedAt").and_then(serde_json::Value::as_i64),
        last_error: in_field("lastError"),
        target: in_field("target"),
    };
    let conn = open_readwrite(&db_path)?;
    let meta = apply_agent_patch(&conn, &workspace_key, &task_id, &patch)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(meta.map(|m| serde_json::to_string(&m).unwrap_or_default()))
}

/// N-API: `TaskIndexRepo.deleteArchivedTask` (read-write). Returns the tombstoned meta JSON, or
/// `null` when the row is missing / already deleted / not archived.
#[napi]
pub fn delete_archived_task_json(
    db_path: String,
    workspace_key: String,
    task_id: String,
) -> Result<Option<String>> {
    let conn = open_readwrite(&db_path)?;
    let meta = delete_archived_task(&conn, &workspace_key, &task_id)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(meta.map(|m| serde_json::to_string(&m).unwrap_or_default()))
}

/// N-API: `TaskIndexRepo.hasGroupedWorkspaceBootstrapRun` (read-only).
#[napi]
pub fn has_grouped_workspace_bootstrap_run_json(db_path: String) -> Result<bool> {
    let conn = open_readonly(&db_path)?;
    has_grouped_workspace_bootstrap_run(&conn).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.listDeletedTaskIds` (read-only) as a JSON string array.
#[napi]
pub fn list_deleted_task_ids_json(
    db_path: String,
    workspace_key: String,
    provider: Option<String>,
) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let ids = list_deleted_task_ids(&conn, &workspace_key, provider.as_deref())
        .map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&ids).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.listSessionsByAutomation` (read-only) as a JSON array of metas.
#[napi]
pub fn list_sessions_by_automation_json(db_path: String, automation_id: String) -> Result<String> {
    let conn = open_readonly(&db_path)?;
    let metas = list_sessions_by_automation(&conn, &automation_id)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&metas).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `TaskIndexRepo.archiveStaleTasks` (read-write) as a JSON array of archived metas.
/// `cutoff` is injected (`Date.now() - olderThanDays`).
#[napi]
pub fn archive_stale_tasks_json(
    db_path: String,
    workspace_key: String,
    cutoff: f64,
    provider: Option<String>,
) -> Result<String> {
    let conn = open_readwrite(&db_path)?;
    let metas =
        archive_stale_tasks(&conn, &workspace_key, cutoff as i64, provider.as_deref())
            .map_err(|e| Error::from_reason(e.to_string()))?;
    serde_json::to_string(&metas).map_err(|e| Error::from_reason(e.to_string()))
}

/// Port of the idempotent startup data-repairs the TS repos run in `initialize()` after migrations —
/// the self-heal writes a faithful `node:sqlite`-free cutover must preserve:
///   (a) `tasks.off_peak_task_id` back-fill from a bound off-peak session row,
///   (b) off-peak system-group membership back-fill (remote primary keys skipped, like the TS, so a
///       historical remote row is never re-projected onto a same-path local workspace),
///   (c) deleted-task grouping-reference cleanup (one `BEGIN IMMEDIATE`),
///   (d) the legacy `awaiting_approval` → `running` status repair.
/// Each is guarded / `INSERT OR IGNORE` so re-running every startup is a no-op once converged.
/// `now` is injected for the membership + status timestamps.
pub fn run_startup_repairs(
    conn: &Connection,
    now: i64,
) -> std::result::Result<(), rusqlite::Error> {
    let has_off_peak = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks' LIMIT 1",
            [],
            |_| Ok::<i64, rusqlite::Error>(1),
        )
        .is_ok();

    if has_off_peak {
        conn.execute(
            "UPDATE tasks SET off_peak_task_id = (SELECT o.off_peak_task_id FROM off_peak_tasks o \
             WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key) \
             WHERE off_peak_task_id IS NULL AND EXISTS (SELECT 1 FROM off_peak_tasks o \
             WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key)",
            [],
        )?;
        conn.execute(
            "UPDATE off_peak_tasks SET status = 'running', updated_at = ?1 WHERE status = 'awaiting_approval'",
            rusqlite::params![now],
        )?;
    }

    let members: Vec<(String, String, Option<String>, String)> = {
        let mut stmt = conn.prepare(
            "SELECT workspace_key, workspace_path, workspace_identity, task_id FROM tasks \
             WHERE off_peak_task_id IS NOT NULL AND deleted = 0",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (wk, wp, wident, tid) in &members {
        // Remote primary keys never get an off-peak group (matches the TS guard).
        if is_remote_workspace_identity(wk) {
            continue;
        }
        let task = TaskRef {
            workspace_key: wk,
            workspace_path: wp,
            workspace_identity: wident.as_deref(),
            task_id: tid,
        };
        ensure_off_peak_group_membership(conn, &task, now)?;
    }

    let deleted: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT workspace_key, task_id FROM tasks WHERE deleted = 1")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    if !deleted.is_empty() {
        conn.execute("BEGIN IMMEDIATE", [])?;
        let run = (|| -> std::result::Result<(), rusqlite::Error> {
            for (wk, tid) in &deleted {
                delete_task_grouping_references(conn, wk, tid)?;
            }
            Ok(())
        })();
        match run {
            Ok(()) => {
                conn.execute("COMMIT", [])?;
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                return Err(e);
            }
        }
    }
    Ok(())
}

/// N-API: run the idempotent startup data-repairs (see [`run_startup_repairs`]) against a
/// read-write DB. The host calls this once at startup after `bootstrapTasksIndex`.
#[napi]
pub fn run_startup_repairs_json(db_path: String, now: f64) -> Result<()> {
    let conn = open_readwrite(&db_path)?;
    run_startup_repairs(&conn, now as i64).map_err(|e| Error::from_reason(e.to_string()))
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
               unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
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
            pinned: 0,
            archived: 0,
            deleted: 0,
            last_unread_at: 0,
            searchable_text: String::new(),
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
    fn task_meta_deserializes_without_optional_title_overridden() {
        // A caller-supplied input meta may omit the optional `titleOverridden` (zod `.optional()`).
        let m: TaskMeta =
            serde_json::from_str(r#"{"taskId":"t","traceId":"tr","title":"x","workspacePath":"/p","createdAt":1,"updatedAt":2,"mode":"build"}"#)
                .expect("titleOverridden is optional on input");
        assert!(!m.title_overridden);
    }

    #[test]
    fn valid_meta_preserves_explicit_null_target_but_rejects_null_last_error() {
        // `target` is nullable → an explicit null survives (TS keeps `target: null`).
        let m = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":5,"updatedAt":6,"mode":"build","target":null}"#,
        ));
        assert_eq!(m.created_at, 5, "valid path (target null is allowed)");
        assert_eq!(m.target, Some(serde_json::Value::Null));
        // `lastError` is optional-but-not-nullable → an explicit null rejects the whole meta.
        let f = row_to_meta(&row(
            r#"{"taskId":"t1","traceId":"z1","title":"hey","workspacePath":"/p","createdAt":5,"updatedAt":6,"mode":"build","lastError":null}"#,
        ));
        assert_eq!(
            f.created_at, 1,
            "null lastError → invalid → column fallback"
        );
        assert_eq!(f.title, "col-title");
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

    fn full_schema_db() -> Connection {
        // The live `tasks` shape after base schema-v1 + the ALTER migrations (cron/off_peak/
        // searchable_text added). Column set matches write_record's INSERT exactly.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
               task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT,
               provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, cron_automation_id TEXT,
               off_peak_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
               searchable_text TEXT NOT NULL DEFAULT '', meta_json TEXT NOT NULL DEFAULT '{}',
               PRIMARY KEY (workspace_key, task_id));
             CREATE TABLE task_group_members (
               group_id TEXT NOT NULL, workspace_key TEXT NOT NULL, workspace_path TEXT,
               workspace_identity TEXT, task_id TEXT NOT NULL, sort_order INTEGER,
               added_at INTEGER, created_at INTEGER, updated_at INTEGER,
               PRIMARY KEY (group_id, workspace_key, task_id));
             CREATE TABLE task_groups (
               group_id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT,
               created_at INTEGER, updated_at INTEGER);
             CREATE TABLE task_group_view_node_orders (
               node_type TEXT NOT NULL, node_key TEXT NOT NULL, sort_order INTEGER,
               created_at INTEGER, updated_at INTEGER,
               PRIMARY KEY (node_type, node_key));",
        )
        .unwrap();
        conn
    }

    fn wr(task_id: &str) -> WriteRecord {
        WriteRecord {
            workspace_key: "/ws".into(),
            workspace_path: "/ws".into(),
            workspace_identity: None,
            task_id: task_id.into(),
            title: "t".into(),
            task_status: Some("completed".into()),
            provider: None,
            mode: "build".into(),
            model: None,
            migration_source: None,
            forked_from_task_id: None,
            cron_automation_id: None,
            off_peak_task_id: None,
            created_at: 1,
            updated_at: 2,
            unread_at: None,
            write_unread_at: true,
            pinned: false,
            archived: false,
            deleted: false,
            title_overridden: false,
            searchable_text: Some("hello".into()),
            meta_json: format!(
                r#"{{"taskId":"{task_id}","traceId":"z-{task_id}","title":"t","workspacePath":"/ws","createdAt":1,"updatedAt":2,"mode":"build"}}"#
            ),
        }
    }

    fn col_i64(conn: &Connection, task_id: &str, column: &str) -> Option<i64> {
        conn.query_row(
            &format!("SELECT {column} FROM tasks WHERE workspace_key='/ws' AND task_id=?1"),
            [task_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .unwrap()
    }

    #[test]
    fn write_record_insert_then_preserves_unread_when_not_flagged() {
        let conn = full_schema_db();
        write_record(&conn, &wr("a")).unwrap();
        assert_eq!(
            col_i64(&conn, "a", "unread_at"),
            None,
            "first insert stores NULL unread_at"
        );

        // A follow-up write that does NOT flag unread must leave the existing value untouched.
        let mut r = wr("a");
        r.write_unread_at = false;
        r.unread_at = Some(99);
        r.searchable_text = Some("world".into());
        write_record(&conn, &r).unwrap();
        assert_eq!(
            col_i64(&conn, "a", "unread_at"),
            None,
            "unread_at preserved (CASE ELSE branch)"
        );

        // Flagging it now writes the new value.
        let mut r2 = wr("a");
        r2.unread_at = Some(7);
        write_record(&conn, &r2).unwrap();
        assert_eq!(
            col_i64(&conn, "a", "unread_at"),
            Some(7),
            "write_unread_at=1 updates value"
        );
    }

    #[test]
    fn write_record_advances_last_unread_at_via_max() {
        let conn = full_schema_db();
        let mut r = wr("b");
        r.unread_at = Some(3);
        write_record(&conn, &r).unwrap();
        assert_eq!(col_i64(&conn, "b", "last_unread_at"), Some(3));

        // New unread (2) is smaller than current unread_at (3): MAX keeps 3, unread_at becomes 2.
        let mut r2 = wr("b");
        r2.unread_at = Some(2);
        write_record(&conn, &r2).unwrap();
        assert_eq!(
            col_i64(&conn, "b", "last_unread_at"),
            Some(3),
            "MAX monotonic"
        );
        assert_eq!(col_i64(&conn, "b", "unread_at"), Some(2));
    }

    #[test]
    fn write_record_keeps_existing_searchable_text_when_none() {
        let conn = full_schema_db();
        let mut r = wr("c");
        r.searchable_text = Some("seed".into());
        write_record(&conn, &r).unwrap();
        // None => preserve the indexed body (the exact corruption the TS comment warns about).
        let mut r2 = wr("c");
        r2.searchable_text = None;
        write_record(&conn, &r2).unwrap();
        let text: String = conn
            .query_row(
                "SELECT searchable_text FROM tasks WHERE workspace_key='/ws' AND task_id='c'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(text, "seed");
    }

    #[test]
    fn truncate_utf16_counts_surrogate_pairs_as_two() {
        // "😀" is 1 Rust char, 4 bytes, but 2 UTF-16 code units (a surrogate pair) — JS slices on 2.
        assert_eq!(truncate_utf16("😀", 1), "");
        assert_eq!(truncate_utf16("😀", 2), "😀");
        assert_eq!(truncate_utf16("a😀b", 3), "a😀");
        assert_eq!(truncate_utf16("abc", 2), "ab");
    }

    #[test]
    fn write_record_returns_persisted_projection() {
        let conn = full_schema_db();
        let meta = write_record(&conn, &wr("d")).unwrap();
        assert_eq!(meta.task_id, "d");
        assert_eq!(
            meta.trace_id, "z-d",
            "valid meta_json projects meta traceId"
        );
        assert_eq!(meta.workspace_path, "/ws");
    }

    fn tm(updated_at: i64, status: Option<&str>) -> TaskMeta {
        TaskMeta {
            task_id: "t1".into(),
            trace_id: "z-t1".into(),
            title: "incoming".into(),
            title_overridden: false,
            workspace_path: "/ws".into(),
            created_at: 1,
            updated_at,
            mode: "build".into(),
            status: status.map(|s| s.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn merge_keeps_updated_at_monotonic() {
        let existing = tm(500, Some("running"));
        let incoming = tm(300, Some("running")); // older snapshot arrives late
        let d = merge_sync_task_meta(
            &incoming,
            Some(&existing),
            ExistingRowFlags::default(),
            &SyncParams::default(),
        );
        assert_eq!(
            d.meta.updated_at, 500,
            "updatedAt never regresses below the stored value"
        );
    }

    #[test]
    fn merge_preserves_newer_terminal_status_over_incoming_running() {
        // existing completed at 500, incoming running at 300 (stale snapshot) → keep completed.
        let mut existing = tm(500, Some("completed"));
        existing.last_error = None;
        let incoming = tm(300, Some("running"));
        let d = merge_sync_task_meta(
            &incoming,
            Some(&existing),
            ExistingRowFlags::default(),
            &SyncParams::default(),
        );
        assert_eq!(
            d.meta.status.as_deref(),
            Some("completed"),
            "terminal status not downgraded"
        );
    }

    #[test]
    fn merge_does_not_preserve_when_incoming_is_non_running() {
        // existing completed@500 but incoming completed@600 (newer, non-running) → take incoming.
        let existing = tm(500, Some("completed"));
        let incoming = tm(600, Some("error"));
        let d = merge_sync_task_meta(
            &incoming,
            Some(&existing),
            ExistingRowFlags::default(),
            &SyncParams::default(),
        );
        assert_eq!(d.meta.status.as_deref(), Some("error"));
        assert_eq!(d.meta.updated_at, 600);
    }

    #[test]
    fn merge_keeps_user_overridden_title() {
        let mut existing = tm(500, Some("running"));
        existing.title = "user rename".into();
        let incoming = tm(600, Some("running"));
        let flags = ExistingRowFlags {
            title_overridden: true,
            ..Default::default()
        };
        let d = merge_sync_task_meta(&incoming, Some(&existing), flags, &SyncParams::default());
        assert!(d.title_overridden);
        assert_eq!(
            d.meta.title, "user rename",
            "app-side rename survives background refresh"
        );
    }

    #[test]
    fn merge_preserves_identity_fields_from_existing() {
        let mut existing = tm(500, Some("completed"));
        existing.cron_automation_id = Some("cron-1".into());
        existing.migration_source = Some("claudeCode".into());
        let incoming = tm(600, Some("completed")); // snapshot carries no cron/migration
        let d = merge_sync_task_meta(
            &incoming,
            Some(&existing),
            ExistingRowFlags::default(),
            &SyncParams::default(),
        );
        assert_eq!(d.meta.cron_automation_id.as_deref(), Some("cron-1"));
        assert_eq!(d.meta.migration_source.as_deref(), Some("claudeCode"));
        assert!(!d.newly_cron, "cron already existed → no re-add trigger");
    }

    #[test]
    fn merge_triggers_first_cron_membership() {
        let existing = tm(500, Some("completed")); // no cron
        let mut incoming = tm(600, Some("completed"));
        incoming.cron_automation_id = Some("cron-new".into());
        let d = merge_sync_task_meta(
            &incoming,
            Some(&existing),
            ExistingRowFlags::default(),
            &SyncParams::default(),
        );
        assert!(
            d.newly_cron,
            "first time a cron id appears → group membership"
        );
    }

    #[test]
    fn merge_target_present_beats_existing_but_absent_defers() {
        let mut existing = tm(500, Some("completed"));
        existing.target = Some(serde_json::json!({"goal": "old"}));

        // Incoming has NO own `target` key → keep existing target.
        let absent = tm(600, Some("completed"));
        let d1 = merge_sync_task_meta(
            &absent,
            Some(&existing),
            ExistingRowFlags::default(),
            &SyncParams::default(),
        );
        assert_eq!(
            d1.meta.target, existing.target,
            "absent target defers to existing"
        );

        // Incoming has target: null (present) → wins (becomes null), NOT existing.
        let mut present_null = tm(600, Some("completed"));
        present_null.target = Some(serde_json::Value::Null);
        let p = SyncParams {
            incoming_target_present: true,
            ..Default::default()
        };
        let d2 = merge_sync_task_meta(
            &present_null,
            Some(&existing),
            ExistingRowFlags::default(),
            &p,
        );
        assert_eq!(
            d2.meta.target,
            Some(serde_json::Value::Null),
            "present null target clears it"
        );
    }

    #[test]
    fn should_preserve_helper_truthiness_of_empty_status() {
        let existing = tm(500, Some("error"));
        // empty-string incoming status is falsy in JS → does not block preservation; existing newer.
        let incoming = tm(300, Some(""));
        assert!(should_preserve_newer_terminal_status(
            Some(&existing),
            &incoming
        ));
        // non-running non-empty incoming status blocks it.
        let incoming2 = tm(300, Some("completed"));
        assert!(!should_preserve_newer_terminal_status(
            Some(&existing),
            &incoming2
        ));
    }

    #[test]
    fn sync_task_meta_stale_snapshot_does_not_regress_terminal_status() {
        let conn = full_schema_db();
        // Seed a completed task at updatedAt 500.
        let first = tm(500, Some("completed"));
        sync_task_meta(&conn, "/ws", &first, &SyncParams::default(), None).unwrap();

        // A late, older running snapshot (300) must NOT downgrade the stored completed status
        // nor rewind updatedAt — the exact phone-replay bug the TS guard prevents.
        let stale = tm(300, Some("running"));
        let (persisted, decision) =
            sync_task_meta(&conn, "/ws", &stale, &SyncParams::default(), None).unwrap();
        assert_eq!(
            persisted.status.as_deref(),
            Some("completed"),
            "terminal kept"
        );
        assert_eq!(persisted.updated_at, 500, "monotonic updatedAt");
        assert!(!decision.newly_cron && !decision.newly_off_peak);
    }

    #[test]
    fn sync_task_meta_preserves_user_overridden_title_across_refresh() {
        let conn = full_schema_db();
        let mut rename = tm(100, Some("running"));
        rename.title = "user title".into();
        let p = SyncParams {
            title_overridden: Some(true),
            ..Default::default()
        };
        sync_task_meta(&conn, "/ws", &rename, &p, None).unwrap();

        // A later agent snapshot with a fresh auto title and NO titleOverridden param must not
        // clobber the user's title (existing row flag drives the keep).
        let mut agent = tm(200, Some("running"));
        agent.title = "auto title".into();
        let (persisted, _) =
            sync_task_meta(&conn, "/ws", &agent, &SyncParams::default(), None).unwrap();
        assert_eq!(persisted.title, "user title");
        assert!(persisted.title_overridden);
    }

    #[test]
    fn sync_task_meta_first_cron_triggers_membership_once() {
        let conn = full_schema_db();
        let mut with_cron = tm(100, Some("completed"));
        with_cron.cron_automation_id = Some("cron-1".into());
        let (_, d1) =
            sync_task_meta(&conn, "/ws", &with_cron, &SyncParams::default(), None).unwrap();
        assert!(
            d1.newly_cron,
            "first cron id appearance → group membership trigger"
        );

        // Re-sync (snapshot without cron, but existing has it) → preserved, not "new".
        let again = tm(200, Some("completed"));
        let (persisted, d2) =
            sync_task_meta(&conn, "/ws", &again, &SyncParams::default(), None).unwrap();
        assert_eq!(persisted.cron_automation_id.as_deref(), Some("cron-1"));
        assert!(!d2.newly_cron, "already grouped → no re-trigger");
    }

    #[test]
    fn seed_writes_only_when_missing_and_never_overwrites_existing() {
        let conn = full_schema_db();
        let mut a = tm(100, Some("running"));
        a.title = "A".into();
        let persisted = seed_task_meta_if_missing(&conn, "/ws", &a).unwrap();
        assert_eq!(persisted.title, "A", "first seed inserts");

        // A second seed with a different title must return the EXISTING row unchanged.
        let mut b = tm(999, Some("completed"));
        b.title = "B".into();
        let again = seed_task_meta_if_missing(&conn, "/ws", &b).unwrap();
        assert_eq!(again.title, "A", "existing row is not clobbered by a seed");
    }

    #[test]
    fn clear_unread_preserves_last_unread_at_and_guards_stale_click() {
        let conn = full_schema_db();
        let mut meta = tm(100, Some("running"));
        meta.unread_at = Some(5);
        let rec = record_from_meta(
            "/ws",
            &meta,
            RowFlags {
                write_unread_at: true,
                ..Default::default()
            },
            Some("x".into()),
        );
        write_record(&conn, &rec).unwrap();
        assert_eq!(col_i64(&conn, "t1", "unread_at"), Some(5));

        let (persisted, cleared) = clear_task_unread_if_matches(&conn, "/ws", "t1", 5).unwrap();
        assert!(cleared);
        assert_eq!(persisted.unread_at, None, "unread cleared");
        assert_eq!(col_i64(&conn, "t1", "unread_at"), None);
        assert_eq!(
            col_i64(&conn, "t1", "last_unread_at"),
            Some(5),
            "MAX keeps the just-cleared unread as last_unread"
        );

        // A stale repeat click (expected no longer matches) must not report cleared.
        let (_, cleared2) = clear_task_unread_if_matches(&conn, "/ws", "t1", 5).unwrap();
        assert!(
            !cleared2,
            "already-cleared row: expected mismatch → not cleared"
        );
    }

    #[test]
    fn clear_unread_errors_on_missing_or_deleted() {
        let conn = full_schema_db();
        assert!(
            clear_task_unread_if_matches(&conn, "/ws", "ghost", 1).is_err(),
            "missing row throws"
        );

        let mut meta = tm(100, Some("running"));
        meta.unread_at = Some(7);
        let mut rec = record_from_meta(
            "/ws",
            &meta,
            RowFlags {
                write_unread_at: true,
                ..Default::default()
            },
            None,
        );
        rec.deleted = true;
        write_record(&conn, &rec).unwrap();
        assert!(
            clear_task_unread_if_matches(&conn, "/ws", "t1", 7).is_err(),
            "deleted row throws"
        );
    }

    #[test]
    fn update_state_allocates_strictly_increasing_unread_marker() {
        let conn = full_schema_db();
        let mut seed = tm(100, Some("running"));
        seed.unread_at = Some(5);
        let rec = record_from_meta(
            "/ws",
            &seed,
            RowFlags {
                write_unread_at: true,
                ..Default::default()
            },
            None,
        );
        write_record(&conn, &rec).unwrap();

        // A requested mark SMALLER than the watermark still moves strictly forward (watermark+1).
        let p = StatePatch {
            unread_at: PatchField::Set(UnreadOp::Allocate(3)),
            ..Default::default()
        };
        let m = update_task_state(&conn, "/ws", "t1", &p).unwrap();
        assert_eq!(
            m.unread_at,
            Some(6),
            "unread marker forced above watermark 5"
        );

        // A large requested mark wins; monotonic never regresses.
        let p2 = StatePatch {
            unread_at: PatchField::Set(UnreadOp::Allocate(100)),
            ..Default::default()
        };
        let m2 = update_task_state(&conn, "/ws", "t1", &p2).unwrap();
        assert_eq!(m2.unread_at, Some(100));
    }

    #[test]
    fn update_state_clear_unread_keeps_watermark_then_re_allocates_above_it() {
        let conn = full_schema_db();
        let mut seed = tm(100, Some("running"));
        seed.unread_at = Some(9);
        let rec = record_from_meta(
            "/ws",
            &seed,
            RowFlags {
                write_unread_at: true,
                ..Default::default()
            },
            None,
        );
        write_record(&conn, &rec).unwrap();
        // Clear (key present, value undefined).
        let clear = StatePatch {
            unread_at: PatchField::Set(UnreadOp::Clear),
            ..Default::default()
        };
        let after_clear = update_task_state(&conn, "/ws", "t1", &clear).unwrap();
        assert_eq!(after_clear.unread_at, None);
        assert_eq!(
            col_i64(&conn, "t1", "last_unread_at"),
            Some(9),
            "watermark persists"
        );

        // Re-mark read again: must exceed the persisted watermark (not reuse a cleared value).
        let re = StatePatch {
            unread_at: PatchField::Set(UnreadOp::Allocate(1)),
            ..Default::default()
        };
        let after_re = update_task_state(&conn, "/ws", "t1", &re).unwrap();
        assert_eq!(
            after_re.unread_at,
            Some(10),
            "strictly above cleared watermark 9"
        );
    }

    #[test]
    fn update_state_applies_field_patches() {
        let conn = full_schema_db();
        write_record(
            &conn,
            &record_from_meta("/ws", &tm(100, Some("running")), RowFlags::default(), None),
        )
        .unwrap();
        let p = StatePatch {
            title: Some("renamed".into()),
            status: Some("error".into()),
            last_error: PatchField::Set(Some(serde_json::json!({"message": "boom"}))),
            ..Default::default()
        };
        let m = update_task_state(&conn, "/ws", "t1", &p).unwrap();
        assert_eq!(m.title, "renamed");
        assert_eq!(m.status.as_deref(), Some("error"));
        assert!(
            m.last_error.is_some(),
            "lastError present in patch is applied"
        );
    }

    #[test]
    fn update_state_delete_tombstones_and_removes_grouping() {
        let conn = full_schema_db();
        write_record(
            &conn,
            &record_from_meta(
                "/ws",
                &tm(100, Some("completed")),
                RowFlags::default(),
                None,
            ),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_group_members (group_id, workspace_key, task_id) VALUES ('g1','/ws','t1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order) VALUES ('task','[\"/ws\",\"t1\"]',50)",
            [],
        )
        .unwrap();

        let p = StatePatch {
            deleted: Some(true),
            ..Default::default()
        };
        update_task_state(&conn, "/ws", "t1", &p).unwrap();

        let row = get_task_index_row(&conn, "/ws", "t1").unwrap().unwrap();
        assert_eq!(row.deleted, 1, "tombstoned");
        let members: i64 = conn
            .query_row("SELECT count(*) FROM task_group_members", [], |r| r.get(0))
            .unwrap();
        let orders: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_group_view_node_orders",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 0, "group membership removed");
        assert_eq!(orders, 0, "task node ordering removed");
    }

    #[test]
    fn update_state_errors_on_missing_or_already_deleted() {
        let conn = full_schema_db();
        let p = StatePatch {
            title: Some("x".into()),
            ..Default::default()
        };
        assert!(
            update_task_state(&conn, "/ws", "ghost", &p).is_err(),
            "missing row throws"
        );

        write_record(
            &conn,
            &record_from_meta(
                "/ws",
                &tm(100, Some("completed")),
                RowFlags {
                    deleted: true,
                    ..Default::default()
                },
                None,
            ),
        )
        .unwrap();
        assert!(
            update_task_state(&conn, "/ws", "t1", &p).is_err(),
            "already-deleted row throws"
        );
    }

    #[test]
    fn next_grouped_top_sort_order_walks_above_minimum() {
        let conn = full_schema_db();
        // Empty view orders → step*2 - step = 1000.
        assert_eq!(get_next_grouped_top_sort_order(&conn).unwrap(), 1000);
        conn.execute(
            "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order) VALUES ('group','g',500)",
            [],
        )
        .unwrap();
        assert_eq!(
            get_next_grouped_top_sort_order(&conn).unwrap(),
            -500,
            "min 500 - step"
        );
    }

    #[test]
    fn ensure_system_group_membership_is_idempotent() {
        let conn = full_schema_db();
        let task = TaskRef {
            workspace_key: "/ws",
            workspace_path: "/ws",
            workspace_identity: None,
            task_id: "t1",
        };
        let group = SystemGroup {
            group_id: "cron-default",
            title: "cron",
            color: "blue",
        };
        ensure_system_group_membership(&conn, &task, &group, 42).unwrap();
        ensure_system_group_membership(&conn, &task, &group, 99).unwrap();

        let groups: i64 = conn
            .query_row("SELECT count(*) FROM task_groups", [], |r| r.get(0))
            .unwrap();
        let members: i64 = conn
            .query_row("SELECT count(*) FROM task_group_members", [], |r| r.get(0))
            .unwrap();
        let orders: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_group_view_node_orders",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            (groups, members, orders),
            (1, 1, 1),
            "INSERT OR IGNORE stays idempotent"
        );
        // The original sort_order (from the first call's watermark 1000) must not be reshuffled.
        let order: i64 = conn
            .query_row(
                "SELECT sort_order FROM task_group_view_node_orders WHERE node_key='cron-default'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(order, 1000, "group order preserved across re-runs");
    }

    fn group_count(conn: &Connection, group_id: &str) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM task_groups WHERE group_id = ?1",
            [group_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn sync_grouping_adds_cron_on_first_appearance_only() {
        let conn = full_schema_db();
        let mut with_cron = tm(100, Some("completed"));
        with_cron.cron_automation_id = Some("cron-1".into());
        sync_task_meta_with_grouping(&conn, "/ws", &with_cron, &SyncParams::default(), None, 10)
            .unwrap();
        assert_eq!(
            group_count(&conn, CRON_DEFAULT_GROUP_ID),
            1,
            "cron group created"
        );

        // Re-sync a snapshot without cron (existing preserved) → no duplicate / no re-add.
        let again = tm(200, Some("completed"));
        sync_task_meta_with_grouping(&conn, "/ws", &again, &SyncParams::default(), None, 20)
            .unwrap();
        assert_eq!(group_count(&conn, CRON_DEFAULT_GROUP_ID), 1, "idempotent");
    }

    #[test]
    fn sync_grouping_off_peak_skips_remote_workspace() {
        let conn = full_schema_db();
        // Local off-peak session → grouped.
        let mut local = tm(100, Some("completed"));
        local.off_peak_task_id = Some("op-1".into());
        sync_task_meta_with_grouping(&conn, "/ws", &local, &SyncParams::default(), None, 10)
            .unwrap();
        assert_eq!(group_count(&conn, OFF_PEAK_DEFAULT_GROUP_ID), 1);

        // Remote off-peak session → NOT grouped (off-peak has no remote support).
        let mut remote = tm(100, Some("completed"));
        remote.task_id = "t2".into();
        remote.workspace_identity = Some("remote:ssh:h:22:u:/p".into());
        remote.off_peak_task_id = Some("op-2".into());
        let wk = "remote:ssh:h:22:u:/p";
        sync_task_meta_with_grouping(&conn, wk, &remote, &SyncParams::default(), None, 10).unwrap();
        let members: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_group_members WHERE group_id=?1 AND workspace_key=?2",
                rusqlite::params![OFF_PEAK_DEFAULT_GROUP_ID, wk],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 0, "remote off-peak not added to the group");
    }

    #[test]
    fn filtered_list_workspace_and_include_deleted() {
        let conn = fixture_db();
        // All workspaces, hide deleted.
        let all = query_task_metas_filtered(&conn, &ListFilter::default()).unwrap();
        let ids: Vec<String> = all.iter().map(|m| m.task_id.clone()).collect();
        assert_eq!(ids, vec!["other", "t-new", "t-mid", "t-old"]);

        // Include tombstones → t-dead (updated_at 400) slots in.
        let with_deleted = query_task_metas_filtered(
            &conn,
            &ListFilter {
                include_deleted: true,
                ..Default::default()
            },
        )
        .unwrap();
        let ids2: Vec<String> = with_deleted.iter().map(|m| m.task_id.clone()).collect();
        assert_eq!(ids2, vec!["other", "t-dead", "t-new", "t-mid", "t-old"]);

        // Single workspace.
        let ws = query_task_metas_filtered(
            &conn,
            &ListFilter {
                workspace_key: Some("ws-A".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(ws.len(), 3);
    }

    #[test]
    fn filtered_list_pin_and_archive() {
        let conn = fixture_db();
        // No row is pinned → pinned=Some(true) yields nothing; Some(false) yields all non-deleted.
        let pinned_true = query_task_metas_filtered(
            &conn,
            &ListFilter {
                pinned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(pinned_true.is_empty());
        let pinned_false = query_task_metas_filtered(
            &conn,
            &ListFilter {
                pinned: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(pinned_false.len(), 4);
    }

    #[test]
    fn normalize_snippet_collapses_and_caps() {
        assert_eq!(normalize_search_snippet_text("a   b\n\tc"), "a b c");
        let long = "x".repeat(200);
        assert_eq!(
            normalize_search_snippet_text(&long).chars().count(),
            SNIPPET_MAX_CHARS
        );
    }

    #[test]
    fn snippets_window_and_dedupe() {
        // Whole short body fits inside the window → single snippet, no ellipses.
        let s = build_search_snippets("The quick brown fox", Some("brown"));
        assert_eq!(s, vec!["The quick brown fox".to_string()]);

        // Match deep in a long body → leading ellipsis, and the matched word is present.
        let body = "a".repeat(30) + "needle" + &"b".repeat(30);
        let s2 = build_search_snippets(&body, Some("needle"));
        assert_eq!(s2.len(), 1);
        assert!(s2[0].starts_with("..."), "truncated leading context");
        assert!(s2[0].contains("needle"));

        // Case-insensitive: uppercase body, lowercase query still matches.
        let s3 = build_search_snippets("HELLO World", Some("hello"));
        assert_eq!(s3, vec!["HELLO World".to_string()]);
    }

    #[test]
    fn snippets_fallback_when_body_has_no_match() {
        // Title-matched rows call this with a query absent from the body → one whole-text snippet.
        assert_eq!(
            build_search_snippets("hello world", Some("zzz")),
            vec!["hello world".to_string()]
        );
    }

    #[test]
    fn snippets_empty_cases() {
        assert!(build_search_snippets("x", None).is_empty());
        assert!(build_search_snippets("x", Some("")).is_empty());
        assert!(build_search_snippets("   ", Some("a")).is_empty());
    }

    fn scope(ws: &str, purpose: Option<&str>) -> WorkspaceScope {
        WorkspaceScope {
            workspace_path: ws.into(),
            workspace_identity: None,
            workspace_purpose: purpose.map(|s| s.to_string()),
        }
    }

    #[test]
    fn query_task_list_orders_totals_and_pagination() {
        let conn = fixture_db();
        let q = TaskListQuery {
            workspace_scopes: vec![scope("ws-A", None), scope("ws-B", None)],
            ..Default::default()
        };
        let r = query_task_list(&conn, &q).unwrap();
        let ids: Vec<&str> = r.items.iter().map(|i| i.meta.task_id.as_str()).collect();
        assert_eq!(ids, vec!["other", "t-new", "t-mid", "t-old"]);
        assert_eq!(r.total, 4);
        assert!(!r.has_more);

        let limited = query_task_list(
            &conn,
            &TaskListQuery {
                workspace_scopes: vec![scope("ws-A", None), scope("ws-B", None)],
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(limited.items.len(), 2);
        assert!(limited.has_more, "total 4 > 2 returned");
    }

    #[test]
    fn query_task_list_kind_and_provider_filters() {
        let conn = fixture_db();
        // No row is pinned → kind "pinned" yields none; default yields the unpinned 4.
        let pinned = query_task_list(
            &conn,
            &TaskListQuery {
                workspace_scopes: vec![scope("ws-A", None), scope("ws-B", None)],
                kind: Some("pinned".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(pinned.items.is_empty());
        // provider filter: fixture rows have provider NULL → filtering on "glm" yields none.
        let prov = query_task_list(
            &conn,
            &TaskListQuery {
                workspace_scopes: vec![scope("ws-A", None), scope("ws-B", None)],
                provider: Some("glm".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(prov.items.is_empty());
    }

    #[test]
    fn query_task_list_search_and_workspace_purpose() {
        let conn = fixture_db();
        // searchable_text is empty in the fixture, but title "new" matches the LIKE on LOWER(title).
        let r = query_task_list(
            &conn,
            &TaskListQuery {
                workspace_scopes: vec![scope("ws-A", Some("project")), scope("ws-B", None)],
                search: Some("new".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].meta.task_id, "t-new");
        assert_eq!(
            r.items[0].meta.workspace_purpose.as_deref(),
            Some("project")
        );
        // Empty body → no snippet fields attached (rowToTaskListItem keeps meta-only).
        assert!(r.items[0].search_snippet.is_none());
        // Serialized item must omit the snippet keys entirely.
        assert!(!serde_json::to_string(&r.items[0])
            .unwrap()
            .contains("searchSnippet"));
    }

    #[test]
    fn query_task_list_empty_scopes_short_circuits() {
        let conn = fixture_db();
        let r = query_task_list(&conn, &TaskListQuery::default()).unwrap();
        assert!(r.items.is_empty());
        assert_eq!(r.total, 0);
        assert!(!r.has_more);
    }

    #[test]
    fn parse_state_patch_distinguishes_in_fields_from_nullish_coalesce() {
        let v: serde_json::Value = serde_json::json!({
            "pinned": null,          // ?? field: null → keep (None)
            "archived": false,       // ?? field: present false → Some(false)
            "lastError": null,       // in field: present → Set(None) (clear)
            "target": { "goal": "g" }, // in field: present → Set(Some(..))
            "unreadAt": 42,          // in field: number → Set(Allocate(42))
        });
        let p = parse_state_patch(v.as_object().unwrap());
        assert_eq!(p.pinned, None, "?? field: null treated as absent");
        assert_eq!(p.archived, Some(false));
        assert_eq!(
            p.last_error,
            PatchField::Set(None),
            "in field: null → clear"
        );
        assert!(matches!(p.target, PatchField::Set(Some(_))));
        assert_eq!(p.unread_at, PatchField::Set(UnreadOp::Allocate(42)));
        // absent `title`/`status`/`lastError`-less object → Unset / None.
        let empty = parse_state_patch(serde_json::json!({}).as_object().unwrap());
        assert_eq!(empty.title, None);
        assert_eq!(empty.last_error, PatchField::Unset);
        assert_eq!(empty.unread_at, PatchField::Unset);
        // clear marker: unreadAt present but null → Clear.
        let clear = parse_state_patch(serde_json::json!({ "unreadAt": null }).as_object().unwrap());
        assert_eq!(clear.unread_at, PatchField::Set(UnreadOp::Clear));
    }

    #[test]
    fn parse_automation_update_params_tri_state() {
        let v: serde_json::Value = serde_json::json!({
            "title": null,           // ??-field: null → None (keep)
            "cronExpr": "0 8 * * *", // ??-field: value
            "maxRuns": null,         // tri: present-null → Some(None) (clear)
            "endAt": 123,            // tri: number → Some(Some(123))
            "modelSelection": null,  // tri: present-null → Some(None)
            "recurring": false,      // ??-bool: false kept → Some(false)
        });
        let p = parse_automation_update_params(v.as_object().unwrap());
        assert_eq!(p.title, None);
        assert_eq!(p.cron_expr.as_deref(), Some("0 8 * * *"));
        assert_eq!(p.max_runs, Some(None), "present-null clears");
        assert_eq!(p.end_at, Some(Some(123)));
        assert_eq!(p.model_selection, Some(None));
        assert_eq!(p.recurring, Some(false));
        // absent keys → keep (None)
        let empty = parse_automation_update_params(serde_json::json!({}).as_object().unwrap());
        assert_eq!(empty.max_runs, None);
        assert_eq!(empty.model_selection, None);
        assert!(
            parse_automation_update_options(
                serde_json::json!({ "resetRetry": true })
                    .as_object()
                    .unwrap()
            )
            .reset_retry
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

    #[test]
    fn run_startup_repairs_backfills_and_cleans() {
        let conn = full_schema_db();
        conn.execute_batch(
            "CREATE TABLE off_peak_tasks (
               off_peak_task_id TEXT PRIMARY KEY, session_id TEXT, workspace_key TEXT NOT NULL,
               status TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        )
        .unwrap();

        // (a) a completed task bound by session to an off-peak row → marker back-filled.
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, created_at, updated_at) VALUES ('/ws','/ws','t1',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO off_peak_tasks VALUES ('op1','t1','/ws','running',5)",
            [],
        )
        .unwrap();

        // (d) a legacy awaiting_approval row → repaired to running.
        conn.execute(
            "INSERT INTO off_peak_tasks VALUES ('op2',NULL,'/ws','awaiting_approval',5)",
            [],
        )
        .unwrap();

        // (c) a deleted task carrying a stale grouping member + order → cleaned.
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, created_at, updated_at, deleted) VALUES ('/ws','/ws','dead',1,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_group_members (group_id, workspace_key, task_id, sort_order, added_at, created_at, updated_at) VALUES ('g1','/ws','dead',1,1,1,1)",
            [],
        )
        .unwrap();

        run_startup_repairs(&conn, 100).unwrap();

        let marker: Option<String> = conn
            .query_row("SELECT off_peak_task_id FROM tasks WHERE task_id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(marker.as_deref(), Some("op1"), "off-peak marker back-filled");

        let status: String = conn
            .query_row("SELECT status FROM off_peak_tasks WHERE off_peak_task_id='op2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "running", "awaiting_approval repaired to running");

        let member_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_group_members WHERE task_id='dead'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(member_count, 0, "deleted-task grouping reference cleaned");

        // (b) t1 now has an off_peak marker → a system off-peak group + membership is created.
        let in_op_group: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_group_members WHERE task_id='t1' AND group_id='zcode-default-group-off-peak'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(in_op_group, 1, "off-peak membership back-filled into the system group");

        // Idempotent: running again adds no duplicate membership.
        run_startup_repairs(&conn, 200).unwrap();
        let dup: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_group_members WHERE task_id='t1' AND group_id='zcode-default-group-off-peak'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dup, 1, "membership back-fill is idempotent");
    }
}
