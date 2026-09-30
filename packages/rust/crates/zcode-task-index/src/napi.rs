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
pub use crate::offpeak::{
    CreateParams, EditablePatch, ModelSelection, SchedulingSnapshot,
};
use crate::offpeak::Task as OffPeakTask;
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
    // -----------------------------------------------------------------------
    // The off-peak repository.
    //
    // Spec §20: these are the twenty methods of `offPeakTaskRepo.ts`, transcribed. They live on
    // `TaskIndexStore` rather than on a class of their own because that is where the crate already
    // exposed the off-peak surface (`offpeak_get`, `offpeak_claim_due`, `offpeak_count_active`) —
    // and because a separate class would have to take the store by reference, which napi's
    // `ClassInstance` cannot recover, leaving the two facades unable to share one connection.
    // -----------------------------------------------------------------------

    /// `awaiting_approval` → `running`, run once after the migrations.
    #[napi]
    pub fn offpeak_recycle_awaiting_approval(&self, now: i64) -> AsyncTask<OffPeakRecycleTask> {
        AsyncTask::new(OffPeakRecycleTask { inner: std::sync::Arc::clone(&self.inner), now })
    }

    /// `countNonTerminal` — the local pre-check of the creation ceiling.
    #[napi]
    pub fn offpeak_count_non_terminal(&self) -> AsyncTask<OffPeakCountTask> {
        AsyncTask::new(OffPeakCountTask { inner: std::sync::Arc::clone(&self.inner), which: CountKind::NonTerminal })
    }

    /// `countActive` — the in-flight count, which is the criterion for the keep-awake power blocker.
    #[napi]
    pub fn offpeak_count_active(&self) -> AsyncTask<OffPeakCountTask> {
        AsyncTask::new(OffPeakCountTask { inner: std::sync::Arc::clone(&self.inner), which: CountKind::Active })
    }

    /// `hasActiveBoundTask` — the pre-create check; index `idx_off_peak_bound_active` uses the
    /// same condition, so the two cannot disagree about what "already bound" means.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn offpeak_has_active_bound_task(&self, workspace_key: String, session_id: String) -> AsyncTask<OffPeakBoundTask> {
        AsyncTask::new(OffPeakBoundTask { inner: std::sync::Arc::clone(&self.inner), workspace_key, session_id })
    }

    /// `claimDue` — the due-task claim, which is a compare-and-swap and must stay one.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_claim_due(&self, now_ms: i64) -> AsyncTask<OffPeakClaimDueTask> {
        AsyncTask::new(OffPeakClaimDueTask {
            inner: std::sync::Arc::clone(&self.inner),
            now_ms,
        })
    }

    // -----------------------------------------------------------------------
    // The task read path — `taskIndexRepo`'s batch A.
    //
    // Spec §22. Each of these differs from its neighbour only in the WHERE clause, so the projection
    // lives once in `meta::TASK_COLUMNS` rather than in seven SELECTs that may drift apart.
    // -----------------------------------------------------------------------

    /// `getTaskMeta` — a deleted row reads as absent.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn get_task_meta(&self, request_json: String) -> AsyncTask<TaskMetaResultTask> {
        AsyncTask::new(TaskMetaResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: TaskReadBody::Get(request_json),
        })
    }

    /// `listTaskMetas` — every filter is a nullable tri-state, so an absent one does not filter.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn list_task_metas(&self, query_json: String) -> AsyncTask<TaskMetaListTask> {
        AsyncTask::new(TaskMetaListTask {
            inner: std::sync::Arc::clone(&self.inner),
            query_json,
        })
    }

    /// `listDeletedTaskIds` — the tombstones, so a deleted task cannot reappear after a cold start.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn list_deleted_task_ids(&self, request_json: String) -> AsyncTask<StringListTask> {
        AsyncTask::new(StringListTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &rusqlite::Connection| {
                let request: DeletedTaskIdsRequest = decode(&request_json)?;
                task_read::list_deleted_task_ids(conn, &request.workspace_key, request.provider.as_deref())
                    .map_err(store_error)
            }),
        })
    }

    /// `listSessionsByAutomation` — the runs an automation produced.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn list_sessions_by_automation(&self, automation_id: String) -> AsyncTask<TaskMetaListByKeyTask> {
        AsyncTask::new(TaskMetaListByKeyTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &rusqlite::Connection| {
                task_read::list_sessions_by_automation(conn, &automation_id).map_err(store_error)
            }),
        })
    }

    /// `queryTaskList` — the sidebar, with search snippets and a `hasMore` against the total.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn query_task_list(&self, query_json: String) -> AsyncTask<TaskListResultTask> {
        AsyncTask::new(TaskListResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            query_json,
        })
    }

    /// `hasGroupedWorkspaceBootstrapRun` — a global marker, not a per-workspace one.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn has_grouped_workspace_bootstrap_run(&self) -> AsyncTask<BootstrapRunTask> {
        AsyncTask::new(BootstrapRunTask { inner: std::sync::Arc::clone(&self.inner) })
    }

    /// `archiveStaleTasks` — select, then archive in one transaction, returning the pre-archive rows.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn archive_stale_tasks(&self, request_json: String) -> AsyncTask<ArchiveStaleTask> {
        AsyncTask::new(ArchiveStaleTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
        })
    }

    // -----------------------------------------------------------------------
    // The automation facade.
    //
    // Spec §15. The four task types below already existed with their `compute` implementations —
    // only the `#[napi]` methods were missing, so they were dead code and the wrapper's
    // `automationClaimDue`/`automationReleaseClaim`/`automationHasTaskBinding`/
    // `automationScheduledRunCount` were `undefined` at runtime.
    // -----------------------------------------------------------------------

    /// `claimDue` — automations whose `next_run_at`/`retry_at` has arrived, with the backoff rule.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_claim_due(&self, now_ms: i64) -> AsyncTask<AutomationClaimDueTask> {
        AsyncTask::new(AutomationClaimDueTask {
            inner: std::sync::Arc::clone(&self.inner),
            now_ms,
        })
    }

    /// `releaseClaim` — clears the claim; `false` when there was nothing to release.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn automation_release_claim(&self, automation_id: String) -> AsyncTask<AutomationReleaseClaimTask> {
        AsyncTask::new(AutomationReleaseClaimTask {
            inner: std::sync::Arc::clone(&self.inner),
            automation_id,
        })
    }

    /// `hasTaskBinding` — a deleted automation reads as `false`, not as a storage fault.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn automation_has_task_binding(&self, automation_id: String) -> AsyncTask<AutomationBindingTask> {
        AsyncTask::new(AutomationBindingTask {
            inner: std::sync::Arc::clone(&self.inner),
            automation_id,
        })
    }

    /// `scheduledRunCount` — `null` when the automation is gone.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn automation_scheduled_run_count(&self, automation_id: String) -> AsyncTask<AutomationRunCountTask> {
        AsyncTask::new(AutomationRunCountTask {
            inner: std::sync::Arc::clone(&self.inner),
            automation_id,
        })
    }

    /// `get` — one row by id, or `null` when it is absent. Never an error for a missing row.
    ///
    /// `OffPeakStore::get` existed in the crate but was not reachable from here, so the wrapper's
    /// `offpeakGet` resolved to `undefined` and the parity harness failed with "offpeakGet is not a
    /// function". Wired through the same `OffPeakResultTask` shape as the other single-row calls.
    #[napi(ts_return_type = "Promise<string | null>")]
    pub fn offpeak_get(&self, off_peak_task_id: String) -> AsyncTask<OffPeakGetTask> {
        AsyncTask::new(OffPeakGetTask {
            inner: std::sync::Arc::clone(&self.inner),
            off_peak_task_id,
        })
    }

    /// `create` — creating a task also enqueues it, as `queued`.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_create(&self, params_json: String) -> AsyncTask<OffPeakResultTask> {
        AsyncTask::new(OffPeakResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakBody::Create(params_json),
        })
    }

    /// `list` — with the session-title join, when the `tasks` table exists.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_list(&self, request_json: String) -> AsyncTask<OffPeakListTask> {
        AsyncTask::new(OffPeakListTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
        })
    }

    /// `markHistoryDeleted` — only for a task that actually started, and idempotent.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_mark_history_deleted(&self, request_json: String) -> AsyncTask<OffPeakResultTask> {
        AsyncTask::new(OffPeakResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakBody::MarkHistoryDeleted(request_json),
        })
    }

    /// `updateEditableFields` — the editable window, with the tri-state selection rule.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_update_editable_fields(&self, request_json: String) -> AsyncTask<OffPeakResultTask> {
        AsyncTask::new(OffPeakResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakBody::UpdateEditableFields(request_json),
        })
    }

    /// `setPaused` — guarded on `claim_running = 0`, so an in-flight dispatch cannot be paused.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_set_paused(&self, request_json: String) -> AsyncTask<OffPeakResultTask> {
        AsyncTask::new(OffPeakResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakBody::SetPaused(request_json),
        })
    }

    /// `requeueForContinuation` — `running` → `queued`, keeping the session and `started_at`.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_requeue_for_continuation(&self, request_json: String) -> AsyncTask<OffPeakResultTask> {
        AsyncTask::new(OffPeakResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakBody::Requeue(request_json),
        })
    }

    /// `markRunning` — `queued` → `running`, refusing a second transition.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_mark_running(&self, request_json: String) -> AsyncTask<OffPeakResultTask> {
        AsyncTask::new(OffPeakResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakBody::MarkRunning(request_json),
        })
    }

    /// `markTerminal` — irreversible: a second transition changes no rows.
    ///
    /// Needs a mutable connection only because the shared handle sits behind a `Mutex`.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_mark_terminal(&self, request_json: String) -> AsyncTask<OffPeakTerminalTask> {
        AsyncTask::new(OffPeakTerminalTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
        })
    }

    /// `invalidateModelSelection` — a real transaction, and it declines to overwrite a repair.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_invalidate_model_selection(&self, request_json: String) -> AsyncTask<OffPeakInvalidateTask> {
        AsyncTask::new(OffPeakInvalidateTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
        })
    }

    /// `delete` — in any state; the service layer settles server-side first.
    #[napi]
    pub fn offpeak_delete(&self, off_peak_task_id: String) -> AsyncTask<OffPeakUnitTask> {
        AsyncTask::new(OffPeakUnitTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakUnitBody::Delete(off_peak_task_id),
        })
    }

    /// `markSettled` — terminal rows only, and idempotent.
    #[napi]
    pub fn offpeak_mark_settled(&self, off_peak_task_id: String, settled_at: i64) -> AsyncTask<OffPeakUnitTask> {
        AsyncTask::new(OffPeakUnitTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakUnitBody::MarkSettled(off_peak_task_id, settled_at),
        })
    }

    /// `updateSchedulingSnapshot` — the poll's write-back; absent fields keep their stored value.
    #[napi]
    pub fn offpeak_update_scheduling_snapshot(&self, request_json: String) -> AsyncTask<OffPeakUnitTask> {
        AsyncTask::new(OffPeakUnitTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakUnitBody::Snapshot(request_json),
        })
    }

    /// `releaseClaim` — resets the single-flight lock without changing the status.
    #[napi]
    pub fn offpeak_release_claim(&self, request_json: String) -> AsyncTask<OffPeakUnitTask> {
        AsyncTask::new(OffPeakUnitTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: OffPeakUnitBody::ReleaseClaim(request_json),
        })
    }

    /// `recoverInterrupted` — startup reclamation, in one transaction.
    #[napi]
    pub fn offpeak_recover_interrupted(&self, now: i64) -> AsyncTask<OffPeakRecoverTask> {
        AsyncTask::new(OffPeakRecoverTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                OffPeakStore::recover_interrupted(conn, now).map(|recovered| recovered as i64)
            }),
        })
    }

    /// `listNonTerminal` — the poll's input.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_list_non_terminal(&self) -> AsyncTask<OffPeakPlainListTask> {
        AsyncTask::new(OffPeakPlainListTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(|conn: &rusqlite::Connection| OffPeakStore::list_non_terminal(conn)),
        })
    }

    /// `listUnsettledTerminal` — terminal rows still awaiting the settle ack.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn offpeak_list_unsettled_terminal(&self) -> AsyncTask<OffPeakPlainListTask> {
        AsyncTask::new(OffPeakPlainListTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(|conn: &rusqlite::Connection| OffPeakStore::list_unsettled_terminal(conn)),
        })
    }

    /// Marks the store closed and releases the connection. **No IO** — in-flight tasks hold their
    /// own borrow, so the connection drops once they drain (the `zcode-events` §4.2 rule).
    ///
    /// A later call is **refused** rather than silently reopening the file, which is stricter than
    /// the legacy `close({ throwOnError: false })`: a repository that quietly reopens after being
    /// closed would re-apply migrations on a store its owner believed was gone.
    #[napi]
    pub fn close(&self) {
        if let Ok(mut guard) = self.inner.connection.lock() {
            *guard = None;
        }
    }
}


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
        // `claim_due` captures the domain task **before** the claim's UPDATE, so the reported
        // `updatedAt` is the one the caller acted on rather than the claim time. Re-reading the
        // row afterwards would report the latter — the differential transcript shows exactly that
        // difference on every claimed task.
        let tasks: Vec<OffPeakTask> = claimed.into_iter().map(|claimed| claimed.task).collect();
        serde_json::to_string(&tasks).map_err(|error| to_napi_error(error.to_string()))
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
        // The **domain** task, not the stored row: the original's `get` returns `rowToTask(...)`,
        // which carries `title`, `permissionMode` and the validated `modelSelection`, and omits
        // every absent optional rather than sending `null`. `OffPeakStore::get` returns the
        // internal `OffPeakRow` for the Tauri scheduler, which is a different caller with a
        // different contract — serialising it here put `claimRunning: 0` and `sessionId: null` in
        // front of a consumer expecting neither.
        let task = with_connection(&self.inner, |connection| {
            OffPeakStore::get_task(connection, &self.off_peak_task_id)
        })?;
        task.map(|task| serde_json::to_string(&task))
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
use crate::meta::TaskMeta;
use crate::task_read;
pub use crate::read::TaskListRow;


// ---- off-peak request shapes and task bodies --------------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakIdAt {
    off_peak_task_id: String,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakListRequest {
    /// `null` lists every workspace — the original's omitted `scope`.
    workspace_key: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakPausedRequest {
    off_peak_task_id: String,
    paused: bool,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakEditableRequest {
    off_peak_task_id: String,
    #[serde(flatten)]
    patch: EditablePatch,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakSnapshotRequest {
    off_peak_task_id: String,
    #[serde(flatten)]
    snapshot: SchedulingSnapshot,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakRunningRequest {
    off_peak_task_id: String,
    started_at: i64,
    conversation_id: Option<String>,
    session_id: Option<String>,
    server_ticket_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakTerminalRequest {
    off_peak_task_id: String,
    status: String,
    ended_at: i64,
    failure_reason: Option<String>,
    files_changed: Option<i64>,
    dispatch_error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakInvalidateRequest {
    off_peak_task_id: String,
    model_selection: ModelSelection,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OffPeakReleaseClaimRequest {
    off_peak_task_id: String,
    /// `null` means "no error was passed", which differs from an empty string.
    error: Option<String>,
    now: i64,
}

/// Which domain-returning off-peak call a task performs.
///
/// One enum rather than a dozen near-identical task structs: they all take the same lock, run one
/// store method and serialise one optional task, so the only thing that varies is the call.
pub enum OffPeakBody {
    Create(String),
    MarkHistoryDeleted(String),
    UpdateEditableFields(String),
    SetPaused(String),
    Requeue(String),
    MarkRunning(String),
}

pub struct OffPeakResultTask {
    inner: std::sync::Arc<Inner>,
    body: OffPeakBody,
}

impl Task for OffPeakResultTask {
    type Output = Option<OffPeakTask>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| -> std::result::Result<Option<OffPeakTask>, Error> { match &self.body {
            OffPeakBody::Create(json) => {
                let params: CreateParams = decode(json)?;
                OffPeakStore::create(conn, &params).map(Some).map_err(store_error)
            }
            OffPeakBody::MarkHistoryDeleted(json) => {
                let request: OffPeakIdAt = decode(json)?;
                OffPeakStore::mark_history_deleted(conn, &request.off_peak_task_id, request.now).map_err(store_error)
            }
            OffPeakBody::UpdateEditableFields(json) => {
                let request: OffPeakEditableRequest = decode(json)?;
                OffPeakStore::update_editable_fields(
                    conn,
                    &request.off_peak_task_id,
                    &request.patch,
                    request.now,
                ).map_err(store_error)
            }
            OffPeakBody::SetPaused(json) => {
                let request: OffPeakPausedRequest = decode(json)?;
                OffPeakStore::set_paused(conn, &request.off_peak_task_id, request.paused, request.now).map_err(store_error)
            }
            OffPeakBody::Requeue(json) => {
                let request: OffPeakIdAt = decode(json)?;
                OffPeakStore::requeue_for_continuation(conn, &request.off_peak_task_id, request.now).map_err(store_error)
            }
            OffPeakBody::MarkRunning(json) => {
                let request: OffPeakRunningRequest = decode(json)?;
                OffPeakStore::mark_running(
                    conn,
                    &request.off_peak_task_id,
                    request.started_at,
                    request.conversation_id.as_deref(),
                    request.session_id.as_deref(),
                    request.server_ticket_id.as_deref(),
                ).map_err(store_error)
            }
        }
        })
    }
}

/// A void off-peak call.
pub enum OffPeakUnitBody {
    Delete(String),
    MarkSettled(String, i64),
    Snapshot(String),
    ReleaseClaim(String),
}

pub struct OffPeakUnitTask {
    inner: std::sync::Arc<Inner>,
    body: OffPeakUnitBody,
}

impl Task for OffPeakUnitTask {
    type Output = ();
    type JsValue = ();

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| -> std::result::Result<(), Error> { match &self.body {
            OffPeakUnitBody::Delete(id) => OffPeakStore::delete_task(conn, id).map_err(store_error),
            OffPeakUnitBody::MarkSettled(id, settled_at) => {
                OffPeakStore::mark_settled(conn, id, *settled_at).map_err(store_error)
            }
            OffPeakUnitBody::Snapshot(json) => {
                let request: OffPeakSnapshotRequest = decode(json)?;
                OffPeakStore::update_scheduling_snapshot(
                    conn,
                    &request.off_peak_task_id,
                    &request.snapshot,
                    request.now,
                ).map_err(store_error)
            }
            OffPeakUnitBody::ReleaseClaim(json) => {
                let request: OffPeakReleaseClaimRequest = decode(json)?;
                OffPeakStore::release_claim(
                    conn,
                    &request.off_peak_task_id,
                    request.error.as_deref(),
                    request.now,
                ).map_err(store_error)
            }
        }
        })
    }
}

/// A list-returning off-peak call over a stored request.
pub struct OffPeakListTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for OffPeakListTask {
    type Output = Vec<OffPeakTask>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| -> std::result::Result<Vec<OffPeakTask>, Error> {
            let request: OffPeakListRequest = decode(&self.request_json)?;
            list_tasks_with_session_titles(conn, request.workspace_key.as_deref())
                .map_err(store_error)
        })
    }
}

/// A list-returning off-peak call with no request.
pub struct OffPeakPlainListTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<
        dyn Fn(&rusqlite::Connection) -> std::result::Result<Vec<OffPeakTask>, crate::migrate::MigrationError>
            + Send
            + Sync,
    >,
}

impl Task for OffPeakPlainListTask {
    type Output = Vec<OffPeakTask>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_connection(&self.inner, |conn| run(conn))
    }
}

/// A count-returning call that needs the mutable handle.
pub struct OffPeakRecoverTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<
        dyn Fn(&mut rusqlite::Connection) -> std::result::Result<i64, crate::migrate::MigrationError>
            + Send
            + Sync,
    >,
}

impl Task for OffPeakRecoverTask {
    type Output = i64;
    type JsValue = i64;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_connection_mut(&self.inner, |conn| run(conn))
    }
}

/// `markTerminal` — a single guarded statement behind the shared mutable handle.
pub struct OffPeakTerminalTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for OffPeakTerminalTask {
    type Output = Option<OffPeakTask>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| -> std::result::Result<Option<OffPeakTask>, Error> {
            let request: OffPeakTerminalRequest = decode(&self.request_json)?;
            OffPeakStore::mark_terminal(
                conn,
                &request.off_peak_task_id,
                &request.status,
                request.ended_at,
                request.failure_reason.as_deref(),
                request.files_changed,
                request.dispatch_error.as_deref(),
            )
            .map_err(store_error)
        })
    }
}

/// `invalidateModelSelection` — the one off-peak call that spans several statements and must be
/// atomic, because a reader between them would see the cleared selection without the snapshot.
pub struct OffPeakInvalidateTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for OffPeakInvalidateTask {
    type Output = Option<OffPeakTask>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| -> std::result::Result<Option<OffPeakTask>, Error> {
            let request: OffPeakInvalidateRequest = decode(&self.request_json)?;
            OffPeakStore::invalidate_model_selection(
                conn,
                &request.off_peak_task_id,
                &request.model_selection,
                request.now,
            )
            .map_err(store_error)
        })
    }
}

/// `list` (`offPeakTaskRepo.ts:319-345`), including the `tasks` join.
///
/// The LEFT JOIN brings back each task's session title for the card. The table may be **absent** on
/// a library that predates the grouping migration, and the original probes `sqlite_master` and
/// falls back to the bare table — so this does too rather than failing the read.
fn list_tasks_with_session_titles(
    conn: &rusqlite::Connection,
    workspace_key: Option<&str>,
) -> std::result::Result<Vec<OffPeakTask>, crate::migrate::MigrationError> {
    let has_tasks_table = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|hit| hit == 1)
        .unwrap_or(false);

    let (sql, with_scope) = if has_tasks_table {
        (
            "SELECT t.*, s.title AS session_title FROM off_peak_tasks t
             LEFT JOIN tasks s ON s.workspace_key = t.workspace_key AND s.task_id = t.session_id
             WHERE (?1 IS NULL OR t.workspace_key = ?1)
             ORDER BY t.created_at DESC",
            true,
        )
    } else {
        (
            "SELECT * FROM off_peak_tasks
             WHERE (?1 IS NULL OR workspace_key = ?1)
             ORDER BY created_at DESC",
            false,
        )
    };
    let _ = with_scope;

    let mut statement = conn.prepare(sql).map_err(|source| crate::migrate::MigrationError::Sql {
        context: "off_peak_tasks".into(),
        source,
    })?;
    let rows = statement
        .query_map(rusqlite::params![workspace_key], OffPeakTask::from_row)
        .map_err(|source| crate::migrate::MigrationError::Sql {
            context: "off_peak_tasks".into(),
            source,
        })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|source| crate::migrate::MigrationError::Sql {
            context: "off_peak_tasks".into(),
            source,
        })?);
    }
    Ok(out)
}

/// Lifts a store error to a napi error, keeping the message the TypeScript side would have seen.
fn store_error(error: crate::migrate::MigrationError) -> Error {
    Error::from_reason(error.to_string())
}

/// Decodes a request body, reporting a malformed one as a napi error.
fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T> {
    serde_json::from_str(json).map_err(|error| Error::from_reason(error.to_string()))
}

/// The `awaiting_approval` recycle, which reports how many rows it moved.
pub struct OffPeakRecycleTask {
    inner: std::sync::Arc<Inner>,
    now: i64,
}

impl Task for OffPeakRecycleTask {
    type Output = i64;
    type JsValue = i64;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| {
            OffPeakStore::recycle_awaiting_approval(conn, self.now)
        })
        .map(|recycled| recycled as i64)
    }
}

// ---- the task read path: request shapes and task bodies ------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskRefRequest {
    /// Already resolved: the identity rule is the caller's, so two paths sharing an identity
    /// cannot produce two scopes.
    workspace_key: String,
    task_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeletedTaskIdsRequest {
    workspace_key: String,
    provider: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveStaleRequest {
    workspace_key: String,
    /// The caller has already floored the span at 1 day; the engine does not re-clamp, because a
    /// zero-day span would archive everything that ever completed and that bound belongs at the
    /// decision, not at the storage layer.
    cutoff: i64,
    provider: Option<String>,
}

/// Which single-result read a task performs.
pub enum TaskReadBody {
    Get(String),
}

pub struct TaskMetaResultTask {
    inner: std::sync::Arc<Inner>,
    body: TaskReadBody,
}

impl Task for TaskMetaResultTask {
    type Output = Option<TaskMeta>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| -> std::result::Result<Option<TaskMeta>, Error> {
            match &self.body {
                TaskReadBody::Get(json) => {
                    let request: TaskRefRequest = decode(json)?;
                    task_read::get_task_meta(conn, &request.workspace_key, &request.task_id)
                        .map_err(store_error)
                }
            }
        })
    }
}

pub struct TaskMetaListTask {
    inner: std::sync::Arc<Inner>,
    query_json: String,
}

impl Task for TaskMetaListTask {
    type Output = Vec<TaskMeta>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| -> std::result::Result<Vec<TaskMeta>, Error> {
            let query: task_read::ListQuery = decode(&self.query_json)?;
            task_read::list_task_metas(conn, &query).map_err(store_error)
        })
    }
}

pub struct TaskMetaListByKeyTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<
        dyn Fn(&rusqlite::Connection) -> std::result::Result<Vec<TaskMeta>, Error> + Send + Sync,
    >,
}

impl Task for TaskMetaListByKeyTask {
    type Output = Vec<TaskMeta>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_connection(&self.inner, |conn| run(conn))
    }
}

pub struct StringListTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<
        dyn Fn(&rusqlite::Connection) -> std::result::Result<Vec<String>, Error> + Send + Sync,
    >,
}

impl Task for StringListTask {
    type Output = Vec<String>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_connection(&self.inner, |conn| run(conn))
    }
}

pub struct TaskListResultTask {
    inner: std::sync::Arc<Inner>,
    query_json: String,
}

impl Task for TaskListResultTask {
    type Output = task_read::TaskListResult;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| -> std::result::Result<task_read::TaskListResult, Error> {
            let query: task_read::TaskListQuery = decode(&self.query_json)?;
            task_read::query_task_list(conn, &query).map_err(store_error)
        })
    }
}

pub struct BootstrapRunTask {
    inner: std::sync::Arc<Inner>,
}

impl Task for BootstrapRunTask {
    type Output = bool;
    type JsValue = bool;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| {
            task_read::has_grouped_workspace_bootstrap_run(conn)
        })
    }
}

/// `archiveStaleTasks` — needs the mutable handle, because the archive is a real transaction.
pub struct ArchiveStaleTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for ArchiveStaleTask {
    type Output = Vec<TaskMeta>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| -> std::result::Result<Vec<TaskMeta>, Error> {
            let request: ArchiveStaleRequest = decode(&self.request_json)?;
            task_read::archive_stale_tasks(
                conn,
                &request.workspace_key,
                request.cutoff,
                request.provider.as_deref(),
            )
            .map_err(store_error)
        })
    }
}

/// `hasActiveBoundTask` — a boolean, so a different `Output` type from the counts.
pub struct OffPeakBoundTask {
    inner: std::sync::Arc<Inner>,
    workspace_key: String,
    session_id: String,
}

impl Task for OffPeakBoundTask {
    type Output = bool;
    type JsValue = bool;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| {
            OffPeakStore::has_active_bound_task(conn, &self.workspace_key, &self.session_id)
        })
    }
}
