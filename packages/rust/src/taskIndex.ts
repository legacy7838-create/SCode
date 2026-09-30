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
import { loadNative } from "./loader.js";

/** One migration, as the store's ledger defines it. */
export interface TaskIndexMigration {
  id: string;
  sql: string;
  /**
   * `JSON.stringify(checksumInput)`, **already serialised**.
   *
   * The ledger checksum is `sha256(JSON.stringify(checksumInput))` — not
   * `sha256(trimmed SQL)` as the session store's runner does. Verified against the real
   * ledger: all three declared checksums reproduce exactly.
   *
   * It is passed as a string rather than an array so the serialisation happens once, in the
   * language whose `JSON.stringify` defined the format. Re-serialising in Rust would require
   * reproducing nested arrays, quote and backslash escaping, and raw non-ASCII exactly, and
   * being wrong costs every existing install a `checksum_mismatch` on first launch.
   */
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

export interface AutomationRow {
  automationId: string;
  workspaceKey: string;
  nextRunAt?: number | null;
  retryAt?: number | null;
  endAt?: number | null;
  enabled: number;
  running: number;
  claimedAt?: number | null;
  scheduledRunCount: number;
  runCount: number;
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

export interface NativeStore {
  ensureReady(migrationsJson: string, nowMs: number): Promise<void>;
  writeBatch(batchJson: string): Promise<number>;
  listTasks(queryJson: string): Promise<string>;
  offpeakClaimDue(nowMs: number): Promise<string>;
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
  automationClaimDue(nowMs: number): Promise<string>;
  automationReleaseClaim(automationId: string): Promise<boolean>;
  automationHasTaskBinding(automationId: string): Promise<boolean>;
  automationScheduledRunCount(automationId: string): Promise<number | null>;

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

  /** Opens the file, applies the pragmas and runs the migrations. */
  async ensureReady(
    migrations: readonly TaskIndexMigration[],
    now: number = Date.now(),
  ): Promise<void> {
    await this.#store.ensureReady(JSON.stringify(migrations), now);
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

  /**
   * The automation claim. A row in backoff becomes due on `retry_at`, not on `next_run_at` —
   * consuming `next_run_at` too would bypass the backoff and retry every tick, and would move
   * `scheduled_at`, so the retry would stop reusing its run id.
   */
  async automationClaimDue(now: number = Date.now()): Promise<AutomationRow[]> {
    return JSON.parse(await this.#store.automationClaimDue(now)) as AutomationRow[];
  }

  async automationReleaseClaim(automationId: string): Promise<boolean> {
    return this.#store.automationReleaseClaim(automationId);
  }

  /** A deleted automation reads as `false`, not as a storage fault. */
  async automationHasTaskBinding(automationId: string): Promise<boolean> {
    return this.#store.automationHasTaskBinding(automationId);
  }

  async automationScheduledRunCount(automationId: string): Promise<number | null> {
    return this.#store.automationScheduledRunCount(automationId);
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
