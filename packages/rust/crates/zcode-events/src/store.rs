//! `EventsStore` internals: connection lifecycle, write batching with the
//! coalesced prune (§4.2), and transaction-scope plumbing (§4.3).

use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{store_closed, StoreError};
use crate::jsjson;
use crate::migrate::{self, MigState};
use crate::ops::{self, Ctx};

pub struct StoreInner {
  pub db_path: String,
  pub startup_lock_timeout_ms: i64,
  pub migration_lock_wait_ms: i64,
  pub state: Mutex<State>,
}

pub struct State {
  conn: Option<Connection>,
  closed: bool,
  in_tx: bool,
  migration: Option<MigState>,
}

impl StoreInner {
  pub fn new(
    db_path: String,
    startup_lock_timeout_ms: i64,
    migration_lock_wait_ms: i64,
  ) -> Self {
    StoreInner {
      db_path,
      startup_lock_timeout_ms,
      migration_lock_wait_ms,
      state: Mutex::new(State {
        conn: None,
        closed: false,
        in_tx: false,
        migration: None,
      }),
    }
  }

  /// Marks closed and releases the connection (sync, no task work). In-flight
  /// tasks hold the mutex, so they drain first; WAL is crash-consistent (D5).
  pub fn close(&self) {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    state.closed = true;
    state.conn = None;
    state.migration = None;
  }

  fn ensure_conn<'a>(&self, state: &'a mut State) -> Result<&'a Connection, StoreError> {
    if state.conn.is_none() {
      match Connection::open(&self.db_path) {
        Ok(conn) => state.conn = Some(conn),
        Err(error) => {
          let error = StoreError::from(error)
            .with_kind("open_failed")
            .with_db_path(&self.db_path);
          return Err(error);
        }
      }
      // Legacy `new DatabaseSync(path, { timeout })` — applied only at open so
      // the migration state machine's 25 ms / 5 000 ms schedule is not clobbered.
      let conn = state.conn.as_ref().expect("connection just opened");
      conn.execute_batch(&format!(
        "pragma busy_timeout = {}",
        self.startup_lock_timeout_ms
      ))?;
    }
    Ok(state.conn.as_ref().expect("connection just opened"))
  }

  fn check_open(state: &State) -> Result<(), StoreError> {
    if state.closed {
      return Err(store_closed());
    }
    Ok(())
  }

  pub fn migrate_step(&self) -> Result<migrate::StepOut, StoreError> {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    Self::check_open(&state)?;
    let lock_wait = self.migration_lock_wait_ms;
    self.ensure_conn(&mut state)?;
    state.migration.get_or_insert_with(|| MigState::new(lock_wait));
    let db_path = self.db_path.clone();
    let mut machine = state.migration.take().expect("migration state just initialized");
    let outcome = {
      let conn = state.conn.as_ref().expect("connection just opened");
      migrate::step(&mut machine, conn, &db_path)
    };
    state.migration = Some(machine);
    outcome
  }

  /// `BEGIN IMMEDIATE …ops… [coalesced prune] … COMMIT`; on failure the whole
  /// batch rolls back and the failing op's error rejects every op (D1).
  pub fn write_batch(&self, ops: &[(String, String)]) -> Result<String, StoreError> {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    Self::check_open(&state)?;
    if state.in_tx {
      return Err(StoreError::op(
        "write_batch cannot run while a transaction scope is open",
      ));
    }
    let conn = self.ensure_conn(&mut state)?;
    let ctx = Ctx { conn };
    if let Err(error) = conn.execute_batch("begin immediate") {
      return Err(StoreError::from(error));
    }
    let mut results: Vec<String> = Vec::with_capacity(ops.len());
    let mut needs_prune = false;
    let mut outcome: Result<String, StoreError> = Ok(String::new());
    for (kind, payload) in ops {
      if ops::TX_ONLY_KINDS.contains(&kind.as_str()) {
        outcome = Err(StoreError::op(format!(
          "op `{}` is only valid inside a transaction scope",
          kind
        )));
        break;
      }
      if ops::is_usage_write(kind) {
        needs_prune = true;
      }
      let parsed = match jsjson::parse(payload) {
        Ok(parsed) => parsed,
        Err(error) => {
          outcome = Err(error);
          break;
        }
      };
      match ops::dispatch(&ctx, kind, &parsed) {
        Ok(result) => results.push(result),
        Err(error) => {
          outcome = Err(error);
          break;
        }
      }
    }
    if outcome.is_ok() && needs_prune {
      // §4.2: retention deletes run once per batch at batch-commit time (D2).
      let before_time = now_ms() - ops::USAGE_RETENTION_MS;
      let prune_result: Result<(), StoreError> = (|| {
        ops::execute(
          &ctx,
          "delete from model_usage where started_at < ?1",
          &[ops::js_i64(before_time)],
        )?;
        ops::execute(
          &ctx,
          "delete from turn_usage where started_at < ?1",
          &[ops::js_i64(before_time)],
        )?;
        ops::execute(
          &ctx,
          "delete from tool_usage where started_at < ?1",
          &[ops::js_i64(before_time)],
        )?;
        Ok(())
      })();
      if let Err(error) = prune_result {
        outcome = Err(error);
      }
    }
    if let Err(error) = &outcome {
      let _ = conn.execute_batch("rollback");
      return Err(error.clone());
    }
    if let Err(error) = conn.execute_batch("commit") {
      let _ = conn.execute_batch("rollback");
      return Err(StoreError::from(error));
    }
    Ok(format!("[{}]", results.join(",")))
  }

  pub fn read(&self, kind: &str, payload_text: &str) -> Result<String, StoreError> {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    Self::check_open(&state)?;
    let conn = self.ensure_conn(&mut state)?;
    let ctx = Ctx { conn };
    let payload = jsjson::parse(payload_text)?;
    ops::dispatch(&ctx, kind, &payload)
  }

  pub fn tx_begin(&self) -> Result<(), StoreError> {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    Self::check_open(&state)?;
    if state.in_tx {
      return Err(StoreError::op("a transaction scope is already open"));
    }
    let conn = self.ensure_conn(&mut state)?;
    if let Err(error) = conn.execute_batch("begin immediate") {
      return Err(StoreError::from(error));
    }
    state.in_tx = true;
    Ok(())
  }

  pub fn tx_exec(&self, kind: &str, payload_text: &str) -> Result<String, StoreError> {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    Self::check_open(&state)?;
    if !state.in_tx {
      return Err(StoreError::op("tx_exec without an open transaction scope"));
    }
    let conn = self.ensure_conn(&mut state)?;
    let ctx = Ctx { conn };
    let payload = jsjson::parse(payload_text)?;
    ops::dispatch(&ctx, kind, &payload)
  }

  pub fn tx_commit(&self) -> Result<(), StoreError> {
    self.tx_finish(true)
  }

  pub fn tx_rollback(&self) -> Result<(), StoreError> {
    self.tx_finish(false)
  }

  fn tx_finish(&self, commit: bool) -> Result<(), StoreError> {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    Self::check_open(&state)?;
    if !state.in_tx {
      return Err(StoreError::op("transaction finish without an open scope"));
    }
    let result = {
      let conn = self.ensure_conn(&mut state)?;
      if commit {
        conn.execute_batch("commit")
      } else {
        conn.execute_batch("rollback")
      }
    };
    state.in_tx = false;
    result.map_err(StoreError::from)
  }
}

fn now_ms() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}
