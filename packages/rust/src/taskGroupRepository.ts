/**
 * `@zcode/rust/task-index` — task groups.
 *
 * Spec: docs/specs/rust-native-task-index.md §23 (batch B).
 *
 * These five methods are `taskIndexRepo`'s group CRUD plus the top-level admission check. There is
 * **no JavaScript fallback**: `loadNative` throws when the binary is missing.
 */
import { NATIVE_STORE, type NativeStore, type TaskIndexStore } from "./taskIndex.js";

/** Mirrors `ZCodeTaskGroup`. */
export interface TaskGroup {
  id: string;
  title: string;
  color: string;
  createdAt: number;
  updatedAt: number;
}

/** The seven colours a group may have. Anything else is refused on write. */
export const TASK_GROUP_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;

export type TaskGroupColor = (typeof TASK_GROUP_COLORS)[number];

/** The colour a group gets when none is chosen, and when a stored value is outside the set. */
export const DEFAULT_TASK_GROUP_COLOR: TaskGroupColor = "gray";

export class TaskGroupRepository {
  /** One native object, so one connection and one migration ledger. */
  readonly #store: NativeStore;

  constructor(store: TaskIndexStore) {
    this.#store = store[NATIVE_STORE];
  }

  /**
   * Creates a group and puts it at the **top** of the current list.
   *
   * The id is the caller's, not the engine's: a test that needs a stable id should not have to read
   * a generated one back out of the result. A blank title falls back to `"New Group"` rather than
   * being stored empty.
   */
  async createTaskGroup(params: {
    groupId: string;
    title?: string;
    color?: TaskGroupColor;
    now?: number;
  }): Promise<TaskGroup> {
    return JSON.parse(
      await this.#store.createTaskGroup(
        JSON.stringify({
          groupId: params.groupId,
          title: params.title,
          color: params.color,
          now: params.now ?? Date.now(),
        }),
      ),
    ) as TaskGroup;
  }

  /** Renames a group. A missing group is an error, not a silent no-op. */
  async renameTaskGroup(params: { groupId: string; title: string; now?: number }): Promise<TaskGroup> {
    return JSON.parse(
      await this.#store.renameTaskGroup(
        JSON.stringify({
          groupId: params.groupId,
          title: params.title,
          now: params.now ?? Date.now(),
        }),
      ),
    ) as TaskGroup;
  }

  /**
   * Recolours a group.
   *
   * The colour is validated **before** the write, so a bad value cannot be stored and then read
   * back as the default — which would look like it worked.
   */
  async updateTaskGroupColor(params: {
    groupId: string;
    color: TaskGroupColor;
    now?: number;
  }): Promise<TaskGroup> {
    return JSON.parse(
      await this.#store.updateTaskGroupColor(
        JSON.stringify({
          groupId: params.groupId,
          color: params.color,
          now: params.now ?? Date.now(),
        }),
      ),
    ) as TaskGroup;
  }

  /**
   * Deletes a group, and its top-level order row with it.
   *
   * The two go in one transaction: an order row left behind renders a node for a group that no
   * longer exists.
   */
  async deleteTaskGroup(groupId: string): Promise<void> {
    await this.#store.deleteTaskGroup(groupId);
  }

  /**
   * Admits a task to the top of the grouped view, and reports whether this call was the one that
   * did it.
   *
   * `true` **only the first time**. A deleted, archived or pinned task is never admitted, nor is
   * one that already has a membership or an order row. That is what stops a repeat snapshot from
   * re-assigning the minimum sort order and putting an older, slow-finishing task above a newer one
   * — the final order would then depend on completion timing rather than on creation.
   */
  async initializeGroupedTaskAtTop(params: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    now?: number;
  }): Promise<boolean> {
    return this.#store.initializeTaskAtTop(
      JSON.stringify({
        workspaceKey: params.workspaceKey,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? null,
        taskId: params.taskId,
        now: params.now ?? Date.now(),
      }),
    );
  }
}

export function taskGroupRepository(store: TaskIndexStore): TaskGroupRepository {
  return new TaskGroupRepository(store);
}
