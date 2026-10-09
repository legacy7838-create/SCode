//! Session-store migration bootstrap (the Agent CLI `~/.zcode/cli/db/db.sqlite`), a faithful port of
//! `apps/zcode-cli/.../session-store/migration-runner.ts`. The ledger table `schema_migration`
//! (`id, checksum, app_version, time_applied`) is keyed on `sha256(sql.trim())` over the frozen SQL in
//! [`crate::session_migrations`], so a DB the TS runner already migrated is adopted without a
//! checksum abort, and a fresh DB reaches the identical schema. Reuses the shared lock-retry helpers
//! from [`crate::migrations`] so WAL acquisition behaves the same as the tasks-index path.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::migrations::acquire_exec;
use super::session_migrations::{SESSION_MIGRATIONS, migration_checksum};

/// Migration facts reported to the caller, mirroring `DatabaseMigrationFacts` field names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMigrationFacts {
    /// `"none"` (fully applied), `"initialize"` (empty DB), or `"upgrade"` (partial).
    pub kind: &'static str,
    pub executed_count: i64,
    pub committed_count: i64,
    /// The last id present in the ledger BEFORE this run (the pre-migration tip), else `None`.
    pub last_applied_migration_id: Option<String>,
}

fn read_applied_checksum(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT checksum FROM schema_migration WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn has_ledger(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .map_err(|e| e.to_string())
}

/// Port of `inspectMigrationKind`: read-only ledger pre-check; errors on a stored-vs-computed
/// checksum mismatch (frozen history must not drift).
pub fn inspect_session_migration_kind(conn: &Connection) -> Result<&'static str, String> {
    let ledger = has_ledger(conn)?;
    let mut pending = false;
    for mig in SESSION_MIGRATIONS {
        let row = if ledger {
            read_applied_checksum(conn, mig.id)?
        } else {
            None
        };
        match row {
            None => pending = true,
            Some(stored) => {
                if stored != migration_checksum(mig.sql) {
                    return Err(format!(
                        "SQLite migration checksum mismatch for {}. Historical migrations are immutable; add a new migration instead.",
                        mig.id
                    ));
                }
            }
        }
    }
    if !pending {
        return Ok("none");
    }
    let has_data_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' \
             AND name NOT IN ('schema_migration','sqlite_sequence') LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map(|r| r.is_some())
        .map_err(|e| e.to_string())?;
    Ok(if has_data_table { "upgrade" } else { "initialize" })
}

/// Apply pending migrations assuming the caller already opened a transaction; returns
/// `(executed_count, last_applied_id_before_run)`. Skips applied ids, errors on checksum mismatch.
/// `now_ms` is injected so the ledger is deterministic/testable.
pub fn run_session_migrations_in_tx(
    conn: &Connection,
    now_ms: i64,
) -> Result<(i64, Option<String>), String> {
    conn.execute(
        "create table if not exists schema_migration (\
           id text primary key, checksum text not null, app_version text, time_applied integer not null)",
        [],
    )
    .map_err(|e| e.to_string())?;
    let baseline: Option<String> = conn
        .query_row(
            "SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut executed = 0i64;
    for mig in SESSION_MIGRATIONS {
        let checksum = migration_checksum(mig.sql);
        if let Some(stored) = read_applied_checksum(conn, mig.id)? {
            if stored != checksum {
                return Err(format!(
                    "SQLite migration checksum mismatch for {}. Historical migrations are immutable; add a new migration instead.",
                    mig.id
                ));
            }
            continue;
        }
        conn.execute_batch(mig.sql)
            .map_err(|e| format!("{}: {e}", mig.id))?;
        conn.execute(
            "insert into schema_migration (id, checksum, app_version, time_applied) values (?1, ?2, ?3, ?4)",
            rusqlite::params![mig.id, checksum, mig.app_version, now_ms],
        )
        .map_err(|e| e.to_string())?;
        executed += 1;
    }
    Ok((executed, baseline))
}

/// Port of `runSqliteSessionMigrations` for the standalone case: one `BEGIN IMMEDIATE` wrapping the
/// ledger-driven apply, COMMIT on success, ROLLBACK on failure (never hand back a half-migrated txn).
pub fn run_session_migrations(
    conn: &Connection,
    deadline_ms: i64,
    now_ms: i64,
) -> Result<SessionMigrationFacts, String> {
    let kind = inspect_session_migration_kind(conn)?;
    acquire_exec(conn, "BEGIN IMMEDIATE", deadline_ms)?;
    match run_session_migrations_in_tx(conn, now_ms) {
        Ok((executed, last)) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(SessionMigrationFacts {
                kind,
                executed_count: executed,
                committed_count: executed,
                last_applied_migration_id: last,
            })
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Full bootstrap: create the parent dir, open RW/CREATE, set `busy_timeout`/`foreign_keys`, acquire
/// WAL under lock-retry, `synchronous=NORMAL`, then migrate in one immediate transaction. Mirrors the
/// schema-owning portion of `prepareTasksIndexStorage` + the session `migrationSteps` pre-check.
pub fn bootstrap_session_store(
    path: &str,
    deadline_ms: i64,
    now_ms: i64,
) -> Result<SessionMigrationFacts, String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA busy_timeout = 25; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    acquire_exec(&conn, "PRAGMA journal_mode = WAL", deadline_ms)?;
    conn.execute_batch("PRAGMA synchronous = NORMAL")
        .map_err(|e| e.to_string())?;
    let kind = inspect_session_migration_kind(&conn)?;
    acquire_exec(&conn, "BEGIN IMMEDIATE", deadline_ms)?;
    match run_session_migrations_in_tx(&conn, now_ms) {
        Ok((executed, last)) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(SessionMigrationFacts {
                kind,
                executed_count: executed,
                committed_count: executed,
                last_applied_migration_id: last,
            })
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("zcode-sess-{}-{}.sqlite", tag, std::process::id()));
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(format!("{}-wal", p.display()));
        let _ = std::fs::remove_file(format!("{}-shm", p.display()));
        p
    }

    /// Bootstrap a fresh DB (all 22 apply), then reopen must report `none` with 0 executed, and the
    /// ledger + a known table must exist. Proves the runner is idempotent and reaches the full schema.
    #[test]
    fn bootstrap_creates_schema_and_reopen_is_none() {
        let path = tmp_path("boot");
        let p = path.to_str().unwrap();
        let facts = bootstrap_session_store(p, 1000, 1_700_000_000_000).expect("bootstrap");
        assert_eq!(facts.kind, "initialize");
        assert_eq!(facts.executed_count as usize, SESSION_MIGRATIONS.len());
        assert_eq!(facts.committed_count, facts.executed_count);
        assert!(facts.last_applied_migration_id.is_none());

        let facts2 = bootstrap_session_store(p, 1000, 1_700_000_000_001).expect("reopen");
        assert_eq!(facts2.kind, "none");
        assert_eq!(facts2.executed_count, 0);

        let conn = Connection::open(&path).expect("open");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM schema_migration", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 22);
        let has_session: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_session, 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
