// ============================================================
// "Configuration" on the details page
// ============================================================
// Detached from WorkflowRunSidePane.tsx (max-lines gate): after the elastic layer host, switches and anchors, and Apply are accepted
// "The panel follows the workflow" - as soon as the new run enters the projection, replace the tab with the new run's tab (same position, same name,
// Do not expand a collapsed sidebar). What we are waiting for is the fact that a new run appears in the projection, not a timeout.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionConfigState, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  useWorkflowRunSettingsPopoverState,
  type WorkflowRunSettingsAccepted,
  type WorkflowRunSettingsHost,
} from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import {
  isWorkflowRunConfigurable,
  workflowSessionModelOf,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Workspace scope of the run tab: carried over as-is when opening another tab (actor, scripts,
 * artifacts, successors).
 */
export function workflowRunTabScope(
  tab: Pick<WorkflowRunSidePaneTab, "workspacePath" | "workspaceIdentity" | "remoteSessionId">,
): Pick<
  OpenScopedWorkflowRunSideTabRequest,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId"
> {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
  };
}

export function useWorkflowRunPaneSettings({
  enabled,
  onOpenWorkflowRun,
  run,
  runs,
  sendCommand,
  sessionConfig,
  tab,
}: {
  /** Gradual rollout gate (the same gate as Resume). */
  enabled: boolean;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  run: WorkflowRunState | undefined;
  runs: readonly WorkflowRunState[] | undefined;
  sendCommand: ReturnType<typeof useV4Conversation>["sendCommand"];
  sessionConfig: SessionConfigState | undefined;
  tab: WorkflowRunSidePaneTab;
}) {
  const configurable = enabled && isWorkflowRunConfigurable(run);
  const popover = useWorkflowRunSettingsPopoverState();
  // run becomes unconfigurable (completed, replaced) when the pop-up layer is open: the pop-up layer is uninstalled, and the switch must be turned off - otherwise run will return to configurable
  // In this state, the elastic layer will pop up by itself. setOpen(false) has no operation when it is closed and will not form an update loop.
  const { setOpen } = popover;
  useEffect(() => {
    if (!configurable) setOpen(false);
  }, [configurable, setOpen]);
  const sessionModel = useMemo(() => workflowSessionModelOf(sessionConfig), [sessionConfig]);
  const host = useMemo<WorkflowRunSettingsHost>(
    () => ({
      ...workflowRunTabScope(tab),
      ...(sessionModel === undefined ? {} : { sessionModel }),
      // Similar to Stop / Resume: without baseRevision, workId ≡ runId.
      apply: (change) =>
        sendCommand(
          createCommandEnvelope({
            type: "amendWorkflowRunSettings",
            payload: { workId: tab.runId, ...change },
            sessionId: tab.parentSessionId,
          }),
        ),
    }),
    [
      sendCommand,
      sessionModel,
      tab.parentSessionId,
      tab.remoteSessionId,
      tab.runId,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );

  // Follow: The new run may not already be in the projection at the moment it is accepted (run-started arrives later), so write it down first and change tabs when it appears.
  const [follow, setFollow] = useState<WorkflowRunSettingsAccepted | undefined>(undefined);
  // Revisions that take effect locally (only the concurrency limit is changed, and run is still running) have no successors.
  // The runId in the result is the tab itself - there is nothing to follow. Note that it will only request to replace the tab with itself.
  const onAccepted = useCallback(
    (accepted: WorkflowRunSettingsAccepted) => {
      if (accepted.runId !== tab.runId) setFollow(accepted);
    },
    [tab.runId],
  );
  const successorArrived =
    follow !== undefined && (runs ?? []).some((candidate) => candidate.runId === follow.runId);
  useEffect(() => {
    if (follow === undefined || !successorArrived) return;
    setFollow(undefined);
    onOpenWorkflowRun?.({
      ...workflowRunTabScope(tab),
      parentSessionId: tab.parentSessionId,
      toolCallId: follow.toolCallId,
      runId: follow.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
      replaceRunId: tab.runId,
    });
  }, [
    follow,
    onOpenWorkflowRun,
    successorArrived,
    tab.parentSessionId,
    tab.remoteSessionId,
    tab.runId,
    tab.workflowName,
    tab.workspaceIdentity,
    tab.workspacePath,
  ]);

  return {
    configurable,
    host,
    onAccepted,
    popover,
  };
}
