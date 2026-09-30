import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunArtifactSummary,
  WorkflowRunPendingQuestion,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowSubagentModelCardLabel } from "@/components/workflow-timeline/subagent-model-label.js";
import { workflowSummaryParts } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowRunArtifactsSection } from "@/app-shell/WorkflowRunArtifactsSection.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { WorkflowRunProvenance } from "@/app-shell/WorkflowRunProvenance.js";
import {
  WorkflowRunResultSections,
  WorkflowRunStatusHeader,
} from "@/app-shell/WorkflowRunSidePaneSections.js";
import {
  useWorkflowRunPaneSettings,
  workflowRunTabScope,
} from "@/app-shell/useWorkflowRunPaneSettings.js";
import { WorkflowRunSettingsPopover } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { resolveWorkflowLaunchProvenance } from "@/app-shell/workflowRunLaunchProvenance.js";
import {
  describeWorkflowRunActionRejection,
  workflowRunActionRejectionMessageId,
  type WorkflowRunAction,
  type WorkflowRunActionRejection,
} from "@/app-shell/workflowRunActionRejection.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  isWorkflowRunCancellable,
  isWorkflowRunResumable,
  workflowRunResultView,
  type WorkflowActorInstance,
} from "@/app-shell/workflowRunPanel.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useWorkflowRunArtifacts } from "@/hooks/useWorkflowRunArtifacts.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  buildWorkflowGraphByToolCallId,
  resolveWorkflowRunGraph,
} from "@/v4/workflowRunCardJoin.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * A stably referenced empty list: the pendingQuestions key comes and goes **back and forth** (the
 * whole key disappears as soon as a question is answered), so the empty reference has to be stable
 * — otherwise the memoized child re-renders on every render for nothing.
 */
const EMPTY_QUESTIONS: readonly WorkflowRunPendingQuestion[] = [];
/**
 * Same reasoning. The `artifacts` key is absent when there are zero artifacts, and it is one of the
 * dependencies that makes the artifacts hook re-read the journal.
 */
const EMPTY_ARTIFACTS: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowRunContent = memo(function WorkflowRunContent({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** "Superseded by run X" → the successor run's details tab. */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** A script row on the spine → the script transcript tab, positioned at that step. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  // The details page resubscribes to the projection of the parent session (according to PlanDetailSidePane): the running state is the authoritative projection of the parent session,
  // Not a local query cache for this panel.
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // Open the workspace scope in the request (actor/script/product/successor tabs all carry the same copy).
  const { remoteSessionId, workspaceIdentity, workspacePath } = tab;
  const tabScope = useMemo(
    () => workflowRunTabScope({ remoteSessionId, workspaceIdentity, workspacePath }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );

  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  // The successor (`run.supersededBy`) must be in the projection and have its own initiating row id: the toolCallId of the open request is
  // Find the key to the picture on the details page. If you fill it in incorrectly, the subsequent details page will show "This picture does not exist in the history."
  const successor = useMemo(() => {
    const supersededBy = run?.supersededBy;
    if (supersededBy === undefined) return undefined;
    const candidate = snapshot?.workflowRuns?.runs.find((item) => item.runId === supersededBy);
    return candidate?.toolCallId === undefined ? undefined : candidate;
  }, [run?.supersededBy, snapshot?.workflowRuns]);
  const handleOpenSuccessor = useCallback(() => {
    if (successor?.toolCallId === undefined) return;
    onOpenWorkflowRun?.({
      ...tabScope,
      parentSessionId: tab.parentSessionId,
      toolCallId: successor.toolCallId,
      runId: successor.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
    });
  }, [onOpenWorkflowRun, successor, tab.parentSessionId, tab.workflowName, tabScope]);

  // Press ** to initiate toolCallId** for static images: with the run card at the end of the wheel,
  // Script transcript the same table - CreateWorkflow tool row or directly launch the metadata of the wheel, whoever hangs the figure is the same. The row window is
  // Bounded, it is normal that the initiating line cannot be found in the old dialogue, and it is not an error - there is no picture to give at this time.
  // The revised run from "Configuration" borrows the predecessor's graph before setting the wheel (see resolveWorkflowRunGraph for rules and reasons).
  const graph = useMemo<WorkflowCausalityGraphData | undefined>(
    () =>
      resolveWorkflowRunGraph(
        buildWorkflowGraphByToolCallId(snapshot?.rows.window),
        tab.toolCallId,
        snapshot?.workflowRuns?.runs,
      ),
    [snapshot?.rows.window, snapshot?.workflowRuns, tab.toolCallId],
  );

  // The ins and outs of direct launch: scope, description, actual participation
  // "Initiated by you from the workflow hub." This section is only present for runs initiated by the hub; runs initiated by the toolpath do not have this section.
  const provenance = useMemo(
    () => resolveWorkflowLaunchProvenance(snapshot?.rows.window, tab.toolCallId),
    [snapshot?.rows.window, tab.toolCallId],
  );

  // One model, three consumption places: lists and summary lines start from it.
  const model = useMemo(
    () => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run)),
    [graph, run],
  );
  // Sub-agent model: The first line of the status header no longer places the chip.
  // The model name becomes the first paragraph of the summary line - this line is originally "the numbers of this run". Strength and specification string into tooltip.
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    tab.workspacePath,
    tab.workspaceIdentity,
  );
  const subagentModel = useMemo(
    () =>
      workflowSubagentModelCardLabel(run?.subagentModel, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(subagentModelProviderName === undefined
          ? {}
          : { providerName: subagentModelProviderName }),
      }),
    [intl, run?.subagentModel, subagentModelProviderName],
  );
  const summaryParts = useMemo(
    () =>
      model === undefined || run === undefined
        ? undefined
        : workflowSummaryParts(
            intl.formatMessage.bind(intl),
            model,
            run,
            subagentModel === undefined ? {} : { subagentModelName: subagentModel.name },
          ),
    [intl, model, run, subagentModel],
  );

  const cancellable = isWorkflowRunCancellable(run);
  // Cancel/Resume the most recent rejection. run status
  // Once the prompt changes (really canceled/restored/cold replay adds settlement), the prompt will no longer apply and will be cleared as the status changes - it is a "change" rather than
  // "Different from then": When the status returns to its original value, the old prompt should not appear again.
  const [rejection, setRejection] = useState<WorkflowRunActionRejection | undefined>(undefined);
  const runStatus = run?.status;
  useEffect(() => {
    setRejection(undefined);
  }, [runStatus]);
  const recordAck = useCallback(
    (action: WorkflowRunAction, ack: Parameters<typeof describeWorkflowRunActionRejection>[1]) => {
      const next = describeWorkflowRunActionRejection(action, ack);
      setRejection(next);
      if (next !== undefined) {
        logger.warn(`[workflow-run] ${action} rejected`, {
          reasonCode: ack.reasonCode,
          runId: tab.runId,
          status: ack.status,
        });
      }
    },
    [tab.runId],
  );
  const rejectionView = useMemo(() => {
    if (rejection === undefined) return undefined;
    return {
      text: intl.formatMessage(
        { id: workflowRunActionRejectionMessageId(rejection) },
        { code: rejection.code },
      ),
      ...(rejection.message === undefined ? {} : { detail: rejection.message }),
    };
  }, [intl, rejection]);

  const handleCancel = useCallback(() => {
    // There is only one path for cancellation: the existing v4 cancelBackgroundWork {workId ≡ runId}.
    void sendCommand(
      createCommandEnvelope({
        type: "cancelBackgroundWork",
        payload: { workId: tab.runId },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => recordAck("cancel", ack));
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId]);

  // Resume Availability read-only projection's `resumable` status bit:
  // After restarting, the projection is completed by CLI cold replay, and the journal summary will not be checked here.
  //
  // Stack another grayscale gate: the existing run will be rendered as usual
  // ——There are many status headers, timelines, and products. Only Resume is put away, because pressing it will actually start an engine.
  // When the snapshot is not ready, enabled is false and is handled as a miss: it would be better for the button to appear late than to give a button that disappears at any time.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  const resumable = isWorkflowRunResumable(run) && dynamicWorkflowEnabled;
  // "Configuration": the same grayscale gate as Resume;
  // After being accepted, the panel follows the workflow to the new run (useWorkflowRunPaneSettings).
  const settings = useWorkflowRunPaneSettings({
    enabled: dynamicWorkflowEnabled,
    run,
    runs: snapshot?.workflowRuns?.runs,
    sendCommand,
    sessionConfig: snapshot?.sessionId === tab.parentSessionId ? snapshot?.config : undefined,
    tab,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
  });
  const handleResume = useCallback(() => {
    // resume is a new v4 command (without baseRevision, similar to cancel); workId ≡ runId.
    // `name` is the topic of completion notification after restoration - after restarting, the original tool input is unavailable, and the display name on the tab is the only remaining source.
    void sendCommand(
      createCommandEnvelope({
        type: "resumeWorkflowRun",
        payload: {
          workId: tab.runId,
          ...(tab.workflowName?.trim() ? { name: tab.workflowName.trim() } : {}),
        },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => {
      recordAck("resume", ack);
      // After accepting, the live projection will turn back to running as run-started, the reducer will then peel off the resumable, and the button will naturally collapse.
    });
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId, tab.workflowName]);

  const handleOpenActor = useCallback(
    (instance: WorkflowActorInstance) => {
      onOpenWorkflowActorSession?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        ...(instance.sessionId ? { actorSessionId: instance.sessionId } : {}),
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        ...(instance.name ? { actorName: instance.name } : {}),
      });
    },
    [onOpenWorkflowActorSession, tab.parentSessionId, tab.runId, tabScope],
  );

  // Script transcript: Isomorphic to actor, only the stage id is handed over, and the scope and run identities are filled in here.
  const handleOpenWorkspace = useCallback(
    (phaseId: string) => {
      onOpenWorkflowWorkspace?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        toolCallId: tab.toolCallId,
        runId: tab.runId,
        ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
        phaseId,
      });
    },
    [
      onOpenWorkflowWorkspace,
      tab.parentSessionId,
      tab.runId,
      tab.toolCallId,
      tab.workflowName,
      tabScope,
    ],
  );

  // Drop point: re-drop every time it is opened - `openedAt` is refreshed when it is opened, so click again on the same site
  // The key changes and the list is dropped again.
  const landing = useMemo(
    () =>
      tab.focusPhaseId === undefined
        ? undefined
        : { key: `${tab.focusPhaseId}@${tab.openedAt ?? 0}`, phaseId: tab.focusPhaseId },
    [tab.focusPhaseId, tab.openedAt],
  );

  // product. Live projection only carries the latest version of metadata, spec and version history are in
  // in the journal, so both sides of the hook are read - when `run` is not in the projection (cold recovery / eliminated by the 8-run upper limit)
  // In the absence of `live`, the entire list goes to journal.
  const { artifacts } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { live: run.artifacts ?? EMPTY_ARTIFACTS }),
  });
  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      // The card only sends the intention (which product), and the session and workspace identities are completed here - with actor transcript
      // Same argument: cards are not scope aware. **Without version number**: Open it to get the latest version.
      //
      // This list is a merged view of live projection + journal, so both the `contentType` and `sourcePath` keys are in:
      // The former allows the host to directly open the html product into a browser tab, while the latter saves the host from checking the journal again.
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
      });
    },
    [artifacts, onOpenWorkflowArtifact, tab.parentSessionId, tab.runId, tabScope],
  );

  const result = workflowRunResultView(run);
  const pendingQuestions = run?.pendingQuestions ?? EMPTY_QUESTIONS;
  const runTitle = tab.workflowName?.trim() || intl.formatMessage({ id: "sidePane.workflowRun" });

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-workflow-run-id={tab.runId}
      data-workflow-run-status={run?.status ?? "absent"}
    >
      <WorkflowRunStatusHeader
        cancellable={cancellable}
        configureOpen={settings.popover.open}
        onCancel={handleCancel}
        {...(settings.configurable ? { onConfigureFrom: settings.popover.toggleFrom } : {})}
        {...(onOpenWorkflowRun === undefined || successor === undefined
          ? {}
          : { onOpenSuccessor: handleOpenSuccessor })}
        onResume={handleResume}
        {...(rejectionView === undefined ? {} : { rejection: rejectionView })}
        resumable={resumable}
        run={run}
        {...(subagentModel === undefined ? {} : { subagentModel })}
        summaryParts={summaryParts}
        title={runTitle}
        usage={run?.usage}
      />

      {run === undefined || !settings.configurable ? null : (
        <WorkflowRunSettingsPopover
          anchorRef={settings.popover.anchorRef}
          host={settings.host}
          onAccepted={settings.onAccepted}
          onOpenChange={settings.popover.setOpen}
          open={settings.popover.open}
          run={run}
        />
      )}

      {provenance === undefined ? null : (
        <WorkflowRunProvenance
          meta={provenance.meta}
          {...(subagentModelProviderName === undefined
            ? {}
            : { providerName: subagentModelProviderName })}
          {...(provenance.startedAt === undefined ? {} : { startedAt: provenance.startedAt })}
        />
      )}

      <WorkflowRunResultSections result={result} />

      {/*
       * Phase checklist: the timeline reads as a vertical checklist, with escalation questions
       * hanging under the row of whoever raised them. When the graph is unavailable (older
       * conversations cannot page back to the originating row) it reads out "graph unavailable"
       * once.
       */}
      {graph !== undefined && model !== undefined ? (
        <WorkflowRunPhaseList
          graph={graph}
          model={model}
          pendingQuestions={pendingQuestions}
          run={run}
          {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenActor: handleOpenActor })}
          {...(onOpenWorkflowWorkspace === undefined
            ? {}
            : { onOpenWorkspace: handleOpenWorkspace })}
          {...(landing === undefined ? {} : { landing })}
        />
      ) : (
        <p
          className="flex-1 px-4 py-3 text-ui-xs text-foreground-subtle"
          data-testid="workflow-run-graph-unavailable"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.graph.unavailable" })}
        </p>
      )}

      {/*
       * Artifacts section: what scripts hand to the **user** through `artifact.*`. The last section
       * of the pane, expanded by default — it is the deliverable of this run and the most common
       * reason a user opens this pane at all. The whole section is absent when there are no
       * artifacts; failed and cancelled runs render the same way (a run that died at step 12 may
       * still have delivered a pdf). The `report` entries, the event log and the script source
       * sections have been removed: they are technical detail, and their readers are the model and
       * the CLI.
       */}
      {artifacts.length === 0 ? null : (
        <WorkflowRunArtifactsSection
          artifacts={artifacts}
          runId={tab.runId}
          sessionId={tab.parentSessionId}
          {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
        />
      )}
    </div>
  );
});

/**
 * The details page of a workflow run.
 *
 * The details page carries usage, controls and deliverables; the graph itself went back to the tool
 * card in the chat area, so what is drawn here is a vertical checklist over the same timeline
 * model. It does **not** reproduce the card's bounded display — everything outside the graph reads
 * the authoritative projection from `workflowRuns`, and the artifact list reads the journal
 * directly.
 *
 * The pane only presents what the **user** needs. The `report` entries, the event log and the
 * script source sections have been removed — they are technical detail whose readers are the model
 * and the CLI, not the person sitting in front of this pane. The journal's read surface is
 * untouched (event queries and report rows are all still there); only their display here was
 * removed.
 */
export const WorkflowRunSidePane = memo(function WorkflowRunSidePane({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  /** A subagent row → the actor transcript tab. The default case means the row is not clickable. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** An artifact card → the full-size view tab. The default case means the card is not clickable. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /**
   * "Superseded by run X" → the successor run's details tab. The default case means that row is
   * static text.
   */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /**
   * A script row → the script transcript tab, positioned at that step. The default case means the
   * row is not clickable.
   */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
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
      <WorkflowRunContent
        tab={tab}
        {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenWorkflowActorSession })}
        {...(onOpenWorkflowWorkspace === undefined ? {} : { onOpenWorkflowWorkspace })}
        {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact })}
        {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
      />
    </V4PaneConversationProvider>
  );
});
