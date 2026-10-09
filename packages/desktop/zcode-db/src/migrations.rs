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

/// Epoch millis for the ledger `time_applied` (matches TS `Date.now()`; not part of any checksum).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Does `column` already exist on `table`? (mirrors the `PRAGMA table_info` skip in `adoptSchema`).
/// `table` comes only from the frozen constant list, so the interpolation is not user input.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names.iter().any(|n| n == column))
}

/// Port of `adoptSchema`: run the frozen base DDL, add any missing frozen columns, create the
/// follow-up indexes, and create the off-peak bound index only when no duplicate active binding
/// exists (so it can't fail on an already-duplicated legacy table).
pub fn adopt_schema(conn: &Connection) -> Result<(), String> {
    for ddl in [TASK_INDEX_SCHEMA, AUTOMATION_SCHEMA, OFF_PEAK_SCHEMA] {
        conn.execute_batch(ddl).map_err(|e| e.to_string())?;
    }
    let columns: Vec<[String; 3]> =
        serde_json::from_str(COLUMNS_JSON).map_err(|e| e.to_string())?;
    for [table, column, definition] in &columns {
        if column_exists(conn, table, column)? {
            continue;
        }
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))
        .map_err(|e| e.to_string())?;
        if table == "automations" && column == "scheduled_run_count" {
            conn.execute_batch("UPDATE automations SET scheduled_run_count=run_count")
                .map_err(|e| e.to_string())?;
        }
    }
    conn.execute_batch(INDEXES_SQL).map_err(|e| e.to_string())?;
    let duplicate: Option<i64> = conn
        .query_row(
            &format!(
                "SELECT 1 FROM off_peak_tasks WHERE {ACTIVE_PREDICATE} \
                 GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1"
            ),
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if duplicate.is_none() {
        conn.execute_batch(&bound_index())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The frozen legacy provider-name table (mirror of `providerNames`).
fn legacy_provider_name(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "builtin:bigmodel" => "bigmodel-api",
        "builtin:zai" => "zai-api",
        "builtin:bigmodel-start-plan" => "account:bigmodel-start-plan",
        "builtin:zai-start-plan" => "account:zai-start-plan",
        "builtin:bigmodel-coding-plan" => "account:bigmodel-individual-coding-plan",
        "builtin:zai-coding-plan" => "account:zai-individual-coding-plan",
        _ => return None,
    })
}

/// `decodeURIComponent` parity: percent-decode as UTF-8; on malformed input return the original
/// (TS `catch { return value }`).
fn decode_component(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

/// Port of `decodeLegacySelection` returning the `JSON.stringify`'d selection, or `None` (which the
/// caller maps to a NULL write). `serde_json`'s `preserve_order` keeps `providerId`/`modelId`/
/// `options` in the TS insertion order for byte-identical output.
fn decode_legacy_selection(
    model_raw: Option<&str>,
    provider_raw: Option<&str>,
    thought_level: Option<&str>,
) -> Option<String> {
    let value = model_raw?.trim();
    if value.is_empty() {
        return None;
    }
    let mut provider = provider_raw.unwrap_or("").trim().to_string();
    let mut model = value.to_string();
    let mut reasoning = thought_level
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    if let Some(body) = value.strip_prefix("custom:") {
        let separator = body.find(':')?;
        let parts: Vec<&str> = body.split(':').collect();
        if parts.len() >= 3 && parts[0] == "builtin" {
            provider = format!("builtin:{}", parts[1]);
            model = decode_component(&parts[2..].join(":"));
        } else {
            provider = decode_component(&body[..separator]);
            model = decode_component(&body[separator + 1..]);
        }
    } else if value.contains('/') {
        let separator = value.find('/')?;
        provider = value[..separator].to_string();
        model = value[separator + 1..].to_string();
        if let Some(ls) = model.find('$') {
            if ls > 0 && ls < model.len() - 1 {
                let level = model[ls + 1..].trim().to_string();
                if level.is_empty() {
                    return None;
                }
                reasoning = Some(level);
                model = model[..ls].to_string();
            }
        }
    } else if provider == "glm" || provider == "zcode" {
        return None;
    }

    provider = provider.trim().to_string();
    model = model.trim().to_string();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let provider_id = if provider.starts_with("builtin:") {
        legacy_provider_name(&provider).map(str::to_string)?
    } else {
        provider.clone()
    };

    let mut map = serde_json::Map::new();
    map.insert("providerId".into(), serde_json::Value::String(provider_id));
    map.insert("modelId".into(), serde_json::Value::String(model));
    if let Some(level) = reasoning {
        let mut opts = serde_json::Map::new();
        opts.insert("reasoningLevel".into(), serde_json::Value::String(level));
        map.insert("options".into(), serde_json::Value::Object(opts));
    }
    Some(serde_json::Value::Object(map).to_string())
}

/// Port of `importLegacyAutomationSelections` (migration 0002's data step). Runs inside the caller's
/// migration transaction; the guarded UPDATE with `IS` re-checks the row hasn't drifted.
pub fn import_legacy_automation_selections(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT automation_id, model, provider, thought_level FROM automations WHERE model IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for (aid, model, provider, thought) in &rows {
        match decode_legacy_selection(model.as_deref(), provider.as_deref(), thought.as_deref()) {
            None => {
                // Explicit intent but indeterminate identity → NULL (never a silent default).
                if !model.as_deref().unwrap_or("").trim().is_empty() {
                    conn.execute(
                        "UPDATE automations SET model_selection=NULL WHERE automation_id=?1",
                        [aid],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Some(json) => {
                conn.execute(
                    "UPDATE automations SET model_selection = ?1 WHERE automation_id = ?2 \
                     AND model IS ?3 AND provider IS ?4 AND thought_level IS ?5",
                    rusqlite::params![json, aid, model, provider, thought],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    conn.execute_batch(
        "UPDATE automations SET model_selection='null' \
         WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='')",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `runTasksDatabaseMigrations` for the not-yet-open case: one `BEGIN IMMEDIATE` wrapping
/// the ledger-driven apply of 0001→0003, writing each applied id+checksum. Skips already-applied
/// ids, and errors on any checksum mismatch (frozen history must not drift).
pub fn run_tasks_database_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    match run_migrations_inner(conn) {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

fn run_migrations_inner(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tasks_schema_migration (\
           id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL)",
        [],
    )
    .map_err(|e| e.to_string())?;
    for (id, input) in migration_definitions() {
        let checksum = checksum_of(&input);
        let applied: Option<String> = conn
            .query_row(
                "SELECT checksum FROM tasks_schema_migration WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(stored) = applied {
            if stored != checksum {
                return Err(format!("Task database migration checksum mismatch: {id}"));
            }
            continue;
        }
        match id {
            "0001_adopt_task_schema" => adopt_schema(conn)?,
            "0002_provider_selection" => import_legacy_automation_selections(conn)?,
            "0003_official_glm_selection" => conn
                .execute_batch(GLM_SELECTION_SQL)
                .map_err(|e| e.to_string())?,
            other => return Err(format!("unknown migration id: {other}")),
        }
        conn.execute(
            "INSERT INTO tasks_schema_migration VALUES(?1, ?2, ?3)",
            rusqlite::params![id, checksum, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
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

    #[test]
    fn fresh_init_builds_schema_and_ledger_then_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        run_tasks_database_migrations(&conn).unwrap();
        // All 3 migrations recorded with the exact frozen checksums, and the DB verifies as applied.
        assert!(are_tasks_migrations_applied(&conn).unwrap());
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN \
                 ('tasks','automations','automation_runs','off_peak_tasks','task_groups')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 5, "all base tables created");
        // Re-running is a no-op (skips applied ids; checksums match) — no error, still applied.
        run_tasks_database_migrations(&conn).unwrap();
        assert!(are_tasks_migrations_applied(&conn).unwrap());
    }

    #[test]
    fn decode_legacy_selection_custom_builtin_parity() {
        let json = decode_legacy_selection(Some("custom:builtin:zai:glm-4.6"), None, Some("high"))
            .unwrap();
        assert_eq!(
            json,
            r#"{"providerId":"zai-api","modelId":"glm-4.6","options":{"reasoningLevel":"high"}}"#,
            "key order + builtin mapping match TS JSON.stringify"
        );
    }

    #[test]
    fn decode_legacy_selection_slash_and_level() {
        let json = decode_legacy_selection(Some("openai/gpt-4o$low"), None, None).unwrap();
        assert_eq!(
            json,
            r#"{"providerId":"openai","modelId":"gpt-4o","options":{"reasoningLevel":"low"}}"#
        );
    }

    #[test]
    fn decode_legacy_selection_rejects_execution_only_providers() {
        // provider glm/zcode with a bare model is an execution backend, not an identity → None.
        assert_eq!(
            decode_legacy_selection(Some("glm-4.6"), Some("glm"), None),
            None
        );
        assert_eq!(decode_legacy_selection(Some(""), Some("x"), None), None);
    }

    #[test]
    fn import_legacy_sets_default_null_for_empty_model() {
        let conn = Connection::open_in_memory().unwrap();
        adopt_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, model, created_at, updated_at) \
             VALUES ('a1','* * * * *','p','wk','/w', NULL, 1, 1)",
            [],
        )
        .unwrap();
        import_legacy_automation_selections(&conn).unwrap();
        let sel: String = conn
            .query_row(
                "SELECT model_selection FROM automations WHERE automation_id='a1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sel, "null", "empty model → default JSON null (not NULL)");
    }
}
