/**
 * `@zcode/rust/task-index` — the write path.
 *
 * Spec: docs/specs/rust-native-task-index.md §25, §26 (batch D).
 *
 * This is the last of `taskIndexRepo`'s surface, and the switch that follows it removes the file's
 * JavaScript implementation entirely. There is **no JavaScript fallback**: `loadNative` throws when
 * the binary is missing, and a task index that quietly half-writes is worse than one that refuses to
 * start — a claim that is taken but never dispatched, or a title that is edited but never persisted,
 * fails silently until a week of work has gone missing.
 */
import { NATIVE_STORE, type TaskIndexStore } from "./taskIndex.js";

interface NativeWriteStore {
  syncTaskMeta(requestJson: string): Promise<string>;
  syncTaskMetaAtGroupedTop(requestJson: string): Promise<string>;
  seedTaskMetaIfMissing(requestJson: string): Promise<string>;
  clearTaskUnreadIfMatches(requestJson: string): Promise<string>;
  deleteArchivedTask(requestJson: string): Promise<string>;
  updateTaskState(requestJson: string): Promise<string>;
  applyAgentPatch(requestJson: string): Promise<string>;
  cleanupDeletedGroupingReferences(): Promise<number>;
}

/**
 * A task reference with the resolved identity key.
 *
 * `workspaceKey` rather than a path, because the identity rule is applied by the caller: two paths
 * sharing an identity must not produce two scopes, and the engine cannot know which of the two is
 * authoritative without the caller's context.
 */
export interface TaskRef {
  workspaceKey: string;
  taskId: string;
}

export class TaskWriteRepository {
  readonly #store: NativeWriteStore;

  constructor(store: TaskIndexStore) {
    this.#store = store[NATIVE_STORE] as NativeWriteStore;
  }

  /**
   * Merges a protocol snapshot into the index.
   *
   * Six rules, each because a specific ordering of events breaks without it:
   *
   * - `updatedAt` is monotone, so a background refresh cannot move a task down the list.
   * - A user rename survives; the agent owns the session title, not the card's.
   * - A newer terminal status is not downgraded by a late `running` snapshot.
   * - `migrationSource` and `cronAutomationId` come from the existing row when the snapshot has
   *   none, which is the normal shape of a running snapshot.
   * - `target` is kept unless the snapshot explicitly carries one.
   * - A system group is entered only on **first acquisition**, so dragging a task out of the cron
   *   group does not drag it back.
   */
  async syncTaskMeta(params: {
    meta: unknown;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    /** Refresh the indexed text. Absent means **keep** the stored one, never clear it. */
    searchableText?: string;
    now?: number;
  }): Promise<unknown> {
    const raw = await this.#store.syncTaskMeta(JSON.stringify(flagsOf(params)));
    return JSON.parse(raw).meta;
  }

  /**
   * The merge plus the top-level admission, in **one** transaction.
   *
   * A reader between them would see a task with an order it does not have. The order is
   * initialised only the first time: a repeat snapshot must not re-assign the minimum
   * `sort_order`, or an older slow-finishing task would jump above a newer one and the final order
   * would depend on completion timing rather than on creation.
   */
  async syncTaskMetaAtGroupedTop(params: {
    meta: unknown;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
    now?: number;
  }): Promise<{ meta: unknown; initializedGroupedOrder: boolean }> {
    return JSON.parse(await this.#store.syncTaskMetaAtGroupedTop(JSON.stringify(flagsOf(params))));
  }

  /**
   * Writes a baseline only when the row does not exist. An existing row is returned as-is,
   * including a deleted one — a seed must not resurrect it.
   */
  async seedTaskMetaIfMissing(params: { workspaceKey: string; meta: unknown }): Promise<unknown> {
    return JSON.parse(
      await this.#store.seedTaskMetaIfMissing(
        JSON.stringify({ workspaceKey: params.workspaceKey, meta: params.meta }),
      ),
    );
  }

  /**
   * Clears the unread mark only on an exact match, and reports the current state either way.
   *
   * A mobile read request can arrive after the task's new final unread state, so the compare and
   * the write share one transaction — otherwise the old click would unconditionally clear the
   * subsequent `unreadAt`.
   */
  async clearTaskUnreadIfMatches(params: {
    workspaceKey: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: unknown; cleared: boolean }> {
    return JSON.parse(await this.#store.clearTaskUnreadIfMatches(JSON.stringify(params)));
  }

  /**
   * Writes the tombstone, but only for a task that is already archived.
   *
   * The archive check and the tombstone share a transaction, and the grouping references go with
   * them: a deleted task that still owns a group slot leaves task visibility and group ownership
   * permanently at odds. A missing, deleted or un-archived task returns `null` rather than an error
   * — the card's delete is idempotent from the caller's side.
   */
  async deleteArchivedTask(ref: TaskRef, now: number = Date.now()): Promise<unknown | null> {
    const raw = await this.#store.deleteArchivedTask(JSON.stringify({ ...ref, now }));
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Patches a task's state.
   *
   * Every field is optional and an absent one means **leave alone** — including for `unreadAt` and
   * `lastError`, where the nested `Option` is what distinguishes "not mentioned" from "clear it".
   */
  async updateTaskState(params: {
    workspaceKey: string;
    taskId: string;
    patch: {
      title?: string;
      titleOverridden?: boolean;
      model?: string;
      updatedAt?: number;
      unreadAt?: number | null;
      status?: unknown;
      lastError?: unknown;
      target?: unknown;
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
    };
    now?: number;
  }): Promise<unknown> {
    return JSON.parse(
      await this.#store.updateTaskState(
        JSON.stringify({ ...params, now: params.now ?? Date.now() }),
      ),
    );
  }

  /**
   * Applies an agent-authored patch.
   *
   * `null` for a missing or deleted task, which is normal rather than a fault: a user can delete a
   * task before its last snapshot arrives. The title is accepted only when the user has **not**
   * overridden it, so a background status refresh cannot wash away a manual rename.
   */
  async applyAgentPatch(params: {
    workspaceKey: string;
    taskId: string;
    title?: string;
    status?: unknown;
    lastError?: unknown;
    target?: unknown;
    updatedAt?: number;
  }): Promise<unknown | null> {
    const raw = await this.#store.applyAgentPatch(JSON.stringify(params));
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * The opening repair: drops the grouping rows of every deleted task.
   *
   * A crash between a tombstone and its grouping delete would otherwise leave a deleted task owning
   * a group slot forever. Returns how many tasks were repaired.
   */
  async cleanupDeletedGroupingReferences(): Promise<number> {
    return this.#store.cleanupDeletedGroupingReferences();
  }
}

/** The shared flag projection both sync methods take. */
const flagsOf = (params: {
  meta: unknown;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  titleOverridden?: boolean;
  searchableText?: string;
  now?: number;
}): Record<string, unknown> => ({
  meta: params.meta,
  pinned: params.pinned,
  archived: params.archived,
  deleted: params.deleted,
  titleOverridden: params.titleOverridden,
  searchableText: params.searchableText,
  now: params.now ?? Date.now(),
});

export function taskWriteRepository(store: TaskIndexStore): TaskWriteRepository {
  return new TaskWriteRepository(store);
}
