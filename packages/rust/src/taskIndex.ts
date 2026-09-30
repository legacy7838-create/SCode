/**
 * `@zcode/rust/task-index` — typed wrapper over the `zcode-task-index` binary.
 *
 * Spec: docs/specs/rust-native-task-index.md §7 (the consumer switch).
 *
 * This module is the whole point of the port from the TypeScript side: the three repositories
 * in `packages/services/src/session/` import from here, and `node:sqlite` leaves the
 * codebase. The wrapper holds no logic — the state machines, the checksums and the search
 * snippets are all Rust. What lives here is exactly what has to: the `loadNative` call, the
 * JSON shapes, and the `Date.now()` defaults that the native side deliberately does not own so
 * it stays pure.
 *
 * There is **no JavaScript fallback** (docs/specs/rust-native-ports.md invariant 1). The engine
 * is a compiled binary; if it is missing, `loadNative` throws and the process does not start
 * with a store that silently behaves differently. A task index that half-works is worse than
 * one that refuses to open.
 */
import { fromNativeError } from "./nativeError.js";
import { loadNative } from "./loader.js";

/**
 * One migration, as the store's ledger defines it.
 *
 * The ledger checksum is `sha256(JSON.stringify(checksumInput))` — not `sha256(trimmed SQL)` as
 * the session store's runner does. The crate owns the list now (spec §28), so this shape is only
 * used by tests that build a ledger by hand.
 */
export interface TaskIndexMigration {
  id: string;
  sql: string;
  /** The already-serialised `JSON.stringify(checksumInput)`. */
  checksumInputJson: string;
}

export interface TaskIndexOpenOptions {
  path: string;
  /** Defaults to 5000, matching the legacy open. */
  busyTimeoutMs?: number;
  /** Open without creating a file or applying migrations, for queries that must not. */
  readOnly?: boolean;
}

/** Mirrors `ZCodeTaskMeta`'s write shape; `searchableText` is three-state (see below). */
export interface TaskIndexWrite {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string | null;
  taskId: string;
  title: string;
  taskStatus?: string | null;
  provider?: string | null;
  mode: string;
  model?: string | null;
  migrationSource?: string | null;
  forkedFromTaskId?: string | null;
  createdAt: number;
  updatedAt: number;
  unreadAt?: number | null;
  lastUnreadAt?: number | null;
  pinned?: number | null;
  metaJson: string;
  /**
   * Three states, and collapsing them is a silent data-loss bug:
   *
   * | value              | meaning                       |
   * |--------------------|-------------------------------|
   * | `undefined` / key absent | leave the stored value alone |
   * | `null`             | clear it to `""`               |
   * | a string           | set it                        |
   *
   * The upsert is `ON CONFLICT … excluded.searchable_text`, so without the read-before-write an
   * omitted value assigns `""` and **wipes every task's indexed text** — the task list keeps
   * working and search silently returns nothing.
   */
  searchableText?: string | null;
  cronAutomationId?: string | null;
  offPeakTaskId?: string | null;
}

export interface ViewNodeOrder {
  nodeType: string;
  nodeKey: string;
  sortOrder: number;
}

export interface GroupMemberOrder {
  groupId: string;
  taskId: string;
  sortOrder?: number | null;
}

export interface TaskIndexWriteBatch {
  tasks: TaskIndexWrite[];
  nodeOrders?: ViewNodeOrder[];
  groupMembers?: GroupMemberOrder[];
}

export interface TaskIndexListQuery {
  workspaceKeys?: string[];
  search?: string | null;
  includeArchived?: boolean;
  limit?: number | null;
}

export interface TaskIndexListRow {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string | null;
  taskId: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  archived: number;
  deleted: number;
  pinned: number;
  unreadAt?: number | null;
  lastUnreadAt: number;
  searchableText: string;
  metaJson: string;
  /** Present only when the query carried a search. */
  snippets: string[];
}

export interface OffPeakRow {
  offPeakTaskId: string;
  sessionId?: string | null;
  prompt: string;
  workspaceKey: string;
  status: string;
  queuedAt: number;
  createdAt: number;
  updatedAt: number;
  schedulable: number;
  claimRunning: number;
  claimedAt?: number | null;
  modelSelection?: string | null;
}

/**
 * The module `loadNative` returns.
 *
 * A **module object with a class on it**, not a constructor itself: `#[napi]` on an
 * `impl` block exports the class as a property. Getting this wrong yields
 * "NativeTaskIndexStore is not a constructor", which is what the first end-to-end run hit.
 */
interface NativeTaskIndexModule {
  TaskIndexStore: new (options: TaskIndexOpenOptions) => NativeStore;
}

/**
 * The native handle, reachable from a sibling module.
 *
 * `offPeakRepository.ts` implements the off-peak methods as a class over the same binary, and napi
 * puts them on the same native object — so the wrapper has to reach it. A `private` field cannot be
 * read across modules, and a public accessor would put the raw binary on the public surface.
 */
export const NATIVE_STORE: unique symbol = Symbol("zcode.taskIndex.nativeStore");

/** The `DatabaseMigrationFacts` shape, matching `@zcode/shared`. */
export interface MigrationFacts {
  kind: "none" | "initialize" | "upgrade";
  executedCount: number;
  committedCount: number;
  lastAppliedMigrationId?: string | null;
}

/** A startup phase; mirrors the deleted `TasksStoragePhase`. */
export type StoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";

/** One progress event, forwarded to the desktop worker's `postMessage`. */
export interface StorageProgress {
  phase: StoragePhase;
  migration: MigrationFacts;
}

export interface NativeStore {
  ensureReady(nowMs: number): Promise<void>;
  prepareStorage(
    nowMs: number,
    lockWaitMs: number | null,
    onProgress: (eventJson: string) => void,
  ): Promise<MigrationFacts>;
  writeBatch(batchJson: string): Promise<number>;
  listTasks(queryJson: string): Promise<string>;
  offpeakClaimDue(nowMs: number): Promise<string>;
  // The grouped view — batch C's napi surface.
  queryGroupedTaskView(requestJson: string): Promise<string>;
  queryGroupedTaskViewStructure(requestJson: string): Promise<string>;
  applyGroupedTaskViewOrder(requestJson: string): Promise<string>;

  // The write path — `taskIndexRepo` batch D.
  syncTaskMeta(requestJson: string): Promise<string>;
  syncTaskMetaAtGroupedTop(requestJson: string): Promise<string>;
  seedTaskMetaIfMissing(requestJson: string): Promise<string>;
  clearTaskUnreadIfMatches(requestJson: string): Promise<string>;
  deleteArchivedTask(requestJson: string): Promise<string>;
  updateTaskState(requestJson: string): Promise<string>;
  applyAgentPatch(requestJson: string): Promise<string>;
  cleanupDeletedGroupingReferences(): Promise<number>;

  // Task groups — `taskIndexRepo` batch B.
  createTaskGroup(requestJson: string): Promise<string>;
  renameTaskGroup(requestJson: string): Promise<string>;
  updateTaskGroupColor(requestJson: string): Promise<string>;
  deleteTaskGroup(groupId: string): Promise<void>;
  initializeTaskAtTop(requestJson: string): Promise<boolean>;

  // The task read path — `taskIndexRepo` batch A.
  getTaskMeta(requestJson: string): Promise<string>;
  listTaskMetas(queryJson: string): Promise<string>;
  listDeletedTaskIds(requestJson: string): Promise<string>;
  listSessionsByAutomation(automationId: string): Promise<string>;
  queryTaskList(queryJson: string): Promise<string>;
  hasGroupedWorkspaceBootstrapRun(): Promise<boolean>;
  archiveStaleTasks(requestJson: string): Promise<string>;

  offpeakRecycleAwaitingApproval(now: number): Promise<number>;
  offpeakCountNonTerminal(): Promise<number>;
  offpeakCountActive(): Promise<number>;
  /**
   * `hasActiveBoundTask` — true when this workspace/session already has a non-terminal task.
   *
   * The native method exists and is exercised by the parity harness; it was simply never declared
   * here, so `repo.offpeakHasActiveBoundTask` was `undefined` rather than the napi binding.
   */
  offpeakHasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean>;
  offpeakGet(offPeakTaskId: string): Promise<string | null>;

  // The automation repository — every method of `automationRepo.ts`. Each request is a JSON
  // body, except the two claim passes, which take the current time. `automationGetRun` takes
  // the id directly for symmetry with `getRun`.
  automationCreate(requestJson: string): Promise<string>;
  automationList(requestJson: string): Promise<string>;
  automationGet(requestJson: string): Promise<string>;
  automationGetModelSelectionForDispatch(requestJson: string): Promise<string>;
  automationGetBotDeliveryTarget(requestJson: string): Promise<string>;
  automationHasTaskBinding(requestJson: string): Promise<boolean>;
  automationGetScheduledRunCount(requestJson: string): Promise<number | null>;
  automationUpdate(requestJson: string): Promise<string>;
  automationDelete(requestJson: string): Promise<boolean>;
  automationSetEnabled(requestJson: string): Promise<void>;
  automationRestart(requestJson: string): Promise<void>;
  automationRunNow(requestJson: string): Promise<string>;
  automationClaimDue(nowMs: number): Promise<string>;
  automationClaimManualRuns(nowMs: number): Promise<string>;
  automationMarkDispatched(requestJson: string): Promise<void>;
  automationMarkDispatchFailed(requestJson: string): Promise<void>;
  automationReleaseClaim(requestJson: string): Promise<boolean>;
  automationReleaseManualClaim(requestJson: string): Promise<void>;
  automationTouchManualClaim(requestJson: string): Promise<void>;
  automationSkipAndReschedule(requestJson: string): Promise<void>;
  automationEnsureRunClaimed(requestJson: string): Promise<void>;
  automationUpsertRunClaimed(requestJson: string): Promise<void>;
  automationFixRunModelSelection(requestJson: string): Promise<string>;
  automationMarkRunDispatch(requestJson: string): Promise<void>;
  automationMarkManualRunDispatched(requestJson: string): Promise<boolean>;
  automationMarkRunOutcome(requestJson: string): Promise<void>;
  automationRecordSkippedRun(requestJson: string): Promise<void>;
  automationListRuns(requestJson: string): Promise<string>;
  automationGetRun(runId: string): Promise<string>;
  automationDeleteRun(requestJson: string): Promise<void>;
  automationPruneRuns(requestJson: string): Promise<number>;

  // The off-peak repository. napi exports method names in camelCase regardless of the Rust
  // spelling, so these are the camelCase forms of the `offpeak_*` methods in `src/napi.rs`.
  offpeakCreate(paramsJson: string): Promise<string>;
  offpeakList(requestJson: string): Promise<string>;
  offpeakInvalidateModelSelection(requestJson: string): Promise<string>;
  offpeakMarkHistoryDeleted(requestJson: string): Promise<string>;
  offpeakUpdateEditableFields(requestJson: string): Promise<string>;
  offpeakUpdateSchedulingSnapshot(requestJson: string): Promise<void>;
  offpeakMarkRunning(requestJson: string): Promise<string>;
  offpeakMarkTerminal(requestJson: string): Promise<string>;
  offpeakSetPaused(requestJson: string): Promise<string>;
  offpeakReleaseClaim(requestJson: string): Promise<void>;
  offpeakRecoverInterrupted(now: number): Promise<number>;
  offpeakRequeueForContinuation(requestJson: string): Promise<string>;
  offpeakListNonTerminal(): Promise<string>;
  offpeakListUnsettledTerminal(): Promise<string>;
  offpeakMarkSettled(offPeakTaskId: string, settledAt: number): Promise<void>;
  /** `delete` — in any state; the service layer settles server-side first. */
  offpeakDelete(offPeakTaskId: string): Promise<void>;
  close(): void;
}

let cached: NativeTaskIndexModule | null = null;

function module(): NativeTaskIndexModule {
  cached ??= loadNative<NativeTaskIndexModule>("zcode-task-index");
  return cached;
}

/**
 * The store handle.
 *
 * `open` does no IO — the file is opened and the migrations run by `ensureReady`, so a missing
 * binary fails at `loadNative` rather than inside a constructor whose error cannot be told apart
 * from a bad path.
 */
export class TaskIndexStore {
  readonly #store: NativeStore;

  constructor(options: TaskIndexOpenOptions) {
    this.#store = new (module().TaskIndexStore)(options);
  }

  /** @internal For `offPeakRepository.ts`; not part of the repository's contract. */
  get [NATIVE_STORE](): NativeStore {
    return this.#store;
  }

  /**
   * Opens the file, applies the pragmas and runs the migrations.
   *
   * The migration list is the **crate's**, not the caller's: the schema, the three frozen
   * payloads and the checksum inputs live in `crate::schema`. The JavaScript that used to build
   * them — and serialise each `JSON.stringify(checksumInput)` — is deleted (spec §28).
   */
  async ensureReady(now: number = Date.now()): Promise<void> {
    await this.#store.ensureReady(now).catch((error: unknown) => {
      throw fromNativeError(error);
    });
  }

  /**
   * The startup orchestrator: pragmas, the busy-lock wait, the migrations and the three
   * post-migration repairs, with progress. It **closes** the connection before resolving, so the
   * window that opens next is not blocked by a write handle.
   */
  async prepareStorage(
    now: number = Date.now(),
    lockWaitMs: number | null = null,
    onProgress?: (event: StorageProgress) => void,
  ): Promise<MigrationFacts> {
    const facts = await this.#store
      .prepareStorage(now, lockWaitMs, (eventJson) => {
        onProgress?.(JSON.parse(eventJson) as StorageProgress);
      })
      .catch((error: unknown) => {
        throw fromNativeError(error);
      });
    // `ready` is emitted here, synchronously before this promise resolves. In Rust it would be a
    // worker-thread `ThreadsafeFunction` call queued behind this very microtask, so the desktop
    // worker could post `done` before the last progress frame. The phase belongs to the caller.
    onProgress?.({ phase: "ready", migration: facts });
    return facts;
  }

  /** Applies a batch in one transaction. Resolves to the number of task rows written. */
  async writeBatch(batch: TaskIndexWriteBatch): Promise<number> {
    return this.#store.writeBatch(JSON.stringify(batch));
  }

  async listTasks(query: TaskIndexListQuery = {}): Promise<TaskIndexListRow[]> {
    const raw = await this.#store.listTasks(JSON.stringify(query));
    return JSON.parse(raw) as TaskIndexListRow[];
  }

  /** The compare-and-swap claim. `None` is never returned: a partial claim would double-dispatch. */
  async offpeakClaimDue(now: number = Date.now()): Promise<OffPeakRow[]> {
    return JSON.parse(await this.#store.offpeakClaimDue(now)) as OffPeakRow[];
  }

  async offpeakCountNonTerminal(): Promise<number> {
    return this.#store.offpeakCountNonTerminal();
  }

  async offpeakCountActive(): Promise<number> {
    return this.#store.offpeakCountActive();
  }

  /** The pre-create check; `idx_off_peak_bound_active` uses the same predicate. */
  async offpeakHasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean> {
    return this.#store.offpeakHasActiveBoundTask(workspaceKey, sessionId);
  }

  async offpeakGet(offPeakTaskId: string): Promise<OffPeakRow | null> {
    const raw = await this.#store.offpeakGet(offPeakTaskId);
    return raw ? (JSON.parse(raw) as OffPeakRow) : null;
  }

  /** Marks the store closed and releases the connection. Safe to call twice. */
  close(): void {
    this.#store.close();
  }

  // The off-peak repository's twenty methods live in `offPeakRepository.ts`, on a class over the
  // same native handle. They are not methods here because the engine puts them on the same object,
  // and splitting the wrapper the same way keeps the two files in step with `src/napi.rs`.
}

/**
 * The off-peak repository, over the same connection the task index uses.
 *
 * The same store: the two facades share one sqlite connection and one migration ledger,
 * which is the arrangement spec §4.4 chose over two connections in two languages. The methods
 * live in `offPeakRepository.ts`, which extends this class at the module level.
 */
export function offPeakRepo(store: TaskIndexStore): TaskIndexStore {
  return store;
}

/** Every export, for callers that want a single namespace object. */
export const nativeTaskIndex = {
  TaskIndexStore,
  loadTaskIndexStore: (options: TaskIndexOpenOptions) => new TaskIndexStore(options),
};
