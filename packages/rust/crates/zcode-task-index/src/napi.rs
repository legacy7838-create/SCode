//! The napi surface, so the TypeScript repositories can reach this crate.
//!
//! Spec: docs/specs/rust-native-task-index.md §4.4, §7 (the consumer switch is not gated on
//! the Electron cutover).
//!
//! # Shape
//!
//! Everything crossing the boundary is a **JSON string**, matching `zcode-events` §3.3 and
//! `zcode-mcp-config`: the domain types stay in TypeScript where the contracts live, and
//! `@zcode/rust` stays free of npm dependencies.
//!
//! # Async, because it is all file IO
//!
//! The event-loop rule: anything that can exceed ~1 ms must not block the loop. Every method
//! here opens the same database the old `node:sqlite` handle did, so every method is an
//! `AsyncTask` and runs on the libuv threadpool. The two exceptions are the constructor and
//! `close`, which do no IO.
//!
//! # Migrations arrive as data, not as code
//!
//! `open` takes the migration list as JSON, including each migration's **already-stringified**
//! `JSON.stringify(checksumInput)`. That is deliberate and was verified against the real
//! ledger: the checksum is `sha256(JSON.stringify(checksumInput))`, so the TypeScript side
//! serialises once, in the language whose `JSON.stringify` defined the format, and the crate
//! hashes bytes. Re-serialising here would require reproducing `JSON.stringify` exactly.

use std::sync::Mutex;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

use crate::automation::AutomationStore;
pub use crate::grouped::{TaskWrite, ViewNodeOrder, WriteBatch};
use crate::migrate::{run_migrations, Migration};
use crate::offpeak::OffPeakStore;
use crate::read::{list_tasks_with_snippets, ListQuery};
use crate::StoreError;

/// Options for the store, matching the legacy `TaskIndexRepoOptions` shape.
///
/// `#[napi(object)]` so the constructor can take it directly. The optional fields are `Option`
/// rather than carrying serde defaults, because **napi's `FromNapiValue` does not honour
/// `#[serde(default)]`** — a non-`Option` field is simply required, and omitting it fails with
/// "Missing field". The defaults are applied here instead, so the TypeScript side can pass
/// only what it knows.
#[napi(object)]
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenOptions {
    /// Absolute path to `tasks-index.sqlite`.
    pub path: String,
    /// Defaults to 5,000 ms, matching the legacy open.
    pub busy_timeout_ms: Option<i64>,
    /// Open without creating a file or applying migrations, for queries that must not.
    pub read_only: Option<bool>,
}

const DEFAULT_BUSY_TIMEOUT_MS: i64 = 5_000;

/// One migration, as supplied by the TypeScript side.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationJson {
    id: String,
    sql: String,
    /// `JSON.stringify(checksumInput)`, already serialised. See the module docs.
    checksum_input_json: String,
}

impl From<MigrationJson> for Migration {
    fn from(value: MigrationJson) -> Self {
        Migration {
            id: value.id,
            sql: value.sql,
            checksum_input_json: value.checksum_input_json,
        }
    }
}

/// The store's shared state.
///
/// `Option<Connection>` so `close` can release it: a closed store rejects rather than
/// silently reopening, which is what the legacy `close({ throwOnError })` path did.
struct Inner {
    /// Kept from construction so `ensure_ready` — which the caller invokes explicitly, to
    /// keep the constructor IO-free — can open the file later.
    path: String,
    busy_timeout_ms: i64,
    connection: Mutex<Option<rusqlite::Connection>>,
    read_only: bool,
}

/// Renders any error into a napi error.
///
/// Takes the already-rendered string rather than `impl Display`, because `napi::Error`'s
/// constructors are generic over `AsRef<str>` and inference gets ambiguous otherwise.
fn to_napi_error(message: impl AsRef<str>) -> Error {
    Error::from_reason(message.as_ref())
}

/// The task index store.
///
/// Named methods mirror the three repositories, so a TypeScript wrapper reads as a direct
/// translation rather than a reshape: `write_*` and `list_*` are the task index,
/// `offpeak_*` and `automation_*` are the two sibling facades over the same connection.
#[napi]
pub struct TaskIndexStore {
    inner: std::sync::Arc<Inner>,
}

#[napi]
impl TaskIndexStore {
    /// Opens the store. **No IO** — the file is opened and the migrations run by `ensure_ready`,
    /// so a missing binary fails at the `loadNative` call rather than inside a constructor the
    /// caller cannot distinguish from a bad path.
    #[napi(constructor)]
    pub fn new(options: OpenOptions) -> Self {
        let busy_timeout_ms = options.busy_timeout_ms.unwrap_or(DEFAULT_BUSY_TIMEOUT_MS);
        let read_only = options.read_only.unwrap_or(false);
        TaskIndexStore {
            inner: std::sync::Arc::new(Inner {
                path: options.path,
                busy_timeout_ms,
                // A placeholder until `ensure_ready`; an unopened store rejects every call.
                connection: Mutex::new(None),
                read_only,
            }),
        }
    }

    /// Opens the file, applies the pragmas and runs the migrations. The one IO-bearing call
    /// the caller makes explicitly.
    #[napi]
    pub fn ensure_ready(
        &self,
        migrations_json: String,
        now_ms: f64,
    ) -> AsyncTask<EnsureReadyTask> {
        AsyncTask::new(EnsureReadyTask {
            inner: std::sync::Arc::clone(&self.inner),
            migrations_json,
            now_ms: now_ms as i64,
        })
    }

    /// `TaskIndexRepo.writeRecord` and the grouped-view bookkeeping, in one transaction.
    #[napi]
    pub fn write_batch(&self, batch_json: String) -> AsyncTask<WriteBatchTask> {
        AsyncTask::new(WriteBatchTask {
            inner: std::sync::Arc::clone(&self.inner),
            batch_json,
        })
    }

    /// The task list, with search snippets attached.
    #[napi]
    pub fn list_tasks(&self, query_json: String) -> AsyncTask<ListTasksTask> {
        AsyncTask::new(ListTasksTask {
            inner: std::sync::Arc::clone(&self.inner),
            query_json,
        })
    }

    /// `OffPeakTaskRepo.claimDue` — the compare-and-swap claim, in one transaction.
    #[napi]
    pub fn offpeak_claim_due(&self, now_ms: f64) -> AsyncTask<OffPeakClaimDueTask> {
        AsyncTask::new(OffPeakClaimDueTask {
            inner: std::sync::Arc::clone(&self.inner),
            now_ms: now_ms as i64,
        })
    }

    #[napi]
    pub fn offpeak_count_non_terminal(&self) -> AsyncTask<OffPeakCountTask> {
        AsyncTask::new(OffPeakCountTask {
            inner: std::sync::Arc::clone(&self.inner),
            which: CountKind::NonTerminal,
        })
    }

    #[napi]
    pub fn offpeak_count_active(&self) -> AsyncTask<OffPeakCountTask> {
        AsyncTask::new(OffPeakCountTask {
            inner: std::sync::Arc::clone(&self.inner),
            which: CountKind::Active,
        })
    }

    /// `AutomationRepo.claimDue` — includes the backoff guard and the expired-task retirement.
    #[napi]
    pub fn automation_claim_due(&self, now_ms: f64) -> AsyncTask<AutomationClaimDueTask> {
        AsyncTask::new(AutomationClaimDueTask {
            inner: std::sync::Arc::clone(&self.inner),
            now_ms: now_ms as i64,
        })
    }

    #[napi]
    pub fn automation_release_claim(
        &self,
        automation_id: String,
    ) -> AsyncTask<AutomationReleaseClaimTask> {
        AsyncTask::new(AutomationReleaseClaimTask {
            inner: std::sync::Arc::clone(&self.inner),
            automation_id,
        })
    }

    /// `AutomationRepo.hasTaskBinding`.
    #[napi]
    pub fn automation_has_task_binding(
        &self,
        automation_id: String,
    ) -> AsyncTask<AutomationBindingTask> {
        AsyncTask::new(AutomationBindingTask {
            inner: std::sync::Arc::clone(&self.inner),
            automation_id,
        })
    }

    /// `OffPeakTaskRepo.get`.
    #[napi]
    pub fn offpeak_get(&self, off_peak_task_id: String) -> AsyncTask<OffPeakGetTask> {
        AsyncTask::new(OffPeakGetTask {
            inner: std::sync::Arc::clone(&self.inner),
            off_peak_task_id,
        })
    }

    /// `AutomationRepo.getScheduledRunCount`.
    #[napi]
    pub fn automation_scheduled_run_count(
        &self,
        automation_id: String,
    ) -> AsyncTask<AutomationRunCountTask> {
        AsyncTask::new(AutomationRunCountTask {
            inner: std::sync::Arc::clone(&self.inner),
            automation_id,
        })
    }

    /// Marks the store closed and releases the connection. **No IO** — in-flight tasks hold
    /// their own borrow, so the connection drops once they drain (the `zcode-events` §4.2 rule).
    #[napi]
    pub fn close(&self) {
        if let Ok(mut guard) = self.inner.connection.lock() {
            *guard = None;
        }
    }
}

// ---- task bodies ----

/// Locks the connection, or reports that the store is closed.
///
/// A `None` here means `close` ran, which is a real condition and not a panic: the legacy
/// `close({ throwOnError: false })` path made a post-close call a no-op, and an error is
/// louder and easier to trace than silence.
/// Locks the connection, or reports that the store is closed.
///
/// Generic over the error type because the underlying functions return `StoreError` or
/// `MigrationError`; both are rendered through `Display`, which is what the legacy code's
/// `error instanceof Error ? error.message : String(error)` produced.
fn with_connection<T, E>(
    inner: &Inner,
    operation: impl FnOnce(&rusqlite::Connection) -> std::result::Result<T, E>,
) -> std::result::Result<T, Error>
where
    E: std::fmt::Display,
{
    let guard = inner
        .connection
        .lock()
        .map_err(|_| to_napi_error("the task index store lock is poisoned"))?;
    let connection = guard
        .as_ref()
        .ok_or_else(|| to_napi_error("the task index store is closed"))?;
    operation(connection).map_err(|error| to_napi_error(error.to_string()))
}

fn with_connection_mut<T, E>(
    inner: &Inner,
    operation: impl FnOnce(&mut rusqlite::Connection) -> std::result::Result<T, E>,
) -> std::result::Result<T, Error>
where
    E: std::fmt::Display,
{
    let mut guard = inner
        .connection
        .lock()
        .map_err(|_| to_napi_error("the task index store lock is poisoned"))?;
    let connection = guard
        .as_mut()
        .ok_or_else(|| to_napi_error("the task index store is closed"))?;
    operation(connection).map_err(|error| to_napi_error(error.to_string()))
}

pub struct EnsureReadyTask {
    inner: std::sync::Arc<Inner>,
    migrations_json: String,
    now_ms: i64,
}

impl Task for EnsureReadyTask {
    type Output = ();
    type JsValue = ();

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let path = self.inner.path.clone();
        let migrations: Vec<MigrationJson> =
            serde_json::from_str(&self.migrations_json).map_err(|error| to_napi_error(error.to_string()))?;
        let migrations: Vec<Migration> = migrations.into_iter().map(Into::into).collect();

        let mut connection = rusqlite::Connection::open(&path).map_err(|error| {
            to_napi_error(StoreError::Open { path: path.clone(), source: error }.to_string())
        })?;
        if !self.inner.read_only {
            // The same four pragmas as the legacy open, in the same order, with the caller's
            // `busy_timeout` rather than a hardcoded one.
            connection
                .execute_batch(&format!(
                    "PRAGMA busy_timeout = {};\nPRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;",
                    self.inner.busy_timeout_ms
                ))
                .map_err(|error| {
                    to_napi_error(StoreError::Open { path: path.clone(), source: error }.to_string())
                })?;
        }
        run_migrations(&mut connection, &migrations, self.now_ms)
            .map_err(|error| to_napi_error(StoreError::Migration(error).to_string()))?;

        let mut guard = self
            .inner
            .connection
            .lock()
            .map_err(|_| to_napi_error("the task index store lock is poisoned"))?;
        *guard = Some(connection);
        Ok(())
    }
}

pub struct WriteBatchTask {
    inner: std::sync::Arc<Inner>,
    batch_json: String,
}

impl Task for WriteBatchTask {
    type Output = i64;
    type JsValue = i64;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let batch: WriteBatch =
            serde_json::from_str(&self.batch_json).map_err(|error| to_napi_error(error.to_string()))?;
        let written = with_connection_mut(&self.inner, |connection| {
            crate::grouped::apply_batch(connection, &batch, 0)
        })?;
        // `apply_batch` returns a count; the boundary declares `i64` because napi has no
        // unsigned type in the portable set, and a count is never negative.
        Ok(written as i64)
    }
}

pub struct ListTasksTask {
    inner: std::sync::Arc<Inner>,
    query_json: String,
}

impl Task for ListTasksTask {
    type Output = String;
    type JsValue = String;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let query: ListQuery =
            serde_json::from_str(&self.query_json).map_err(|error| to_napi_error(error.to_string()))?;
        let rows = with_connection(&self.inner, |connection| {
            list_tasks_with_snippets(connection, &query)
        })?;
        serde_json::to_string(&rows).map_err(|error| to_napi_error(error.to_string()))
    }
}

pub struct OffPeakClaimDueTask {
    inner: std::sync::Arc<Inner>,
    now_ms: i64,
}

impl Task for OffPeakClaimDueTask {
    type Output = String;
    type JsValue = String;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let claimed = with_connection_mut(&self.inner, |connection| {
            OffPeakStore::claim_due(connection, self.now_ms)
        })?;
        serde_json::to_string(&claimed).map_err(|error| to_napi_error(error.to_string()))
    }
}

#[derive(Clone, Copy)]
enum CountKind {
    NonTerminal,
    Active,
}

pub struct OffPeakCountTask {
    inner: std::sync::Arc<Inner>,
    which: CountKind,
}

impl Task for OffPeakCountTask {
    type Output = i64;
    type JsValue = i64;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |connection| match self.which {
            CountKind::NonTerminal => OffPeakStore::count_non_terminal(connection),
            CountKind::Active => OffPeakStore::count_active(connection),
        })
    }
}

pub struct OffPeakGetTask {
    inner: std::sync::Arc<Inner>,
    off_peak_task_id: String,
}

impl Task for OffPeakGetTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let row = with_connection(&self.inner, |connection| {
            OffPeakStore::get(connection, &self.off_peak_task_id)
        })?;
        row.map(|row| serde_json::to_string(&row))
            .transpose()
            .map_err(|error| to_napi_error(error.to_string()))
    }
}

pub struct AutomationClaimDueTask {
    inner: std::sync::Arc<Inner>,
    now_ms: i64,
}

impl Task for AutomationClaimDueTask {
    type Output = String;
    type JsValue = String;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let claimed = with_connection_mut(&self.inner, |connection| {
            AutomationStore::claim_due(connection, self.now_ms)
        })?;
        serde_json::to_string(&claimed).map_err(|error| to_napi_error(error.to_string()))
    }
}

pub struct AutomationReleaseClaimTask {
    inner: std::sync::Arc<Inner>,
    automation_id: String,
}

impl Task for AutomationReleaseClaimTask {
    type Output = bool;
    type JsValue = bool;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |connection| {
            AutomationStore::release_claim(connection, &self.automation_id)
        })
    }
}

pub struct AutomationBindingTask {
    inner: std::sync::Arc<Inner>,
    automation_id: String,
}

impl Task for AutomationBindingTask {
    type Output = bool;
    type JsValue = bool;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |connection| {
            AutomationStore::has_task_binding(connection, &self.automation_id)
        })
    }
}

pub struct AutomationRunCountTask {
    inner: std::sync::Arc<Inner>,
    automation_id: String,
}

impl Task for AutomationRunCountTask {
    type Output = Option<i64>;
    type JsValue = Option<i64>;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |connection| {
            AutomationStore::scheduled_run_count(connection, &self.automation_id)
        })
    }
}

/// Serialises a value the way the boundary does, for tests and for the TypeScript wrapper's
/// shape assertions.
pub fn to_json<T: Serialize>(value: &T) -> std::result::Result<String, Error> {
    serde_json::to_string(value).map_err(|error| to_napi_error(error.to_string()))
}

/// The row types, re-exported so the boundary's consumers (and the parity tests) can name
/// them through one module rather than four.
pub use crate::grouped::GroupMemberOrder;
pub use crate::offpeak::OffPeakRow;
pub use crate::read::TaskListRow;
