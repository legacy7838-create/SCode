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
//! # Migrations are the crate's, not the caller's
//!
//! `ensure_ready` takes **no migration argument**: the schema, the ledger and the three frozen
//! payloads are `crate::schema` (spec §28). The JavaScript that used to build the list — and
//! serialise each `JSON.stringify(checksumInput)` — is deleted; the crate reproduces the three
//! real ledger checksums exactly, pinned by `schema::tests` and `tests/real_database.rs`.
//!
//! `prepare_storage` is the startup orchestrator: pragmas, the busy-lock wait, the migrations
//! and the three post-migration repairs, reporting progress through a `ThreadsafeFunction` so a
//! libuv worker thread can emit `waiting_for_lock` / `migrating` / `committing` without touching
//! the event loop.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

use crate::automation_repo::{
    AutomationError, AutomationRepository, AutomationListRequest, AutomationScopeRequest,
    CreateAutomationRequest, DeleteRunRequest, DispatchSelectionRequest, EnsureRunClaimedRequest,
    FixRunModelSelectionRequest, HasTaskBindingRequest, ListRunsRequest,
    MarkDispatchFailedRequest, MarkDispatchedRequest, MarkManualRunDispatchedRequest,
    MarkRunDispatchRequest, MarkRunOutcomeRequest, PruneRunsRequest, RecordSkippedRunRequest,
    ReleaseClaimRequest, ReleaseManualClaimRequest, RestartRequest, RunNowRequest,
    SetEnabledRequest, SkipAndRescheduleRequest, TouchManualClaimRequest, UpdateAutomationRequest,
    UpsertRunClaimedRequest,
};
pub use crate::grouped::{TaskWrite, ViewNodeOrder, WriteBatch};
pub use crate::offpeak::{
    CreateParams, EditablePatch, ModelSelection, SchedulingSnapshot,
};
use crate::offpeak::Task as OffPeakTask;
use crate::migrate::{baseline_id, run_migrations, MigrationError};
use crate::schema::{build_migrations, inspect_kind};
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

/// The `DatabaseMigrationFacts` a progress callback receives. A `#[napi(object)]` so the
/// TypeScript side gets a plain object, matching what `worker.postMessage` forwarded before.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationFacts {
    /// `"none" | "initialize" | "upgrade"`.
    pub kind: String,
    pub executed_count: i64,
    pub committed_count: i64,
    pub last_applied_migration_id: Option<String>,
}

/// One progress event: the phase plus the facts at that time.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageProgress {
    /// `"checking" | "waiting_for_lock" | "migrating" | "maintaining" | "committing" | "ready"`.
    pub phase: String,
    pub migration: MigrationFacts,
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

/// A startup failure with the structured fields the desktop classification reads.
///
/// The napi message is a JSON envelope (`{"z":1,...}`) that `@zcode/rust/task-index`'s
/// `fromNativeError` decodes back into a real `Error` carrying
/// `kind`/`errcode`/`migrationId`/`startupMigration`. A plain-text message would silently
/// classify every startup failure as `sql_failed`, because `classifyDatabaseStartupError` reads
/// `error.kind`, never the message (spec §28).
#[derive(Debug)]
struct StartupError {
    message: String,
    kind: Option<&'static str>,
    errcode: Option<i32>,
    migration_id: Option<String>,
}

/// The extended SQLite result code, where one exists.
fn sqlite_code(error: &rusqlite::Error) -> Option<i32> {
    match error {
        rusqlite::Error::SqliteFailure(failure, _) => Some(failure.extended_code),
        _ => None,
    }
}

impl StartupError {
    /// The JSON envelope the napi error carries. Kept separate from [`Self::envelope`] so it can
    /// be asserted in a unit test without a Node runtime.
    fn envelope_json(&self, startup_migration: Option<&MigrationFacts>) -> String {
        let mut value = serde_json::Map::new();
        value.insert("z".to_string(), serde_json::Value::from(1));
        value.insert("m".to_string(), serde_json::Value::from(self.message.clone()));
        if let Some(kind) = self.kind {
            value.insert("k".to_string(), serde_json::Value::from(kind));
        }
        if let Some(errcode) = self.errcode {
            value.insert("c".to_string(), serde_json::Value::from(errcode));
        }
        if let Some(id) = &self.migration_id {
            value.insert("i".to_string(), serde_json::Value::from(id.clone()));
        }
        if let Some(facts) = startup_migration {
            value.insert(
                "sm".to_string(),
                serde_json::to_value(facts).unwrap_or(serde_json::Value::Null),
            );
        }
        serde_json::Value::Object(value).to_string()
    }

    /// Renders the error as the napi envelope. `startup_migration` is the facts at the moment of
    /// failure, so `tasksStorageWorker.ts` can forward the migration state the wrapper lost.
    fn envelope(&self, startup_migration: Option<&MigrationFacts>) -> Error {
        Error::new(
            napi::Status::GenericFailure,
            self.envelope_json(startup_migration),
        )
    }
}

impl From<StoreError> for StartupError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Open { path, source } => StartupError {
                message: format!("cannot open the task index at {path}: {source}"),
                kind: Some("open_failed"),
                errcode: sqlite_code(&source),
                migration_id: None,
            },
            StoreError::Query { context, source } => StartupError {
                message: format!("{context}: {source}"),
                kind: None,
                errcode: sqlite_code(&source),
                migration_id: None,
            },
            StoreError::Migration(MigrationError::ChecksumMismatch {
                id,
                applied,
                computed,
            }) => StartupError {
                message: format!(
                    "migration {id:?} was already applied with checksum {applied} but this build computes {computed}; the database was written by a different version"
                ),
                kind: Some("checksum_mismatch"),
                errcode: None,
                migration_id: Some(id),
            },
            StoreError::Migration(MigrationError::Sql { context, source }) => StartupError {
                message: format!("{context}: {source}"),
                kind: None,
                errcode: sqlite_code(&source),
                migration_id: None,
            },
            StoreError::Migration(MigrationError::Io { path, source }) => StartupError {
                message: format!("cannot access {path}: {source}"),
                kind: None,
                errcode: sqlite_code(&source),
                migration_id: None,
            },
            StoreError::Migration(other) => StartupError {
                message: other.to_string(),
                kind: None,
                errcode: None,
                migration_id: None,
            },
            StoreError::Closed => StartupError {
                message: "the task index store is closed".to_string(),
                kind: None,
                errcode: None,
                migration_id: None,
            },
        }
    }
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

    /// Opens the file, applies the pragmas and runs the crate's own migrations. The one
    /// IO-bearing call the caller makes explicitly.
    #[napi]
    pub fn ensure_ready(&self, now_ms: f64) -> AsyncTask<EnsureReadyTask> {
        AsyncTask::new(EnsureReadyTask {
            inner: std::sync::Arc::clone(&self.inner),
            now_ms: now_ms as i64,
            lock_wait_ms: None,
        })
    }

    /// The startup orchestrator (`prepareTasksIndexStorage`).
    ///
    /// Opens the file, applies the pragmas, waits asynchronously for the write lock
    /// (`lock_wait_ms`, default 60 minutes), runs the migrations inside one `BEGIN IMMEDIATE`,
    /// then applies the three post-migration repairs and closes. Progress is reported through
    /// `on_progress` as `{ phase, kind, lastAppliedMigrationId, executedCount, committedCount }`,
    /// matching `DatabaseMigrationFacts`.
    #[napi(ts_return_type = "Promise<object>")]
    pub fn prepare_storage(
        &self,
        now_ms: f64,
        lock_wait_ms: Option<f64>,
        on_progress: ThreadsafeFunction<String, (), String, napi::Status, false>,
    ) -> AsyncTask<PrepareStorageTask> {
        AsyncTask::new(PrepareStorageTask {
            inner: std::sync::Arc::clone(&self.inner),
            now_ms: now_ms as i64,
            lock_wait_ms: lock_wait_ms.map(|value| value as i64),
            progress: on_progress,
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
    // The write path — `taskIndexRepo`'s batch D.
    //
    // Spec §25. `syncTaskMeta` and its grouped-top variant are here, plus the four transitions that
    // change `unread_at` or the deleted flag and therefore need the mutable handle.
    // -----------------------------------------------------------------------

    /// `queryGroupedTaskView` — the joined view, with the bootstrap and the order writeback.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn query_grouped_task_view(&self, request_json: String) -> AsyncTask<GroupedViewTask> {
        AsyncTask::new(GroupedViewTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
            apply: false,
        })
    }

    /// `queryGroupedTaskViewStructure` — groups, members and orders, with no join and no writeback.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn query_grouped_task_view_structure(&self, request_json: String) -> AsyncTask<GroupedStructureTask> {
        AsyncTask::new(GroupedStructureTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
        })
    }

    /// `applyGroupedTaskViewOrder` — the drag-and-drop save, in one transaction.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn apply_grouped_task_view_order(&self, request_json: String) -> AsyncTask<GroupedViewTask> {
        AsyncTask::new(GroupedViewTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
            apply: true,
        })
    }

    /// `syncTaskMeta` — the merge, and nothing else.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn sync_task_meta(&self, request_json: String) -> AsyncTask<SyncMetaTask> {
        AsyncTask::new(SyncMetaTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
            admit: false,
        })
    }

    /// `syncTaskMetaAtGroupedTop` — the merge and the top-level admission, in one transaction.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn sync_task_meta_at_grouped_top(&self, request_json: String) -> AsyncTask<SyncMetaTask> {
        AsyncTask::new(SyncMetaTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
            admit: true,
        })
    }

    /// `seedTaskMetaIfMissing` — the read and the write are one transaction.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn seed_task_meta_if_missing(&self, request_json: String) -> AsyncTask<SeedTask> {
        AsyncTask::new(SeedTask { inner: std::sync::Arc::clone(&self.inner), request_json })
    }

    /// `clearTaskUnreadIfMatches` — compare-and-clear, so a late read cannot clear a newer mark.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn clear_task_unread_if_matches(&self, request_json: String) -> AsyncTask<ClearUnreadTask> {
        AsyncTask::new(ClearUnreadTask { inner: std::sync::Arc::clone(&self.inner), request_json })
    }

    /// `deleteArchivedTask` — the archive check and the tombstone are one transaction.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn delete_archived_task(&self, request_json: String) -> AsyncTask<DeleteTaskTask> {
        AsyncTask::new(DeleteTaskTask { inner: std::sync::Arc::clone(&self.inner), request_json })
    }

    /// `updateTaskState` — always transactional, so the compare and the write cannot interleave.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn update_task_state(&self, request_json: String) -> AsyncTask<StateTask> {
        AsyncTask::new(StateTask { inner: std::sync::Arc::clone(&self.inner), request_json })
    }

    /// `applyAgentPatch` — `null` for a task that is gone, which is normal and not a fault.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn apply_agent_patch(&self, request_json: String) -> AsyncTask<AgentPatchTask> {
        AsyncTask::new(AgentPatchTask { inner: std::sync::Arc::clone(&self.inner), request_json })
    }

    /// The opening repair: drop the grouping rows of every deleted task.
    #[napi]
    pub fn cleanup_deleted_grouping_references(&self) -> AsyncTask<GroupingRepairTask> {
        AsyncTask::new(GroupingRepairTask { inner: std::sync::Arc::clone(&self.inner) })
    }

    // -----------------------------------------------------------------------
    // Task groups — `taskIndexRepo`'s batch B.
    //
    // Spec §23. `create` takes the id from the caller rather than minting one, so a test can use a
    // stable value instead of reading a UUID out of the result.
    // -----------------------------------------------------------------------

    /// `createTaskGroup` — the new group goes to the **top** of the current list.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn create_task_group(&self, request_json: String) -> AsyncTask<GroupResultTask> {
        AsyncTask::new(GroupResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: GroupBody::Create(request_json),
        })
    }

    /// `renameTaskGroup` — a blank title falls back rather than storing an empty one.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn rename_task_group(&self, request_json: String) -> AsyncTask<GroupResultTask> {
        AsyncTask::new(GroupResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: GroupBody::Rename(request_json),
        })
    }

    /// `updateTaskGroupColor` — the colour is validated before the write.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn update_task_group_color(&self, request_json: String) -> AsyncTask<GroupResultTask> {
        AsyncTask::new(GroupResultTask {
            inner: std::sync::Arc::clone(&self.inner),
            body: GroupBody::Recolour(request_json),
        })
    }

    /// `deleteTaskGroup` — the row and its top-level order row go together.
    #[napi]
    pub fn delete_task_group(&self, group_id: String) -> AsyncTask<GroupUnitTask> {
        AsyncTask::new(GroupUnitTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                groups::delete_task_group(conn, &group_id)
            }),
        })
    }

    /// `initializeGroupedTaskAtTop` — `true` only the first time a task reaches the top level.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn initialize_task_at_top(&self, request_json: String) -> AsyncTask<GroupAdmissionTask> {
        AsyncTask::new(GroupAdmissionTask {
            inner: std::sync::Arc::clone(&self.inner),
            request_json,
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
    // The automation repository.
    //
    // Spec §15, §27. Every method of `automationRepo.ts` is here; the request JSON is decoded
    // into the typed shapes in `automation_repo.rs`, which own the SQL and the state machine.
    // -----------------------------------------------------------------------

    /// `create` — the count guard and the insert are one transaction.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_create(&self, request_json: String) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: CreateAutomationRequest = decode(&request_json)?;
                let automation =
                    AutomationRepository::create(conn, &request).map_err(automation_error)?;
                json(&automation)
            }),
        })
    }

    /// `list` — the workspace-scoped list, newest first.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_list(&self, request_json: String) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: AutomationListRequest = decode(&request_json)?;
                let automations = AutomationRepository::list(conn, request.workspace_key.as_deref())
                    .map_err(automation_error)?;
                json(&automations)
            }),
        })
    }

    /// `get` — one automation, or `null`.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_get(&self, request_json: String) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: AutomationScopeRequest = decode(&request_json)?;
                let automation = AutomationRepository::get(
                    conn,
                    &request.automation_id,
                    request.workspace_key.as_deref(),
                )
                .map_err(automation_error)?;
                json(&automation)
            }),
        })
    }

    /// `getModelSelectionForDispatch` — the three-way decision, never a silent default.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_get_model_selection_for_dispatch(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: DispatchSelectionRequest = decode(&request_json)?;
                let selection = AutomationRepository::get_model_selection_for_dispatch(
                    conn,
                    &request.automation_id,
                    &request.workspace_key,
                )
                .map_err(automation_error)?;
                json(&selection)
            }),
        })
    }

    /// `getBotDeliveryTarget` — the internal source, never part of the display model.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_get_bot_delivery_target(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: AutomationScopeRequest = decode(&request_json)?;
                let target = AutomationRepository::get_bot_delivery_target(
                    conn,
                    &request.automation_id,
                    request.workspace_key.as_deref(),
                )
                .map_err(automation_error)?;
                json(&target)
            }),
        })
    }

    /// `hasTaskBinding` — the authorization criterion itself, scoped by workspace.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn automation_has_task_binding(&self, request_json: String) -> AsyncTask<AutomationBoolTask> {
        AsyncTask::new(AutomationBoolTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: HasTaskBindingRequest = decode(&request_json)?;
                AutomationRepository::has_task_binding(
                    conn,
                    &request.workspace_key,
                    &request.target_task_id,
                )
                .map_err(automation_error)
            }),
        })
    }

    /// `getScheduledRunCount` — `null` when the automation is gone.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn automation_get_scheduled_run_count(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationOptNumberTask> {
        AsyncTask::new(AutomationOptNumberTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: AutomationScopeRequest = decode(&request_json)?;
                AutomationRepository::scheduled_run_count(
                    conn,
                    &request.automation_id,
                    request.workspace_key.as_deref(),
                )
                .map_err(automation_error)
            }),
        })
    }

    /// `update` — the tri-state edit, with `enabled` derived from the lifecycle.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_update(&self, request_json: String) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: UpdateAutomationRequest = decode(&request_json)?;
                let automation =
                    AutomationRepository::update(conn, &request).map_err(automation_error)?;
                json(&automation)
            }),
        })
    }

    /// `delete` — `true` when a row was removed.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn automation_delete(&self, request_json: String) -> AsyncTask<AutomationBoolTask> {
        AsyncTask::new(AutomationBoolTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: AutomationScopeRequest = decode(&request_json)?;
                AutomationRepository::delete(conn, &request.automation_id, request.workspace_key.as_deref())
                    .map_err(automation_error)
            }),
        })
    }

    /// `setEnabled` — pause / resume, keeping the schedule.
    #[napi]
    pub fn automation_set_enabled(&self, request_json: String) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: SetEnabledRequest = decode(&request_json)?;
                AutomationRepository::set_enabled(
                    conn,
                    &request.automation_id,
                    request.enabled,
                    request.workspace_key.as_deref(),
                    request.now,
                )
                .map_err(automation_error)
            }),
        })
    }

    /// `restart` — back to active, counters and retry state cleared.
    #[napi]
    pub fn automation_restart(&self, request_json: String) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: RestartRequest = decode(&request_json)?;
                AutomationRepository::restart(
                    conn,
                    &request.automation_id,
                    request.next_run_at,
                    request.workspace_key.as_deref(),
                    request.now,
                )
                .map_err(automation_error)
            }),
        })
    }

    /// `runNow` — the manual run, taking the single-flight lock.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_run_now(&self, request_json: String) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: RunNowRequest = decode(&request_json)?;
                let claimed =
                    AutomationRepository::run_now(conn, &request).map_err(automation_error)?;
                json(&claimed)
            }),
        })
    }

    /// `claimDue` — the backoff-aware claim, in one transaction.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_claim_due(&self, now_ms: i64) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let claimed =
                    AutomationRepository::claim_due(conn, now_ms).map_err(automation_error)?;
                json(&claimed)
            }),
        })
    }

    /// `claimManualRuns` — the manual-run queue.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_claim_manual_runs(&self, now_ms: i64) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let claimed = AutomationRepository::claim_manual_runs(conn, now_ms)
                    .map_err(automation_error)?;
                json(&claimed)
            }),
        })
    }

    /// `markDispatched` — the successful-dispatch settlement.
    #[napi]
    pub fn automation_mark_dispatched(&self, request_json: String) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: MarkDispatchedRequest = decode(&request_json)?;
                AutomationRepository::mark_dispatched(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `markDispatchFailed` — transient backoff and the terminal give-up.
    #[napi]
    pub fn automation_mark_dispatch_failed(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: MarkDispatchFailedRequest = decode(&request_json)?;
                AutomationRepository::mark_dispatch_failed(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `releaseClaim` — clears the claim; `true` when there was one.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn automation_release_claim(&self, request_json: String) -> AsyncTask<AutomationBoolTask> {
        AsyncTask::new(AutomationBoolTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: ReleaseClaimRequest = decode(&request_json)?;
                AutomationRepository::release_claim(conn, &request.automation_id, request.now)
                    .map_err(automation_error)
            }),
        })
    }

    /// `releaseManualClaim` — releases the lock only, leaving the schedule untouched.
    #[napi]
    pub fn automation_release_manual_claim(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: ReleaseManualClaimRequest = decode(&request_json)?;
                AutomationRepository::release_manual_claim(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `touchManualClaim` — renews the lease for a long manual run.
    #[napi]
    pub fn automation_touch_manual_claim(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: TouchManualClaimRequest = decode(&request_json)?;
                AutomationRepository::touch_manual_claim(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `skipAndReschedule` — the missed-fire-window compensation.
    #[napi]
    pub fn automation_skip_and_reschedule(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: SkipAndRescheduleRequest = decode(&request_json)?;
                AutomationRepository::skip_and_reschedule(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `ensureRunClaimed` — the fallback row, without bumping `attempts`.
    #[napi]
    pub fn automation_ensure_run_claimed(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: EnsureRunClaimedRequest = decode(&request_json)?;
                AutomationRepository::ensure_run_claimed(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `upsertRunClaimed` — the claim upsert; a retry reuses its run row.
    #[napi]
    pub fn automation_upsert_run_claimed(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: UpsertRunClaimedRequest = decode(&request_json)?;
                AutomationRepository::upsert_run_claimed(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `fixRunModelSelection` — pins the selection on first submit.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_fix_run_model_selection(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: FixRunModelSelectionRequest = decode(&request_json)?;
                let selection = AutomationRepository::fix_run_model_selection(conn, &request)
                    .map_err(automation_error)?;
                json(&selection)
            }),
        })
    }

    /// `markRunDispatch` — the dispatch result onto the run row.
    #[napi]
    pub fn automation_mark_run_dispatch(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: MarkRunDispatchRequest = decode(&request_json)?;
                AutomationRepository::mark_run_dispatch(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `markManualRunDispatched` — idempotent at the first `dispatched`.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn automation_mark_manual_run_dispatched(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationBoolTask> {
        AsyncTask::new(AutomationBoolTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: MarkManualRunDispatchedRequest = decode(&request_json)?;
                AutomationRepository::mark_manual_run_dispatched(conn, &request)
                    .map_err(automation_error)
            }),
        })
    }

    /// `markRunOutcome` — the session runtime's write-back, guarded against `running` regressions.
    #[napi]
    pub fn automation_mark_run_outcome(&self, request_json: String) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: MarkRunOutcomeRequest = decode(&request_json)?;
                AutomationRepository::mark_run_outcome(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `recordSkippedRun` — a skipped row, without touching the counters.
    #[napi]
    pub fn automation_record_skipped_run(
        &self,
        request_json: String,
    ) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: RecordSkippedRunRequest = decode(&request_json)?;
                AutomationRepository::record_skipped_run(conn, &request).map_err(automation_error)
            }),
        })
    }

    /// `listRuns` — the run history, newest first.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_list_runs(&self, request_json: String) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: ListRunsRequest = decode(&request_json)?;
                let runs = AutomationRepository::list_runs(
                    conn,
                    &request.automation_id,
                    request.workspace_key.as_deref(),
                )
                .map_err(automation_error)?;
                json(&runs)
            }),
        })
    }

    /// `getRun` — one run, or `null`.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn automation_get_run(&self, run_id: String) -> AsyncTask<AutomationJsonTask> {
        AsyncTask::new(AutomationJsonTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let run = AutomationRepository::get_run(conn, &run_id).map_err(automation_error)?;
                json(&run)
            }),
        })
    }

    /// `deleteRun` — scoped by workspace when one is given.
    #[napi]
    pub fn automation_delete_run(&self, request_json: String) -> AsyncTask<AutomationVoidTask> {
        AsyncTask::new(AutomationVoidTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: DeleteRunRequest = decode(&request_json)?;
                AutomationRepository::delete_run(
                    conn,
                    &request.run_id,
                    request.workspace_key.as_deref(),
                )
                .map_err(automation_error)
            }),
        })
    }

    /// `pruneRuns` — the retention sweep; returns how many rows it dropped.
    #[napi]
    pub fn automation_prune_runs(&self, request_json: String) -> AsyncTask<AutomationNumberTask> {
        AsyncTask::new(AutomationNumberTask {
            inner: std::sync::Arc::clone(&self.inner),
            run: std::sync::Arc::new(move |conn: &mut rusqlite::Connection| {
                let request: PruneRunsRequest = decode(&request_json)?;
                AutomationRepository::prune_runs(conn, request.max_age_ms, request.now)
                    .map_err(automation_error)
            }),
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
    now_ms: i64,
    lock_wait_ms: Option<i64>,
}

/// Opens the file, applies the pragmas and runs the crate's migrations.
///
/// `on_progress` is `Some` only for `prepare_storage`; `ensure_ready` passes `None` and takes the
/// whole wait silently.
fn open_and_migrate(
    inner: &Inner,
    now_ms: i64,
    lock_wait_ms: Option<i64>,
    on_progress: Option<&ThreadsafeFunction<String, (), String, napi::Status, false>>,
    facts: &mut MigrationFacts,
) -> std::result::Result<rusqlite::Connection, StartupError> {
    // The historical default: the desktop worker waited up to an hour for the write lock.
    const DEFAULT_LOCK_WAIT_MS: i64 = 60 * 60_000;
    let path = inner.path.clone();
    let mut connection = rusqlite::Connection::open(&path).map_err(|error| {
        StartupError::from(StoreError::Open { path: path.clone(), source: error })
    })?;
    if !inner.read_only {
        // The same four pragmas as the legacy open, in the same order, with the caller's
        // `busy_timeout` rather than a hardcoded one.
        connection
            .execute_batch(&format!(
                "PRAGMA busy_timeout = {};\nPRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;",
                inner.busy_timeout_ms
            ))
            .map_err(|error| {
                StartupError::from(StoreError::Open { path: path.clone(), source: error })
            })?;
    }

    // The migration list is compiled from the live connection (the frozen `0002` decode reads
    // current rows), so it is built after the pragmas and before the transaction.
    let migrations = build_migrations(&connection).map_err(|error| {
        StartupError::from(StoreError::Migration(MigrationError::Sql {
            context: "cannot build the task database migrations".into(),
            source: error,
        }))
    })?;

    // Pre-check for the display kind, then wait for the lock with the same retry the JavaScript
    // used. `busy_timeout` alone is not enough: the JS waited *asynchronously* (reporting
    // `waiting_for_lock`) rather than failing after 5 s.
    let kind = inspect_kind(&connection)
        .map_err(|error| StartupError::from(StoreError::Migration(error)))?;
    facts.kind = kind.as_str().to_string();
    facts.executed_count = 0;
    facts.committed_count = 0;
    // The trusted baseline is the newest ledger row *before* this run: `null` on a fresh file,
    // the last applied id on an existing one. Same value the deleted runner read inside its
    // transaction.
    facts.last_applied_migration_id = baseline_id(&connection)
        .map_err(|error| StartupError::from(StoreError::Migration(error)))?;
    if let Some(callback) = on_progress {
        emit_progress(callback, "checking", facts);
    }

    let lock_wait_ms = lock_wait_ms.unwrap_or(DEFAULT_LOCK_WAIT_MS);
    if !inner.read_only {
        wait_for_lock(&connection, lock_wait_ms, on_progress, facts)?;
    }
    // The same phase sequence the deleted runner reported: `migrating` before the pending
    // migrations run, `committing` before the per-migration transactions are recorded, then
    // `maintaining` for the post-migration repairs.
    let pending = kind.as_str() != "none";
    if pending {
        if let Some(callback) = on_progress {
            emit_progress(callback, "migrating", facts);
        }
    }
    let applied = run_migrations(&mut connection, &migrations, now_ms)
        .map_err(|error| StartupError::from(StoreError::Migration(error)))?;
    facts.executed_count = applied.len() as i64;
    facts.committed_count = applied.len() as i64;
    // The kind flips to `upgrade` only when a fresh migration was actually applied on a file
    // that was otherwise `none`.
    if kind.as_str() == "none" && !applied.is_empty() {
        facts.kind = "upgrade".to_string();
    }
    if pending {
        if let Some(callback) = on_progress {
            emit_progress(callback, "committing", facts);
        }
    }

    if let Some(callback) = on_progress {
        emit_progress(callback, "maintaining", facts);
    }
    Ok(connection)
}

/// Emits one progress event. A closed channel is not an error: the caller may have stopped
/// listening, and the work must continue.
fn emit_progress(
    callback: &ThreadsafeFunction<String, (), String, napi::Status, false>,
    phase: &str,
    facts: &MigrationFacts,
) {
    let event = StorageProgress {
        phase: phase.to_string(),
        migration: facts.clone(),
    };
    let payload = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    let _ = callback.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
}

/// Waits for the write lock by attempting `BEGIN IMMEDIATE`, retrying on SQLITE_BUSY.
///
/// This is the JavaScript's `acquire()` loop: attempt, and on `(errcode & 0xff) == 5` sleep
/// 100 ms and retry until the deadline. An expired wait is a **failure** (`lock_timeout`), not a
/// silent skip, exactly as the deleted implementation threw.
fn wait_for_lock(
    connection: &rusqlite::Connection,
    lock_wait_ms: i64,
    on_progress: Option<&ThreadsafeFunction<String, (), String, napi::Status, false>>,
    facts: &MigrationFacts,
) -> std::result::Result<(), StartupError> {
    let deadline = Instant::now() + Duration::from_millis(lock_wait_ms.max(0) as u64);
    let mut waiting = false;
    loop {
        match connection.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => {
                // Release it immediately: `run_migrations` takes its own transactions per
                // migration. Holding it here would nest transactions and fail.
                let _ = connection.execute_batch("COMMIT");
                return Ok(());
            }
            Err(error) => {
                let code = sqlite_code(&error);
                let busy = code.is_some_and(|code| (code & 0xff) == 5);
                if !busy {
                    return Err(StartupError::from(StoreError::Query {
                        context: "cannot acquire the task storage write lock".into(),
                        source: error,
                    }));
                }
                if Instant::now() >= deadline {
                    // `kind: "lock_timeout"` is what the desktop's
                    // `classifyDatabaseStartupError` reads.
                    return Err(StartupError {
                        message: "Task storage lock wait expired".to_string(),
                        kind: Some("lock_timeout"),
                        errcode: code,
                        migration_id: None,
                    });
                }
                if !waiting {
                    waiting = true;
                    if let Some(callback) = on_progress {
                        emit_progress(callback, "waiting_for_lock", facts);
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

impl Task for EnsureReadyTask {
    type Output = ();
    type JsValue = ();

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        // `ensure_ready` reports no progress; the facts exist only because `open_and_migrate`
        // accumulates them.
        let mut facts = MigrationFacts {
            kind: "none".to_string(),
            executed_count: 0,
            committed_count: 0,
            last_applied_migration_id: None,
        };
        let connection =
            open_and_migrate(&self.inner, self.now_ms, self.lock_wait_ms, None, &mut facts)
                .map_err(|error| error.envelope(None))?;
        let mut guard = self
            .inner
            .connection
            .lock()
            .map_err(|_| to_napi_error("the task index store lock is poisoned"))?;
        *guard = Some(connection);
        Ok(())
    }
}

/// The startup orchestrator's task. It is the only caller that wants progress, and the only one
/// that **closes** the connection afterwards: it runs before the window opens its own store, and
/// holding a write connection would block it.
pub struct PrepareStorageTask {
    inner: std::sync::Arc<Inner>,
    now_ms: i64,
    lock_wait_ms: Option<i64>,
    progress: ThreadsafeFunction<String, (), String, napi::Status, false>,
}

impl Task for PrepareStorageTask {
    type Output = MigrationFacts;
    type JsValue = MigrationFacts;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let mut facts = MigrationFacts {
            kind: "none".to_string(),
            executed_count: 0,
            committed_count: 0,
            last_applied_migration_id: None,
        };
        let connection = open_and_migrate(
            &self.inner,
            self.now_ms,
            self.lock_wait_ms,
            Some(&self.progress),
            &mut facts,
        )
        .map_err(|error| error.envelope(Some(&facts)))?;

        // The post-migration repairs the three repositories ran on `ensureReady`. They are
        // idempotent startup repairs, not part of the migration transaction.
        crate::task_write::cleanup_deleted_grouping_references(&connection)
            .map_err(|error| StartupError::from(StoreError::Migration(error)).envelope(None))?;
        let now = self.now_ms;
        crate::offpeak::OffPeakStore::recycle_awaiting_approval(&connection, now)
            .map_err(|error| StartupError::from(StoreError::Migration(error)).envelope(None))?;
        let _ = connection.execute_batch("PRAGMA optimize");
        drop(connection);

        // `ready` is emitted by the TypeScript wrapper, synchronously before its returned promise
        // resolves. A worker-thread `ThreadsafeFunction` call is queued behind the promise's own
        // microtask, so emitting it here would deliver `ready` **after** `done`.
        Ok(facts)
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

/// Runs an automation task body against the connection.
///
/// A dedicated helper rather than `with_connection_mut`, because these bodies already return a
/// napi `Result`; `with_connection_mut` maps a generic `E: Display`, and `napi::Error` does not
/// satisfy that bound.
fn with_automation_connection<T>(
    inner: &Inner,
    operation: impl FnOnce(&mut rusqlite::Connection) -> Result<T>,
) -> Result<T> {
    let mut guard = inner
        .connection
        .lock()
        .map_err(|_| to_napi_error("the task index store lock is poisoned"))?;
    let connection = guard
        .as_mut()
        .ok_or_else(|| to_napi_error("the task index store is closed"))?;
    operation(connection)
}

pub struct AutomationJsonTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<dyn Fn(&mut rusqlite::Connection) -> std::result::Result<String, Error> + Send + Sync>,
}

impl Task for AutomationJsonTask {
    type Output = String;
    type JsValue = String;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_automation_connection(&self.inner, |connection| run(connection))
    }
}

pub struct AutomationBoolTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<dyn Fn(&mut rusqlite::Connection) -> std::result::Result<bool, Error> + Send + Sync>,
}

impl Task for AutomationBoolTask {
    type Output = bool;
    type JsValue = bool;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_automation_connection(&self.inner, |connection| run(connection))
    }
}

pub struct AutomationOptNumberTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<dyn Fn(&mut rusqlite::Connection) -> std::result::Result<Option<i64>, Error> + Send + Sync>,
}

impl Task for AutomationOptNumberTask {
    type Output = Option<i64>;
    type JsValue = Option<i64>;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_automation_connection(&self.inner, |connection| run(connection))
    }
}

pub struct AutomationNumberTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<dyn Fn(&mut rusqlite::Connection) -> std::result::Result<i64, Error> + Send + Sync>,
}

impl Task for AutomationNumberTask {
    type Output = i64;
    type JsValue = i64;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_automation_connection(&self.inner, |connection| run(connection))
    }
}

pub struct AutomationVoidTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<dyn Fn(&mut rusqlite::Connection) -> std::result::Result<(), Error> + Send + Sync>,
}

impl Task for AutomationVoidTask {
    type Output = ();
    type JsValue = ();

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let run = std::sync::Arc::clone(&self.run);
        with_automation_connection(&self.inner, |connection| run(connection))
    }
}

/// Serialises a repository value to the JSON string the boundary carries.
fn json<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|error| to_napi_error(error.to_string()))
}

/// Lifts a repository error to a napi error, keeping the message the TypeScript side would see.
fn automation_error(error: AutomationError) -> Error {
    Error::from_reason(error.to_string())
}

/// Serialises a value the way the boundary does, for tests and for the TypeScript wrapper's
/// shape assertions.
pub fn to_json<T: Serialize>(value: &T) -> std::result::Result<String, Error> {
    serde_json::to_string(value).map_err(|error| to_napi_error(error.to_string()))
}

/// The row types, re-exported so the boundary's consumers (and the parity tests) can name
/// them through one module rather than four.
pub use crate::grouped::GroupMemberOrder;
pub use crate::groups::TaskGroup;
use crate::grouped_view;
use crate::groups;
use crate::task_write;
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupedViewRequest {
    workspace_scopes: Vec<grouped_view::WorkspaceScope>,
    provider: Option<String>,
    #[serde(default)]
    include_all_workspaces: bool,
    now: i64,
    /// Present only on the order save.
    #[serde(default)]
    top_level_nodes: Vec<grouped_view::TopLevelNode>,
    #[serde(default)]
    groups: Vec<(String, Vec<grouped_view::GroupedTaskRef>)>,
}

pub struct GroupedViewTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
    /// Whether this is the order save rather than a read.
    apply: bool,
}

impl Task for GroupedViewTask {
    type Output = Vec<grouped_view::GroupedNode>;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| {
            let request: GroupedViewRequest = decode(&self.request_json)?;
            if self.apply {
                grouped_view::apply_grouped_task_view_order(
                    conn,
                    &request.workspace_scopes,
                    request.provider.as_deref(),
                    &request.top_level_nodes,
                    &request.groups,
                    request.now,
                )
            } else {
                grouped_view::query_grouped_task_view(
                    conn,
                    &grouped_view::GroupedViewQuery {
                        workspace_scopes: request.workspace_scopes,
                        include_all_workspaces: request.include_all_workspaces,
                        provider: request.provider,
                    },
                    request.now,
                )
            }
            .map_err(store_error)
        })
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupedStructureRequest {
    workspace_scopes: Vec<grouped_view::WorkspaceScope>,
}

pub struct GroupedStructureTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for GroupedStructureTask {
    type Output = grouped_view::GroupedStructure;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| {
            let request: GroupedStructureRequest = decode(&self.request_json)?;
            grouped_view::query_grouped_task_view_structure(conn, &request.workspace_scopes)
                .map_err(store_error)
        })
    }
}

// ---- the write path: request shapes and task bodies ------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncMetaRequest {
    meta: TaskMeta,
    pinned: Option<bool>,
    archived: Option<bool>,
    deleted: Option<bool>,
    title_overridden: Option<bool>,
    searchable_text: Option<String>,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskRefWithTime {
    workspace_key: String,
    task_id: String,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearUnreadRequest {
    workspace_key: String,
    task_id: String,
    expected_unread_at: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateRequest {
    workspace_key: String,
    task_id: String,
    #[serde(flatten)]
    patch: task_write::StatePatch,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeedRequest {
    workspace_key: String,
    meta: TaskMeta,
}

pub struct SyncMetaTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
    /// Whether the grouped-top admission runs, in the same transaction as the write.
    admit: bool,
}

impl Task for SyncMetaTask {
    type Output = task_write::SyncResult;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| {
            let request: SyncMetaRequest = decode(&self.request_json)?;
            let flags = task_write::SyncFlags {
                pinned: request.pinned,
                archived: request.archived,
                deleted: request.deleted,
                title_overridden: request.title_overridden,
                searchable_text: request.searchable_text,
            };
            if self.admit {
                task_write::sync_task_meta_at_grouped_top(conn, &request.meta, &flags, request.now)
            } else {
                task_write::sync_task_meta(conn, &request.meta, &flags, request.now)
            }
            .map_err(store_error)
        })
    }
}

pub struct SeedTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for SeedTask {
    type Output = TaskMeta;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| {
            let request: SeedRequest = decode(&self.request_json)?;
            task_write::seed_task_meta_if_missing(conn, &request.workspace_key, &request.meta)
                .map_err(store_error)
        })
    }
}

pub struct ClearUnreadTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for ClearUnreadTask {
    type Output = task_write::ClearUnreadResult;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| {
            let request: ClearUnreadRequest = decode(&self.request_json)?;
            task_write::clear_task_unread_if_matches(
                conn,
                &request.workspace_key,
                &request.task_id,
                request.expected_unread_at,
            )
            .map_err(store_error)
        })
    }
}

pub struct DeleteTaskTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for DeleteTaskTask {
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
        with_connection_mut(&self.inner, |conn| {
            let request: TaskRefWithTime = decode(&self.request_json)?;
            task_write::delete_archived_task(
                conn,
                &request.workspace_key,
                &request.task_id,
                request.now,
            )
            .map_err(store_error)
        })
    }
}

pub struct StateTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for StateTask {
    type Output = TaskMeta;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection_mut(&self.inner, |conn| {
            let request: StateRequest = decode(&self.request_json)?;
            task_write::update_task_state(
                conn,
                &request.workspace_key,
                &request.task_id,
                &request.patch,
                request.now,
            )
            .map_err(store_error)
        })
    }
}

pub struct AgentPatchTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for AgentPatchTask {
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
        with_connection_mut(&self.inner, |conn| {
            let request: AgentPatchRequest = decode(&self.request_json)?;
            task_write::apply_agent_patch(
                conn,
                &request.workspace_key,
                &request.task_id,
                request.title.as_deref(),
                request.status,
                request.last_error.clone(),
                request.target.clone(),
                request.updated_at,
            )
            .map_err(store_error)
        })
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentPatchRequest {
    workspace_key: String,
    task_id: String,
    title: Option<String>,
    status: Option<crate::meta::PersistStatus>,
    last_error: Option<Option<crate::meta::LastError>>,
    target: Option<Option<crate::meta::TaskGoal>>,
    updated_at: Option<i64>,
}

pub struct GroupingRepairTask {
    inner: std::sync::Arc<Inner>,
}

impl Task for GroupingRepairTask {
    type Output = i64;
    type JsValue = i64;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| {
            task_write::cleanup_deleted_grouping_references(conn)
        })
        .map(|cleaned| cleaned as i64)
    }
}

// ---- task groups: request shapes and task bodies --------------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateGroupRequest {
    group_id: String,
    title: Option<String>,
    color: Option<String>,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameGroupRequest {
    group_id: String,
    title: String,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecolourGroupRequest {
    group_id: String,
    color: String,
    now: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdmitTaskRequest {
    workspace_key: String,
    workspace_path: String,
    workspace_identity: Option<String>,
    task_id: String,
    now: i64,
}

pub enum GroupBody {
    Create(String),
    Rename(String),
    Recolour(String),
}

pub struct GroupResultTask {
    inner: std::sync::Arc<Inner>,
    body: GroupBody,
}

impl Task for GroupResultTask {
    type Output = groups::TaskGroup;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        to_json(&output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| -> std::result::Result<groups::TaskGroup, Error> {
            match &self.body {
                GroupBody::Create(json) => {
                    let request: CreateGroupRequest = decode(json)?;
                    groups::create_task_group(
                        conn,
                        &request.group_id,
                        request.title.as_deref(),
                        request.color.as_deref(),
                        request.now,
                    )
                    .map_err(store_error)
                }
                GroupBody::Rename(json) => {
                    let request: RenameGroupRequest = decode(json)?;
                    groups::rename_task_group(conn, &request.group_id, &request.title, request.now)
                        .map_err(store_error)
                }
                GroupBody::Recolour(json) => {
                    let request: RecolourGroupRequest = decode(json)?;
                    groups::update_task_group_color(
                        conn,
                        &request.group_id,
                        &request.color,
                        request.now,
                    )
                    .map_err(store_error)
                }
            }
        })
    }
}

/// `deleteTaskGroup` needs the mutable handle, because the two deletes are one transaction.
pub struct GroupUnitTask {
    inner: std::sync::Arc<Inner>,
    run: std::sync::Arc<
        dyn Fn(&mut rusqlite::Connection) -> std::result::Result<(), crate::migrate::MigrationError>
            + Send
            + Sync,
    >,
}

impl Task for GroupUnitTask {
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
        let run = std::sync::Arc::clone(&self.run);
        with_connection_mut(&self.inner, |conn| run(conn))
    }
}

pub struct GroupAdmissionTask {
    inner: std::sync::Arc<Inner>,
    request_json: String,
}

impl Task for GroupAdmissionTask {
    type Output = bool;
    type JsValue = bool;

    fn resolve(&mut self, _env: Env, output: Self::Output) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        with_connection(&self.inner, |conn| {
            let request: AdmitTaskRequest = decode(&self.request_json)?;
            groups::initialize_task_at_top(
                conn,
                &request.workspace_key,
                &request.workspace_path,
                request.workspace_identity.as_deref(),
                &request.task_id,
                request.now,
            )
            .map_err(store_error)
        })
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

#[cfg(test)]
mod startup_error_tests {
    use super::*;

    fn facts() -> MigrationFacts {
        MigrationFacts {
            kind: "upgrade".to_string(),
            executed_count: 2,
            committed_count: 2,
            last_applied_migration_id: Some("0002_provider_selection".to_string()),
        }
    }

    /// The desktop classification reads `error.kind`, never the message, so a checksum mismatch
    /// must arrive as `k` and `i` in the envelope or it is classified `sql_failed`.
    #[test]
    fn a_checksum_mismatch_carries_kind_and_migration_id() {
        let error = StartupError::from(StoreError::Migration(MigrationError::ChecksumMismatch {
            id: "0001_adopt_task_schema".to_string(),
            applied: "applied".to_string(),
            computed: "computed".to_string(),
        }));
        let parsed: serde_json::Value =
            serde_json::from_str(&error.envelope_json(None)).expect("envelope is JSON");
        assert_eq!(parsed["z"], 1);
        assert_eq!(parsed["k"], "checksum_mismatch");
        assert_eq!(parsed["i"], "0001_adopt_task_schema");
        assert!(parsed["m"].as_str().is_some_and(|m| m.contains("checksum")));
    }

    /// A busy lock must be `lock_timeout`, with the SQLite code so
    /// `classifyDatabaseStartupError` can mask it.
    #[test]
    fn a_lock_timeout_carries_the_kind() {
        let error = StartupError {
            message: "Task storage lock wait expired".to_string(),
            kind: Some("lock_timeout"),
            errcode: Some(5),
            migration_id: None,
        };
        let parsed: serde_json::Value =
            serde_json::from_str(&error.envelope_json(None)).expect("envelope is JSON");
        assert_eq!(parsed["k"], "lock_timeout");
        assert_eq!(parsed["c"], 5);
    }

    /// The facts at the moment of failure ride along as `sm`, which is what
    /// `tasksStorageWorker.ts` reads as `error.startupMigration`.
    #[test]
    fn the_failure_envelope_carries_the_startup_migration_facts() {
        let error = StartupError {
            message: "migration 0002_provider_selection failed".to_string(),
            kind: None,
            errcode: None,
            migration_id: None,
        };
        let parsed: serde_json::Value =
            serde_json::from_str(&error.envelope_json(Some(&facts()))).expect("envelope is JSON");
        assert_eq!(parsed["sm"]["kind"], "upgrade");
        assert_eq!(parsed["sm"]["executedCount"], 2);
        assert_eq!(parsed["sm"]["committedCount"], 2);
        assert_eq!(parsed["sm"]["lastAppliedMigrationId"], "0002_provider_selection");
    }

    /// A plain open failure must classify as `open_failed`, not fall through to `sql_failed`.
    #[test]
    fn an_open_failure_carries_the_kind() {
        let error = StartupError::from(StoreError::Open {
            path: "/data/tasks-index.sqlite".to_string(),
            source: rusqlite::Error::InvalidPath("/data/tasks-index.sqlite".into()),
        });
        let parsed: serde_json::Value =
            serde_json::from_str(&error.envelope_json(None)).expect("envelope is JSON");
        assert_eq!(parsed["k"], "open_failed");
    }
}

/// Checkpoints and truncates the task-index WAL, then closes.
///
/// The only reason this exists is the **fixture producer**
/// (`scripts/capture-task-read-ground-truth.mts`): it copies the database file
/// into a committed fixture, and a WAL database keeps everything written after the
/// last checkpoint in the `-wal` sidecar. Copying the main file alone produced a
/// fixture silently missing every task the read sweep selects.
///
/// It used to be the one `node:sqlite` import in `scripts/`, which existed only
/// for this `PRAGMA wal_checkpoint(TRUNCATE)`. Doing it here keeps the repository
/// free of a SQLite driver in JavaScript, with no fallback (spec §28 invariants 1-2).
#[napi]
pub fn checkpoint_task_index_wal(db_path: String) -> Result<()> {
    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|error| to_napi_error(StoreError::from(error).to_string()))?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|error| to_napi_error(StoreError::from(error).to_string()))?;
    Ok(())
}

#[cfg(test)]
mod state_request_wire_tests {
    use super::{decode, StateRequest};

    /// Spec §29 — the wire body `taskWriteRepository.ts` sends is **flat**: `#[serde(flatten)]`
    /// puts the `StatePatch` fields at the top level next to `workspaceKey`/`taskId`/`now`,
    /// the same shape `applyAgentPatch` takes.
    #[test]
    fn state_request_decodes_the_flat_body_the_typescript_glue_sends() {
        let json =
            r#"{"workspaceKey":"ws:home","taskId":"t1","archived":true,"now":1712345678901}"#;
        let request: StateRequest = decode(json).expect("the flat body must decode");
        assert_eq!(request.workspace_key, "ws:home");
        assert_eq!(request.task_id, "t1");
        assert_eq!(request.patch.archived, Some(true));
        assert_eq!(request.now, 1712345678901);
    }

    /// The regression this pins: the nested `{ "patch": … }` body handed the `patch` key to the
    /// flattened `StatePatch`, whose `deny_unknown_fields` failed every archive/pin/delete/unread
    /// write with `unknown field \`patch\`` (server log: `zcode-task.archiveTask FAIL`).
    #[test]
    fn state_request_rejects_the_nested_patch_body() {
        let json = r#"{"workspaceKey":"ws","taskId":"t1","patch":{"archived":true},"now":1}"#;
        let error = decode::<StateRequest>(json).expect_err("a nested patch must be rejected");
        assert!(
            error.to_string().contains("unknown field `patch`"),
            "unexpected error: {error}"
        );
    }
}
