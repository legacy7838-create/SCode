import { Hourglass, MessageCircleQuestion, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";
import { WorkflowNotificationArtifactChips } from "@/v4/WorkflowNotificationArtifactChips.js";

/**
 * Background workflow notification row.
 *
 * The manifest ledger form has been rejected (deemed "too flowery"), and the existing tool card syntax has been changed:
 * The notification row is of the same visual family as the ordinary tool call row (ToolLayout: icon + kindLabel + primaryText + expanded body).
 * Data contracts / launch side / hydration / pendingQuestions joint queries are all unchanged - this is just the presentation layer.
 *
 * Pure display: The join results (onOpenRun/pendingQids) are injected by the host after parsing from the projection, and the component does not retrieve the store itself.
 * So that it can be tested under renderToStaticMarkup (the expanded state is transparently passed to ToolLayout via forceOpen).
 */

/** The testid base name of the root node of the notification row. */
const TID_CHAT_WORKFLOW_NOTIFICATION_ROW = "chat-workflow-notification-row";

/** The upper limit of the single-line summary in the folded header is as shown in the escalate card: the summary is just "roughly what was asked", and the full text is in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

const TERMINAL_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;
const ESCALATION_ICON = (
  <MessageCircleQuestion className="size-4 shrink-0 text-foreground-subtle" />
);

/** Panel text (issue/result prose): Follow the border-border bg-panel convention of escalate/submit-result. */
const PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5";
/** Failure error panel: Follow the border-destructive/40 convention of resolve-question outcome (not row-level failure devices). */
const ERROR_PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-panel px-4 py-3 text-ui-base leading-5 text-foreground";

/** Fold into a single line summary: wrap lines into spaces, and truncate if they are too long (see escalate card toInlinePreview). */
function toInlinePreview(value: string): string | undefined {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

const TERMINAL_KIND_LABEL_ID: Record<"completed" | "errored" | "stopped", string> = {
  completed: "chat.backgroundResult.workflow.completed",
  errored: "chat.backgroundResult.workflow.errored",
  stopped: "chat.backgroundResult.workflow.stopped",
};

/** The kindLabel:run of the stall line is still running, but there has been no successful model request for 20 minutes. */
const STALL_KIND_LABEL_ID = "chat.backgroundResult.workflow.stall";
const STALL_ICON = <Hourglass className="size-4 shrink-0 text-foreground-subtle" />;

/** Expand a `label: value` fact line in the body (stall wait time / reason / number of concurrency). */
function factLine(label: string, value: string, key: string) {
  return (
    <p key={key} className="text-ui-sm text-foreground-subtle">
      <span className="text-foreground-subtlest">{label}</span> {value}
    </p>
  );
}

/**
 * Upgrade the kindLabel three-state (based on pendingQuestions presence joint check and flip, the same logic as manifest):
 *   pendingQids contains qid → waiting (waiting for answer);
 *   run is present and qid is absent → answered (question has been answered);
 *   run absent (pendingQids === undefined) → asked (neutral: asked a question).
 * No shimmer, no shimmer - the semantics of shimmer is "working", and the main agent is the one who stops the problem.
 */
function escalationState(
  pendingQids: ReadonlySet<string> | undefined,
  qid: string,
): "waiting" | "answered" | "asked" {
  if (pendingQids === undefined) return "asked";
  return pendingQids.has(qid) ? "waiting" : "answered";
}

interface WorkflowNotificationToolRowProps {
  notification: WorkflowNotificationMeta;
  /** run name = originMeta.title (given authoritatively by CLI, not localized). */
  runName: string;
  /** testid suffix + ToolLayout persist key, take unit.key. */
  testIdKey: string;
  /** CodeBlock's application theme (json result takes it). */
  theme: Theme;
  /** Pre-bound open run details callback; when unavailable, the "open run details" link will not be rendered in the expansion body. */
  onOpenRun?: () => void;
  /**
   * Pre-bound open product tab callback (host injected from join, same as `onOpenRun`). chips are still rendered in its absence,
   * Just don’t point it out – “what was delivered” is the fact, and “whether it can be opened” is the ability.
   */
  onOpenArtifact?: (artifactId: string) => void;
  /** Presence joint query of upgrade row: undefined = run is not in live projection; Set contains qid = Waiting; does not contain = Answered. */
  pendingQids?: ReadonlySet<string>;
  /** Test/host forced expansion (transparent transmission of ToolLayout.forceOpen); product default folding. */
  forceOpen?: boolean;
}

export function WorkflowNotificationToolRow({
  notification,
  runName,
  testIdKey,
  theme,
  onOpenRun,
  onOpenArtifact,
  pendingQids,
  forceOpen = false,
}: WorkflowNotificationToolRowProps) {
  const { intl } = useZCodeIntl();

  // The waiting time should be taken even when there is no event flow (the parked run just does not send events), and new "now" should be fed at fixed intervals.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const openRunLink = onOpenRun ? (
    <button
      type="button"
      onClick={onOpenRun}
      className="text-ui-sm text-foreground-subtle decoration-dotted underline-offset-2 hover:text-foreground hover:underline"
    >
      {intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
    </button>
  ) : null;

  const isEscalation = notification.kind === "escalation";
  const isStall = notification.kind === "stall";

  // kindLabel + primaryText + expand body, cast according to three types of notifications.
  const escalationView = isEscalation ? escalationState(pendingQids, notification.qid) : undefined;

  // The reason word for stopped follows kindLabel.
  const stopReason =
    notification.kind === "terminal" && notification.status === "stopped"
      ? notification.stopReason
      : undefined;
  const kindLabel = isEscalation
    ? intl.formatMessage({ id: `chat.backgroundResult.workflow.${escalationView!}` })
    : isStall
      ? intl.formatMessage({ id: STALL_KIND_LABEL_ID })
      : stopReason !== undefined
        ? `${intl.formatMessage({ id: TERMINAL_KIND_LABEL_ID[notification.status] })} · ${intl.formatMessage({ id: `chat.toolCall.workflow.run.stopReason.${stopReason}` })}`
        : intl.formatMessage({ id: TERMINAL_KIND_LABEL_ID[notification.status] });

  const primaryText = useMemo(() => {
    if (notification.kind === "terminal" || notification.kind === "stall") {
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{runName}</span>
        </span>
      );
    }
    const preview = toInlinePreview(notification.question);
    return <span className="min-w-0 truncate">{preview ?? runName}</span>;
  }, [notification, runName]);

  // Chips are the product of folding the head and tail.
  // Use the `secondaryText` slot of ToolLayout and cooperate with the existing `hideSecondaryTextWhenOpen`——
  // Only displayed in **Collapsed Head**: After expansion, the text itself is talking about the results, and hanging the chips again is just repetition.
  const artifactChips =
    notification.kind === "terminal" &&
    notification.artifacts !== undefined &&
    notification.artifacts.length > 0 ? (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <WorkflowNotificationArtifactChips
          artifacts={notification.artifacts}
          {...(notification.artifactsTruncated === undefined
            ? {}
            : { truncated: notification.artifactsTruncated })}
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        />
      </span>
    ) : undefined;

  // Expand the door: look at the artifact in the final state (errored/provider stopped error, otherwise result), there is always a problem text in the upgrade,
  // stall always waits for the fact.
  const hasDetails =
    notification.kind === "escalation" || notification.kind === "stall"
      ? true
      : notification.error !== undefined
        ? true
        : Boolean(notification.result);

  const waited =
    escalationView === "waiting" && notification.kind === "escalation"
      ? workflowRunQuestionWaitedLabel(notification.askedAt, now, (descriptor, values) =>
          intl.formatMessage(descriptor, values),
        )
      : undefined;

  const renderContent = useCallback(() => {
    if (notification.kind === "escalation") {
      const contextHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.context" });
      return (
        <div className="space-y-3">
          {/* Full text of the question (do not quote the original text of the answer - the answer is in the adjacent ResolveWorkflowQuestion card). */}
          <p className={`${PANEL_CLASS} text-foreground`}>{notification.question}</p>
          {notification.context !== undefined ? (
            <section className="space-y-1.5">
              <h4 className="text-ui-sm font-medium text-foreground-subtlest">{contextHeading}</h4>
              <p className={`${PANEL_CLASS} text-foreground-subtle`}>{notification.context}</p>
            </section>
          ) : null}
          {waited ? <p className="text-ui-sm text-foreground-subtle">{waited}</p> : null}
          {openRunLink}
        </div>
      );
    }

    if (notification.kind === "stall") {
      const minutes = Math.max(1, Math.round(notification.sinceMs / 60_000));
      return (
        <div className="space-y-1" data-testid="workflow-notification-stall">
          <p className={`${PANEL_CLASS} text-foreground`}>
            {intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.body" }, { minutes })}
          </p>
          {notification.reason !== undefined
            ? factLine(
                intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.reason" }),
                notification.reason,
                "reason",
              )
            : null}
          {notification.cap !== undefined
            ? factLine(
                intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.cap" }),
                String(notification.cap),
                "cap",
              )
            : null}
          {openRunLink}
        </div>
      );
    }

    // errored, or stopped with error details (provider/interrupted): error panel.
    if (notification.error !== undefined) {
      return (
        <div className="space-y-3">
          <p className={ERROR_PANEL_CLASS}>{notification.error}</p>
          {openRunLink}
        </div>
      );
    }

    // completed / stopped: Only result (prose <p> / json CodeBlock, as per submit-result convention) is displayed.
    const { result, resultForm } = notification;
    let resultCode = result ?? "";
    if (resultForm === "json") {
      try {
        resultCode = JSON.stringify(JSON.parse(resultCode), null, 2);
      } catch {
        /* History truncated JSON retains the original text without discarding the results. */
      }
    }
    return (
      <div className="mb-2 min-w-0 space-y-2" data-testid="workflow-notification-result">
        {resultForm === "json" ? (
          <CodeBlock
            appTheme={theme}
            code={resultCode}
            language="json"
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            wrapLongLines
          >
            <CodeBlockHeader className="pl-3 pr-2 pt-2" language="json" />
          </CodeBlock>
        ) : (
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base leading-relaxed text-foreground">
            {result}
          </p>
        )}
        {openRunLink}
      </div>
    );
  }, [notification, theme, waited, openRunLink, intl]);

  const toolId = `${TID_CHAT_WORKFLOW_NOTIFICATION_ROW}-${testIdKey}`;

  return (
    <div data-testid={toolId}>
      <ToolLayout
        toolId={toolId}
        persistOpenKey={toolId}
        icon={isEscalation ? ESCALATION_ICON : isStall ? STALL_ICON : TERMINAL_ICON}
        // The icon is distinguished by kind; showIcon displays it by default.
        canToggle={hasDetails}
        forceOpen={forceOpen && hasDetails}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        primaryText={primaryText}
        secondaryText={artifactChips}
        // Key: **Do not** use the failure status device of ToolLayout (that is the semantics of "this call is broken");
        // "Workflow failed" is said by kindLabel, the error details are in the expanded body. There is also no isRunning (no shimmer).
        title={runName}
        renderContent={hasDetails ? renderContent : undefined}
      />
    </div>
  );
}
