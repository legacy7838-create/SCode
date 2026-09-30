import { memo, useEffect, useMemo } from "react";
import { HourglassIcon } from "lucide-react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkflowActorSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { workflowActorStartState } from "@/app-shell/workflowRunPanel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

interface WorkflowActorSessionSidePaneProps {
  tab: WorkflowActorSessionSidePaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}

/**
 * Not-started placeholder. This is where a tab lands when it is opened from a pill on the card that
 * has not started yet.
 *
 * The wording only says "has not started yet" and explains that it will appear on its own — that is
 * the truth (the gate reads the live projection), and it also keeps the user from clicking a retry
 * that does not exist. State is not carried by color alone: icon + title + body all say the same
 * thing.
 */
function WorkflowActorNotStarted() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex h-full flex-col items-center justify-center px-6 text-center"
      data-testid="workflow-actor-not-started"
    >
      <HourglassIcon className="size-8 text-foreground-subtlest" />
      <p className="mt-3 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.title" })}
      </p>
      <p className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.body" })}
      </p>
    </div>
  );
}

/**
 * Gate + nested read-only SessionPane.
 *
 * The gate's input is the **parent session's** `workflowRuns` projection (same as
 * `WorkflowRunSidePane`: run state is the parent session's authoritative projection, not this
 * pane's local cache). The lease is reference-counted, and the parent session is usually already
 * subscribed by the main pane, so this extra read opens no additional connection.
 *
 * While `notStarted`, the **entire SessionPane is not mounted** — it is not a hidden render of it.
 * The subscription happens on `layer.acquire(actorSessionId)` inside SessionPane; only by not
 * mounting is there genuinely no failed subscription, and therefore no projection store parked in
 * error waiting for a manual retry.
 */
const WorkflowActorSessionContent = memo(function WorkflowActorSessionContent({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
  const { layer } = useV4Conversation();

  // The parent session lease goes to **synchronous connection establishment during the rendering period** (`useMemo`, the same as `ReadyV4PaneConversationProvider`),
  // Not `useEffect` + `setLease` of `WorkflowRunSidePane`. The difference is important: the first frame of the effect version
  // Without projection, the door can only be judged as unknown, so SessionPane hangs one frame, subscribes to the session that does not exist yet, and fails.
  // The failed store will live in the keep-warm of SessionDataLayer for 30 seconds with status: "error".
  // The acquire when the door is later released directly reuses it (refCount++, no longer connect) - that is the dead panel that was supposed to be repaired.
  // The details page can tolerate one frame delay (it just draws an empty state first), but this door cannot.
  const lease = useMemo(() => layer.acquire(tab.parentSessionId), [layer, tab.parentSessionId]);
  useEffect(() => () => lease.release(), [lease]);

  const snapshot = useConversationProjection(lease).snapshot;
  const gate = useMemo(
    () =>
      workflowActorStartState(snapshot?.workflowRuns?.runs, {
        runId: tab.runId,
        siteId: tab.siteId,
        ordinal: tab.ordinal,
        ...(tab.actorSessionId === undefined ? {} : { actorSessionId: tab.actorSessionId }),
      }),
    [snapshot?.workflowRuns, tab.actorSessionId, tab.ordinal, tab.runId, tab.siteId],
  );

  // Both `unknown` and `started` are subscribed as usual: the former is the normal state after run is eliminated/cold recovery, and direct subscription is
  // Transcript is the only way to keep the existing error + manual retry panel intact when it fails. without session id
  // Slots (tabs opened by unactivated pills) can only occupy space - the door reads real-time projection, and the actor appears with a session and heals itself.
  if (gate.state === "notStarted" || gate.sessionId === undefined) {
    return <WorkflowActorNotStarted />;
  }

  return (
    <SessionPane
      paneId={tab.id}
      sessionId={gate.sessionId}
      readOnly
      allowWorkspaceFileRewind
      focused={focused}
      telemetryVisible={focused}
      workspacePath={tab.workspacePath}
      workspaceIdentity={tab.workspaceIdentity}
      remoteSessionId={tab.remoteSessionId}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenCodeViewer={onOpenCodeViewer}
      onOpenFileLink={onOpenFileLink}
    />
  );
});

/**
 * The transcript of one dwf actor instance.
 *
 * Composed like `SubagentSessionSidePane`: pane scope + a nested **read-only** `SessionPane`. Apart
 * from the not-started gate there is no fetching logic of its own here, and that is exactly what
 * turning the actor session into a real persistent session buys — the live stream, cold recovery,
 * and looking back after the run ends are all handled by the existing SessionPane chain.
 *
 * Two **deliberate** differences from the subagent pane:
 *
 * - `onOpenSubagentSession` is not passed: subagents are turned off in the actor's tool surface
 *   (the engine spec's "Actor tool surface"), so there is no nested drill-down to click and hence
 *   no entry point to offer.
 * - `rootSessionId` is not passed: an actor session does not sit inside any subagent tree.
 *   Inventing a root would make this read-only pane subscribe to a session that has nothing to do
 *   with it.
 */
export const WorkflowActorSessionSidePane = memo(function WorkflowActorSessionSidePane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
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
      <WorkflowActorSessionContent
        tab={tab}
        focused={focused}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
