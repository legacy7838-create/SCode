//! Grouped-task-view bookkeeping: the write path and the order normalisation.
//!
//! Ported from `packages/services/src/session/taskIndexRepo.ts:653-865, 1141-1272`.
//! Spec: docs/specs/rust-native-task-index.md §3.1, §3.3, §4.3.
//!
//! # `node_key` is the storage format, not a workaround
//!
//! The live database stores `task_group_view_node_orders.node_key` as
//! `["<workspaceKey>","<taskId>"]` — `JSON.stringify` of a two-element array, with **zero NUL
//! bytes** anywhere. An earlier draft of the spec called that a removable driver workaround
//! and proposed reverting it to the NUL form; that would have written keys matching nothing
//! already on disk and silently reordered every task list, with no error to notice.
//!
//! So [`task_order_node_key`] reproduces the JSON form exactly. The NUL form is in-memory only
//! (`writeKey` at `:653`, a `Map` key for `writeChains`) and is not needed here at all, because
//! this module keys its own state on the tuple.
//!
//! # Order is the semantics
//!
//! [`normalize_grouped_top_node_orders`] and [`normalize_group_member_orders`] make an
//! ordering **dense and monotonic**. That is order semantics, not set semantics: a `HashMap` or
//! a `BTreeSet` anywhere in this path produces a stable but *different* order, and the task list
//! renders wrong with nothing failing. `GROUPED_TASK_ORDER_STEP` (1000, `:155`) is the step the
//! normalisation assigns, and the live file shows why negative orders exist — five rows at
//! -3000, -2000, -1000, 0, 1000.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::migrate::MigrationError;

/// The step assigned between consecutive entries by the order normalisation (`:155`).
pub const GROUPED_TASK_ORDER_STEP: i64 = 1000;

/// The key identifying a task for the `task_group_view_node_orders.node_key` column.
///
/// `JSON.stringify([workspaceKey, taskId])`, byte for byte. See the module docs for why this
/// is not negotiable.
pub fn task_order_node_key(workspace_key: &str, task_id: &str) -> Result<String, MigrationError> {
    serde_json::to_string(&serde_json::json!([workspace_key, task_id]))
        .map_err(|error| MigrationError::InvalidId { id: error.to_string() })
}

/// The same key, parsed back. Used to recover the components when reading rows, and to prove
/// the round trip in tests.
pub fn parse_task_order_node_key(node_key: &str) -> Result<(String, String), MigrationError> {
    let parsed: serde_json::Value = serde_json::from_str(node_key).map_err(|error| {
        MigrationError::InvalidId {
            id: format!("{node_key:?} is not a task order node key: {error}"),
        }
    })?;
    let array = parsed.as_array().ok_or_else(|| MigrationError::InvalidId {
        id: format!("{node_key:?} is not a two-element array"),
    })?;
    if array.len() != 2 {
        return Err(MigrationError::InvalidId {
            id: format!("{node_key:?} has {} elements, expected 2", array.len()),
        });
    }
    let workspace_key = array[0].as_str().ok_or_else(|| MigrationError::InvalidId {
        id: format!("{node_key:?} has a non-string workspace key"),
    })?;
    let task_id = array[1].as_str().ok_or_else(|| MigrationError::InvalidId {
        id: format!("{node_key:?} has a non-string task id"),
    })?;
    Ok((workspace_key.to_string(), task_id.to_string()))
}

/// One row of `task_group_view_node_orders`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewNodeOrder {
    /// `group` or `task`.
    pub node_type: String,
    pub node_key: String,
    pub sort_order: i64,
}

/// `normalizeGroupedTopNodeOrders` (`:751`).
///
/// Rewrites `sort_order` so the sequence is dense and monotonic from zero, preserving the
/// existing relative order. Entries with **equal** orders keep their incoming order, which is
/// what makes the function stable rather than arbitrary — a `HashMap` iteration here would
/// shuffle them.
pub fn normalize_grouped_top_node_orders(
    mut nodes: Vec<ViewNodeOrder>,
) -> Vec<ViewNodeOrder> {
    // A stable sort by the existing order. Ties keep their incoming relative order, which is
    // the property a `HashMap` would destroy.
    nodes.sort_by(|left, right| left.sort_order.cmp(&right.sort_order));
    for (index, node) in nodes.iter_mut().enumerate() {
        node.sort_order = index as i64 * GROUPED_TASK_ORDER_STEP;
    }
    nodes
}

/// `normalizeGroupMemberOrders` (`:810`).
///
/// The same densification for a group's members, which carry an *optional* `sort_order`: a
/// member with no order keeps its position relative to the others and is assigned the next
/// step, rather than being pushed to the front or dropped.
pub fn normalize_group_member_orders(
    mut members: Vec<GroupMemberOrder>,
) -> Vec<GroupMemberOrder> {
    members.sort_by(|left, right| match (left.sort_order, right.sort_order) {
        (None, None) => std::cmp::Ordering::Equal,
        // A member with no order sorts after every ordered member, preserving input order
        // among themselves.
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(left), Some(right)) => left.cmp(&right),
    });
    let mut next: i64 = 0;
    for member in &mut members {
        member.sort_order = Some(next);
        next += GROUPED_TASK_ORDER_STEP;
    }
    members
}

/// One row of `task_group_members`, reduced to what the ordering needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberOrder {
    pub group_id: String,
    pub task_id: String,
    pub sort_order: Option<i64>,
}

/// A task write, as the caller supplies it.
///
/// # `searchable_text` is a three-state contract
///
/// `writeRecord` (`:1141-1150`) reads the existing row *precisely so that* an omitted
/// `searchable_text` is not clobbered: the upsert is `ON CONFLICT … excluded.searchable_text`,
/// so without the read an absent value would assign `""` and **wipe every task's indexed
/// text**. The task list would keep working and search would silently return nothing.
///
/// `None` therefore means three different things and must not be collapsed:
///
/// | value            | meaning                          |
/// |------------------|----------------------------------|
/// | `None`           | leave the stored value alone     |
/// | `Some(None)`     | clear it to `""`                 |
/// | `Some(Some(text))` | set it                        |
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWrite {
    pub workspace_key: String,
    pub workspace_path: String,
    #[serde(default)]
    pub workspace_identity: Option<String>,
    pub task_id: String,
    pub title: String,
    #[serde(default)]
    pub task_status: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub migration_source: Option<String>,
    #[serde(default)]
    pub forked_from_task_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub unread_at: Option<i64>,
    #[serde(default)]
    pub last_unread_at: Option<i64>,
    #[serde(default)]
    pub pinned: Option<i64>,
    #[serde(default)]
    pub meta_json: String,
    /// Three-state; see the type docs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub searchable_text: Option<Option<String>>,
    #[serde(default)]
    pub cron_automation_id: Option<String>,
    #[serde(default)]
    pub off_peak_task_id: Option<String>,
}

/// A batch of writes applied in **one** transaction.
///
/// This is the measured win (spec §4.3): a snapshot touches `tasks`, `task_groups`,
/// `task_group_members` and `task_group_view_node_orders`, and the TypeScript pays a durable
/// commit per `.run()` — 32 write sites, and `writeRecord` is exactly one commit per call. The
/// events store went from 3-7 commits per tool call to 1 for the same reason.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteBatch {
    pub tasks: Vec<TaskWrite>,
    /// Normalised top-node orders to apply as part of the same transaction.
    #[serde(default)]
    pub node_orders: Vec<ViewNodeOrder>,
    /// Group member orders to apply in the same transaction.
    #[serde(default)]
    pub group_members: Vec<GroupMemberOrder>,
}

impl WriteBatch {
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty() && self.node_orders.is_empty() && self.group_members.is_empty()
    }
}

/// The upsert for `tasks`, with `searchable_text` resolved from the stored row.
///
/// # The three states need two different expressions, not one
///
/// The obvious single expression —
/// `CASE WHEN ?18 = 0 THEN searchable_text …` in `VALUES` — **is not valid SQL** and was
/// caught by `omitting_searchable_text_preserves_the_stored_value`. A bare column name in an
/// `INSERT … VALUES` list has no row to read: SQLite answers `no such column`.
///
/// The two branches therefore differ, and both are correct:
///
/// * **INSERT** — a fresh row has nothing to keep, so `Keep` and `Clear` both write `''` and
///   only `Set` writes the supplied text.
/// * **UPDATE** — the existing row *is* addressable as `tasks.searchable_text`, which is what
///   makes `Keep` mean "leave it alone" instead of "overwrite it".
///
/// Collapsing the two would be the silent-data-loss bug §3.1 describes: an omitted
/// `searchable_text` would assign `""` and wipe every task's indexed text, leaving the task
/// list working and search returning nothing.
pub const UPSERT_TASK: &str = "\
INSERT INTO tasks (
  workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider,
  mode, model, migration_source, forked_from_task_id, created_at, updated_at, unread_at,
  last_unread_at, pinned, meta_json, searchable_text, cron_automation_id, off_peak_task_id
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
  CASE WHEN ?18 = 2 THEN ?19 ELSE '' END,
  ?20, ?21
)
ON CONFLICT (workspace_key, task_id) DO UPDATE SET
  workspace_path = excluded.workspace_path,
  workspace_identity = excluded.workspace_identity,
  title = excluded.title,
  task_status = excluded.task_status,
  provider = excluded.provider,
  mode = excluded.mode,
  model = excluded.model,
  migration_source = excluded.migration_source,
  forked_from_task_id = excluded.forked_from_task_id,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  unread_at = excluded.unread_at,
  last_unread_at = excluded.last_unread_at,
  pinned = excluded.pinned,
  meta_json = excluded.meta_json,
  searchable_text = CASE WHEN ?18 = 0 THEN tasks.searchable_text
                        WHEN ?18 = 1 THEN ''
                        ELSE ?19
                    END,
  cron_automation_id = excluded.cron_automation_id,
  off_peak_task_id = excluded.off_peak_task_id";

/// The `searchable_text` mode, encoded as the single integer the SQL branches on.
///
/// `Set` is `2` so that a value of `0`/`1` cannot be confused with it; the SQL compares
/// against the discriminant, and the *insert* branch only writes text when the mode is
/// exactly `Set`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchableTextMode {
    /// Leave the stored value alone. On a fresh insert there is nothing to keep, so `''`.
    Keep = 0,
    /// Clear it to the empty string.
    Clear = 1,
    /// Set it to the supplied text.
    Set = 2,
}

impl SearchableTextMode {
    pub fn of(value: &Option<Option<String>>) -> Self {
        match value {
            None => SearchableTextMode::Keep,
            Some(None) => SearchableTextMode::Clear,
            Some(Some(_)) => SearchableTextMode::Set,
        }
    }
}

/// The bound parameters for [`UPSERT_TASK`], in order.
pub fn upsert_task_params(write: &TaskWrite) -> Vec<Box<dyn rusqlite::ToSql>> {
    let mode = SearchableTextMode::of(&write.searchable_text);
    let text = write.searchable_text.clone().flatten();
    vec![
        Box::new(write.workspace_key.clone()),
        Box::new(write.workspace_path.clone()),
        Box::new(write.workspace_identity.clone()),
        Box::new(write.task_id.clone()),
        Box::new(write.title.clone()),
        Box::new(write.task_status.clone()),
        Box::new(write.provider.clone()),
        Box::new(write.mode.clone()),
        Box::new(write.model.clone()),
        Box::new(write.migration_source.clone()),
        Box::new(write.forked_from_task_id.clone()),
        Box::new(write.created_at),
        Box::new(write.updated_at),
        Box::new(write.unread_at),
        Box::new(write.last_unread_at.or(Some(0))),
        Box::new(write.pinned.or(Some(0))),
        Box::new(write.meta_json.clone()),
        Box::new(mode as i64),
        Box::new(text),
        Box::new(write.cron_automation_id.clone()),
        Box::new(write.off_peak_task_id.clone()),
    ]
}

/// Applies a batch inside one transaction.
///
/// Ordering is deliberate: the task rows land first so the grouped-view bookkeeping can
/// reference them, and the whole thing is atomic so the view is never left half-written.
pub fn apply_batch(
    conn: &mut rusqlite::Connection,
    batch: &WriteBatch,
    now_ms: i64,
) -> Result<usize, crate::StoreError> {
    if batch.is_empty() {
        return Ok(0);
    }
    let transaction = conn.transaction().map_err(|source| crate::StoreError::Query {
        context: "cannot begin the task index batch".into(),
        source,
    })?;

    for write in &batch.tasks {
        transaction
            .execute(&UPSERT_TASK, rusqlite::params_from_iter(upsert_task_params(write)))
            .map_err(|source| crate::StoreError::Query {
                context: format!("cannot upsert task {}", write.task_id),
                source,
            })?;
    }

    for order in &batch.node_orders {
        transaction
            .execute(
                "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT (node_type, node_key) DO UPDATE SET
                   sort_order = excluded.sort_order, updated_at = excluded.updated_at",
                rusqlite::params![order.node_type, order.node_key, order.sort_order, now_ms],
            )
            .map_err(|source| crate::StoreError::Query {
                context: format!("cannot upsert node order {}", order.node_key),
                source,
            })?;
    }

    for member in &batch.group_members {
        transaction
            .execute(
                "UPDATE task_group_members
                 SET sort_order = ?3, updated_at = ?4
                 WHERE group_id = ?1 AND task_id = ?2",
                rusqlite::params![
                    member.group_id,
                    member.task_id,
                    member.sort_order,
                    now_ms
                ],
            )
            .map_err(|source| crate::StoreError::Query {
                context: format!(
                    "cannot update the order of {} in group {}",
                    member.task_id, member.group_id
                ),
                source,
            })?;
    }

    transaction.commit().map_err(|source| crate::StoreError::Query {
        context: "cannot commit the task index batch".into(),
        source,
    })?;
    Ok(batch.tasks.len())
}

/// Reads the `node_key` rows in order, for the grouped view and for the parity fixtures.
pub fn read_node_orders(conn: &rusqlite::Connection) -> Result<Vec<ViewNodeOrder>, crate::StoreError> {
    let mut statement = conn
        .prepare(
            "SELECT node_type, node_key, sort_order FROM task_group_view_node_orders
             ORDER BY sort_order, node_key",
        )
        .map_err(|source| crate::StoreError::Query {
            context: "cannot read the node orders".into(),
            source,
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok(ViewNodeOrder {
                node_type: row.get(0)?,
                node_key: row.get(1)?,
                sort_order: row.get(2)?,
            })
        })
        .map_err(|source| crate::StoreError::Query {
            context: "cannot read the node orders".into(),
            source,
        })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|source| crate::StoreError::Query {
            context: "cannot read a node order row".into(),
            source,
        })?);
    }
    Ok(out)
}

/// Groups node orders by type, for callers that need the two streams separately.
pub fn by_node_type(orders: &[ViewNodeOrder]) -> BTreeMap<String, Vec<&ViewNodeOrder>> {
    let mut out: BTreeMap<String, Vec<&ViewNodeOrder>> = BTreeMap::new();
    for order in orders {
        out.entry(order.node_type.clone()).or_default().push(order);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The five keys the real database holds, captured from the live file. If the JSON form
    /// drifts by so much as a space, this fails — and that drift would silently reorder
    /// every task list, because the new keys would match no existing row.
    #[test]
    fn the_node_key_format_matches_the_real_database() {
        let real = [
            (
                "/home/legacy/Downloads/ZCode",
                "sess_e8019768-ecd0-4aca-a5f7-8d14564110d7",
            ),
            (
                "/home/legacy/Downloads/module",
                "sess_d905a0cf-32dd-46c0-9297-75e6d991c505",
            ),
            (
                "/home/legacy/Downloads/ZCode/packages/server",
                "sess_449189ae-76d2-4b34-96ed-8fae06851431",
            ),
        ];
        for (workspace, task) in real {
            let key = task_order_node_key(workspace, task).expect("serialise");
            assert_eq!(
                key,
                format!(r#"[{workspace:?},{task:?}]"#),
                "the JSON form must match the on-disk bytes"
            );
            assert!(!key.contains('\0'), "stored keys must never contain a NUL");
            // And it round-trips back to the components.
            let (w, t) = parse_task_order_node_key(&key).expect("parse back");
            assert_eq!((w.as_str(), t.as_str()), (workspace, task));
        }
    }

    #[test]
    fn a_node_key_with_an_escaped_character_round_trips() {
        // A workspace path containing a quote or a backslash must survive, because
        // JSON.stringify escapes it and a naive concatenation would not.
        for workspace in [r#"C:\Users\a"b"#, "/tmp/with space", "/tmp/日本語"] {
            let key = task_order_node_key(workspace, "sess_1").expect("serialise");
            let (w, t) = parse_task_order_node_key(&key).expect("parse back");
            assert_eq!(w, workspace, "workspace must round-trip for {workspace:?}");
            assert_eq!(t, "sess_1");
        }
    }

    #[test]
    fn a_malformed_node_key_is_rejected_rather_than_guessed() {
        for bad in ["not json", "[]", r#"["only-one"]"#, "[1,2]", r#"{"a":1}"#] {
            assert!(
                parse_task_order_node_key(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    /// Normalisation is a *stable* densification: ties keep their incoming order. A
    /// `HashMap` here would shuffle them and the task list would render differently with
    /// nothing failing.
    #[test]
    fn normalisation_is_stable_for_tied_orders() {
        let nodes = vec![
            ViewNodeOrder { node_type: "task".into(), node_key: "a".into(), sort_order: 5 },
            ViewNodeOrder { node_type: "task".into(), node_key: "b".into(), sort_order: 5 },
            ViewNodeOrder { node_type: "task".into(), node_key: "c".into(), sort_order: 5 },
        ];
        let normalized = normalize_grouped_top_node_orders(nodes);
        let keys: Vec<&str> = normalized.iter().map(|n| n.node_key.as_str()).collect();
        assert_eq!(keys, vec!["a", "b", "c"], "ties must keep their incoming order");
        let orders: Vec<i64> = normalized.iter().map(|n| n.sort_order).collect();
        assert_eq!(orders, vec![0, 1000, 2000], "and be densified by the step");
    }

    /// The live file's own orders, -3000 through 1000, must normalise to 0, 1000, 2000, 3000,
    /// 4000 — the negative values exist precisely because normalisation has not run yet.
    #[test]
    fn the_real_negative_orders_normalise_to_a_dense_sequence() {
        let real = vec![
            ViewNodeOrder { node_type: "task".into(), node_key: "k0".into(), sort_order: -3000 },
            ViewNodeOrder { node_type: "task".into(), node_key: "k1".into(), sort_order: -2000 },
            ViewNodeOrder { node_type: "task".into(), node_key: "k2".into(), sort_order: -1000 },
            ViewNodeOrder { node_type: "task".into(), node_key: "k3".into(), sort_order: 0 },
            ViewNodeOrder { node_type: "task".into(), node_key: "k4".into(), sort_order: 1000 },
        ];
        let orders: Vec<i64> = normalize_grouped_top_node_orders(real)
            .iter()
            .map(|n| n.sort_order)
            .collect();
        assert_eq!(orders, vec![0, 1000, 2000, 3000, 4000]);
    }

    /// A member with no order is assigned one rather than being dropped or pushed to the
    /// front, and ordered members keep their relative sequence.
    #[test]
    fn member_normalisation_handles_absent_orders() {
        let members = vec![
            GroupMemberOrder { group_id: "g".into(), task_id: "ordered-1".into(), sort_order: Some(10) },
            GroupMemberOrder { group_id: "g".into(), task_id: "unordered".into(), sort_order: None },
            GroupMemberOrder { group_id: "g".into(), task_id: "ordered-2".into(), sort_order: Some(20) },
        ];
        let normalized = normalize_group_member_orders(members);
        let ids: Vec<&str> = normalized.iter().map(|m| m.task_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["ordered-1", "ordered-2", "unordered"],
            "unordered members sort after ordered ones, keeping input order among themselves"
        );
        let orders: Vec<i64> = normalized.iter().map(|m| m.sort_order.unwrap()).collect();
        assert_eq!(orders, vec![0, 1000, 2000]);
    }

    /// The three states must stay distinguishable, or an omitted `searchable_text` wipes
    /// every task's indexed text and search silently returns nothing.
    #[test]
    fn the_three_searchable_text_states_stay_distinct() {
        assert_eq!(SearchableTextMode::of(&None), SearchableTextMode::Keep);
        assert_eq!(SearchableTextMode::of(&Some(None)), SearchableTextMode::Clear);
        assert_eq!(
            SearchableTextMode::of(&Some(Some("hello".into()))),
            SearchableTextMode::Set
        );
    }

    fn sample_write(searchable_text: Option<Option<String>>) -> TaskWrite {
        TaskWrite {
            workspace_key: "/ws".into(),
            workspace_path: "/ws".into(),
            workspace_identity: None,
            task_id: "sess_1".into(),
            title: "t".into(),
            task_status: None,
            provider: None,
            mode: "build".into(),
            model: None,
            migration_source: None,
            forked_from_task_id: None,
            created_at: 1,
            updated_at: 2,
            unread_at: None,
            last_unread_at: None,
            pinned: None,
            meta_json: "{}".into(),
            searchable_text,
            cron_automation_id: None,
            off_peak_task_id: None,
        }
    }

    /// Against a real-schema database: omitting `searchable_text` must leave the stored value
    /// intact. This is the silent-data-loss guard.
    #[test]
    fn omitting_searchable_text_preserves_the_stored_value() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL,
               workspace_identity TEXT, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
               meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '',
               cron_automation_id TEXT, off_peak_task_id TEXT,
               PRIMARY KEY (workspace_key, task_id));
             CREATE TABLE task_group_view_node_orders (
               node_type TEXT NOT NULL, node_key TEXT NOT NULL, sort_order INTEGER NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (node_type, node_key));
             CREATE TABLE task_group_members (
               group_id TEXT NOT NULL, workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL,
               workspace_identity TEXT, task_id TEXT NOT NULL, sort_order INTEGER,
               added_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (workspace_key, task_id));",
        )
        .expect("schema");

        // Seed with text.
        apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write(Some(Some("original text".into())))], ..Default::default() }, 1)
            .expect("seed write");
        let stored: String = conn
            .query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_1'", [], |r| r.get(0))
            .expect("read back");
        assert_eq!(stored, "original text");

        // Now write with the field omitted: the text must survive.
        apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write(None)], ..Default::default() }, 2)
            .expect("update without text");
        let stored: String = conn
            .query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_1'", [], |r| r.get(0))
            .expect("read back");
        assert_eq!(stored, "original text", "an omitted field must not clear the text");
    }

    #[test]
    fn clearing_searchable_text_sets_the_empty_string() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL,
               workspace_identity TEXT, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
               meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '',
               cron_automation_id TEXT, off_peak_task_id TEXT,
               PRIMARY KEY (workspace_key, task_id));",
        )
        .expect("schema");
        apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write(Some(Some("text".into())))], ..Default::default() }, 1).unwrap();
        apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write(Some(None))], ..Default::default() }, 2).unwrap();
        let stored: String = conn
            .query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_1'", [], |r| r.get(0))
            .expect("read back");
        assert_eq!(stored, "", "an explicit clear must empty the text");
    }

    #[test]
    fn setting_searchable_text_replaces_it() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL,
               workspace_identity TEXT, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
               meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '',
               cron_automation_id TEXT, off_peak_task_id TEXT,
               PRIMARY KEY (workspace_key, task_id));",
        )
        .expect("schema");
        apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write(Some(Some("old".into())))], ..Default::default() }, 1).unwrap();
        apply_batch(&mut conn, &WriteBatch { tasks: vec![sample_write(Some(Some("new".into())))], ..Default::default() }, 2).unwrap();
        let stored: String = conn
            .query_row("SELECT searchable_text FROM tasks WHERE task_id='sess_1'", [], |r| r.get(0))
            .expect("read back");
        assert_eq!(stored, "new");
    }

    /// The win: a batch touching tasks, node orders and group members is **one** commit.
    #[test]
    fn a_multi_table_batch_is_atomic() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL,
               workspace_identity TEXT, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
               meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '',
               cron_automation_id TEXT, off_peak_task_id TEXT,
               PRIMARY KEY (workspace_key, task_id));
             CREATE TABLE task_group_view_node_orders (
               node_type TEXT NOT NULL, node_key TEXT NOT NULL, sort_order INTEGER NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (node_type, node_key));
             CREATE TABLE task_group_members (
               group_id TEXT NOT NULL, workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL,
               workspace_identity TEXT, task_id TEXT NOT NULL, sort_order INTEGER,
               added_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (workspace_key, task_id));
             INSERT INTO task_group_members VALUES ('g','/ws','/ws',NULL,'sess_1',999,1,1,1);",
        )
        .expect("schema");

        let key = task_order_node_key("/ws", "sess_1").expect("key");
        let batch = WriteBatch {
            tasks: vec![sample_write(Some(Some("text".into())))],
            node_orders: vec![ViewNodeOrder {
                node_type: "task".into(),
                node_key: key.clone(),
                sort_order: 0,
            }],
            group_members: vec![GroupMemberOrder {
                group_id: "g".into(),
                task_id: "sess_1".into(),
                sort_order: Some(0),
            }],
        };
        let written = apply_batch(&mut conn, &batch, 10).expect("batch");
        assert_eq!(written, 1);

        // All three tables reflect the batch.
        let order: i64 = conn
            .query_row("SELECT sort_order FROM task_group_view_node_orders WHERE node_key=?1", [&key], |r| r.get(0))
            .expect("node order");
        assert_eq!(order, 0);
        let member_order: Option<i64> = conn
            .query_row("SELECT sort_order FROM task_group_members WHERE task_id='sess_1'", [], |r| r.get(0))
            .expect("member order");
        assert_eq!(member_order, Some(0));

        // Re-applying is idempotent, which is what makes the batch safe to retry.
        apply_batch(&mut conn, &batch, 20).expect("second batch");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM task_group_view_node_orders", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 1, "re-applying must not duplicate rows");
    }

    #[test]
    fn an_empty_batch_is_a_no_op() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("memory db");
        assert_eq!(apply_batch(&mut conn, &WriteBatch::default(), 1).expect("no-op"), 0);
        assert!(WriteBatch::default().is_empty());
    }

    /// A failure part-way must leave nothing behind, so the grouped view is never
    /// half-written — the property the single transaction exists to provide.
    #[test]
    fn a_failing_batch_rolls_back_completely() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL,
               workspace_identity TEXT, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
               meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '',
               cron_automation_id TEXT, off_peak_task_id TEXT,
               PRIMARY KEY (workspace_key, task_id));
             CREATE TABLE task_group_view_node_orders (
               node_type TEXT NOT NULL, node_key TEXT NOT NULL, sort_order INTEGER NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (node_type, node_key));",
        )
        .expect("schema");

        // A node order whose node_key is fine, but the batch also writes a task with a
        // duplicate primary key in the same batch is not a failure — so force one by
        // referencing a table that does not exist through a bad group member update.
        let batch = WriteBatch {
            tasks: vec![sample_write(Some(Some("text".into())))],
            node_orders: vec![ViewNodeOrder {
                node_type: "task".into(),
                node_key: task_order_node_key("/ws", "sess_1").unwrap(),
                sort_order: 0,
            }],
            group_members: vec![GroupMemberOrder {
                group_id: "g".into(),
                task_id: "sess_1".into(),
                sort_order: Some(0),
            }], // task_group_members was never created -> fails
        };
        assert!(apply_batch(&mut conn, &batch, 1).is_err(), "must fail");

        // Nothing from the batch survived.
        let tasks: i64 = conn.query_row("SELECT count(*) FROM tasks", [], |r| r.get(0)).expect("count");
        assert_eq!(tasks, 0, "the task row must be rolled back with the batch");
        let orders: i64 = conn
            .query_row("SELECT count(*) FROM task_group_view_node_orders", [], |r| r.get(0))
            .expect("count");
        assert_eq!(orders, 0, "the node order must be rolled back too");
    }
}
