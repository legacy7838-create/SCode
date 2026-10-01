//! Native migration runner — port of the `migrationSteps` generator
//! (`adapters/src/storage/session-store/migration-runner.ts:99-234`) as a
//! resumable state machine driven by `migrate_step`.
//!
//! Each `migrate_step` call runs until the next legacy yield point and returns
//! `progress` / `delay` / `done`; a failure yields the legacy `failed` progress
//! first and throws on the following call (mirroring `yield failed` → `throw`).
//! The TS driver keeps the async loop, `await onProgress`, timer delays and
//! `SqliteSessionMigrationError` normalization (spec §4.4).

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::StoreError;

const SQLITE_BUSY: i32 = 5;
const WAL_RETRY_INITIAL_DELAY_MS: i64 = 10;
const WAL_RETRY_MAX_DELAY_MS: i64 = 200;
const ASYNC_NATIVE_BUSY_TIMEOUT_MS: i64 = 25;
/// Legacy restores the DEFAULT open policy after migration
/// (`migration-runner.ts:92`, `DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS`).
const RESTORE_BUSY_TIMEOUT_MS: i64 = 5_000;

pub struct MigrationDef {
  pub id: String,
  pub sql: String,
  pub app_version: String,
}

/// Serialized with the exact `databaseMigrationFactsSchema` key names
/// (`executedCount`, `committedCount`, `lastAppliedMigrationId`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
  pub kind: String,
  pub executed_count: i64,
  pub committed_count: i64,
  /// Tri-state: `None` = baseline not yet read, `Some(None)` = empty ledger
  /// (`lastAppliedMigrationId: null`), `Some(Some(id))` = baseline id.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_applied_migration_id: Option<Option<String>>,
}

enum Phase {
  Init,
  ForeignKeys,
  Journal,
  Facts,
  Recheck,
  Begin,
  Ledger,
  Loop,
  RunMigration,
  DoCommit,
  Ready,
  Fail,
  FailThrow,
  Done,
}

enum Acq {
  /// Attempt the operation.
  Run,
  /// A `waiting_for_lock` yield happened; surface the pending delay first.
  Delay,
}

pub struct MigState {
  phase: Phase,
  started_at_ms: i64,
  deadline_ms: i64,
  lock_wait_ms: i64,
  facts: Option<Facts>,
  transaction_started: bool,
  next_index: usize,
  completed: i64,
  waiting_reported: bool,
  retry_delay_ms: i64,
  acq: Acq,
  pending_delay_ms: i64,
  pending_error: Option<StoreError>,
}

impl MigState {
  pub fn new(lock_wait_ms: i64) -> Self {
    MigState {
      phase: Phase::Init,
      started_at_ms: 0,
      deadline_ms: 0,
      lock_wait_ms,
      facts: None,
      transaction_started: false,
      next_index: 0,
      completed: 0,
      waiting_reported: false,
      retry_delay_ms: WAL_RETRY_INITIAL_DELAY_MS,
      acq: Acq::Run,
      pending_delay_ms: 0,
      pending_error: None,
    }
  }
}

/// One `migrate_step` result.
pub struct StepOut {
  pub kind: &'static str,
  pub progress: Option<String>,
  pub delay_ms: Option<u32>,
}

#[derive(Serialize)]
struct ProgressOut {
  phase: &'static str,
  #[serde(rename = "elapsedMs")]
  elapsed_ms: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  migration: Option<Facts>,
  #[serde(rename = "migrationId", skip_serializing_if = "Option::is_none")]
  migration_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  completed: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  total: Option<i64>,
  #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
  error_code: Option<String>,
  #[serde(rename = "sqliteCode", skip_serializing_if = "Option::is_none")]
  sqlite_code: Option<i64>,
  #[serde(rename = "systemCode", skip_serializing_if = "Option::is_none")]
  system_code: Option<String>,
}

fn now_ms() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

fn is_busy(error: &StoreError) -> bool {
  matches!(error.errcode, Some(code) if code & 0xff == SQLITE_BUSY)
}

/// JS `String.prototype.trim` (Unicode White_Space + U+FEFF, which Rust's
/// `str::trim` does not strip) — spec §4.4 checksum parity.
pub fn js_trim(text: &str) -> &str {
  text.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

pub fn migration_checksum(sql: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(js_trim(sql).as_bytes());
  let digest = hasher.finalize();
  let mut out = String::with_capacity(64);
  for byte in digest {
    out.push_str(&format!("{:02x}", byte));
  }
  out
}

/// `classifyDatabaseStartupError` (shared) over errcode/kind — the native error
/// has no system `code`; the failed-progress step adds node:sqlite's
/// `ERR_SQLITE_ERROR` when an errcode exists.
pub fn classify(error: &StoreError) -> String {
  let mut fallback = "sql_failed".to_string();
  if let Some(code) = error.errcode {
    match code & 0xff {
      13 => return "storage_full".to_string(),
      3 | 8 => return "permission_denied".to_string(),
      10 => return "io_error".to_string(),
      7 => return "out_of_memory".to_string(),
      11 | 26 => return "corrupt".to_string(),
      14 => fallback = "open_failed".to_string(),
      5 => fallback = "lock_timeout".to_string(),
      _ => {}
    }
  }
  if let Some(kind) = &error.kind {
    if kind != "sql_failed" {
      fallback = kind.clone();
    }
  }
  fallback
}

/// The crate now owns the frozen migration list ([`crate::migrations`]); validate
/// its shape so a bad edit fails loudly here rather than mid-migration. This
/// preserves the invariants the previous JSON payload was validated against
/// (non-empty list, `databaseMigrationIdSchema` id format) without the JSON hop.
fn validate_migrations() -> Result<Vec<MigrationDef>, StoreError> {
  let migrations = crate::migrations::migration_definitions();
  if migrations.is_empty() {
    return Err(StoreError::op("migrations list must not be empty"));
  }
  for migration in &migrations {
    if !valid_migration_id(&migration.id) {
      return Err(StoreError::op(format!(
        "invalid migration id `{}` (expected ^[a-zA-Z_0-9-]{{1,128}}$)",
        migration.id
      )));
    }
  }
  Ok(migrations)
}

/// `databaseMigrationIdSchema` (`packages/shared/src/database-startup.ts:110`).
fn valid_migration_id(id: &str) -> bool {
  let length = id.chars().count();
  (1..=128).contains(&length)
    && id
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn base_progress(state: &MigState, phase: &'static str) -> ProgressOut {
  ProgressOut {
    phase,
    elapsed_ms: now_ms() - state.started_at_ms,
    migration: state.facts.clone(),
    migration_id: None,
    completed: None,
    total: None,
    error_code: None,
    sqlite_code: None,
    system_code: None,
  }
}

fn serialize_progress(progress: ProgressOut) -> String {
  serde_json::to_string(&progress)
    .unwrap_or_else(|_| "{\"phase\":\"failed\",\"elapsedMs\":0}".into())
}

fn failed_progress(state: &MigState, error: &StoreError) -> String {
  let mut progress = base_progress(state, "failed");
  progress.error_code = Some(classify(error));
  progress.migration_id = error.migration_id.clone();
  progress.sqlite_code = error.errcode.map(i64::from);
  // node:sqlite attaches `code = "ERR_SQLITE_ERROR"` to every SqliteError;
  // `databaseStartupErrorDetails` surfaces it as `systemCode`.
  progress.system_code = error.errcode.map(|_| "ERR_SQLITE_ERROR".to_string());
  serialize_progress(progress)
}

fn read_journal_mode(conn: &Connection) -> Result<String, StoreError> {
  let mode: String = conn.query_row("pragma journal_mode", [], |row| row.get(0))?;
  Ok(mode.to_lowercase())
}

fn is_memory_journal_mode(db_path: &str, journal_mode: &str) -> bool {
  db_path == ":memory:" && journal_mode == "memory"
}

fn inspect_migration_kind(
  conn: &Connection,
  migrations: &[MigrationDef],
  db_path: &str,
) -> Result<String, StoreError> {
  let has_ledger: Option<i64> = conn
    .query_row(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'",
      [],
      |row| row.get(0),
    )
    .ok();
  let mut pending = false;
  for migration in migrations {
    let applied: Option<(String, String)> = if has_ledger.is_some() {
      conn.query_row(
        "select id, checksum from schema_migration where id = ?1",
        [&migration.id],
        |row| Ok((row.get(0)?, row.get(1)?)),
      ).ok()
    } else {
      None
    };
    if let Some((_, checksum)) = applied {
      ensure_migration_checksum(
        &migration.id,
        &checksum,
        &migration_checksum(&migration.sql),
        db_path,
      )?;
    } else {
      pending = true;
    }
  }
  if !pending {
    return Ok("none".to_string());
  }
  let has_data_tables: Option<i64> = conn
    .query_row(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migration', 'sqlite_sequence') LIMIT 1",
      [],
      |row| row.get(0),
    )
    .ok();
  Ok(if has_data_tables.is_some() {
    "upgrade".to_string()
  } else {
    "initialize".to_string()
  })
}

fn ensure_migration_checksum(
  id: &str,
  applied: &str,
  current: &str,
  db_path: &str,
) -> Result<(), StoreError> {
  if applied == current {
    return Ok(());
  }
  Err(StoreError::op(format!(
    "SQLite migration checksum mismatch for {}. Historical migrations are immutable; add a new migration instead.",
    id
  ))
  .with_kind("checksum_mismatch")
  .with_migration(id)
  .with_db_path(db_path))
}

fn lock_timeout_error(busy: &StoreError, db_path: &str) -> StoreError {
  let mut error = StoreError::op(format!(
    "Timed out waiting for SQLite migration lock at {}",
    db_path
  ))
  .with_kind("lock_timeout")
  .with_db_path(db_path);
  error.errcode = busy.errcode;
  error
}

fn fail(state: &mut MigState, error: StoreError) {
  state.pending_error = Some(error);
  state.phase = Phase::Fail;
}

/// Busy-acquire handling: returns the next yield (`waiting_for_lock` then the
/// delay), transitions to `Fail` on budget exhaustion, or signals "retry now".
fn acquire_busy(
  state: &mut MigState,
  error: StoreError,
  db_path: &str,
) -> Result<Option<StepOut>, StoreError> {
  let remaining = state.deadline_ms - now_ms();
  if remaining <= 0 {
    fail(state, lock_timeout_error(&error, db_path));
    return Ok(None);
  }
  let delay = remaining.min(state.retry_delay_ms);
  state.retry_delay_ms = WAL_RETRY_MAX_DELAY_MS.min(state.retry_delay_ms * 2);
  if !state.waiting_reported {
    state.waiting_reported = true;
    state.acq = Acq::Delay;
    state.pending_delay_ms = delay;
    return Ok(Some(StepOut {
      kind: "progress",
      progress: Some(serialize_progress(base_progress(state, "waiting_for_lock"))),
      delay_ms: None,
    }));
  }
  Ok(Some(StepOut {
    kind: "delay",
    progress: None,
    delay_ms: Some(u32::try_from(delay.max(1)).unwrap_or(u32::MAX)),
  }))
}

/// Entry check for acquire phases: after a `waiting_for_lock` yield, the delay
/// must surface before the operation is attempted again (legacy order).
fn pending_delay_yield(state: &mut MigState) -> Option<StepOut> {
  if matches!(state.acq, Acq::Delay) {
    let delay = state.pending_delay_ms;
    state.acq = Acq::Run;
    Some(StepOut {
      kind: "delay",
      progress: None,
      delay_ms: Some(u32::try_from(delay.max(1)).unwrap_or(u32::MAX)),
    })
  } else {
    None
  }
}

/// Advance the machine by one legacy yield point (or a terminal value/error).
pub fn step(state: &mut MigState, conn: &Connection, db_path: &str) -> Result<StepOut, StoreError> {
  let migrations = validate_migrations()?;
  loop {
    match state.phase {
      Phase::Init => {
        state.started_at_ms = now_ms();
        state.deadline_ms = state.started_at_ms + state.lock_wait_ms.max(0);
        conn.execute_batch(&format!(
          "pragma busy_timeout = {}",
          ASYNC_NATIVE_BUSY_TIMEOUT_MS
        ))?;
        state.phase = Phase::ForeignKeys;
        return Ok(StepOut {
          kind: "progress",
          progress: Some(serialize_progress(base_progress(state, "checking"))),
          delay_ms: None,
        });
      }
      Phase::ForeignKeys => {
        conn.execute_batch("pragma foreign_keys = on")?;
        state.phase = Phase::Journal;
        state.waiting_reported = false;
        state.retry_delay_ms = WAL_RETRY_INITIAL_DELAY_MS;
        state.acq = Acq::Run;
      }
      Phase::Journal => {
        if let Some(out) = pending_delay_yield(state) {
          return Ok(out);
        }
        let mode = read_journal_mode(conn)?;
        if mode == "wal" || is_memory_journal_mode(db_path, &mode) {
          state.phase = Phase::Facts;
          state.waiting_reported = false;
          state.retry_delay_ms = WAL_RETRY_INITIAL_DELAY_MS;
          state.acq = Acq::Run;
          continue;
        }
        match conn.query_row("pragma journal_mode = wal", [], |row| row.get::<_, String>(0)) {
          Ok(enabled) => {
            let enabled = enabled.to_lowercase();
            if enabled != "wal" && !is_memory_journal_mode(db_path, &enabled) {
              let error = StoreError::op(format!(
                "SQLite refused WAL journal mode for {}; received {}",
                db_path, enabled
              ))
              .with_kind("sql_failed")
              .with_db_path(db_path);
              fail(state, error);
              continue;
            }
            state.phase = Phase::Facts;
            state.waiting_reported = false;
            state.retry_delay_ms = WAL_RETRY_INITIAL_DELAY_MS;
            state.acq = Acq::Run;
            continue;
          }
          Err(error) => {
            let error = StoreError::from(error);
            if is_busy(&error) {
              if let Some(out) = acquire_busy(state, error, db_path)? {
                return Ok(out);
              }
              continue;
            }
            fail(state, error.with_db_path(db_path));
            continue;
          }
        }
      }
      Phase::Facts => {
        if let Some(out) = pending_delay_yield(state) {
          return Ok(out);
        }
        match inspect_migration_kind(conn, &migrations, db_path) {
          Ok(kind) => {
            state.facts = Some(Facts {
              kind,
              executed_count: 0,
              committed_count: 0,
              last_applied_migration_id: None,
            });
            state.phase = Phase::Recheck;
          }
          Err(error) => {
            if is_busy(&error) {
              if let Some(out) = acquire_busy(state, error, db_path)? {
                return Ok(out);
              }
              continue;
            }
            fail(state, error.with_db_path(db_path));
            continue;
          }
        }
      }
      Phase::Recheck => {
        state.phase = Phase::Begin;
        state.waiting_reported = false;
        state.retry_delay_ms = WAL_RETRY_INITIAL_DELAY_MS;
        state.acq = Acq::Run;
        return Ok(StepOut {
          kind: "progress",
          progress: Some(serialize_progress(base_progress(state, "checking"))),
          delay_ms: None,
        });
      }
      Phase::Begin => {
        if let Some(out) = pending_delay_yield(state) {
          return Ok(out);
        }
        match conn.execute_batch("begin immediate") {
          Ok(()) => {
            state.transaction_started = true;
            state.phase = Phase::Ledger;
          }
          Err(error) => {
            let error = StoreError::from(error);
            if is_busy(&error) {
              if let Some(out) = acquire_busy(state, error, db_path)? {
                return Ok(out);
              }
              continue;
            }
            fail(state, error.with_db_path(db_path));
            continue;
          }
        }
      }
      Phase::Ledger => {
        let create = "create table if not exists schema_migration (
      id text primary key, checksum text not null, app_version text, time_applied integer not null
    )";
        if let Err(error) = conn.execute_batch(create) {
          fail(state, StoreError::from(error).with_db_path(db_path));
          continue;
        }
        let baseline: Option<String> = conn
          .query_row(
            "SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
          )
          .ok();
        // `databaseMigrationIdSchema.safeParse(baseline.id).data` — an invalid id
        // becomes `undefined` (key omitted), no baseline becomes `null`.
        let validated = match &baseline {
          None => Some(None),
          Some(id) if valid_migration_id(id) => Some(Some(id.clone())),
          Some(_) => None,
        };
        if let Some(facts) = state.facts.as_mut() {
          facts.last_applied_migration_id = validated;
        }
        state.completed = 0;
        state.phase = Phase::Loop;
      }
      Phase::Loop => {
        if state.next_index >= migrations.len() {
          state.phase = Phase::DoCommit;
          return Ok(StepOut {
            kind: "progress",
            progress: Some(serialize_progress(base_progress(state, "committing"))),
            delay_ms: None,
          });
        }
        let migration = &migrations[state.next_index];
        let checksum = migration_checksum(&migration.sql);
        let applied: Option<(String, String)> = conn
          .query_row(
            "select id, checksum from schema_migration where id = ?1",
            [&migration.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
          )
          .ok();
        if let Some((_, applied_checksum)) = applied {
          if let Err(error) =
            ensure_migration_checksum(&migration.id, &applied_checksum, &checksum, db_path)
          {
            fail(state, error);
            continue;
          }
          state.completed += 1;
          state.next_index += 1;
          continue;
        }
        // A new item after preflight promotes a preflight "none" to "upgrade".
        if let Some(facts) = state.facts.as_mut() {
          if facts.kind == "none" {
            facts.kind = "upgrade".to_string();
          }
        }
        let total = migrations.len() as i64;
        let id = migration.id.clone();
        let completed = state.completed;
        state.phase = Phase::RunMigration;
        return Ok(StepOut {
          kind: "progress",
          progress: Some(serialize_progress({
            let mut progress = base_progress(state, "migrating");
            progress.migration_id = Some(id);
            progress.completed = Some(completed);
            progress.total = Some(total);
            progress
          })),
          delay_ms: None,
        });
      }
      Phase::RunMigration => {
        let migration = &migrations[state.next_index];
        let checksum = migration_checksum(&migration.sql);
        if let Err(error) = conn.execute_batch(&migration.sql) {
          let mut error = StoreError::from(error).with_db_path(db_path);
          error.migration_id = Some(migration.id.clone());
          fail(state, error);
          continue;
        }
        if let Some(facts) = state.facts.as_mut() {
          facts.executed_count += 1;
        }
        let insert = "insert into schema_migration (id, checksum, app_version, time_applied) values (?1, ?2, ?3, ?4)";
        if let Err(error) = conn.execute(
          insert,
          rusqlite::params![migration.id, checksum, migration.app_version, now_ms()],
        ) {
          let mut error = StoreError::from(error).with_db_path(db_path);
          error.migration_id = Some(migration.id.clone());
          fail(state, error);
          continue;
        }
        state.completed += 1;
        state.next_index += 1;
        state.phase = Phase::Loop;
      }
      Phase::DoCommit => {
        if let Err(error) = conn.execute_batch("commit") {
          fail(state, StoreError::from(error).with_db_path(db_path));
          continue;
        }
        state.transaction_started = false;
        if let Some(facts) = state.facts.as_mut() {
          facts.committed_count = facts.executed_count;
        }
        state.phase = Phase::Ready;
        return Ok(StepOut {
          kind: "progress",
          progress: Some(serialize_progress(base_progress(state, "ready"))),
          delay_ms: None,
        });
      }
      Phase::Ready => {
        // Restore the open policy (legacy `finally` restores the 5 s default).
        let _ = conn.execute_batch(&format!("pragma busy_timeout = {}", RESTORE_BUSY_TIMEOUT_MS));
        state.phase = Phase::Done;
        return Ok(StepOut {
          kind: "done",
          progress: None,
          delay_ms: None,
        });
      }
      Phase::Fail => {
        // Roll back first, then notify (legacy order at migration-runner.ts:195-221).
        if state.transaction_started {
          let _ = conn.execute_batch("rollback");
          state.transaction_started = false;
        }
        let error = state
          .pending_error
          .take()
          .unwrap_or_else(|| StoreError::op("SQLite migration initialization failed"));
        let failed = failed_progress(state, &error);
        state.pending_error = Some(error);
        state.phase = Phase::FailThrow;
        return Ok(StepOut {
          kind: "progress",
          progress: Some(failed),
          delay_ms: None,
        });
      }
      Phase::FailThrow => {
        let _ = conn.execute_batch(&format!("pragma busy_timeout = {}", RESTORE_BUSY_TIMEOUT_MS));
        state.phase = Phase::Done;
        let error = state
          .pending_error
          .take()
          .unwrap_or_else(|| StoreError::op("SQLite migration failed"));
        return Err(error);
      }
      Phase::Done => {
        return Ok(StepOut {
          kind: "done",
          progress: None,
          delay_ms: None,
        });
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// R3: legacy hashes `sql.trim()` with JS `String.trim` — White_Space plus
  /// U+FEFF, which Rust's `str::trim` does not strip.
  #[test]
  fn js_trim_matches_javascript_trim() {
    assert_eq!(js_trim("  select 1 \n"), "select 1");
    assert_eq!(js_trim("\u{FEFF}select 1\u{FEFF}"), "select 1");
    assert_eq!(js_trim("\u{FEFF} \t select 1 \u{FEFF} "), "select 1");
    assert_eq!(js_trim("select 1"), "select 1");
    // Non-breaking space is JS White_Space (and Rust is_whitespace).
    assert_eq!(js_trim("\u{A0}select 1\u{A0}"), "select 1");
  }

  #[test]
  fn checksum_equals_node_create_hash_sha256_of_trimmed_sql() {
    // Vector generated with `createHash("sha256").update(sql.trim()).digest("hex")`.
    let sql = "  create table t (id text primary key, n integer not null);  ";
    let expected = "db2899bbbde3d84a36b190cd8f531664b0c91f035b673b5bc332b6a49396c96c";
    let digest = migration_checksum(sql);
    assert_eq!(digest, expected);
    // BOM-padded variants hash identically to the plain SQL (JS trim parity).
    assert_eq!(
      migration_checksum(sql),
      migration_checksum(&format!("\u{FEFF}{}", sql))
    );
    assert_eq!(
      migration_checksum(sql),
      migration_checksum(&format!("{}\u{FEFF}", sql))
    );
  }
}
