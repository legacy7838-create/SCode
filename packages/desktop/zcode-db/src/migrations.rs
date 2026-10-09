//! Migration-ledger checksum parity (slice 14). Reproduces the frozen
//! `sha256(JSON.stringify(checksumInput))` of `tasksDatabase/migrations.ts` byte-for-byte so the
//! Rust side can verify/adopt a DB ledger created by the TS runner. These strings are FROZEN: any
//! edit changes the checksum and would make `are_tasks_migrations_applied` reject an existing DB —
//! the `checksum_matches_live_ledger` test guards against transcription drift.

use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// Frozen base schema for `tasks` + the group tables + their indexes (mirror of `TASK_INDEX_SCHEMA`).
const TASK_INDEX_SCHEMA: &str = r#"
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

/// Frozen automations schema (mirror of `AUTOMATION_SCHEMA`).
const AUTOMATION_SCHEMA: &str = r#"
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

/// Frozen off-peak schema (mirror of `OFF_PEAK_SCHEMA`).
const OFF_PEAK_SCHEMA: &str = r#"
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

/// Frozen ALTER column list (mirror of the `columns` array; order is part of the checksum).
const COLUMNS_JSON: &str = r#"[["tasks","title_overridden","INTEGER NOT NULL DEFAULT 0"],["tasks","last_unread_at","INTEGER NOT NULL DEFAULT 0"],["tasks","searchable_text","TEXT NOT NULL DEFAULT ''"],["tasks","cron_automation_id","TEXT"],["tasks","off_peak_task_id","TEXT"],["automations","target_task_id","TEXT"],["automations","bot_delivery_target","TEXT"],["automations","mode","TEXT"],["automations","end_at","INTEGER"],["automations","schedule_rule","TEXT"],["automations","schedule_edited_by_user","INTEGER NOT NULL DEFAULT 0"],["automations","thought_level","TEXT"],["automations","model_selection","TEXT"],["automations","scheduled_run_count","INTEGER NOT NULL DEFAULT 0"],["automation_runs","model_selection","TEXT"],["off_peak_tasks","thought_level","TEXT"],["off_peak_tasks","model_selection","TEXT"],["off_peak_tasks","history_deleted_at","INTEGER"]]"#;

/// Frozen follow-up indexes blob (mirror of `indexes`).
const INDEXES_SQL: &str = r#"
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
"#;

/// `activePredicate` (frozen) used by the off-peak bound index.
const ACTIVE_PREDICATE: &str =
    "session_id IS NOT NULL AND status NOT IN ('completed','failed','cancelled')";

/// Frozen off-peak unique bound index (mirror of `boundIndex`, `${activePredicate}` inlined).
fn bound_index() -> String {
    format!("CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE {ACTIVE_PREDICATE}")
}

/// Frozen GLM selection migration SQL (mirror of `OFFICIAL_GLM_SELECTION_MIGRATION_SQL`).
const GLM_SELECTION_SQL: &str = r#"
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

/// `(id, checksumInput JSON)` pairs, in the exact order `definitions` runs. `checksum_input_json`
/// is a serde_json value that serializes byte-identically to `JSON.stringify(checksumInput)`.
pub fn migration_definitions() -> Vec<(&'static str, serde_json::Value)> {
    let input_0001 = serde_json::json!([
        TASK_INDEX_SCHEMA,
        AUTOMATION_SCHEMA,
        OFF_PEAK_SCHEMA,
        serde_json::from_str::<serde_json::Value>(COLUMNS_JSON)
            .expect("frozen columns JSON is valid"),
        INDEXES_SQL,
        bound_index(),
        "scheduled-count-backfill-v1",
    ]);
    let input_0002 = serde_json::json!([
        "legacy-automation-selection-v1",
        "no-provider-for-legacy-off-peak-v1",
    ]);
    let input_0003 = serde_json::json!([GLM_SELECTION_SQL]);
    vec![
        ("0001_adopt_task_schema", input_0001),
        ("0002_provider_selection", input_0002),
        ("0003_official_glm_selection", input_0003),
    ]
}

/// sha256 hex of `JSON.stringify(input)`. serde_json's compact output matches `JSON.stringify` for
/// these ASCII-only frozen strings (no special escaping differences), so the digest is equal.
pub fn checksum_of(input: &serde_json::Value) -> String {
    let json = serde_json::to_string(input).expect("checksum input is serializable");
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Port of `areTasksDatabaseMigrationsApplied` (the read-only ledger check, no data migrations):
/// true when the ledger table exists and every defined migration's stored checksum equals the
/// recomputed one. A missing row → false; a mismatch → Err (mirrors the TS throw).
pub fn are_tasks_migrations_applied(conn: &Connection) -> Result<bool, String> {
    let has_ledger: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if has_ledger.is_none() {
        return Ok(false);
    }
    for (id, input) in migration_definitions() {
        let stored: Option<String> = conn
            .query_row(
                "SELECT checksum FROM tasks_schema_migration WHERE id = ?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let stored = match stored {
            Some(s) => s,
            None => return Ok(false),
        };
        let expected = checksum_of(&input);
        if stored != expected {
            return Err(format!("Task database migration checksum mismatch: {id}"));
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden parity: these digests are what the TS runner writes into a real DB (verified against
    /// the live `~/.zcode/v2/tasks-index.sqlite` ledger). If any frozen constant drifts, this fails.
    #[test]
    fn checksum_matches_live_ledger() {
        let mut map = std::collections::BTreeMap::new();
        for (id, input) in migration_definitions() {
            map.insert(id, checksum_of(&input));
        }
        assert_eq!(
            map["0001_adopt_task_schema"],
            "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17"
        );
        assert_eq!(
            map["0002_provider_selection"],
            "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc"
        );
        assert_eq!(
            map["0003_official_glm_selection"],
            "8987adb50ae412a46c294141c1af89ccfc252f22d41351bdf4c7528f56edc8b4"
        );
    }

    #[test]
    fn ledger_absent_reports_not_applied() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(!are_tasks_migrations_applied(&conn).unwrap());
    }

    #[test]
    fn ledger_with_matching_checksums_is_applied() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tasks_schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL)",
            [],
        )
        .unwrap();
        for (id, input) in migration_definitions() {
            conn.execute(
                "INSERT INTO tasks_schema_migration VALUES (?1, ?2, 0)",
                rusqlite::params![id, checksum_of(&input)],
            )
            .unwrap();
        }
        assert!(are_tasks_migrations_applied(&conn).unwrap());
    }

    #[test]
    fn ledger_with_tampered_checksum_errors() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tasks_schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks_schema_migration VALUES ('0001_adopt_task_schema','deadbeef',0)",
            [],
        )
        .unwrap();
        assert!(are_tasks_migrations_applied(&conn).is_err());
    }
}
