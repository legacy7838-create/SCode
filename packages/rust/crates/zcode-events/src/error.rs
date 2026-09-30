//! Structured store errors. The napi-facing message is a JSON envelope
//! (`{"z":1,...}`) that `packages/rust/src/events.ts` decodes back into a plain
//! Error with `kind`/`errcode`/`migrationId`/`dbPath` properties so the legacy
//! classification (`packages/shared/src/database-startup.ts`) is unchanged.

use napi::Status;

#[derive(Debug, Clone)]
pub struct StoreError {
  /// Structured kind (e.g. `checksum_mismatch`, `sql_failed`, `lock_timeout`, `open_failed`).
  pub kind: Option<String>,
  /// Human-readable message (matches legacy texts where the spec requires it).
  pub message: String,
  /// SQLite result code (extended where available); mirrors node:sqlite `errcode`.
  pub errcode: Option<i32>,
  pub migration_id: Option<String>,
  pub db_path: Option<String>,
}

impl StoreError {
  /// Plain operation failure: no structured `kind` (legacy op errors are bare
  /// node:sqlite/JS errors; classification for these walks `errcode` only).
  pub fn op(message: impl Into<String>) -> Self {
    StoreError { kind: None, message: message.into(), errcode: None, migration_id: None, db_path: None }
  }

  pub fn with_kind(mut self, kind: &str) -> Self {
    self.kind = Some(kind.to_string());
    self
  }

  pub fn with_migration(mut self, id: &str) -> Self {
    self.migration_id = Some(id.to_string());
    self
  }

  pub fn with_db_path(mut self, path: &str) -> Self {
    self.db_path = Some(path.to_string());
    self
  }

  /// Envelope for the JS side; see module docs.
  pub fn envelope(&self) -> String {
    let mut out = String::from("{\"z\":1,\"m\":");
    push_json_string(&mut out, &self.message);
    if let Some(kind) = &self.kind {
      out.push_str(",\"k\":");
      push_json_string(&mut out, kind);
    }
    if let Some(code) = self.errcode {
      out.push_str(",\"c\":");
      out.push_str(&code.to_string());
    }
    if let Some(id) = &self.migration_id {
      out.push_str(",\"i\":");
      push_json_string(&mut out, id);
    }
    if let Some(path) = &self.db_path {
      out.push_str(",\"d\":");
      push_json_string(&mut out, path);
    }
    out.push('}');
    out
  }

  pub fn into_napi(self) -> napi::Error {
    napi::Error::new(Status::GenericFailure, self.envelope())
  }
}

impl std::fmt::Display for StoreError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.message)
  }
}

impl std::error::Error for StoreError {}

fn push_json_string(out: &mut String, value: &str) {
  out.push('"');
  for ch in value.chars() {
    match ch {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\u{8}' => out.push_str("\\b"),
      '\u{c}' => out.push_str("\\f"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
      c => out.push(c),
    }
  }
  out.push('"');
}

/// Map a rusqlite failure onto the store error, keeping the extended result code
/// (node:sqlite exposes the extended code too; classification masks with `& 0xff`).
impl From<rusqlite::Error> for StoreError {
  fn from(err: rusqlite::Error) -> Self {
    let mut store = StoreError { kind: None, message: err.to_string(), errcode: None, migration_id: None, db_path: None };
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = &err {
      store.errcode = Some(ffi_err.extended_code);
      if store.message.is_empty() {
        store.message = ffi_err.to_string();
      }
    }
    store
  }
}

impl From<serde_json::Error> for StoreError {
  fn from(err: serde_json::Error) -> Self {
    StoreError { kind: None, message: format!("JSON payload error: {}", err), errcode: None, migration_id: None, db_path: None }
  }
}

impl From<std::io::Error> for StoreError {
  fn from(err: std::io::Error) -> Self {
    StoreError { kind: None, message: err.to_string(), errcode: None, migration_id: None, db_path: None }
  }
}

/// Store-level failures that always surface with this kind.
pub fn store_closed() -> StoreError {
  StoreError { kind: Some("store_closed".into()), message: "SQLite session store is closed".into(), errcode: None, migration_id: None, db_path: None }
}
