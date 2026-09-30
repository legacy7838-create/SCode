import { ModelRequestSessionType, ModelRetryBudget, type SessionTaskType } from "@zcode/contracts";

/**
 * Model requests are coarsely classified by their host session; a workflow child is not a subagent, so server-side statistics uniformly count as other.
 */
export function resolveModelRequestSessionTypeFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRequestSessionType {
  if (taskType === "subagent_child") return ModelRequestSessionType.Subagent;
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRequestSessionType.Other;
  }
  return ModelRequestSessionType.Main;
}

/**
 * Model requests of a workflow actor (including the actor of a nested workflow) get an **unbounded** retry
 * budget: a model error is never a workflow error, and the runner recovers it with best effort. All other
 * sessions (main session, subagent, fork…) keep the adapter's default budget.
 */
export function resolveModelRetryBudgetFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRetryBudget {
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRetryBudget.Unbounded;
  }
  return ModelRetryBudget.Default;
}
