/**
 * `@zcode/rust/task-index` — the task read path.
 *
 * Spec: docs/specs/rust-native-task-index.md §22 (batch A).
 *
 * These seven methods are `taskIndexRepo`'s reads, transcribed. They cover the surface everything
 * else in that repository is built on, which is why they are switched first: the grouped view, the
 * group CRUD and the sync/write path all read through this.
 *
 * There is **no JavaScript fallback**: `loadNative` throws when the binary is missing, and a task
 * list that quietly came back empty reads as "you have no tasks" rather than as a failure.
 */
import { NATIVE_STORE, type NativeStore, type TaskIndexStore } from "./taskIndex.js";

/** The seven reads, over the same native handle the task index uses. */
/**
 * A workspace scope with the identity key already resolved.
 *
 * `workspaceIdentity` is **optional** rather than `null`-able: the Rust side distinguishes an
 * absent identity from a path-derived one by the key, and sending an explicit `null` for "no
 * identity" would be a second spelling of the same thing.
 */
export interface TaskEngineScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export class TaskReadRepository {
  /** One native object, so one connection and one migration ledger. */
  readonly #store: NativeStore;

  constructor(store: TaskIndexStore) {
    this.#store = store[NATIVE_STORE];
  }

  /**
   * One task, or `null`.
   *
   * A **deleted** row reads as `null`. The tombstone is not erased — the CLI session store still
   * holds the session — so a deleted task must not come back as a normal one.
   */
  async getTaskMeta(request: { workspaceKey: string; taskId: string }): Promise<unknown | null> {
    const raw = await this.#store.getTaskMeta(JSON.stringify(request));
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Every filter is a nullable tri-state, so an absent one does not narrow the result: `{ pinned:
   * undefined }` lists both pinned and unpinned, while `{ pinned: false }` lists only unpinned.
   */
  async listTaskMetas(query: {
    workspaceKey?: string;
    includeDeleted?: boolean;
    provider?: string;
    pinned?: boolean;
    archived?: boolean;
  }): Promise<unknown[]> {
    return JSON.parse(await this.#store.listTaskMetas(JSON.stringify(query)));
  }

  /**
   * The tombstones for a workspace.
   *
   * Needed because the list join reads only active/pinned/archived rows: without this, a deleted
   * task is "not in the archived collection" and reappears after a cold start.
   */
  async listDeletedTaskIds(request: {
    workspaceKey: string;
    provider?: string;
  }): Promise<string[]> {
    return JSON.parse(await this.#store.listDeletedTaskIds(JSON.stringify(request)));
  }

  /** The runs an automation produced, newest first. */
  async listSessionsByAutomation(automationId: string): Promise<unknown[]> {
    return JSON.parse(await this.#store.listSessionsByAutomation(automationId));
  }

  /**
   * The sidebar, with search snippets.
   *
   * `workspaceKeys` must already be **resolved** by the caller: the identity rule is
   * `identity?.trim() || path`, and resolving it here would mean the engine and every other
   * repository could disagree about a scope.
   */
  async queryTaskList(query: {
    workspaceKeys: string[];
    search?: string;
    kind?: "pinned" | "archived" | "timeline" | "active";
    provider?: string;
    limit?: number;
    sortBy?: "created" | "updated";
    workspacePurposeByKey?: Array<[string, string]>;
  }): Promise<{ items: unknown[]; total: number; hasMore: boolean }> {
    return JSON.parse(await this.#store.queryTaskList(JSON.stringify(query)));
  }

  /**
   * Whether the workspace-group bootstrap has **ever** run, not whether it is enabled here: the
   * marker table is global, and that is deliberate — a user who has seen a grouped sidebar once
   * should not have it re-created for every new workspace afterwards.
   */
  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    return this.#store.hasGroupedWorkspaceBootstrapRun();
  }

  /**
   * Archives completed, unpinned, unread-free tasks older than `cutoff`, and returns them.
   *
   * The returned tasks are the rows as they were **read**, so `archived` still reports the
   * pre-archive value — the caller can show them as they were before the sweep.
   *
   * The span floor lives at the call site: a zero-day cutoff would archive everything that ever
   * completed, and that is a decision about intent, not about storage.
   */
  async archiveStaleTasks(request: {
    workspaceKey: string;
    cutoff: number;
    provider?: string;
  }): Promise<unknown[]> {
    return JSON.parse(await this.#store.archiveStaleTasks(JSON.stringify(request)));
  }


  // -------------------------------------------------------------------------
  // The grouped view. On `TaskIndexStore` rather than here, because the grouped view needs the
  // mutable handle — it runs the bootstrap and the order writeback, both of which write.
  // -------------------------------------------------------------------------

  /**
   * The joined grouped view, with the workspace bootstrap and the order writeback.
   *
   * The writeback is not a cache: it is what turns "sorted by `createdAt` for this query" into a
   * stable order the user can then drag.
   */
  async queryGroupedTaskView(query: {
    workspaceScopes: TaskEngineScope[];
    includeAllWorkspaces?: boolean;
    provider?: string;
    now?: number;
  }): Promise<unknown[]> {
    return JSON.parse(
      await this.#store.queryGroupedTaskView(
        JSON.stringify({
          workspaceScopes: query.workspaceScopes,
          includeAllWorkspaces: query.includeAllWorkspaces ?? false,
          provider: query.provider ?? null,
          now: query.now ?? Date.now(),
        }),
      ),
    );
  }

  /** The order save, in one transaction. Returns the view as it now reads. */
  async applyGroupedTaskViewOrder(params: {
    workspaceScopes: TaskEngineScope[];
    topLevelNodes: unknown[];
    groups: Array<[string, unknown[]]>;
    provider?: string;
    now?: number;
  }): Promise<unknown[]> {
    return JSON.parse(
      await this.#store.applyGroupedTaskViewOrder(
        JSON.stringify({
          workspaceScopes: params.workspaceScopes,
          topLevelNodes: params.topLevelNodes,
          groups: params.groups,
          provider: params.provider ?? null,
          now: params.now ?? Date.now(),
        }),
      ),
    );
  }

  /**
   * The **structure** read: groups, members and top-level orders, with no join to `tasks` and no
   * writeback. The task content comes from sessions-index and the client joins it, so this stays
   * cheap and mutates nothing.
   */
  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: TaskEngineScope[];
  }): Promise<unknown> {
    return JSON.parse(
      await this.#store.queryGroupedTaskViewStructure(
        JSON.stringify({ workspaceScopes: params.workspaceScopes }),
      ),
    );
  }
}

/** The read repository handle — the same store, wrapped. */
export function taskReadRepository(store: TaskIndexStore): TaskReadRepository {
  return new TaskReadRepository(store);
}
