import type { WorkspacePurpose, ZCodeTaskMeta } from "@zcode/shared";

export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ZCodeTaskListQuery {
  kind: ZCodeTaskListKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type ZCodeTaskListItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ZCodeTaskListResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type ZCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface ZCodeTaskGroup {
  id: string;
  title: string;
  color: ZCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ZCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ZCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: ZCodeGroupedTaskRef };

export type ZCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: ZCodeTaskGroup;
      tasks: ZCodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: ZCodeTaskListItem;
      sortOrder?: number;
    };

export interface ZCodeGroupedTaskView {
  nodes: ZCodeGroupedTaskViewNode[];
}

export interface ZCodeGroupedTaskViewQuery {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped original structure (without joining tasks table)──
// After the task data source of the grouped view is moved to sessions-index, the server only provides the grouping structure.
// (task_groups / task_group_members / task_group_view_node_orders),
// The client joins the sessions-index session.

/** Group member reference (without task meta; task content comes from sessions-index). */
export interface ZCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** workspaceKey in service terms (resolveWorkspaceKey: identity ?? path), the join matching key. */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = sort_order has not been persisted yet (newly joined group); the client backfills an in-memory order by addedAt descending. */
  sortOrder: number | null;
  addedAt: number;
}

/** Top-level node ordering (task_group_view_node_orders, with node_key already resolved into a structured reference). */
export type ZCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface ZCodeGroupedTaskViewStructure {
  /** Groups already filtered by workspaceScopes visibility (a bootstrap workspace group is only visible in its own workspace). */
  groups: ZCodeTaskGroup[];
  /** All group members (including members of invisible groups — the top-level exclusion rules need a complete picture). */
  members: ZCodeGroupedTaskViewStructureMember[];
  topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[];
}

export interface ZCodeGroupedTaskViewOrderInput {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  topLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: ZCodeGroupedTaskRef[];
  }>;
}

export interface ZCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
