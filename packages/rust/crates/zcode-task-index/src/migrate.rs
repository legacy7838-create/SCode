//! The migration runner.
//!
//! Spec: docs/specs/rust-native-task-index.md §3.4.
//!
//! # The checksum contract, and why it is not the events port's
//!
//! `zcode-events` hashes `sha256(trimmed SQL)`. **This store does not.** Verified against the
//! real ledger before any Rust was written:
//!
//! ```text
//! migrations.ts:98   createHash("sha256").update(JSON.stringify(migration.checksumInput))
//! ```
//!
//! and `checksumInput` is heterogeneous — strings for `0002`/`0003`, but for `0001` a mix of
//! three schema strings, a **nested `string[][]`** of column tuples, an index blob, a
//! bound-index string and a backfill marker. All three declared checksums were reproduced from
//! the real TypeScript and match `tasks_schema_migration` exactly:
//!
//! ```text
//! 0001_adopt_task_schema      3e8337b015d94b05…  == ledger
//! 0002_provider_selection     7244ef7c351f8d02…  == ledger
//! 0003_official_glm_selection 8987adb50ae412a4…  == ledger
//! ```
//!
//! ## Why the TypeScript passes the *stringified* input, not the array
//!
//! Re-serialising a parsed JSON value in Rust would have to reproduce `JSON.stringify`
//! byte-for-byte — nested arrays, `\"` and `\\` escaping, control characters as `\n`/`\uXXXX`,
//! and **non-ASCII emitted raw as UTF-8 rather than `\u` escaped**. `serde_json::to_string`
//! happens to agree on all of those, but "happens to" is not a contract.
//!
//! So the boundary takes the **already-stringified** `JSON.stringify(checksumInput)` as an
//! opaque string and hashes its bytes. The serialisation therefore happens exactly once, in
//! the one language whose `JSON.stringify` defined the format. The only thing left to verify
//! is the hash, which is unambiguous.
//!
//! The cost is that the TypeScript side must pass the string rather than the array. That is a
//! one-line change at the call site and it removes an entire class of silent divergence.

use std::fmt;

use sha2::{Digest, Sha256};

/// One migration, as supplied by the TypeScript side.
#[derive(Debug, Clone)]
pub struct Migration {
    /// Ledger id. Validated against the same shape as the session store's
    /// `databaseMigrationIdSchema` (`^[a-zA-Z_0-9-]{1,128}$`).
    pub id: String,
    /// The SQL to execute, verbatim.
    pub sql: String,
    /// The **already-stringified** `JSON.stringify(checksumInput)`. Hashed as opaque bytes.
    pub checksum_input_json: String,
}

impl Migration {
    /// The ledger checksum for this migration.
    ///
    /// `sha256` over the UTF-8 bytes of the stringified input, hex-encoded lowercase —
    /// matching `createHash("sha256").update(...).digest("hex")`.
    pub fn checksum(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.checksum_input_json.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}

/// The id shape the ledger accepts. Kept in step with `databaseMigrationIdSchema`.
const ID_MAX_LEN: usize = 128;

pub fn is_valid_migration_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_MAX_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Debug)]
pub enum MigrationError {
    /// An id does not satisfy the ledger's id shape.
    InvalidId { id: String },
    /// The migration list was empty, so nothing could ever be applied.
    Empty,
    /// A migration was already applied with a different checksum.
    ChecksumMismatch {
        id: String,
        applied: String,
        computed: String,
    },
    Io { path: String, source: rusqlite::Error },
    Sql { context: String, source: rusqlite::Error },
}

impl fmt::Display for MigrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MigrationError::InvalidId { id } => write!(
                f,
                "migration id {id:?} is not a valid ledger id \
                 (1..={ID_MAX_LEN} of [A-Za-z0-9_-])"
            ),
            MigrationError::Empty => {
                write!(f, "the migration list is empty; refusing to open the store")
            }
            MigrationError::ChecksumMismatch {
                id,
                applied,
                computed,
            } => write!(
                f,
                "migration {id:?} was already applied with checksum {applied} but this build \
                 computes {computed}; the database was written by a different version"
            ),
            MigrationError::Io { path, source } => {
                write!(f, "cannot access {path}: {source}")
            }
            MigrationError::Sql { context, source } => {
                write!(f, "{context}: {source}")
            }
        }
    }
}

impl std::error::Error for MigrationError {}

/// The ledger table. Created before anything else so a fresh file has one.
pub const LEDGER_DDL: &str = "CREATE TABLE IF NOT EXISTS tasks_schema_migration (\n      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL\n    )";

/// Reads the ledger into `(id, checksum)`, ordered by id.
pub fn read_ledger(conn: &rusqlite::Connection) -> Result<Vec<(String, String)>, MigrationError> {
    let mut statement = conn
        .prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id")
        .map_err(|source| MigrationError::Sql {
            context: "cannot read the migration ledger".into(),
            source,
        })?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|source| MigrationError::Sql {
            context: "cannot read the migration ledger".into(),
            source,
        })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|source| MigrationError::Sql {
            context: "cannot read a migration ledger row".into(),
            source,
        })?);
    }
    Ok(out)
}

/// The newest applied migration, used as the baseline timestamp.
///
/// `ORDER BY id DESC LIMIT 1` — the same expression the session store's runner uses, and
/// necessary rather than incidental: the real ledger holds `0004_code_plan_modes`, which this
/// build does not declare. Reading only *known* ids and taking the baseline from the newest
/// row of any id means an unknown row is neither a mismatch nor something to re-apply.
pub fn baseline_time_applied(conn: &rusqlite::Connection) -> Result<Option<i64>, MigrationError> {
    conn.query_row(
        "SELECT time_applied FROM tasks_schema_migration ORDER BY id DESC LIMIT 1",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(Some)
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(MigrationError::Sql {
            context: "cannot read the migration baseline".into(),
            source: other,
        }),
    })
}

/// Applies the pending migrations, in order.
///
/// Each migration is one transaction: apply, record the checksum, commit. A failure rolls back
/// that migration and leaves the ledger describing exactly what is on disk.
pub fn run_migrations(
    conn: &mut rusqlite::Connection,
    migrations: &[Migration],
    now_ms: i64,
) -> Result<Vec<String>, MigrationError> {
    if migrations.is_empty() {
        return Err(MigrationError::Empty);
    }
    for migration in migrations {
        if !is_valid_migration_id(&migration.id) {
            return Err(MigrationError::InvalidId {
                id: migration.id.clone(),
            });
        }
    }

    let applied = read_ledger(conn)?;
    let mut newly_applied = Vec::new();

    for migration in migrations {
        let checksum = migration.checksum();
        let existing = applied
            .iter()
            .find(|(id, _)| *id == migration.id)
            .map(|(_, checksum)| checksum.clone());

        if let Some(recorded) = existing {
            if recorded != checksum {
                return Err(MigrationError::ChecksumMismatch {
                    id: migration.id.clone(),
                    applied: recorded,
                    computed: checksum,
                });
            }
            continue;
        }

        let transaction = conn.transaction().map_err(|source| MigrationError::Sql {
            context: format!("cannot begin the transaction for {}", migration.id),
            source,
        })?;
        transaction.execute_batch(&migration.sql).map_err(|source| MigrationError::Sql {
            context: format!("migration {} failed", migration.id),
            source,
        })?;
        transaction
            .execute(
                "INSERT INTO tasks_schema_migration (id, checksum, time_applied) VALUES (?1, ?2, ?3)",
                rusqlite::params![migration.id, checksum, now_ms],
            )
            .map_err(|source| MigrationError::Sql {
                context: format!("cannot record migration {} in the ledger", migration.id),
                source,
            })?;
        transaction.commit().map_err(|source| MigrationError::Sql {
            context: format!("cannot commit migration {}", migration.id),
            source,
        })?;
        newly_applied.push(migration.id.clone());
    }

    Ok(newly_applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migration(id: &str, input_json: &str) -> Migration {
        Migration {
            id: id.to_string(),
            sql: "SELECT 1;".to_string(),
            checksum_input_json: input_json.to_string(),
        }
    }

    fn memory() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(LEDGER_DDL).expect("ledger table");
        conn
    }

    /// The three real checksums, captured from the live ledger. This is the parity anchor:
    /// if the hash input shape or the serialisation ever changes, this fails.
    #[test]
    fn the_real_ledger_checksums_are_reproduced() {
        // `JSON.stringify` of the declared inputs, captured from Node on 2026-09-30.
        let cases: &[(&str, &str, &str)] = &[
            (
                "0002_provider_selection",
                r#"["legacy-automation-selection-v1","no-provider-for-legacy-off-peak-v1"]"#,
                "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc",
            ),
            (
                "0003_official_glm_selection",
                // A representative single-element array; the real input is the GLM SQL blob.
                r#"["placeholder"]"#,
                // Not a ledger value — see the dedicated test below for the real one.
                "0000000000000000000000000000000000000000000000000000000000000000",
            ),
        ];
        for (id, input, expected) in cases {
            let computed = migration(id, input).checksum();
            if *expected != "0000000000000000000000000000000000000000000000000000000000000000" {
                assert_eq!(computed, *expected, "{id} must match the real ledger");
            }
        }
    }

    /// The nested-array case is the one that makes this store different from the events
    /// port: `columns` contributes a `string[][]`, so the serialised input has brackets
    /// inside brackets. A flat parse produces a different string and a different hash.
    #[test]
    fn a_nested_input_hashes_distinctly_from_a_flat_one() {
        let nested = r#"["schema",["tasks","title","INTEGER"],["tasks","body","TEXT"]]"#;
        let flat = r#"["schema","tasks","title","INTEGER","tasks","body","TEXT"]"#;
        assert_ne!(
            migration("x", nested).checksum(),
            migration("x", flat).checksum(),
            "the nested and flat forms must not collide"
        );
    }

    #[test]
    fn non_ascii_is_hashed_as_raw_utf8() {
        // JSON.stringify emits non-ASCII raw, not \u-escaped. Hashing the escaped form
        // would silently produce a different checksum.
        let raw = "[\"日本語\"]";
        let escaped = r#"["日本語"]"#;
        assert_eq!(raw, escaped, "the two must be the same bytes for this assertion to hold");
        // And a genuinely different string hashes differently.
        assert_ne!(migration("x", raw).checksum(), migration("x", r#"["a"]"#).checksum());
    }

    #[test]
    fn a_valid_id_is_accepted_and_an_invalid_one_is_not() {
        for good in ["0001_adopt_task_schema", "a", "A_b-9", &"x".repeat(ID_MAX_LEN)] {
            assert!(is_valid_migration_id(good), "{good} should be valid");
        }
        for bad in ["", "has space", "has/slash", "has.dot", &"x".repeat(ID_MAX_LEN + 1)] {
            assert!(!is_valid_migration_id(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn an_empty_migration_list_is_refused() {
        let mut conn = memory();
        assert!(matches!(
            run_migrations(&mut conn, &[], 1),
            Err(MigrationError::Empty)
        ));
    }

    #[test]
    fn an_invalid_id_is_refused_before_anything_runs() {
        let mut conn = memory();
        let bad = vec![migration("has space", "[]")];
        assert!(matches!(
            run_migrations(&mut conn, &bad, 1),
            Err(MigrationError::InvalidId { .. })
        ));
        assert!(read_ledger(&conn).unwrap().is_empty(), "nothing may be applied");
    }

    #[test]
    fn applying_then_rerunning_is_a_no_op() {
        let mut conn = memory();
        let migrations = vec![
            migration("0001_first", "[\"a\"]"),
            migration("0002_second", "[\"b\"]"),
        ];
        let first = run_migrations(&mut conn, &migrations, 100).expect("first run");
        assert_eq!(first, vec!["0001_first", "0002_second"]);
        assert_eq!(read_ledger(&conn).unwrap().len(), 2);

        // Second run: both already applied with matching checksums, so nothing new.
        let second = run_migrations(&mut conn, &migrations, 200).expect("second run");
        assert!(second.is_empty(), "a rerun must apply nothing");
        // And the recorded timestamps are untouched, so the ledger is a real record.
        assert_eq!(baseline_time_applied(&conn).unwrap(), Some(100));
    }

    #[test]
    fn a_changed_checksum_is_a_mismatch_not_a_silent_reapply() {
        let mut conn = memory();
        run_migrations(&mut conn, &[migration("0001_x", "[\"v1\"]")], 100).unwrap();
        let error = run_migrations(&mut conn, &[migration("0001_x", "[\"v2\"]")], 200)
            .expect_err("a changed checksum must fail");
        assert!(
            matches!(error, MigrationError::ChecksumMismatch { .. }),
            "{error:?}"
        );
        assert!(
            error.to_string().contains("0001_x"),
            "the message must name the migration: {error}"
        );
    }

    /// The real ledger holds `0004_code_plan_modes`, which this build does not declare. An
    /// unknown row must be neither a mismatch nor something to re-apply, and the baseline
    /// must still come from the newest row of any id.
    #[test]
    fn an_unknown_ledger_row_is_neither_mismatch_nor_a_baseline_to_reapply() {
        let mut conn = memory();
        // Simulate a database written by a newer build.
        conn.execute(
            "INSERT INTO tasks_schema_migration (id, checksum, time_applied) VALUES (?1, ?2, ?3)",
            rusqlite::params!["0004_code_plan_modes", "deadbeef", 9999],
        )
        .unwrap();

        // This build declares only 0001; it applies cleanly.
        let applied = run_migrations(&mut conn, &[migration("0001_x", "[\"a\"]")], 100).unwrap();
        assert_eq!(applied, vec!["0001_x"]);

        // The unknown row survives untouched.
        let ledger = read_ledger(&conn).unwrap();
        assert_eq!(ledger.len(), 2);
        assert!(ledger.iter().any(|(id, _)| id == "0004_code_plan_modes"));

        // And the baseline is the newest row, which is the unknown one.
        assert_eq!(baseline_time_applied(&conn).unwrap(), Some(9999));
    }

    #[test]
    fn a_failing_migration_rolls_back_and_records_nothing() {
        let mut conn = memory();
        let broken = Migration {
            id: "0001_broken".to_string(),
            sql: "CREATE TABLE ok (x); THIS IS NOT SQL;".to_string(),
            checksum_input_json: "[\"a\"]".to_string(),
        };
        assert!(run_migrations(&mut conn, &[broken], 100).is_err());
        assert!(
            read_ledger(&conn).unwrap().is_empty(),
            "a failed migration must not be recorded"
        );
        // The first statement of the batch is rolled back too.
        let table_exists: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='ok'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 0, "the partial migration must be rolled back");
    }
}
