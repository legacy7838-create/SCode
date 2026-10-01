//! Debug observation reads over the session database
//! (`docs/specs/rust-native-events.md` §14.5).
//!
//! The `debug` package's observation server used to open its own read-only
//! `node:sqlite` connection (`sources.ts`). This module is the same three
//! queries, ported verbatim, on a read-only rusqlite connection
//! (`OpenFlags::SQLITE_OPEN_READ_ONLY`, matching
//! `new DatabaseSync(path, { readOnly: true })`).
//!
//! It is a **separate connection on purpose**: the debug server must never
//! block, migrate or take a write lock on the live session DB, and it runs in a
//! different process. Row shaping (ISO timestamps, `data` JSON parsing) stays in
//! TS — the row-transport rule of §3.3.

use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};

use crate::error::StoreError;
use crate::ops::{self, Ctx};

/// Read-only handle over the session DB for the observation server.
#[napi]
pub struct DebugSnapshot {
  conn: Connection,
  db_path: String,
}

#[napi]
impl DebugSnapshot {
  /// Opens `db_path` read-only. Mirrors the legacy `readOnly: true` open, so a
  /// missing file or a non-database file fails here exactly as it did before.
  #[napi(constructor)]
  pub fn new(db_path: String) -> napi::Result<Self> {
    let conn = Connection::open_with_flags(
      &db_path,
      OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
      StoreError::from(error)
        .with_kind("open_failed")
        .with_db_path(&db_path)
        .into_napi()
    })?;
    Ok(DebugSnapshot { conn, db_path })
  }

  /// One named read. Returns a JSON row array; there is no write op by design.
  #[napi]
  pub fn exec(&self, op: String) -> napi::Result<String> {
    let sql: &str = match op.as_str() {
      "debugSessions" => {
        "select id, project_id, title, directory, time_created, time_updated
         from session
         order by time_updated desc
         limit 200"
      }
      "debugMessages" => {
        "select id, session_id, time_created, time_updated, data
         from message
         order by time_created asc, rowid asc
         limit 1000"
      }
      "debugParts" => {
        "select id, message_id, session_id, time_created, time_updated, data
         from part
         order by time_created asc, id asc
         limit 2000"
      }
      other => {
        return Err(StoreError::op(format!("debug snapshot: unknown op `{}`", other))
          .with_db_path(&self.db_path)
          .into_napi())
      }
    };
    let ctx = Ctx { conn: &self.conn };
    ops::query_rows(&ctx, sql, &[]).map_err(StoreError::into_napi)
  }

  /// Release the read-only handle.
  #[napi]
  pub fn close(&self) {}
}
