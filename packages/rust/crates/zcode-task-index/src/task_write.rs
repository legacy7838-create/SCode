//! The write path: `writeRecord`, the grouping-reference delete, and the guarded state transitions.
//!
//! Ported from `taskIndexRepo.ts:1108-1270` (the write), `:603-617` (the grouping delete) and
//! `:1471-1665` (the transitions). Spec: docs/specs/rust-native-task-index.md §25 (batch D).
//!
//! # `searchable_text` is three-state, and two of the states are the whole point
//!
//! `write_record` takes `searchable_text: Option<Option<&str>>`:
//!
//! | value | meaning |
//! |---|---|
//! | `None` | leave the stored value alone |
//! | `Some(None)` | clear it |
//! | `Some(Some(text))` | set it, truncated |
//!
//! The upsert is `ON CONFLICT … excluded.searchable_text`, so **without** the read-before-write an
//! omitted value assigns `""` and wipes every task's indexed text. The task list keeps working and
//! search silently returns nothing. That is why `None` is a distinct case rather than "absent
//! field".
//!
//! # `unread_at` and `last_unread_at` move together, and `last_unread_at` only ever rises
//!
//! `last_unread_at` is a **watermark**, and the SQL takes `MAX` of the stored value, the stored
//! `unread_at` and the incoming one. Two logical reads of the same task can land on the same
//! millisecond, and after `unread_at` is cleared, reading only the current value would re-issue the
//! old version. A watermark that never decreases is what makes "already seen" monotonic.
//!
//! `unread_at` itself is written **only** when `write_unread_at` is set; otherwise the stored value
//! is kept. A mobile read request can arrive after the new final state of unread, so compare and
//! write must be in the same transaction — which is why the transitions that touch it take the
//! mutable handle.
use rusqlite::Row;

use crate::grouped::task_order_node_key;
use crate::meta::{row_to_meta, sql, TaskMeta, TaskRow, TASK_COLUMNS};
use crate::migrate::MigrationError;
/// `TASK_SEARCH_TEXT_MAX_CHARS` (`taskIndexRepo.ts:150`): the stored `searchable_text` is truncated
/// to this many **characters**.
///
/// A bound rather than a rejection, so an oversized document still indexes the part a search can
/// reach. It is a storage decision, so it lives with the write path rather than the snippet
/// builder, which has its own and much smaller limit.
pub const TASK_SEARCH_TEXT_MAX_CHARS: usize = 200_000;

/// One `writeRecord` call. No `Default`: a write always carries a full document, and a default
/// here would let a caller write a task with no title or mode.
#[derive(Debug, Clone)]
pub struct WriteRecord {
    pub meta: TaskMeta,
    pub pinned: bool,
    pub archived: bool,
    pub deleted: bool,
    pub title_overridden: bool,
    /// The tri-state described in the module docs.
    pub searchable_text: Option<Option<String>>,
    /// Whether `unread_at` may move. `false` leaves it, and the watermark still rises.
    pub write_unread_at: bool,
}

/// `deleteTaskGroupingReferencesReady` (`taskIndexRepo.ts:603-617`).
///
/// Two deletes, and the order row matches on **either** key form: the JSON array written today, and
/// the bare `workspace_key` that an older build stored. Matching only the current form would strand
/// every node an earlier version created, and the grouped view would keep rendering them.
pub fn delete_grouping_references(
    conn: &rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
) -> Result<(), MigrationError> {
    conn.execute(
        "DELETE FROM task_group_members WHERE workspace_key = ?1 AND task_id = ?2",
        rusqlite::params![workspace_key, task_id],
    )
    .map_err(|source| sql("cannot delete the membership", source))?;
    let order_key = task_order_node_key(workspace_key, task_id)?;
    conn.execute(
        "DELETE FROM task_group_view_node_orders
         WHERE node_type = 'task' AND (node_key = ?1 OR node_key = ?2)",
        rusqlite::params![order_key, workspace_key],
    )
    .map_err(|source| sql("cannot delete the task order", source))?;
    Ok(())
}

/// `serializeMetaJson` is a bare `JSON.stringify` — the document is stored exactly as the domain
/// type serialises, so a field the schema does not know is still preserved.
fn serialize_meta_json(meta: &TaskMeta) -> Result<String, MigrationError> {
    serde_json::to_string(meta).map_err(|error| sql(&format!("cannot serialise the meta: {error}"), rusqlite::Error::InvalidQuery))
}

/// `writeRecord` (`taskIndexRepo.ts:1108-1270`).
pub fn write_record(
    conn: &rusqlite::Connection,
    record: &WriteRecord,
) -> Result<TaskMeta, MigrationError> {
    let meta = &record.meta;
    let key = workspace_key(meta);
    // Read the row once so an omitted `searchable_text` keeps its stored value. Without this the
    // `ON CONFLICT` clause assigns `excluded.searchable_text`, which is `""`.
    let existing: Option<String> = conn
        .query_row(
            "SELECT searchable_text FROM tasks WHERE workspace_key = ?1 AND task_id = ?2",
            rusqlite::params![key, meta.task_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|source| sql("cannot read the existing task", source))?
        .flatten();
    let searchable_text: String = match &record.searchable_text {
        Some(Some(text)) => truncate_search_text(text),
        Some(None) => String::new(),
        None => existing.unwrap_or_default(),
    };

    let unread_at = meta.unread_at;
    let incoming_last_unread = unread_at.unwrap_or(0);
    conn.execute(
        "INSERT INTO tasks (
           workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider,
           mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id,
           created_at, updated_at, unread_at, last_unread_at, pinned, archived, deleted,
           title_overridden, searchable_text, meta_json)
         VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
           ?14, ?15, ?16, ?17, ?18, ?19, ?20,
           ?21, ?22, ?23)
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
           unread_at = CASE WHEN ?24 = 1 THEN excluded.unread_at ELSE tasks.unread_at END,
           last_unread_at = MAX(
             tasks.last_unread_at,
             COALESCE(tasks.unread_at, 0),
             CASE WHEN ?24 = 1 THEN excluded.last_unread_at ELSE 0 END
           ),
           pinned = excluded.pinned,
           archived = excluded.archived,
           deleted = excluded.deleted,
           title_overridden = excluded.title_overridden,
           searchable_text = excluded.searchable_text,
           meta_json = excluded.meta_json",
        rusqlite::params![
            key,
            meta.workspace_path,
            meta.workspace_identity,
            meta.task_id,
            meta.title,
            meta.status.map(|status| status_wire(status)),
            meta.provider.map(|provider| provider_wire(provider)),
            mode_wire(meta.mode),
            meta.model,
            meta.migration_source.map(migration_source_wire),
            meta.forked_from_task_id,
            meta.cron_automation_id,
            meta.off_peak_task_id,
            meta.created_at,
            meta.updated_at,
            unread_at,
            incoming_last_unread,
            i64::from(record.pinned),
            i64::from(record.archived),
            i64::from(record.deleted),
            i64::from(record.title_overridden),
            searchable_text,
            serialize_meta_json(meta)?,
            i64::from(record.write_unread_at),
        ],
    )
    .map_err(|source| sql("cannot write the task", source))?;

    read_task_row(conn, &key, &meta.task_id)?
        .as_ref()
        .map(row_to_meta)
        .ok_or_else(|| sql(&format!("task index has no task after the write: {}", meta.task_id), rusqlite::Error::InvalidQuery))
}

/// `searchable_text` is truncated rather than rejected, so an oversized document still indexes the
/// part a search can reach. Truncation is by **characters**, not bytes, so a multi-byte document is
/// not cut mid-codepoint.
fn truncate_search_text(text: &str) -> String {
    text.chars().take(TASK_SEARCH_TEXT_MAX_CHARS).collect()
}

/// The identity key for a meta: `identity?.trim() || path`, resolved by the caller.
fn workspace_key(meta: &TaskMeta) -> String {
    match meta.workspace_identity.as_deref().map(str::trim) {
        Some(identity) if !identity.is_empty() => identity.to_string(),
        _ => meta.workspace_path.clone(),
    }
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

/// The wire spelling of the persisted enums.
///
/// These are hand-written rather than derived, because the column values are a **storage contract**
/// that predates the Rust types: a rename in the enum must not silently rewrite every row.
fn status_wire(status: crate::meta::PersistStatus) -> &'static str {
    match status {
        crate::meta::PersistStatus::Running => "running",
        crate::meta::PersistStatus::Completed => "completed",
        crate::meta::PersistStatus::Error => "error",
    }
}

fn mode_wire(mode: crate::meta::TaskMode) -> &'static str {
    match mode {
        crate::meta::TaskMode::Yolo => "yolo",
        crate::meta::TaskMode::Plan => "plan",
        crate::meta::TaskMode::Edit => "edit",
        crate::meta::TaskMode::Auto => "auto",
        crate::meta::TaskMode::AutoEdit => "autoEdit",
        crate::meta::TaskMode::Build => "build",
    }
}

fn provider_wire(provider: crate::meta::AgentProvider) -> &'static str {
    match provider {
        crate::meta::AgentProvider::Glm => "glm",
    }
}

fn migration_source_wire(source: crate::meta::MigrationSource) -> &'static str {
    match source {
        crate::meta::MigrationSource::ClaudeCode => "claudeCode",
    }
}

/// `isTerminalTaskStatus` for the three persisted statuses.
fn is_terminal_status(status: Option<crate::meta::PersistStatus>) -> bool {
    matches!(
        status,
        Some(crate::meta::PersistStatus::Completed) | Some(crate::meta::PersistStatus::Error)
    )
}

/// `shouldPreserveNewerTerminalStatus` (`taskIndexRepo.ts:177-188`).
///
/// `turn.completed` writes the newer `completed`/`error` first; a protocol snapshot that arrives
/// afterwards can still carry an older `running`. Downgrading here would make the mobile
/// replayable-link restore a finished task to "working" when it switches back.
///
/// So the existing terminal status wins when it is **newer** than the incoming one, and only when
/// the incoming status is `running` or absent — an incoming terminal status is a deliberate change.
pub fn should_preserve_newer_terminal_status(
    existing: Option<&TaskMeta>,
    incoming: &TaskMeta,
) -> bool {
    let Some(existing) = existing else { return false };
    if !is_terminal_status(existing.status) {
        return false;
    }
    if incoming.status.is_some() && incoming.status != Some(crate::meta::PersistStatus::Running) {
        return false;
    }
    existing.updated_at > incoming.updated_at
}

/// Why a state transition was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    /// No such task, or it is already deleted. Both are the same refusal, because a deleted task
    /// is not a thing a caller may resurrect through the state API.
    NoSuchTask(String),
}

impl std::fmt::Display for StateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateError::NoSuchTask(task_id) => {
                write!(formatter, "task index has no such task: {task_id}")
            }
        }
    }
}

impl From<StateError> for MigrationError {
    fn from(error: StateError) -> Self {
        sql(&error.to_string(), rusqlite::Error::InvalidQuery)
    }
}

/// The result of `clearTaskUnreadIfMatches`.
#[derive(Debug, Clone, PartialEq)]
pub struct ClearUnreadResult {
    pub meta: TaskMeta,
    /// `false` when the stored `unread_at` did not match, so nothing was written. The task is still
    /// returned: the caller asked what the current state is, and that is a valid answer.
    pub cleared: bool,
}

/// `clearTaskUnreadIfMatches` (`taskIndexRepo.ts:1488-1531`).
///
/// Compare-and-clear **in one transaction**. A mobile read request can arrive after the task's new
/// final unread state; reading the row and then writing outside a transaction would let the old
/// click unconditionally clear the subsequent `unread_at`.
///
/// There is no `now` parameter, and that is deliberate rather than an omission: clearing unread
/// does not change the task, so `updated_at` must stay where it was. A caller that stamped the
/// write would make every read bump the task to the top of a list sorted by recency.
pub fn clear_task_unread_if_matches(
    conn: &mut rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
    expected_unread_at: i64,
) -> Result<ClearUnreadResult, MigrationError> {
    let transaction = conn.transaction().map_err(|source| sql("cannot begin the clear", source))?;
    let row = read_task_row(&transaction, workspace_key, task_id)?;
    let Some(row) = row.filter(|row| row.deleted != 1) else {
        return Err(StateError::NoSuchTask(task_id.to_string()).into());
    };
    let current = row_to_meta(&row);
    if current.unread_at != Some(expected_unread_at) {
        // Nothing to do. Committing rather than rolling back keeps the read visible to the next
        // reader, and there is nothing to undo.
        transaction.commit().map_err(|source| sql("cannot commit the clear", source))?;
        return Ok(ClearUnreadResult { meta: current, cleared: false });
    }
    let next = TaskMeta { unread_at: None, ..current.clone() };
    let persisted = write_record(
        &transaction,
        &WriteRecord {
            meta: next,
            pinned: row.pinned == 1,
            archived: row.archived == 1,
            deleted: false,
            title_overridden: row.title_overridden == 1,
            // The searchable text is left alone: an omitted value keeps the stored one.
            searchable_text: None,
            write_unread_at: true,
        },
    )?;
    transaction.commit().map_err(|source| sql("cannot commit the clear", source))?;
    Ok(ClearUnreadResult { meta: persisted, cleared: true })
}

/// `deleteArchivedTask` (`taskIndexRepo.ts:1532-1565`).
///
/// The archive check and the tombstone are in **one transaction**, on purpose. Reading first and
/// deleting after would let a confirmation restored from the other end slip through, and would
/// resurrect a task the CLI seeded again.
///
/// The grouping references are deleted in the same transaction: a deleted task that still owns a
/// group membership leaves the sidebar, task visibility and group ownership permanently at odds.
pub fn delete_archived_task(
    conn: &mut rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
    now: i64,
) -> Result<Option<TaskMeta>, MigrationError> {
    let transaction = conn.transaction().map_err(|source| sql("cannot begin the delete", source))?;
    let row = read_task_row(&transaction, workspace_key, task_id)?;
    // Deleted, missing and un-archived all return `None` rather than an error: the card's delete is
    // idempotent from the caller's side.
    let Some(row) = row.filter(|row| row.deleted != 1 && row.archived == 1) else {
        transaction.commit().map_err(|source| sql("cannot commit the delete", source))?;
        return Ok(None);
    };
    let mut meta = row_to_meta(&row);
    meta.updated_at = now;
    let persisted = write_record(
        &transaction,
        &WriteRecord {
            meta,
            pinned: row.pinned == 1,
            archived: true,
            deleted: true,
            title_overridden: row.title_overridden == 1,
            searchable_text: None,
            write_unread_at: false,
        },
    )?;
    delete_grouping_references(&transaction, workspace_key, task_id)?;
    transaction.commit().map_err(|source| sql("cannot commit the delete", source))?;
    Ok(Some(persisted))
}

/// `updateTaskState`'s patch. Every field is optional, and `None` means **leave alone** — including
/// for the two that are genuinely three-state, which the flags below carry.
#[derive(Debug, Clone, Default)]
pub struct StatePatch {
    pub title: Option<String>,
    pub title_overridden: Option<bool>,
    pub model: Option<String>,
    pub updated_at: Option<i64>,
    pub unread_at: Option<Option<i64>>,
    pub status: Option<crate::meta::PersistStatus>,
    pub last_error: Option<Option<crate::meta::LastError>>,
    pub target: Option<Option<crate::meta::TaskGoal>>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub deleted: Option<bool>,
}

/// `updateTaskState` (`taskIndexRepo.ts:1566-1634`).
///
/// The unread allocation is the subtle part. A millisecond timestamp lets two logical reads of the
/// same task take the same version, and after `unread_at` is cleared, reading only the current value
/// would re-issue the old one. So a requested timestamp is pushed to at least
/// `MAX(stored watermark, stored unread, current unread) + 1` — strictly increasing, and based on
/// watermarks that clearing does not reset.
pub fn update_task_state(
    conn: &mut rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
    patch: &StatePatch,
    now: i64,
) -> Result<TaskMeta, MigrationError> {
    update_task_state_transactional(conn, workspace_key, task_id, patch, now)
}

/// The body of [`update_task_state`], always inside a transaction.
///
/// Opening one unconditionally is a deliberate simplification: the original branched, opening a
/// transaction only for a delete or an unread change. That branch is invisible from the outside —
/// a plain title edit touches one row and no other reader can interleave inside a single statement
/// — and paying two extra statements for it removes a whole class of "was this path transactional
/// by accident" question.
fn update_task_state_transactional(
    conn: &mut rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
    patch: &StatePatch,
    now: i64,
) -> Result<TaskMeta, MigrationError> {
    let transaction = conn
        .transaction()
        .map_err(|source| sql("cannot begin the state update", source))?;
    let outcome = update_task_state_in(&transaction, workspace_key, task_id, patch, now);
    match outcome {
        Ok(value) => {
            transaction
                .commit()
                .map_err(|source| sql("cannot commit the state update", source))?;
            Ok(value)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

fn update_task_state_in(
    conn: &rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
    patch: &StatePatch,
    now: i64,
) -> Result<TaskMeta, MigrationError> {
    let row = read_task_row(conn, workspace_key, task_id)?
        .filter(|row| row.deleted != 1)
        .ok_or_else(|| StateError::NoSuchTask(task_id.to_string()))?;
    let current = row_to_meta(&row);

    let last_unread_at = row
        .last_unread_at
        .max(row.unread_at.unwrap_or(0))
        .max(current.unread_at.unwrap_or(0));
    let unread_at = match patch.unread_at {
        // `Some(Some(value))` is a request: push it strictly above the watermark.
        // `Some(None)` clears it, which the allocation treats as no request.
        Some(Some(requested)) => Some(requested.max(last_unread_at + 1)),
        _ => current.unread_at,
    };

    let next = TaskMeta {
        title: patch.title.clone().unwrap_or_else(|| current.title.clone()),
        title_overridden: Some(patch.title_overridden.unwrap_or(current.title_overridden.unwrap_or(false))),
        model: patch.model.clone().or_else(|| current.model.clone()),
        // An explicit `updatedAt` is the caller's truth; otherwise the write stamps `now`, but
        // never moves the task backwards.
        updated_at: match patch.updated_at {
            Some(value) => value,
            None => current.updated_at.max(now),
        },
        unread_at,
        status: patch.status.or(current.status),
        last_error: match &patch.last_error {
            Some(value) => value.clone(),
            None => current.last_error,
        },
        // The field is `Option<Option<TaskGoal>>` — absent, explicitly null, or a goal — so a
        // mentioned patch re-wraps rather than collapsing the inner null away.
        target: match &patch.target {
            Some(value) => Some(value.clone()),
            None => current.target,
        },
        ..current
    };
    let persisted = write_record(
        conn,
        &WriteRecord {
            meta: next,
            pinned: patch.pinned.unwrap_or(row.pinned == 1),
            archived: patch.archived.unwrap_or(row.archived == 1),
            deleted: patch.deleted.unwrap_or(row.deleted == 1),
            title_overridden: patch.title_overridden.unwrap_or(row.title_overridden == 1),
            searchable_text: None,
            write_unread_at: mutating_unread_of(patch),
        },
    )?;
    if patch.deleted == Some(true) {
        // The tombstone and the grouping delete are one transaction. Committing them apart leaves
        // task visibility and group ownership permanently at odds with each other.
        delete_grouping_references(conn, workspace_key, task_id)?;
    }
    Ok(persisted)
}

fn mutating_unread_of(patch: &StatePatch) -> bool {
    patch.unread_at.is_some()
}

/// `applyAgentPatch` (`taskIndexRepo.ts:1635-1667`).
///
/// Returns `None` for a missing or deleted task rather than throwing — an agent patch arriving for
/// a task the user has already deleted is normal, not a fault.
///
/// The title is accepted only when the user has **not** overridden it. The agent owns the session's
/// core title; a manual rename belongs to the app side, and a background status refresh must not
/// wash it away.
pub fn apply_agent_patch(
    conn: &mut rusqlite::Connection,
    workspace_key: &str,
    task_id: &str,
    title: Option<&str>,
    status: Option<crate::meta::PersistStatus>,
    last_error: Option<Option<crate::meta::LastError>>,
    target: Option<Option<crate::meta::TaskGoal>>,
    updated_at: Option<i64>,
) -> Result<Option<TaskMeta>, MigrationError> {
    let Some(row) = read_task_row(conn, workspace_key, task_id)?.filter(|row| row.deleted != 1) else {
        return Ok(None);
    };
    let current = row_to_meta(&row);
    let can_accept_agent_title = row.title_overridden != 1;
    let next = TaskMeta {
        title: match title {
            Some(value) if can_accept_agent_title && !value.is_empty() => value.to_string(),
            _ => current.title.clone(),
        },
        title_overridden: Some(row.title_overridden == 1),
        updated_at: updated_at.unwrap_or(current.updated_at),
        status: status.or(current.status),
        last_error: match &last_error {
            Some(value) => value.clone(),
            None => current.last_error.clone(),
        },
        target: match &target {
            Some(value) => Some(value.clone()),
            None => current.target.clone(),
        },
        ..current
    };
    write_record(
        conn,
        &WriteRecord {
            meta: next,
            pinned: row.pinned == 1,
            archived: row.archived == 1,
            deleted: row.deleted == 1,
            title_overridden: row.title_overridden == 1,
            searchable_text: None,
            write_unread_at: false,
        },
    )
    .map(Some)
}

/// `seedTaskMetaIfMissing` (`taskIndexRepo.ts:1471-1487`).
///
/// The read and the write are in **one transaction**, so a concurrent first sync cannot see "missing"
/// and then both write — the second would overwrite the first's row with its own merge.
pub fn seed_task_meta_if_missing(
    conn: &mut rusqlite::Connection,
    workspace_key: &str,
    meta: &TaskMeta,
) -> Result<TaskMeta, MigrationError> {
    let transaction = conn.transaction().map_err(|source| sql("cannot begin the seed", source))?;
    if let Some(row) = read_task_row(&transaction, workspace_key, &meta.task_id)? {
        transaction.commit().map_err(|source| sql("cannot commit the seed", source))?;
        return Ok(row_to_meta(&row));
    }
    let seeded = write_record(
        &transaction,
        &WriteRecord {
            meta: meta.clone(),
            pinned: false,
            archived: false,
            deleted: false,
            title_overridden: meta.title_overridden.unwrap_or(false),
            searchable_text: None,
            write_unread_at: false,
        },
    )?;
    transaction.commit().map_err(|source| sql("cannot commit the seed", source))?;
    Ok(seeded)
}

/// `cleanupDeletedTaskGroupingReferences` (`taskIndexRepo.ts:619-658`): drop the grouping rows of
/// every deleted task.
///
/// A repair, not a transition: it runs on open, so a crash between a tombstone and its grouping
/// delete cannot leave a deleted task owning a group slot forever.
pub fn cleanup_deleted_grouping_references(
    conn: &rusqlite::Connection,
) -> Result<usize, MigrationError> {
    let mut statement = conn
        .prepare("SELECT workspace_key, task_id FROM tasks WHERE deleted = 1")
        .map_err(|source| sql("cannot read the deleted tasks", source))?;
    let rows = statement
        .query_map([], |row: &Row<'_>| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|source| sql("cannot read the deleted tasks", source))?;
    let mut cleaned = 0usize;
    for row in rows {
        let (workspace_key, task_id) = row.map_err(|source| sql("cannot read a deleted task", source))?;
        delete_grouping_references(conn, &workspace_key, &task_id)?;
        cleaned += 1;
    }
    Ok(cleaned)
}

/// The migration-source wire spelling, exposed for the write path's tests.
pub fn migration_source_name(source: crate::meta::MigrationSource) -> &'static str {
    migration_source_wire(source)
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
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

    /// A record with only `meta` set; the flags default the way the transitions want them.
    fn empty_record() -> WriteRecord {
        WriteRecord {
            meta: TaskMeta {
                task_id: String::new(),
                trace_id: "tr".into(),
                title: String::new(),
                title_overridden: Some(false),
                workspace_path: "/ws".into(),
                workspace_identity: None,
                workspace_purpose: None,
                created_at: 1,
                updated_at: 1,
                mode: crate::meta::TaskMode::Auto,
                model: None,
                thought_level: None,
                runtime_epoch: None,
                provider: None,
                migration_source: None,
                forked_from_task_id: None,
                cron_automation_id: None,
                off_peak_task_id: None,
                unread_at: None,
                status: None,
                last_error: None,
                change_summary: None,
                target: None,
            },
            pinned: false,
            archived: false,
            deleted: false,
            title_overridden: false,
            searchable_text: None,
            write_unread_at: false,
        }
    }

    fn task(task_id: &str, title: &str) -> TaskMeta {
        TaskMeta {
            task_id: task_id.into(),
            trace_id: "tr".into(),
            title: title.into(),
            title_overridden: Some(false),
            workspace_path: "/ws".into(),
            workspace_identity: None,
            workspace_purpose: None,
            created_at: 1,
            updated_at: 1,
            mode: crate::meta::TaskMode::Auto,
            model: None,
            thought_level: None,
            runtime_epoch: None,
            provider: None,
            migration_source: None,
            forked_from_task_id: None,
            cron_automation_id: None,
            off_peak_task_id: None,
            unread_at: None,
            status: None,
            last_error: None,
            change_summary: None,
            target: None,
        }
    }

    /// An omitted `searchable_text` keeps the stored value.
    ///
    /// This is the case the three-state exists for: the upsert assigns `excluded.searchable_text`,
    /// so an omitted value would become `""` and wipe every task's indexed text. The list would keep
    /// working and search would silently return nothing.
    #[test]
    fn an_omitted_searchable_text_keeps_the_stored_value() {
        let conn = memory();
        write_record(
            &conn,
            &WriteRecord { meta: task("t1", "first"), searchable_text: Some(Some("body text".into())), ..empty_record() },
        )
        .expect("write");
        // A later write that says nothing about the text must not clear it.
        write_record(
            &conn,
            &WriteRecord { meta: task("t1", "renamed"), searchable_text: None, ..empty_record() },
        )
        .expect("write");
        let stored: String = conn
            .query_row("SELECT searchable_text FROM tasks WHERE task_id = 't1'", [], |row| row.get(0))
            .expect("read");
        assert_eq!(stored, "body text", "an omitted value must not wipe the index");
    }

    /// An explicit empty string clears it, which is the third state.
    #[test]
    fn an_explicit_empty_text_clears_the_index() {
        let conn = memory();
        write_record(
            &conn,
            &WriteRecord { meta: task("t1", "t"), searchable_text: Some(Some("body".into())), ..empty_record() },
        )
        .expect("write");
        write_record(
            &conn,
            &WriteRecord { meta: task("t1", "t"), searchable_text: Some(None), ..empty_record() },
        )
        .expect("write");
        let stored: String = conn
            .query_row("SELECT searchable_text FROM tasks WHERE task_id = 't1'", [], |row| row.get(0))
            .expect("read");
        assert_eq!(stored, "");
    }

    /// `last_unread_at` is a watermark and only ever rises.
    #[test]
    fn the_unread_watermark_never_decreases() {
        let mut conn = memory();
        let mut meta = task("t1", "t");
        meta.unread_at = Some(500);
        write_record(
            &mut conn,
            &WriteRecord { meta, write_unread_at: true, ..empty_record() },
        )
        .expect("write");
        let watermark: i64 = conn
            .query_row("SELECT last_unread_at FROM tasks WHERE task_id = 't1'", [], |row| row.get(0))
            .expect("read");
        assert_eq!(watermark, 500);

        // A later write that does not touch unread leaves the watermark where it was, even though
        // the stored `unread_at` has been cleared.
        write_record(
            &conn,
            &WriteRecord { meta: task("t1", "t"), write_unread_at: true, ..empty_record() },
        )
        .expect("write");
        let (unread, watermark): (Option<i64>, i64) = conn
            .query_row("SELECT unread_at, last_unread_at FROM tasks WHERE task_id = 't1'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("read");
        assert_eq!(unread, None, "the unread mark was cleared");
        assert_eq!(watermark, 500, "but the watermark is not reset by clearing");
    }

    /// A requested unread timestamp is pushed strictly above the watermark.
    ///
    /// Two logical reads of the same task can land on the same millisecond, and after clearing, a
    /// read of the current value would re-issue the old version. Allocating `max(requested,
    /// watermark + 1)` is what makes "already seen" monotonic.
    #[test]
    fn a_requested_unread_timestamp_is_pushed_above_the_watermark() {
        let mut conn = memory();
        let mut meta = task("t1", "t");
        meta.unread_at = Some(900);
        write_record(
            &mut conn,
            &WriteRecord { meta, write_unread_at: true, ..empty_record() },
        )
        .expect("write");
        // The caller asks for a timestamp *below* the watermark; it must still move forward.
        let updated = update_task_state(
            &mut conn,
            "/ws",
            "t1",
            &StatePatch { unread_at: Some(Some(100)), ..StatePatch::default() },
            1_000,
        )
        .expect("state");
        assert!(
            updated.unread_at.expect("unread") > 900,
            "a stale request must not move the version backwards, got {:?}",
            updated.unread_at
        );
    }

    /// The terminal-status guard: a newer `completed` survives a late `running` snapshot, but a
    /// deliberate terminal change still wins.
    #[test]
    fn a_newer_terminal_status_survives_a_late_running_snapshot() {
        let mut existing = task("t1", "t");
        existing.status = Some(crate::meta::PersistStatus::Completed);
        existing.updated_at = 200;

        let mut late = task("t1", "t");
        late.status = Some(crate::meta::PersistStatus::Running);
        late.updated_at = 100;
        assert!(
            should_preserve_newer_terminal_status(Some(&existing), &late),
            "a late running snapshot must not downgrade a completed task"
        );

        // A deliberate terminal change is not blocked, even when it is older.
        let mut deliberate = task("t1", "t");
        deliberate.status = Some(crate::meta::PersistStatus::Error);
        deliberate.updated_at = 50;
        assert!(!should_preserve_newer_terminal_status(Some(&existing), &deliberate));

        // A newer terminal status needs no guard.
        let mut newer = task("t1", "t");
        newer.status = Some(crate::meta::PersistStatus::Completed);
        newer.updated_at = 300;
        assert!(!should_preserve_newer_terminal_status(Some(&existing), &newer));
    }

    /// An agent patch does not overwrite a title the user renamed.
    #[test]
    fn an_agent_patch_leaves_a_user_renamed_title_alone() {
        let mut conn = memory();
        write_record(
            &conn,
            &WriteRecord {
                meta: task("t1", "user's name"),
                title_overridden: true,
                ..empty_record()
            },
        )
        .expect("write");
        let patched = apply_agent_patch(
            &mut conn,
            "/ws",
            "t1",
            Some("agent's title"),
            Some(crate::meta::PersistStatus::Completed),
            None,
            None,
            Some(500),
        )
        .expect("patch")
        .expect("present");
        assert_eq!(patched.title, "user's name", "the user's rename wins");
        assert_eq!(patched.status, Some(crate::meta::PersistStatus::Completed), "the status still moves");

        // Without the override, the agent's title is accepted.
        let mut conn = memory();
        write_record(&mut conn, &WriteRecord { meta: task("t2", "old"), ..empty_record() })
            .expect("write");
        let patched = apply_agent_patch(
            &mut conn,
            "/ws",
            "t2",
            Some("agent's title"),
            None,
            None,
            None,
            Some(500),
        )
        .expect("patch")
        .expect("present");
        assert_eq!(patched.title, "agent's title");
    }

    /// A patch for a missing or deleted task is `None`, not an error: it is normal for the user to
    /// have deleted a task before its last snapshot arrives.
    #[test]
    fn a_patch_for_a_gone_task_is_none_rather_than_an_error() {
        let mut conn = memory();
        assert!(apply_agent_patch(&mut conn, "/ws", "nope", Some("t"), None, None, None, Some(1))
            .expect("patch")
            .is_none());
        let mut deleted = task("t3", "t");
        write_record(
            &mut conn,
            &WriteRecord { meta: deleted.clone(), deleted: true, ..empty_record() },
        )
        .expect("write");
        deleted.task_id = "t3".into();
        assert!(apply_agent_patch(&mut conn, "/ws", "t3", Some("t"), None, None, None, Some(1))
            .expect("patch")
            .is_none());
    }

    /// Deleting an archived task drops its grouping references in the same transaction.
    #[test]
    fn deleting_an_archived_task_drops_its_grouping_references() {
        let mut conn = memory();
        with_group_schema(&conn);
        write_record(
            &conn,
            &WriteRecord { meta: task("t1", "t"), archived: true, ..empty_record() },
        )
        .expect("write");
        conn.execute(
            "INSERT INTO task_group_members VALUES ('g1', '/ws', '/ws', NULL, 't1', 1, 1, 1, 1)",
            [],
        )
        .expect("member");
        conn.execute(
            "INSERT INTO task_group_view_node_orders VALUES ('task', ?, 1, 1, 1)",
            rusqlite::params![task_order_node_key("/ws", "t1").expect("key")],
        )
        .expect("order");

        let deleted = delete_archived_task(&mut conn, "/ws", "t1", 500).expect("delete").expect("deleted");
        let members: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_group_members", [], |row| row.get(0))
            .expect("count");
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_group_view_node_orders", [], |row| row.get(0))
            .expect("count");
        assert_eq!(members, 0, "the membership is gone");
        assert_eq!(orders, 0, "and so is the top-level order");
        assert_eq!(deleted.updated_at, 500);
    }

    /// Deleting a task that is not archived is a no-op, not an error.
    #[test]
    fn deleting_an_unarchived_task_is_a_no_op() {
        let mut conn = memory();
        with_group_schema(&conn);
        write_record(&mut conn, &WriteRecord { meta: task("t1", "t"), ..empty_record() })
            .expect("write");
        assert!(delete_archived_task(&mut conn, "/ws", "t1", 500).expect("delete").is_none());
        let deleted: i64 = conn
            .query_row("SELECT deleted FROM tasks WHERE task_id = 't1'", [], |row| row.get(0))
            .expect("read");
        assert_eq!(deleted, 0, "the row is untouched");
    }

    /// Seeding is idempotent, and a second call returns the stored row rather than overwriting it.
    #[test]
    fn seeding_twice_keeps_the_first_row() {
        let mut conn = memory();
        let first = seed_task_meta_if_missing(&mut conn, "/ws", &task("t1", "original")).expect("seed");
        assert_eq!(first.title, "original");
        let mut different = task("t1", "different");
        different.updated_at = 999;
        let second = seed_task_meta_if_missing(&mut conn, "/ws", &different).expect("seed again");
        assert_eq!(second.title, "original", "a present row is returned, not overwritten");
    }

    /// Clearing unread only happens on an exact match, and a mismatch still reports the current
    /// state.
    #[test]
    fn clearing_unread_is_a_compare_and_set() {
        let mut conn = memory();
        let mut meta = task("t1", "t");
        meta.unread_at = Some(100);
        write_record(&mut conn, &WriteRecord { meta, write_unread_at: true, ..empty_record() })
            .expect("write");

        let mismatch = clear_task_unread_if_matches(&mut conn, "/ws", "t1", 999).expect("clear");
        assert!(!mismatch.cleared, "a stale expectation does not clear");
        assert_eq!(mismatch.meta.unread_at, Some(100), "and the current state is still reported");

        let matched = clear_task_unread_if_matches(&mut conn, "/ws", "t1", 100).expect("clear");
        assert!(matched.cleared);
        assert_eq!(matched.meta.unread_at, None);
    }

    /// The opening repair drops the grouping rows of every deleted task.
    #[test]
    fn the_repair_drops_grouping_rows_of_deleted_tasks() {
        let conn = memory();
        with_group_schema(&conn);
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, created_at,
               updated_at, deleted, meta_json, searchable_text)
             VALUES ('/ws', '/ws', 't1', 't1', 'auto', 1, 1, 1, ?1, '')",
            rusqlite::params![meta_json("t1", 1)],
        )
        .expect("insert");
        conn.execute("INSERT INTO tasks (workspace_key, workspace_path, task_id, title, mode, created_at, updated_at, deleted, meta_json, searchable_text) VALUES ('/ws', '/ws', 'live', 'live', 'auto', 1, 1, 0, '{}', '')", [])
            .expect("insert");
        conn.execute(
            "INSERT INTO task_group_members VALUES ('g1', '/ws', '/ws', NULL, 't1', 1, 1, 1, 1)",
            [],
        )
        .expect("member");

        assert_eq!(cleanup_deleted_grouping_references(&conn).expect("repair"), 1);
        let members: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_group_members", [], |row| row.get(0))
            .expect("count");
        assert_eq!(members, 0);
    }

    /// The search text is truncated by **characters**, so a multi-byte document is not cut
    /// mid-codepoint.
    #[test]
    fn the_search_text_is_truncated_by_character() {
        let long = "क".repeat(TASK_SEARCH_TEXT_MAX_CHARS + 100);
        let truncated = truncate_search_text(&long);
        assert_eq!(truncated.chars().count(), TASK_SEARCH_TEXT_MAX_CHARS);
        assert!(truncated.is_char_boundary(truncated.len()), "no partial codepoint");
    }
}
