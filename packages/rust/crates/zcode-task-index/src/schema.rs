//! The frozen task-index schema and migration ledger.
//!
//! Spec: docs/specs/rust-native-task-index.md §28.
//!
//! This module is the **migration source**: the DDL, the ALTER list, the indexes, the two frozen
//! migration payloads (`0002`, `0003`) and the checksum inputs. It used to be
//! `packages/services/src/session/tasksDatabase/*` in TypeScript. It is Rust now, because a
//! module that owns a persisted file's schema, its ledger and its startup lock has no business
//! behind a JavaScript fallback (docs/specs/rust-native-ports.md invariant 1).
//!
//! # The checksum contract
//!
//! The ledger checksum is `sha256(JSON.stringify(checksumInput))` — **not**
//! `sha256(trimmed SQL)` as the events store uses. Reproducing `JSON.stringify` in Rust is the
//! risk that kept this in TypeScript; it is safe here because the inputs are **frozen constants**
//! and the result is pinned against the real ledger by
//! `tests/real_database.rs::the_three_checksums_match_the_real_ledger`. `serde_json` emits
//! non-ASCII raw and escapes control characters as `\n`/`\uXXXX`, exactly as V8 does.
//!
//! The serialised inputs are computed by `migration_definitions()`, which serialises a
//! `serde_json::Value` built from these constants — the same shape `JSON.stringify` produced.

use crate::migrate::Migration;
use crate::provider_selection::migration_0002_sql;
use serde_json::{json, Value};

pub const TASK_INDEX_SCHEMA: &str = r#"
      CREATE TABLE IF NOT EXISTS tasks (
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        task_status TEXT,
        provider TEXT,
        mode TEXT NOT NULL DEFAULT 'build',
        model TEXT,
        migration_source TEXT,
        forked_from_task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        unread_at INTEGER,
        last_unread_at INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        title_overridden INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (workspace_key, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_archived_updated
      ON tasks (workspace_key, archived, updated_at DESC)
      WHERE deleted = 0;

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_pinned_updated
      ON tasks (workspace_key, pinned, updated_at DESC)
      WHERE deleted = 0;

      CREATE TABLE IF NOT EXISTS task_groups (
        group_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'gray',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_group_members (
        group_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        sort_order INTEGER,
        added_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_key, task_id),
        FOREIGN KEY (group_id) REFERENCES task_groups(group_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_group_view_node_orders (
        node_type TEXT NOT NULL,
        node_key TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (node_type, node_key)
      );

      CREATE TABLE IF NOT EXISTS task_group_workspace_bootstraps (
        workspace_key TEXT PRIMARY KEY,
        group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_group_members_group_order
      ON task_group_members (group_id, sort_order, added_at);

      CREATE INDEX IF NOT EXISTS idx_task_group_view_node_orders_order
      ON task_group_view_node_orders (sort_order, created_at);
    "#;

pub const AUTOMATION_SCHEMA: &str = r#"
      CREATE TABLE IF NOT EXISTS automations (
        automation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        mode TEXT,
        thought_level TEXT,
        model_selection TEXT,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        target_task_id TEXT,
        bot_delivery_target TEXT,
        location_kind TEXT NOT NULL DEFAULT 'local',
        recurring INTEGER NOT NULL DEFAULT 1,
        max_runs INTEGER,
        end_at INTEGER,
        schedule_rule TEXT,
        schedule_edited_by_user INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0,
        scheduled_run_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        next_run_at INTEGER,
        last_run_at INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        dispatch_status TEXT NOT NULL DEFAULT 'idle',
        dispatch_attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automations_due
      ON automations (enabled, next_run_at);

      CREATE INDEX IF NOT EXISTS idx_automations_retry
      ON automations (enabled, retry_at);

      CREATE INDEX IF NOT EXISTS idx_automations_workspace
      ON automations (workspace_key);

      CREATE TABLE IF NOT EXISTS automation_runs (
        run_id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        scheduled_at INTEGER,
        trigger TEXT NOT NULL DEFAULT 'schedule',
        model_selection TEXT,
        dispatch_status TEXT NOT NULL DEFAULT 'claimed',
        outcome TEXT,
        session_id TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automation_runs_by_automation
      ON automation_runs (automation_id, created_at DESC);
    "#;

pub const OFF_PEAK_SCHEMA: &str = r#"
      CREATE TABLE IF NOT EXISTS off_peak_tasks (
        off_peak_task_id   TEXT PRIMARY KEY,
        server_ticket_id   TEXT,
        title              TEXT NOT NULL DEFAULT '',
        conversation_id    TEXT,
        session_id         TEXT,
        prompt             TEXT NOT NULL,
        permission_mode    TEXT NOT NULL,
        model              TEXT,
        thought_level      TEXT,
        model_selection    TEXT,
        workspace_key      TEXT NOT NULL,
        workspace_path     TEXT NOT NULL,
        workspace_identity TEXT,
        status             TEXT NOT NULL,
        queued_at          INTEGER NOT NULL,
        started_at         INTEGER,
        ended_at           INTEGER,
        failure_reason     TEXT,
        files_changed      INTEGER,
        settled_at         INTEGER,
        history_deleted_at INTEGER,
        registered_at      INTEGER,
        schedulable        INTEGER NOT NULL DEFAULT 0,
        queue_position     INTEGER,
        next_poll_at       INTEGER,
        claim_running      INTEGER NOT NULL DEFAULT 0,
        claimed_at         INTEGER,
        attempt_count      INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_off_peak_pick
      ON off_peak_tasks (status, queued_at);

      CREATE INDEX IF NOT EXISTS idx_off_peak_ws
      ON off_peak_tasks (workspace_key, status);
    "#;

pub const INDEXES: &str = r#"
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
"#;

pub const BOUND_INDEX: &str = r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE session_id IS NOT NULL AND status NOT IN ('completed','failed','cancelled')"#;

pub const OFFICIAL_GLM_SELECTION_SQL: &str = r#"
UPDATE automations
SET model_selection = json_set(model_selection, '$.modelId',
  CASE lower(json_extract(model_selection, '$.modelId'))
    WHEN 'glm-5.3' THEN 'GLM-5.3'
    WHEN 'glm-5.3-flash' THEN 'GLM-5.3-Flash'
    WHEN 'glm-5v-turbo' THEN 'GLM-5V-Turbo'
    WHEN 'glm-5.2' THEN 'GLM-5.2'
    WHEN 'glm-5.1' THEN 'GLM-5.1'
    WHEN 'glm-5.1-highspeed' THEN 'GLM-5.1-Highspeed'
    WHEN 'glm-5' THEN 'GLM-5'
    WHEN 'glm-5-turbo' THEN 'GLM-5-Turbo'
    WHEN 'glm-4.7' THEN 'GLM-4.7'
    WHEN 'glm-4.7-flashx' THEN 'GLM-4.7-FlashX'
    WHEN 'glm-4.7-flash' THEN 'GLM-4.7-Flash'
    WHEN 'glm-4.6' THEN 'GLM-4.6'
    WHEN 'glm-4.5-air' THEN 'GLM-4.5-Air'
    WHEN 'glm-4.5' THEN 'GLM-4.5'
    WHEN 'glm-4.6v' THEN 'GLM-4.6V'
    WHEN 'glm-4.6v-flash' THEN 'GLM-4.6V-Flash'
    WHEN 'glm-4.6v-flashx' THEN 'GLM-4.6V-FlashX'
    WHEN 'glm-4.1v-thinking-flashx' THEN 'GLM-4.1V-Thinking-FlashX'
    WHEN 'glm-4.1v-thinking-flash' THEN 'GLM-4.1V-Thinking-Flash'
    WHEN 'glm-4-flashx-250414' THEN 'GLM-4-FlashX-250414'
    WHEN 'glm-4-flash-250414' THEN 'GLM-4-Flash-250414'
    WHEN 'glm-4v-flash' THEN 'GLM-4V-Flash'
    ELSE json_extract(model_selection, '$.modelId')
  END)
WHERE CASE WHEN json_valid(model_selection) THEN
  json_extract(model_selection, '$.providerId') IN ('account:zai-start-plan', 'account:bigmodel-start-plan', 'account:zai-individual-coding-plan', 'account:bigmodel-individual-coding-plan', 'account:zai-team-coding-plan', 'account:bigmodel-team-coding-plan')
  AND lower(json_extract(model_selection, '$.modelId')) IN ('glm-5.3', 'glm-5.3-flash', 'glm-5v-turbo', 'glm-5.2', 'glm-5.1', 'glm-5.1-highspeed', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx', 'glm-4.7-flash', 'glm-4.6', 'glm-4.5-air', 'glm-4.5', 'glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx', 'glm-4.1v-thinking-flashx', 'glm-4.1v-thinking-flash', 'glm-4-flashx-250414', 'glm-4-flash-250414', 'glm-4v-flash')
  ELSE 0 END;
"#;

/// `TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA` — the DDL both runners start from.
pub fn schema_ddl() -> String {
    format!("{TASK_INDEX_SCHEMA}{AUTOMATION_SCHEMA}{OFF_PEAK_SCHEMA}")
}

/// The frozen `ALTER TABLE` list. Declared as data because the `0001` checksum depends on it:
/// a tuple per row, exactly the nested `string[][]` that makes this store's checksum different
/// from the events port's.
pub const COLUMNS: &[(&str, &str, &str)] = &[
    ("tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"),
    ("tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"),
    ("tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"),
    ("tasks", "cron_automation_id", "TEXT"),
    ("tasks", "off_peak_task_id", "TEXT"),
    ("automations", "target_task_id", "TEXT"),
    ("automations", "bot_delivery_target", "TEXT"),
    ("automations", "mode", "TEXT"),
    ("automations", "end_at", "INTEGER"),
    ("automations", "schedule_rule", "TEXT"),
    ("automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"),
    ("automations", "thought_level", "TEXT"),
    ("automations", "model_selection", "TEXT"),
    ("automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"),
    ("automation_runs", "model_selection", "TEXT"),
    ("off_peak_tasks", "thought_level", "TEXT"),
    ("off_peak_tasks", "model_selection", "TEXT"),
    ("off_peak_tasks", "history_deleted_at", "INTEGER"),
];

/// The frozen terminal-status predicate used by the bound index and the duplicate check.
pub const TERMINAL_STATUSES: &str = "'completed','failed','cancelled'";

/// The active-predicate substring from the TypeScript
/// (`session_id IS NOT NULL AND status NOT IN (...)`).
pub fn active_predicate() -> String {
    format!("session_id IS NOT NULL AND status NOT IN ({TERMINAL_STATUSES})")
}

/// Whether a schema already declares a column, matched inside its `CREATE TABLE <table> (` block.
///
/// Two rows of `COLUMNS` — `tasks.title_overridden` and `tasks.last_unread_at` — are already
/// inside `TASK_INDEX_SCHEMA`, so a literal `ALTER` list fails on a fresh file with
/// `duplicate column name`. The live runner filtered with `PRAGMA table_info`; the native runner
/// receives plain SQL, so the filter is folded into the string, exactly as the deleted
/// TypeScript did statically.
fn schema_already_declares(table: &str, column: &str) -> bool {
    let ddl = schema_ddl();
    let marker = format!("CREATE TABLE IF NOT EXISTS {table} (");
    let Some(start) = ddl.find(&marker) else {
        return false;
    };
    let body = &ddl[start + marker.len()..];
    let block = match body.find("\n      )") {
        Some(end) => &body[..end],
        None => body,
    };
    block
        .split('\n')
        .any(|line| line.trim_start().starts_with(&format!("{column} ")))
}

/// `0001`'s body: the three schemas, the filtered `ALTER TABLE` list, the indexes and the bound
/// index.
///
/// The `scheduled_run_count` backfill stays attached to its `ALTER`, as in the migration, and is
/// **not** produced when that column already exists.
pub fn adopt_task_schema_sql() -> String {
    let mut statements: Vec<String> = Vec::new();
    for (table, column, definition) in COLUMNS {
        if schema_already_declares(table, column) {
            continue;
        }
        statements.push(format!("ALTER TABLE {table} ADD COLUMN {column} {definition};"));
        if *table == "automations" && *column == "scheduled_run_count" {
            statements.push("UPDATE automations SET scheduled_run_count=run_count;".to_string());
        }
    }
    format!(
        "{}\n{}\n{}{}",
        schema_ddl(),
        statements.join("\n"),
        INDEXES,
        BOUND_INDEX
    )
}

/// The `0001` checksum input as a `serde_json::Value`: three schemas, the nested column tuples,
/// the index blob, the bound index and the backfill marker.
fn migration_0001_checksum_input() -> Value {
    let columns: Vec<Value> = COLUMNS
        .iter()
        .map(|(table, column, definition)| json!([table, column, definition]))
        .collect();
    json!([
        TASK_INDEX_SCHEMA,
        AUTOMATION_SCHEMA,
        OFF_PEAK_SCHEMA,
        Value::Array(columns),
        INDEXES,
        BOUND_INDEX,
        "scheduled-count-backfill-v1",
    ])
}

/// The `0002` checksum input: two marker strings. A pure literal, so it is asserted directly
/// against the real ledger.
pub const MIGRATION_0002_CHECKSUM_INPUT: &str =
    r#"["legacy-automation-selection-v1","no-provider-for-legacy-off-peak-v1"]"#;

/// One frozen migration: the ledger id, the checksum input JSON and the payload builder.
pub struct MigrationDef {
    pub id: &'static str,
    pub checksum_input_json: String,
}

/// The migration list, in order, with their serialised checksum inputs.
///
/// The checksums are the real ledger's (`3e8337b0…`, `7244ef7c…`, `8987adb5…`) and are pinned
/// by both a literal unit test and the real-database integration test.
pub fn migration_definitions() -> Vec<MigrationDef> {
    vec![
        MigrationDef {
            id: "0001_adopt_task_schema",
            checksum_input_json: serde_json::to_string(&migration_0001_checksum_input())
                .expect("0001 checksum input serialises"),
        },
        MigrationDef {
            id: "0002_provider_selection",
            checksum_input_json: MIGRATION_0002_CHECKSUM_INPUT.to_string(),
        },
        MigrationDef {
            id: "0003_official_glm_selection",
            checksum_input_json: serde_json::to_string(&json!([OFFICIAL_GLM_SELECTION_SQL]))
                .expect("0003 checksum input serialises"),
        },
    ]
}

/// The migrations **with their SQL payloads**, for a live connection.
///
/// `0001` and `0003` are static; `0002` reads the current rows (the frozen decode depends on the
/// rows that existed when `0002` first ran) and emits its payload through
/// [`crate::provider_selection::migration_0002_sql`]. The emitted SQL is the exact body the
/// deleted TypeScript passed to the native runner, so a database that was migrated by the old
/// path and one migrated by this path are indistinguishable.
///
/// This is what `run_migrations` is given; the caller never supplies a migration list.
pub fn build_migrations(connection: &rusqlite::Connection) -> Result<Vec<Migration>, rusqlite::Error> {
    let defs = migration_definitions();
    Ok(vec![
        Migration {
            id: defs[0].id.to_string(),
            sql: adopt_task_schema_sql(),
            checksum_input_json: defs[0].checksum_input_json.clone(),
        },
        Migration {
            id: defs[1].id.to_string(),
            sql: migration_0002_sql(connection)?,
            checksum_input_json: defs[1].checksum_input_json.clone(),
        },
        Migration {
            id: defs[2].id.to_string(),
            sql: OFFICIAL_GLM_SELECTION_SQL.to_string(),
            checksum_input_json: defs[2].checksum_input_json.clone(),
        },
    ])
}

/// The display-oriented pre-check against a read-only ledger, not an execution authorization.
///
/// The migration runner still rechecks every item after taking the lock. Mirrors the deleted
/// `inspectTasksMigrationKind`: `"none"` when the ledger holds every declared migration with a
/// matching checksum, `"upgrade"` when there is a pending migration on a file that already has
/// other tables, and `"initialize"` when the file is otherwise empty.
pub enum MigrationKind {
    None,
    Upgrade,
    Initialize,
}

impl MigrationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MigrationKind::None => "none",
            MigrationKind::Upgrade => "upgrade",
            MigrationKind::Initialize => "initialize",
        }
    }
}

/// The `kind` a `DatabaseMigrationFacts` carries. Returns the checksum mismatch as an error the
/// caller renders with `kind: "checksum_mismatch"`.
pub fn inspect_kind(
    connection: &rusqlite::Connection,
) -> Result<MigrationKind, crate::migrate::MigrationError> {
    let defs = migration_definitions();
    let has_ledger: bool = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'",
            [],
            |_| Ok(true),
        )
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(crate::migrate::MigrationError::Sql {
                context: "cannot inspect the migration ledger".into(),
                source: other,
            }),
        })?;

    let mut pending = false;
    for def in &defs {
        let recorded: Option<String> = if has_ledger {
            connection
                .query_row(
                    "SELECT checksum FROM tasks_schema_migration WHERE id=?1",
                    rusqlite::params![def.id],
                    |row| row.get(0),
                )
                .or_else(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(crate::migrate::MigrationError::Sql {
                        context: "cannot read a migration ledger row".into(),
                        source: other,
                    }),
                })?
        } else {
            None
        };
        match recorded {
            None => pending = true,
            Some(recorded) => {
                let computed = Migration {
                    id: def.id.to_string(),
                    sql: String::new(),
                    checksum_input_json: def.checksum_input_json.clone(),
                }
                .checksum();
                if recorded != computed {
                    return Err(crate::migrate::MigrationError::ChecksumMismatch {
                        id: def.id.to_string(),
                        applied: recorded,
                        computed,
                    });
                }
            }
        }
    }
    if !pending {
        return Ok(MigrationKind::None);
    }
    let has_other_tables: bool = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
            [],
            |_| Ok(true),
        )
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(crate::migrate::MigrationError::Sql {
                context: "cannot inspect the schema".into(),
                source: other,
            }),
        })?;
    Ok(if has_other_tables {
        MigrationKind::Upgrade
    } else {
        MigrationKind::Initialize
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate::{run_migrations, Migration};

    fn checksum(id: &str, input: &str) -> String {
        Migration {
            id: id.to_string(),
            sql: String::new(),
            checksum_input_json: input.to_string(),
        }
        .checksum()
    }

    /// The three real ledger checksums as literals. This is the anchor: it catches a
    /// serialisation change on a machine with **no** `~/.zcode` database.
    #[test]
    fn the_three_checksums_are_the_real_ledger_values() {
        let defs = migration_definitions();
        assert_eq!(
            checksum("0001_adopt_task_schema", &defs[0].checksum_input_json),
            "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17"
        );
        assert_eq!(
            checksum("0002_provider_selection", &defs[1].checksum_input_json),
            "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc"
        );
        assert_eq!(
            checksum("0003_official_glm_selection", &defs[2].checksum_input_json),
            "8987adb50ae412a46c294141c1af89ccfc252f22d41351bdf4c7528f56edc8b4"
        );
    }

    /// `0002`'s input is the literal, not something re-derived.
    #[test]
    fn the_0002_input_is_the_frozen_literal() {
        assert_eq!(
            migration_definitions()[1].checksum_input_json,
            MIGRATION_0002_CHECKSUM_INPUT
        );
    }

    /// A fresh file's `0001` payload must skip the two columns the schema already creates, and
    /// must not carry a duplicate `title_overridden` / `last_unread_at`.
    #[test]
    fn the_0001_payload_does_not_duplicate_schema_columns() {
        let sql = adopt_task_schema_sql();
        assert!(!sql.contains("ADD COLUMN title_overridden"), "{sql}");
        assert!(!sql.contains("ADD COLUMN last_unread_at"), "{sql}");
        // A column the schema does not create is still added.
        assert!(sql.contains("ALTER TABLE tasks ADD COLUMN searchable_text TEXT NOT NULL DEFAULT '';"), "{sql}");
        // And the ones the automations schema already declares are not.
        assert!(!sql.contains("ADD COLUMN mode"), "{sql}");
        assert!(!sql.contains("ADD COLUMN target_task_id"), "{sql}");
        // `scheduled_run_count` is already in the automations schema, so neither its ALTER nor
        // its backfill is emitted — the same branch the deleted TypeScript took (`continue`).
        assert!(!sql.contains("scheduled_run_count=run_count"), "{sql}");
        // And the bound index is present.
        assert!(sql.contains("idx_off_peak_bound_active"), "{sql}");
    }

    /// `build_migrations` returns the three payloads, with `0002` the emitted SQL.
    #[test]
    fn build_migrations_returns_the_three_payloads() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory");
        connection
            .execute_batch(
                "CREATE TABLE automations (automation_id TEXT PRIMARY KEY, model TEXT, provider TEXT, thought_level TEXT, model_selection TEXT);",
            )
            .expect("automations table");
        let migrations = build_migrations(&connection).expect("build");
        assert_eq!(migrations.len(), 3);
        assert_eq!(migrations[0].id, "0001_adopt_task_schema");
        assert!(migrations[0].sql.contains("CREATE TABLE IF NOT EXISTS tasks"), "{}", migrations[0].sql);
        assert!(migrations[1].sql.contains("model_selection IS NULL"), "{}", migrations[1].sql);
        assert!(migrations[2].sql.contains("json_set"), "{}", migrations[2].sql);
    }

    /// `inspect_kind` reports `initialize` on an empty file, `none` after a full run.
    #[test]
    fn inspect_kind_reports_the_three_states() {
        let mut connection = rusqlite::Connection::open_in_memory().expect("in-memory");
        assert_eq!(inspect_kind(&connection).unwrap().as_str(), "initialize");
        let migrations = build_migrations(&connection).expect("build");
        run_migrations(&mut connection, &migrations, 1).expect("migrate");
        assert_eq!(inspect_kind(&connection).unwrap().as_str(), "none");
    }

    /// The nested `columns` contributes `[[...]]`, not a flat array.
    #[test]
    fn the_0001_input_is_nested() {
        let input = &migration_definitions()[0].checksum_input_json;
        assert!(input.contains("[[\"tasks\",\"title_overridden\""), "{input}");
    }

    /// A retired `acp_session_id` column and its user rows survive a reopen.
    ///
    /// This is the store-level guarantee the deleted TypeScript test asserted from Node: the
    /// migrations **adopt** an existing `tasks` table (`CREATE TABLE IF NOT EXISTS` plus
    /// `ALTER TABLE ADD COLUMN`) and never recreate it, so a column a newer/older build added
    /// and the rows that use it are untouched. It lives here, next to the schema it guards, and
    /// needs no `node:sqlite` in `packages/services`.
    #[test]
    fn a_foreign_column_and_its_rows_survive_a_reopen() {
        let mut connection = rusqlite::Connection::open_in_memory().expect("in-memory");
        let migrations = build_migrations(&connection).expect("build");
        run_migrations(&mut connection, &migrations, 1).expect("first run");

        connection
            .execute_batch(
                "ALTER TABLE tasks ADD COLUMN acp_session_id TEXT;
                 INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at, meta_json)
                 VALUES ('ws', '/ws', 'task-1', 'Retired', 1, 2, '{}');
                 UPDATE tasks SET acp_session_id = 'session-example' WHERE task_id = 'task-1';",
            )
            .expect("foreign column");

        // A second open rebuilds the migration list against the live schema and applies nothing.
        let migrations = build_migrations(&connection).expect("rebuild");
        let applied = run_migrations(&mut connection, &migrations, 2).expect("second run");
        assert!(applied.is_empty(), "a reopen must apply nothing: {applied:?}");

        let row: (String, String) = connection
            .query_row(
                "SELECT task_id, acp_session_id FROM tasks WHERE task_id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the retired row must survive");
        assert_eq!(row, ("task-1".to_string(), "session-example".to_string()));
    }
}
