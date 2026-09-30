import type { ConversationRow, WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";

/**
 * The ins and outs of direct launch: scope, description, actual participation
 * "You start from the workflow hub" moment. Only the hub-started run has it - it hangs on the start wheel turnHeader / userInput line
 * `workflowLaunch` metadata (same toolCallId); the run initiated by the tool path cannot find this copy in the line window and returns
 * undefined, the side panel does not have this section. turnHeader takes priority (live projection authority, `startedAt` is the starting time), falls back to the user
 * The same copy on the visible line (cold recovery hydration is also written on the userInput line).
 */
interface WorkflowLaunchProvenance {
  meta: WorkflowLaunchMeta;
  startedAt?: number;
}

export function resolveWorkflowLaunchProvenance(
  rows: readonly ConversationRow[] | undefined,
  toolCallId: string,
): WorkflowLaunchProvenance | undefined {
  let fallback: WorkflowLaunchProvenance | undefined;
  for (const row of rows ?? []) {
    if (row.kind === "turnHeader" && row.workflowLaunch?.toolCallId === toolCallId) {
      return { meta: row.workflowLaunch, startedAt: row.startedAt };
    }
    if (
      fallback === undefined &&
      row.kind === "userInput" &&
      row.workflowLaunch?.toolCallId === toolCallId
    ) {
      fallback = { meta: row.workflowLaunch, startedAt: row.createdAt };
    }
  }
  return fallback;
}
