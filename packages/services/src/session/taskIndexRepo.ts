/**
 * Task index repository (`tasks-index.sqlite`, WAL, multi-process safe).
 *
 * **This is a wrapper, not an implementation.** The schema, the guarded writes, the scheduling
 * claims, the grouped view and the `meta_json` document all live in the `zcode-task-index` Rust
 * crate (`packages/rust/crates/zcode-task-index/`). The 2,567 lines that used to be here are
 * deleted. Spec: docs/specs/rust-native-task-index.md §22–§27.
 *
 * What remains is exactly what has to be:
 *
 * - the `ensureReady` handshake and the per-task write chain;
 * - the identity rule, `workspaceIdentity?.trim() || workspacePath`, resolved **here** so the
 *   wrapper and every other repository agree on a scope;
 * - the `Date.now()` defaults the native side deliberately does not own, so it stays pure;
 * - the `TaskIndexRepo` **name and method signatures** the service layer already imports, so no
 *   call site changed.
 *
 * There is **no JavaScript fallback** (docs/specs/rust-native-ports.md invariant 1). `loadNative`
 * throws when the binary is missing. A task index that quietly half-writes is worse than one that
 * refuses to start: a claim that is taken but never dispatched, or a title that is edited but never
 * persisted, fails silently until a week of work has gone missing.
 *
 * The equivalence is not asserted by inspection. `scripts/verify-task-read-parity.mts` replays a
 * 46-entry transcript captured from the TypeScript implementation through the Rust engine, and all
 * 46 match; the off-peak and MCP transcripts are checked the same way.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListWorkspaceScope,
} from "#src/session/zcodeTaskListTypes.js";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";

/**
 * The state patch every task write takes.
 *
 * Declared here rather than imported because it was a local interface in the JavaScript
 * implementation, and the service layer reaches it only through the method signatures — which have
 * not changed. Every field is optional and an absent one means **leave alone**, which is why the
 * engine carries them as tri-states rather than as a nullable struct.
 */
export interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ZCodeTaskMeta["status"];
  lastError?: ZCodeTaskMeta["lastError"];
  target?: ZCodeTaskMeta["target"];
  updatedAt?: number;
}

import { getTasksIndexDatabasePath } from "#src/paths.js";
import { TaskIndexStore } from "@zcode/rust/task-index";
import { TaskGroupRepository, DEFAULT_TASK_GROUP_COLOR } from "@zcode/rust/task-group-repository";
import { TaskReadRepository } from "@zcode/rust/task-read-repository";
import { engineScopes, keyOf, keysOf } from "#src/session/taskIndexScope.js";

export { keyOf };
import { TaskWriteRepository } from "@zcode/rust/task-write-repository";

export type { ZCodeGroupedTaskRef, ZCodeTaskListWorkspaceScope };

export { DEFAULT_TASK_GROUP_COLOR };

export class TaskIndexRepo {
  /**
   * The path is fixed at construction.
   *
   * It deliberately does not read the process-level data directory: under vitest, test files run
   * concurrently and a global would be overwritten by whichever file ran last, opening a window in
   * which a test writes to the real library. The temporary path is injected during tests.
   */
  readonly #dbPath: string | null;
  readonly #startupBusyTimeoutMs: number;
  #store: TaskIndexStore | null = null;
  #reads: TaskReadRepository | null = null;
  #writes: TaskWriteRepository | null = null;
  #groups: TaskGroupRepository | null = null;
  #ready: Promise<void> | null = null;
  #openedPath: string | null = null;
  /**
   * The per-task write chain.
   *
   * One in-flight write per task, serialised by key. Two syncs of the same task must not
   * interleave — each reads the row, merges and writes, so an interleaving loses whichever merge
   * lands second. Different tasks do **not** block each other: the key is the task, not the store.
   */
  readonly #writeChains = new Map<string, Promise<unknown>>();

  constructor(dbPath?: string, startupBusyTimeoutMs = 5000) {
    this.#dbPath = dbPath?.trim() || null;
    this.#startupBusyTimeoutMs = startupBusyTimeoutMs;
  }

  #resolveDbPath(): string {
    return this.#dbPath ?? getTasksIndexDatabasePath();
  }

  /**
   * Opens the file, applies the pragmas, runs the migrations and repairs the grouping rows.
   *
   * Idempotent, and **re-opens** if the resolved path changed — otherwise a caller that handed over
   * a different path would keep reading the old file. A failure clears the memoised promise so the
   * next call retries instead of replaying the same rejection forever.
   */
  async ensureReady(): Promise<void> {
    const path = this.#resolveDbPath();
    if (this.#store && this.#openedPath !== path) {
      this.close();
    }
    if (!this.#ready) {
      this.#ready = this.#initialize(path).catch((error: unknown) => {
        this.close();
        throw error;
      });
    }
    await this.#ready;
  }

  async #initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // The migrations are the **crate's**: the ledger checksum is
    // `sha256(JSON.stringify(checksumInput))`, and the schema, the three frozen payloads and the
    // checksum inputs live in `crate::schema` (spec §28). `ensureReady` takes no migration list.
    const store = new TaskIndexStore({ path, busyTimeoutMs: this.#startupBusyTimeoutMs });
    await store.ensureReady(Date.now());
    this.#store = store;
    this.#reads = new TaskReadRepository(store);
    this.#writes = new TaskWriteRepository(store);
    this.#groups = new TaskGroupRepository(store);
    this.#openedPath = path;

    // A crash between a tombstone and its grouping delete would otherwise leave a deleted task
    // owning a group slot forever. It is a repair, so it belongs on open.
    await this.#writes.cleanupDeletedGroupingReferences();
  }

  /** Refuses loudly once closed, rather than silently reopening. */
  #requireStore(): TaskIndexStore {
    if (!this.#store || !this.#reads || !this.#writes || !this.#groups) {
      throw new Error("TaskIndexRepo is not initialized: await ensureReady() first");
    }
    return this.#store;
  }

  #read(): TaskReadRepository {
    this.#requireStore();
    return this.#reads as TaskReadRepository;
  }

  #write(): TaskWriteRepository {
    this.#requireStore();
    return this.#writes as TaskWriteRepository;
  }

  #group(): TaskGroupRepository {
    this.#requireStore();
    return this.#groups as TaskGroupRepository;
  }

  /**
   * Releases the connection and drops the write chains.
   *
   * `throwOnError` is accepted for call-site compatibility and honoured by rethrowing, so the two
   * behaviours are not silently unified.
   */
  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.#store?.close();
    } catch (error) {
      closeError = error;
    }
    this.#store = null;
    this.#reads = null;
    this.#writes = null;
    this.#groups = null;
    this.#openedPath = null;
    this.#ready = null;
    this.#writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  /**
   * Serialises writes for one task.
   *
   * The chain is keyed by the task, and a rejected link is swallowed so one failure does not
   * poison every later write. The chain is removed once it drains, so a long-lived process does not
   * accumulate an entry per task it has ever touched.
   */
  #enqueueWrite<T>(scope: { workspacePath: string; workspaceIdentity?: string; taskId: string }, operation: () => Promise<T>): Promise<T> {
    const key = `${keyOf(scope)}\u0000${scope.taskId}`;
    const previous = this.#writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.#writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.#writeChains.get(key) === completion) {
        this.#writeChains.delete(key);
      }
    });
    return result;
  }

  // ---- reads ----------------------------------------------------------------

  /** Whether the workspace-group bootstrap has **ever** run; the marker table is global. */
  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    await this.ensureReady();
    return this.#read().hasGroupedWorkspaceBootstrapRun();
  }

  /**
   * Archives completed, unpinned, unread-free tasks older than the span.
   *
   * The span floors at **1 day**: a zero or negative span would archive everything that ever
   * completed, and that bound belongs at the decision, not at the storage layer.
   */
  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
    return this.#read().archiveStaleTasks({
      workspaceKey: keyOf(params),
      cutoff,
      provider: params.provider,
    }) as Promise<ZCodeTaskMeta[]>;
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // A call with no path is a **full query**, not a workspace query, so the scope is only
    // resolved when a path was given.
    return this.#read().listTaskMetas({
      workspaceKey: params.workspacePath ? keyOf(params) : undefined,
      includeDeleted: params.includeDeleted,
      provider: params.provider,
      pinned: params.pinned,
      archived: params.archived,
    }) as Promise<ZCodeTaskMeta[]>;
  }

  /** The tombstones for a workspace, so a deleted task cannot reappear after a cold start. */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    return this.#read().listDeletedTaskIds({ workspaceKey: keyOf(params), provider: params.provider });
  }

  async listSessionsByAutomation(automationId: string): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    return this.#read().listSessionsByAutomation(automationId) as Promise<ZCodeTaskMeta[]>;
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    return this.#read().queryTaskList({
      workspaceKeys: keysOf(params.workspaceScopes),
      search: params.search,
      kind: params.kind,
      provider: params.provider,
      limit: params.limit,
      sortBy: params.sortBy,
      // The purpose is per **workspace**, and is not stored on the row.
      workspacePurposeByKey: params.workspaceScopes
        .filter((scope) => scope.workspacePurpose)
        .map((scope) => [keyOf(scope), scope.workspacePurpose as string] as [string, string]),
    }) as Promise<ZCodeTaskListResult>;
  }

  /** One task, or `null`. A deleted row reads as absent — the tombstone is not erased. */
  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.#read().getTaskMeta({ workspaceKey: keyOf(params), taskId: params.taskId }) as Promise<ZCodeTaskMeta | null>;
  }

  // ---- writes ---------------------------------------------------------------

  /** Merges a protocol snapshot into the index. */
  async syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.#enqueueWrite(params.meta, async () => {
      return (await this.#write().syncTaskMeta({
        meta: params.meta,
        pinned: params.pinned,
        archived: params.archived,
        deleted: params.deleted,
        titleOverridden: params.titleOverridden,
        searchableText: params.searchableText,
      })) as ZCodeTaskMeta;
    });
  }

  /**
   * The merge plus the grouped-top admission, in one transaction.
   *
   * Reported separately so a caller knows whether it needs to refresh the grouped view at all.
   */
  async syncTaskMetaAtGroupedTop(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    return this.#enqueueWrite(params.meta, async () => {
      return (await this.#write().syncTaskMetaAtGroupedTop({
        meta: params.meta,
        pinned: params.pinned,
        archived: params.archived,
        deleted: params.deleted,
        titleOverridden: params.titleOverridden,
        searchableText: params.searchableText,
      })) as { meta: ZCodeTaskMeta; initializedGroupedOrder: boolean };
    });
  }

  /** Writes a baseline only when the row does not exist; an existing one is returned as-is. */
  async seedTaskMetaIfMissing(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.#enqueueWrite(meta, async () => {
      return (await this.#write().seedTaskMetaIfMissing({
        workspaceKey: keyOf(meta),
        meta,
      })) as ZCodeTaskMeta;
    });
  }

  /**
   * Clears the unread mark only on an exact match, and reports the current state either way.
   *
   * The compare and the write share one transaction: a mobile read request can arrive after the
   * task's new final unread state, and without that the old click would clear the subsequent one.
   */
  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.#enqueueWrite(params, async () => {
      return (await this.#write().clearTaskUnreadIfMatches({
        workspaceKey: keyOf(params),
        taskId: params.taskId,
        expectedUnreadAt: params.expectedUnreadAt,
      })) as { meta: ZCodeTaskMeta; cleared: boolean };
    });
  }

  /**
   * Writes the tombstone, but only for a task that is already archived.
   *
   * The archive check, the tombstone and the grouping cleanup are one transaction, so a
   * confirmation restored from the other end cannot slip through between them.
   */
  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.#enqueueWrite(params, async () => {
      return (await this.#write().deleteArchivedTask({
        workspaceKey: keyOf(params),
        taskId: params.taskId,
      })) as ZCodeTaskMeta | null;
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.#enqueueWrite(params, async () => {
      return (await this.#write().updateTaskState({
        workspaceKey: keyOf(params),
        taskId: params.taskId,
        patch: params.patch,
      })) as ZCodeTaskMeta;
    });
  }

  /**
   * Applies an agent-authored patch.
   *
   * `null` for a missing or deleted task, which is normal: a user can delete a task before its
   * last snapshot arrives.
   */
  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: {
      title?: string;
      status?: ZCodeTaskMeta["status"];
      lastError?: ZCodeTaskMeta["lastError"];
      target?: ZCodeTaskMeta["target"];
      updatedAt?: number;
    };
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.#enqueueWrite(params, async () => {
      return (await this.#write().applyAgentPatch({
        workspaceKey: keyOf(params),
        taskId: params.taskId,
        title: params.patch.title,
        status: params.patch.status,
        lastError: params.patch.lastError,
        target: params.patch.target,
        updatedAt: params.patch.updatedAt,
      })) as ZCodeTaskMeta | null;
    });
  }

  // ---- groups ---------------------------------------------------------------

  async createTaskGroup(params?: { title?: string; color?: ZCodeTaskGroupColor }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    return this.#group().createTaskGroup({
      // The original minted `task-group-<uuid>`; the engine takes the id so a test can use a
      // stable one instead of reading a generated value back out of the result.
      groupId: `task-group-${crypto.randomUUID()}`,
      title: params?.title,
      color: params?.color,
    }) as Promise<ZCodeTaskGroup>;
  }

  async renameTaskGroup(params: { groupId: string; title: string }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    return this.#group().renameTaskGroup(params) as Promise<ZCodeTaskGroup>;
  }

  async updateTaskGroupColor(params: { groupId: string; color: ZCodeTaskGroupColor }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    return this.#group().updateTaskGroupColor(params) as Promise<ZCodeTaskGroup>;
  }

  async deleteTaskGroup(params: { groupId: string }): Promise<void> {
    await this.ensureReady();
    await this.#group().deleteTaskGroup(params.groupId);
  }

  /** `true` only the first time a task reaches the top of the grouped view. */
  async initializeGroupedTaskAtTop(params: ZCodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    return this.#group().initializeGroupedTaskAtTop({
      workspaceKey: keyOf(params),
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      taskId: params.taskId,
    });
  }

  async queryGroupedTaskView(
    params: ZCodeGroupedTaskViewQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const nodes = await this.#read().queryGroupedTaskView({
      workspaceScopes: engineScopes(params.workspaceScopes),
      includeAllWorkspaces: params.includeAllWorkspaces,
      provider: params.provider,
    });
    return { nodes } as ZCodeGroupedTaskView;
  }

  /** The structure read: no join to `tasks`, no bootstrap, no writeback. */
  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeGroupedTaskViewStructure> {
    await this.ensureReady();
    return this.#read().queryGroupedTaskViewStructure({
      workspaceScopes: engineScopes(params.workspaceScopes),
    }) as Promise<ZCodeGroupedTaskViewStructure>;
  }

  /** The drag-and-drop save, in one transaction. Returns the view as it now reads. */
  async applyGroupedTaskViewOrder(
    params: ZCodeGroupedTaskViewOrderInput & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const toRef = (task: ZCodeGroupedTaskRef) => ({
      workspaceKey: keyOf(task),
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity ?? null,
      taskId: task.taskId,
    });
    const nodes = await this.#read().applyGroupedTaskViewOrder({
      workspaceScopes: engineScopes(params.workspaceScopes),
      topLevelNodes: params.topLevelNodes.map((node) =>
        node.type === "group"
          ? { type: "group", groupId: node.groupId }
          : { type: "task", task: toRef(node.task) },
      ),
      groups: params.groups.map((group) => [group.groupId, group.taskRefs.map(toRef)] as [string, unknown[]]),
      provider: params.provider,
    });
    return { nodes } as ZCodeGroupedTaskView;
  }
}
