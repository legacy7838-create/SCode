//! `zcode-task-index` — the task index store.
//!
//! Spec: docs/specs/rust-native-task-index.md.
//!
//! One file, one implementation. `TaskIndexRepo`, `AutomationRepo` and `OffPeakTaskRepo` all
//! open the **same** `~/.zcode/v2/tasks-index.sqlite` (stated at `automationRepo.ts:222` and
//! `offPeakTaskRepo.ts:9`, and confirmed by the live schema), so porting one and leaving the
//! other two on `node:sqlite` would leave two languages owning a persisted file with a shared
//! migration ledger. All three move together, as three facades over one connection.
//!
//! Step 1 of §4.5 — the foundation: schema, migration runner, open/close. It is gated on
//! opening a copy of the real database and asserting the schema and ledger match, because
//! nothing else may start until the file itself is proven readable.

pub mod migrate;

pub use migrate::{
    baseline_time_applied, is_valid_migration_id, read_ledger, run_migrations, Migration,
    MigrationError, LEDGER_DDL,
};

/// The pragmas the TypeScript sets on open (`taskIndexRepo.ts:527-530`).
///
/// `synchronous` deserves a note: the store requests `NORMAL`, but the **real database
/// reports `synchronous = 2` (FULL)**, so the requested value is not what is in effect. The
/// port sets what the store asked for, exactly as the TypeScript did, and records the
/// *effective* value so a caller can see the difference rather than assume it.
pub const BUSY_TIMEOUT_SQL: &str = "PRAGMA busy_timeout = 5000";
pub const FOREIGN_KEYS_SQL: &str = "PRAGMA foreign_keys = ON";
pub const JOURNAL_MODE_SQL: &str = "PRAGMA journal_mode = WAL";
pub const SYNCHRONOUS_SQL: &str = "PRAGMA synchronous = NORMAL";

/// A store failure, typed so the caller can distinguish a locked file from a corrupt one
/// rather than matching on message text.
#[derive(Debug)]
pub enum StoreError {
    /// The file could not be opened or read.
    Open {
        path: String,
        source: rusqlite::Error,
    },
    /// A statement failed.
    Query {
        context: String,
        source: rusqlite::Error,
    },
    /// A migration failed. See [`MigrationError`] for the variants.
    Migration(MigrationError),
    /// A call arrived after `close()`.
    Closed,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Open { path, source } => {
                write!(f, "cannot open the task index at {path}: {source}")
            }
            StoreError::Query { context, source } => write!(f, "{context}: {source}"),
            StoreError::Migration(error) => write!(f, "{error}"),
            StoreError::Closed => write!(f, "the task index store is closed"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<MigrationError> for StoreError {
    fn from(error: MigrationError) -> Self {
        StoreError::Migration(error)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(source: rusqlite::Error) -> Self {
        StoreError::Query {
            context: "task index statement failed".into(),
            source,
        }
    }
}
