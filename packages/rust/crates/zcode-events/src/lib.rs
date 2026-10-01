//! zcode-events — the session persistence store (`docs/specs/rust-native-events.md`).
//!
//! napi surface per spec §3.1: exactly two sync exports (constructor + `close`),
//! every DB operation an `AsyncTask` on the libuv threadpool. Op kinds are a
//! closed set whose SQL is ported verbatim from the legacy repositories — there
//! is no raw-SQL escape hatch.

mod debug;
mod dwf_journal;
mod error;
mod jsjson;
mod migrate;
mod migrations;
mod ops;
mod store;

use std::sync::Arc;

use napi::bindgen_prelude::{AsyncTask, Env};
use napi::Task;
use napi_derive::napi;

use crate::error::StoreError;
use crate::store::StoreInner;

#[napi(object)]
pub struct EventsOpenOptions {
  pub db_path: String,
  /// Legacy `DatabaseSync { timeout }` (default 5 000).
  pub startup_lock_timeout_ms: u32,
  /// Migration lock budget (default 3 600 000, spec §3.1).
  pub migration_lock_wait_ms: u32,
  /// Test-only; mirrors `options.forkCommitFaultAt` (`options.ts:5-9`).
  pub fork_commit_fault_at: Option<String>,
}

#[napi(object)]
pub struct MigrationStepResult {
  /// "progress" | "delay" | "done"
  pub kind: String,
  /// `SqliteMigrationProgress` as JSON (validated by TS with
  /// `zcodeStorageStartupStateSchema`).
  pub progress: Option<String>,
  pub delay_ms: Option<u32>,
}

/// One unit of store work: named op kind + JSON payload (transport per §3.3).
#[napi(object)]
pub struct StoreOp {
  pub kind: String,
  pub payload: String,
}

#[napi]
pub struct EventsStore {
  inner: Arc<StoreInner>,
}

#[napi]
impl EventsStore {
  /// Sync, no I/O: validates options and allocates state (§2.3).
  #[napi(constructor)]
  pub fn new(options: EventsOpenOptions) -> Self {
    let _ = options.fork_commit_fault_at;
    EventsStore {
      inner: Arc::new(StoreInner::new(
        options.db_path,
        options.startup_lock_timeout_ms as i64,
        options.migration_lock_wait_ms as i64,
      )),
    }
  }

  /// Runs the native migration state machine to its next yield point
  /// (progress | delay | done). The frozen migration list is owned by the crate
  /// (`migrations.rs`), so no migration SQL text crosses the boundary.
  #[napi]
  pub fn migrate_step(&self) -> AsyncTask<MigrateStepTask> {
    AsyncTask::new(MigrateStepTask {
      inner: self.inner.clone(),
    })
  }

  /// One write batch: `BEGIN IMMEDIATE …ops… [coalesced prune] … COMMIT` (§4.2).
  /// Resolves a JSON array of per-op results, same length as `ops`.
  #[napi]
  pub fn write_batch(&self, ops: Vec<StoreOp>) -> AsyncTask<WriteBatchTask> {
    AsyncTask::new(WriteBatchTask {
      inner: self.inner.clone(),
      ops: ops.into_iter().map(|op| (op.kind, op.payload)).collect(),
    })
  }

  /// Barrier read (the dispatcher flushes the pending batch first).
  #[napi]
  pub fn read(&self, op: StoreOp) -> AsyncTask<ReadTask> {
    AsyncTask::new(ReadTask {
      inner: self.inner.clone(),
      kind: op.kind,
      payload: op.payload,
    })
  }

  /// Transaction scope for TS-orchestrated legacy transactions (§4.3).
  /// Only the scope owner reaches these — the JS dispatcher is the sole scheduler.
  #[napi]
  pub fn tx_begin(&self) -> AsyncTask<TxTask> {
    AsyncTask::new(TxTask {
      inner: self.inner.clone(),
      op: TxOp::Begin,
    })
  }

  /// One op inside the open transaction; rows for reads.
  #[napi]
  pub fn tx_exec(&self, op: StoreOp) -> AsyncTask<TxExecTask> {
    AsyncTask::new(TxExecTask {
      inner: self.inner.clone(),
      kind: op.kind,
      payload: op.payload,
    })
  }

  #[napi]
  pub fn tx_commit(&self) -> AsyncTask<TxTask> {
    AsyncTask::new(TxTask {
      inner: self.inner.clone(),
      op: TxOp::Commit,
    })
  }

  #[napi]
  pub fn tx_rollback(&self) -> AsyncTask<TxTask> {
    AsyncTask::new(TxTask {
      inner: self.inner.clone(),
      op: TxOp::Rollback,
    })
  }

  /// Marks closed; rejects new calls; already-issued ops drain; the connection
  /// is released after the last in-flight task (sync, no I/O — §2.3/§5.4-H6).
  #[napi]
  pub fn close(&self) {
    self.inner.close();
  }
}

type TaskResult<T> = std::result::Result<T, napi::Error>;

fn into_napi<T>(result: Result<T, StoreError>) -> TaskResult<T> {
  result.map_err(StoreError::into_napi)
}

pub struct MigrateStepTask {
  inner: Arc<StoreInner>,
}

impl Task for MigrateStepTask {
  type Output = MigrationStepResult;
  type JsValue = MigrationStepResult;

  fn compute(&mut self) -> TaskResult<Self::Output> {
    let step = into_napi(self.inner.migrate_step())?;
    Ok(MigrationStepResult {
      kind: step.kind.to_string(),
      progress: step.progress,
      delay_ms: step.delay_ms,
    })
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> TaskResult<Self::JsValue> {
    Ok(output)
  }
}

pub struct WriteBatchTask {
  inner: Arc<StoreInner>,
  ops: Vec<(String, String)>,
}

impl Task for WriteBatchTask {
  type Output = String;
  type JsValue = String;

  fn compute(&mut self) -> TaskResult<Self::Output> {
    into_napi(self.inner.write_batch(&self.ops))
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> TaskResult<Self::JsValue> {
    Ok(output)
  }
}

pub struct ReadTask {
  inner: Arc<StoreInner>,
  kind: String,
  payload: String,
}

impl Task for ReadTask {
  type Output = String;
  type JsValue = String;

  fn compute(&mut self) -> TaskResult<Self::Output> {
    into_napi(self.inner.read(&self.kind, &self.payload))
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> TaskResult<Self::JsValue> {
    Ok(output)
  }
}

pub struct TxExecTask {
  inner: Arc<StoreInner>,
  kind: String,
  payload: String,
}

impl Task for TxExecTask {
  type Output = String;
  type JsValue = String;

  fn compute(&mut self) -> TaskResult<Self::Output> {
    into_napi(self.inner.tx_exec(&self.kind, &self.payload))
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> TaskResult<Self::JsValue> {
    Ok(output)
  }
}

enum TxOp {
  Begin,
  Commit,
  Rollback,
}

pub struct TxTask {
  inner: Arc<StoreInner>,
  op: TxOp,
}

impl Task for TxTask {
  type Output = ();
  type JsValue = ();

  fn compute(&mut self) -> TaskResult<Self::Output> {
    match self.op {
      TxOp::Begin => into_napi(self.inner.tx_begin()),
      TxOp::Commit => into_napi(self.inner.tx_commit()),
      TxOp::Rollback => into_napi(self.inner.tx_rollback()),
    }
  }

  fn resolve(&mut self, _env: Env, _output: Self::Output) -> TaskResult<Self::JsValue> {
    Ok(())
  }
}
