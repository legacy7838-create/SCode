import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowRunDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  buildWorkflowRunDirectory,
  workflowRunDirectoryRefreshKey,
  type WorkflowRunDirectoryRow,
} from "@/v4/workflowRunDirectoryModel.js";

/**
 * The workflow run directory for a conversation. The three-step shape is literally isomorphic to the subagent directory: task list footer row → this page → `workflow-run`
 * Details page.
 *
 * **Line only renders journal summary**: It is found that the query originally returns `pending`/
 * `running`, so both paragraphs are included; the number of steps and duration of active run are on the task list (just above the line you clicked) and on the details page,
 * This page does not duplicate that live status.
 *
 * But it **does** order a projection - only as a freshness trigger. first edition press
 * "No session renting, no projection reservation" is implemented, so there is no signal on the page: the hook is closed after the first answer, and the finished run remains forever
 * "Running". Lease + Projection This set of wiring is literally the same as `SubagentDirectorySidePane`, over there is
 * `subagents.revision`; the key here needs to be more selective (see `workflowRunDirectoryRefreshKey`), because the dwf
 * `revision` is raised every time a node event comes.
 */
function buildWorkflowRunDirectoryOpenRequest(
  tab: WorkflowRunDirectorySidePaneTab,
  row: WorkflowRunDirectoryRow,
): OpenScopedWorkflowRunSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    parentSessionId: tab.parentSessionId,
    runId: row.runId,
    toolCallId: row.toolCallId,
    // The display name is frozen into the tab only for the title pane when the shadow is absent (see the comments for WorkflowRunSidePaneTab).
    ...(row.label ? { workflowName: row.label } : {}),
  };
}

const DirectoryRow = memo(function DirectoryRow({
  onOpen,
  row,
}: {
  onOpen: (row: WorkflowRunDirectoryRow) => void;
  row: WorkflowRunDirectoryRow;
}) {
  const { intl } = useZCodeIntl();
  // The unnamed run uses the same name as the tool card/task list, and the runId is never brought to the table.
  const name = row.label ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const statusLabel = intl.formatMessage({
    id: `chat.toolCall.workflow.run.status.${row.status}`,
  });
  const stopReason = readWorkflowRunStopReason(row);

  return (
    <button
      type="button"
      data-run-id={row.runId}
      data-run-status={row.status}
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      onClick={() => onOpen(row)}
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
    >
      {/* States always have words (next line), dots are just redundant channels. */}
      <span
        aria-hidden="true"
        className={cn("mt-2 size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[row.status])}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{name}</span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-ui-sm">
          <span className={cn("shrink-0", RUN_STATUS_TEXT[row.status])}>{statusLabel}</span>
          {/*
            The half sentence of "Why is it worth going back to read": the stopped line shows the reason for stopping, and the errored line shows the failureCode.
            If the old server does not provide a reason for stopped, it will fall back to failureCode.
          */}
          {stopReason ? (
            <span className="min-w-0 truncate text-foreground-subtle">
              · {intl.formatMessage({ id: workflowRunStopReasonMessageId(stopReason) })}
            </span>
          ) : (row.status === "errored" || row.status === "stopped") && row.failureCode ? (
            <span className="min-w-0 truncate text-foreground-subtle">· {row.failureCode}</span>
          ) : null}
        </span>
      </span>
      {row.updatedAt === undefined ? null : (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(row.updatedAt, intl)}
        </span>
      )}
      <ChevronRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-subtlest" />
    </button>
  );
});

function DirectorySection({
  countTestId,
  emptyLabel,
  emptyTestId,
  onOpen,
  rows,
  section,
  title,
}: {
  countTestId: string;
  emptyLabel: string;
  emptyTestId: string;
  onOpen: (row: WorkflowRunDirectoryRow) => void;
  rows: readonly WorkflowRunDirectoryRow[];
  section: "running" | "ended";
  title: string;
}) {
  return (
    <section
      data-workflow-directory-section={section}
      className={section === "ended" ? "mt-5" : ""}
    >
      <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
        {title} · <span data-testid={countTestId}>{rows.length}</span>
      </h3>
      {rows.length > 0 ? (
        rows.map((row) => <DirectoryRow key={row.runId} row={row} onOpen={onOpen} />)
      ) : (
        <p data-testid={emptyTestId} className="px-3 py-3 text-ui-base text-foreground-subtlest">
          {emptyLabel}
        </p>
      )}
    </section>
  );
}

const WorkflowRunDirectoryContents = memo(function WorkflowRunDirectoryContents({
  onOpenWorkflowRun,
  tab,
}: {
  onOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  tab: WorkflowRunDirectorySidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  // The pane is opened from a live conversation, so `live: true` is true; `limit` is shared with the task list count
  // With the same constant, once the two depths are different, they are equal to two sets of calibers.
  //
  // `refreshKey` is the **all** basis for whether this page will be updated by itself (actual test bug: the finished run will not be moved to
  // "It's over" because no signal was received here at the beginning). The projection here is just the trigger, not the source: the row still only renders
  // The journal summary, the number of steps and the duration of the run are still only available in the task list and details page. The shape of the key (number of runs + number of settled)
  // Let "one more run / finish one run" be retried once, but the node-level progress will not be retried - see the comment in the model.
  const summaries = useWorkflowRunJournalSummaries({
    sessionId: tab.parentSessionId,
    live: true,
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(projection.snapshot?.workflowRuns?.runs),
  });
  const directory = useMemo(() => buildWorkflowRunDirectory(summaries), [summaries]);
  const handleOpen = (row: WorkflowRunDirectoryRow) => {
    onOpenWorkflowRun(buildWorkflowRunDirectoryOpenRequest(tab, row));
  };
  // Three types of "no lines on the screen" must be distinguished: no lines (summary is absent)/no lines at all/just a certain paragraph empty.
  const isUnavailable = summaries === null;
  const isEmpty = !isUnavailable && directory.running.length + directory.ended.length === 0;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "workflowDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {isUnavailable ? (
          // Not an error message: the most common reason for not getting the list is that the runtime where this dialogue is located does not provide an enumeration surface.
          <p
            data-testid="workflow-run-directory-unavailable"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "workflowDirectory.unavailable" })}
          </p>
        ) : isEmpty ? (
          <p
            data-testid="workflow-run-directory-empty"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "workflowDirectory.empty" })}
          </p>
        ) : (
          <>
            <DirectorySection
              section="running"
              title={intl.formatMessage({ id: "workflowDirectory.running" })}
              rows={directory.running}
              countTestId="workflow-run-directory-running-count"
              emptyTestId="workflow-run-directory-running-empty"
              emptyLabel={intl.formatMessage({ id: "workflowDirectory.runningEmpty" })}
              onOpen={handleOpen}
            />
            <DirectorySection
              section="ended"
              title={intl.formatMessage({ id: "workflowDirectory.ended" })}
              rows={directory.ended}
              countTestId="workflow-run-directory-ended-count"
              emptyTestId="workflow-run-directory-ended-empty"
              emptyLabel={intl.formatMessage({ id: "workflowDirectory.endedEmpty" })}
              onOpen={handleOpen}
            />
            {/* The truncation must be clearly stated: "That's it" when the page is exactly full is a lie, and the query has no cursor to turn. */}
            {directory.truncated ? (
              <p
                data-testid="workflow-run-directory-truncated"
                className="px-3 pt-4 text-ui-sm text-foreground-subtlest"
              >
                {intl.formatMessage(
                  { id: "workflowDirectory.truncated" },
                  { count: String(WORKFLOW_RUN_DIRECTORY_LIMIT) },
                )}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
});

export const WorkflowRunDirectorySidePane = memo(function WorkflowRunDirectorySidePane({
  onOpenWorkflowRun,
  tab,
}: {
  onOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  tab: WorkflowRunDirectorySidePaneTab;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowRunDirectoryContents tab={tab} onOpenWorkflowRun={onOpenWorkflowRun} />
    </V4PaneConversationProvider>
  );
});
