import type { SessionTaskType } from "@zcode/contracts";

/**
 * Session-type projection for the left task list.
 *
 * List visibility cannot be substituted with a hierarchical query on `parent_id is null`: primary
 * tasks that have a parent, such as an explicit fork, would be filtered out by the cold-start seeding after a CLI restart. Visibility has to
 * be decided by taskType, while side conversations, subagents and workflow children keep being carried by their own dedicated projections.
 */
export const TASK_LIST_SESSION_TYPES = [
  "interactive",
  "fork",
  "workflow_parent",
] as const satisfies readonly SessionTaskType[];

const TASK_LIST_SESSION_TYPE_SET = new Set<SessionTaskType>(
  TASK_LIST_SESSION_TYPES,
);

export function isTaskListSessionType(
  taskType: SessionTaskType | undefined,
): boolean {
  return TASK_LIST_SESSION_TYPE_SET.has(taskType ?? "interactive");
}
