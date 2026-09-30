import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
import type { WorkflowRunSettingsHost } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";
import { isWorkflowRunConfigurable } from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { WorkflowTurnDigest } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";

/**
 * Where the end-of-turn digests land: wiring the parsed digests to the host callbacks. The
 * callback's presence is itself the gate (invariant 7): opening the details needs
 * `onOpenWorkflowRun` + sessionId; Resume needs `onResumeWorkflowRun` + a linked digest saying the
 * run is resumable; a pill needs `onOpenWorkflowActor` + a live projection. This is word-for-word
 * the same wiring path `ToolCallRowView` gives tool cards — the same run opened from either place
 * is the same tab.
 */
export function ConversationWorkflowDigests({
  context,
  digests,
  turnKey,
}: {
  digests: readonly WorkflowTurnDigest[];
  context: ConversationRowRenderContext;
  turnKey: string;
}) {
  const { intl } = useZCodeIntl();
  // The provider name in the subagent model name comes from the session's model list (the card itself does not touch the store, the host passes the lookup function into it).
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    context.workspacePath,
    context.workspaceIdentity,
  );
  if (digests.length === 0) return null;
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  return (
    <div className="flex flex-col gap-3" data-testid={`workflow-run-digests-${turnKey}`}>
      {digests.map((digest) => {
        const { runId, summary } = digest;
        const name = digest.name ?? fallbackName;
        const sessionId = context.sessionId;
        // The setting wheel that takes effect in place: that line is
        // All presented. Returning early, none of the following connections for the entire set of cards (Open, Resume, Stop, Pills, "Configuration") are built——
        // Those are controls on cards, and there are no cards this round.
        if (digest.rowOnly && digest.settings !== undefined) {
          return (
            <WorkflowSettingsChangeRow
              amend={digest.settings.amend}
              key={digest.key}
              {...(digest.settings.at === undefined ? {} : { at: digest.settings.at })}
              {...(subagentModelProviderName === undefined
                ? {}
                : { providerName: subagentModelProviderName })}
            />
          );
        }
        // The line "n more" contains drop points (note "five pills and a door"); ⤢ does not contain the problem chip.
        const onOpenRun =
          context.onOpenWorkflowRun && sessionId
            ? (landing?: { phaseId: string }) =>
                context.onOpenWorkflowRun?.({
                  parentSessionId: sessionId,
                  toolCallId: resolveWorkflowRunOpenToolCallId(digest.toolCallId, summary),
                  runId,
                  workflowName: name,
                  ...(landing === undefined ? {} : { phaseId: landing.phaseId }),
                })
            : undefined;
        const onResume =
          context.onResumeWorkflowRun && summary?.resumable
            ? () => context.onResumeWorkflowRun?.(runId, name)
            : undefined;
        // There is only one path to cancel: the details page also takes cancelBackgroundWork {workId ≡ runId}.
        const onCancel =
          context.onCancelBackgroundWork && summary?.status === "running"
            ? () => context.onCancelBackgroundWork?.(runId)
            : undefined;
        const onOpenPill =
          context.onOpenWorkflowActor && sessionId && summary?.run
            ? (pill: TimelinePill) => {
                // Slot identity: If the session id is present, it will be followed; if not, a placeholder tab will be opened.
                const slot = pill.slot;
                if (slot === undefined) return;
                const actorSessionId = pill.instance?.sessionId;
                const actorName = pill.runtimeName ?? pill.lane.name;
                context.onOpenWorkflowActor?.({
                  parentSessionId: sessionId,
                  ordinal: slot.ordinal,
                  runId,
                  siteId: slot.siteId,
                  ...(actorSessionId === undefined ? {} : { actorSessionId }),
                  ...(actorName === undefined ? {} : { actorName }),
                });
              }
            : undefined;
        // Script Pill: The same path as the tool card, open the same tab.
        const onOpenWorkspace =
          context.onOpenWorkflowWorkspace && sessionId && summary?.run
            ? (pill: TimelinePill) => {
                const phaseId = pill.workspace?.phaseId;
                if (phaseId === undefined) return;
                context.onOpenWorkflowWorkspace?.({
                  parentSessionId: sessionId,
                  toolCallId: resolveWorkflowRunOpenToolCallId(digest.toolCallId, summary),
                  runId,
                  workflowName: name,
                  phaseId,
                });
              }
            : undefined;
        const onOpenArtifact =
          context.onOpenWorkflowArtifact && sessionId
            ? (artifactId: string) => {
                // The live projection product summary has the latest version of `contentType`, and the host can directly open the html product into a browser based on it
                // tab; `sourcePath` The summary is deliberately not included (high-frequency status key), and the host will check the journal by itself in absence.
                const artifact = summary?.run?.artifacts?.find(
                  (candidate) => candidate.id === artifactId,
                );
                context.onOpenWorkflowArtifact?.({
                  parentSessionId: sessionId,
                  runId,
                  artifactId,
                  ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                  ...(artifact?.contentType === undefined
                    ? {}
                    : { contentType: artifact.contentType }),
                });
              }
            : undefined;
        const pendingQuestions = context.workflowRunPendingQuestionsByRunId?.get(runId)?.size ?? 0;
        // "Configuration": Host callback presence (read-only /
        // The two grayscale gates have been cut by the host) and this run can be configured. The model list of the elastic layer is read according to the scope of this session.
        const amendSettings = context.onAmendWorkflowRunSettings;
        const settingsHost: WorkflowRunSettingsHost | undefined =
          amendSettings !== undefined && isWorkflowRunConfigurable(summary?.run)
            ? {
                workspacePath: context.workspacePath,
                ...(context.workspaceIdentity
                  ? { workspaceIdentity: context.workspaceIdentity }
                  : {}),
                ...(context.workspaceRemoteSessionId
                  ? { remoteSessionId: context.workspaceRemoteSessionId }
                  : {}),
                ...(context.workflowSessionModel === undefined
                  ? {}
                  : { sessionModel: context.workflowSessionModel }),
                apply: (change) => amendSettings(runId, change),
              }
            : undefined;
        const card = (
          <WorkflowRunDigest
            graph={digest.graph}
            key={digest.key}
            name={name}
            pendingQuestions={pendingQuestions}
            runId={runId}
            summary={summary}
            testIdKey={`${turnKey}-${digest.toolCallId}`}
            {...(subagentModelProviderName === undefined ? {} : { subagentModelProviderName })}
            {...(onOpenRun === undefined ? {} : { onOpenRun })}
            {...(onResume === undefined ? {} : { onResume })}
            {...(onCancel === undefined ? {} : { onCancel })}
            {...(onOpenPill === undefined ? {} : { onOpenPill })}
            {...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace })}
            {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
            {...(settingsHost === undefined ? {} : { settingsHost })}
          />
        );
        // Settings Wheel: The line above the card says what was changed.
        if (digest.settings === undefined) return card;
        return (
          <div className="flex flex-col gap-1.5" key={digest.key}>
            <WorkflowSettingsChangeRow
              amend={digest.settings.amend}
              {...(digest.settings.at === undefined ? {} : { at: digest.settings.at })}
              {...(subagentModelProviderName === undefined
                ? {}
                : { providerName: subagentModelProviderName })}
            />
            {card}
          </div>
        );
      })}
    </div>
  );
}
