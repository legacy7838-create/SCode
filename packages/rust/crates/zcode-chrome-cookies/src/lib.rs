//! zcode-chrome-cookies — the last `node:sqlite` user in the repository.
//!
//! `packages/desktop/src/main/chromeCookieManager.ts` imported `node:sqlite` for
//! exactly two things, and both are here now:
//!
//! 1. **Online Backup** of Chrome's own `Cookies` database into a temp snapshot,
//!    so the importer never reads a database Chrome may be writing to. This is
//!    SQLite's Online Backup API (`Connection::backup`).
//! 2. Reading the `meta.version` row and the `cookies` table out of that
//!    snapshot (`read_chrome_cookies`).
//!
//! # Why the value transport is JSON strings, not napi structs
//!
//! The `cookies` table has two shapes napi objects handle badly:
//!
//! - `encrypted_value` is a **BLOB**. Per the umbrella spec invariant 8, napi
//!   binds a real `Uint8Array` only through `Buffer`; a JSON number array would
//!   both be slow and violate the byte-boundary contract. It travels as
//!   **base64** inside a JSON string and is decoded back to a `Uint8Array` by the
//!   TS wrapper.
//! - `expires_utc` is a **64-bit microsecond timestamp** (Chrome epoch 1601, so
//!   ≈1.3e16 — well past `Number.MAX_SAFE_INTEGER`) and `is_secure` /
//!   `is_httponly` / `samesite` are the same width. `node:sqlite` returned them as
//!   `BigInt` via `setReadBigInts(true)`, and `chromeCookieMapping.ts` compares
//!   them against `1n` / `0n`. Serializing them as JSON numbers would silently
//!   round them, so they travel as **decimal strings** and the wrapper rebuilds
//!   real `BigInt`s.
//!
//! Nothing else in the payload needs a struct: it is a flat table read.

use base64::Engine;
use napi::bindgen_prelude::AsyncTask;
use napi::Task;
use napi_derive::napi;
use rusqlite::backup::{Backup, StepResult};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

const COOKIE_COLUMNS: &str = "host_key, name, path, expires_utc, is_secure, is_httponly, samesite, value, encrypted_value";

/// Copies `source_path` into `dest_path` with SQLite's Online Backup API and
/// returns the number of pages written.
///
/// The source is opened read-only, mirroring
/// `new DatabaseSync(sourcePath, { readOnly: true })`.
///
/// This is a bounded amount of IO (one cookie database), and the legacy
/// `await backup(...)` was async, so it stays an `AsyncTask` on the libuv
/// threadpool: the Electron main-process event loop keeps running while Chrome's
/// database is snapshotted.
#[napi]
pub fn backup_chrome_cookie_db(
  source_path: String,
  dest_path: String,
) -> AsyncTask<BackupChromeCookieDbTask> {
  AsyncTask::new(BackupChromeCookieDbTask {
    source_path,
    dest_path,
  })
}

/// The Online Backup step, run off the event loop.
pub struct BackupChromeCookieDbTask {
  source_path: String,
  dest_path: String,
}

impl Task for BackupChromeCookieDbTask {
  type Output = u32;
  type JsValue = u32;

  fn compute(&mut self) -> Result<Self::Output, napi::Error> {
    backup_database(&self.source_path, &self.dest_path).map_err(|error| {
      napi::Error::from_reason(format!("chrome cookie backup failed: {}", error))
    })
  }

  fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue, napi::Error> {
    Ok(output)
  }
}

fn backup_database(source_path: &str, dest_path: &str) -> rusqlite::Result<u32> {
  let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
  let mut destination = Connection::open(dest_path)?;
  let backup = Backup::new(&source, &mut destination)?;
  // A negative page count copies every remaining page in one step. `Busy`/`Locked`
  // are surfaced as an error rather than retried here: the TS caller already owns
  // a staged-copy retry ladder for a locked source, and a second, hidden retry
  // policy here would mask it (AGENTS.md: no timeout/fallback ladders).
  match backup.step(-1)? {
    StepResult::Done => Ok(backup.progress().pagecount as u32),
    _ => Err(rusqlite::Error::InvalidQuery),
  }
}

/// Reads `meta.version` and every `cookies` row from a snapshot.
///
/// Returns `{ "schemaVersion": <number>, "rows": [ … ] }`; see the module docs
/// for the 64-bit / BLOB encodings.
#[napi]
pub fn read_chrome_cookies(database_path: String) -> napi::Result<String> {
  let conn = Connection::open_with_flags(&database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| napi::Error::from_reason(format!("chrome cookie open failed: {}", error)))?;

  let schema_version: f64 = conn
    .query_row(
      "SELECT value FROM meta WHERE key = 'version'",
      [],
      |row| match row.get_ref(0)? {
        ValueRef::Text(bytes) => Ok(String::from_utf8_lossy(bytes).parse::<f64>().unwrap_or(0.0)),
        ValueRef::Integer(value) => Ok(value as f64),
        _ => Ok(0.0),
      },
    )
    .unwrap_or(0.0);

  let mut statement = conn
    .prepare(&format!("SELECT {} FROM cookies", COOKIE_COLUMNS))
    .map_err(|error| napi::Error::from_reason(format!("chrome cookie prepare failed: {}", error)))?;
  let column_names: Vec<String> = statement
    .column_names()
    .iter()
    .map(|name| name.to_string())
    .collect();
  let mut rows = statement
    .query([])
    .map_err(|error| napi::Error::from_reason(format!("chrome cookie query failed: {}", error)))?;

  let mut encoded_rows: Vec<serde_json::Value> = Vec::new();
  while let Some(row) = rows
    .next()
    .map_err(|error| napi::Error::from_reason(format!("chrome cookie row failed: {}", error)))?
  {
    let mut map = serde_json::Map::with_capacity(column_names.len());
    for (index, name) in column_names.iter().enumerate() {
      let value = row
        .get_ref(index)
        .map_err(|error| napi::Error::from_reason(format!("chrome cookie column failed: {}", error)))?;
      let json = match value {
        // 64-bit integers (expires_utc, is_secure, is_httponly, samesite) are
        // decimal strings; JSON numbers would round them past 2^53.
        ValueRef::Integer(number) => serde_json::Value::String(number.to_string()),
        ValueRef::Real(number) => serde_json::Number::from_f64(number)
          .map(serde_json::Value::Number)
          .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(bytes) => serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()),
        // BLOB → base64; the TS wrapper decodes to the Uint8Array the type declares.
        ValueRef::Blob(bytes) => {
          serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        ValueRef::Null => serde_json::Value::Null,
      };
      map.insert(name.clone(), json);
    }
    encoded_rows.push(serde_json::Value::Object(map));
  }

  let payload = serde_json::json!({
    "schemaVersion": schema_version,
    "rows": encoded_rows,
  });
  Ok(payload.to_string())
}
