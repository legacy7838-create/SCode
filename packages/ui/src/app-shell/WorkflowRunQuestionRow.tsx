import { MessageCircleQuestionIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/**
 * One escalation question: hung below the asker's row.
 *
 * **Read-only, v1 has no answer box**: the answerer is the main agent, not the user — when it is
 * unsure it can already forward the query to the user through AskUserQuestion. qid is the token the
 * main agent uses when it answers; the user cannot answer it themselves, but showing it lets the
 * user point at a particular question and have the main agent answer it — the only handle a
 * read-only surface can relay through.
 */
export function WorkflowRunQuestionRow({
  className,
  now,
  question,
  showAsker = false,
}: {
  /**
   * Placement is supplied by the caller (in the spine it hangs below the asker and is pulled back
   * another 26px; a trailing orphan block indents itself).
   */
  className?: string;
  /**
   * The "now" fed in by the list's timer, so that the elapsed wait keeps ticking even when there is
   * no event stream.
   */
  now: number;
  question: WorkflowRunPendingQuestion;
  /**
   * A question that matches no asker (hung at the end of a stage) has to report its own name; one
   * hung below a row need not repeat it.
   */
  showAsker?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const waited = workflowRunQuestionWaitedLabel(question.askedAt, now, (descriptor, values) =>
    intl.formatMessage(descriptor, values),
  );

  return (
    <div
      className={cn(
        "mt-1 flex min-w-0 items-start gap-2 rounded-lg bg-[var(--color-interaction-confirmation-surface)] px-2 py-1.5 text-ui-sm text-[var(--color-interaction-confirmation-foreground)]",
        className,
      )}
      data-qid={question.qid}
      data-testid="workflow-run-question"
    >
      <MessageCircleQuestionIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {showAsker ? (
          <span className="mr-2 font-mono text-ui-xs font-medium">
            {question.actorName ??
              (question.actorSiteId === undefined
                ? intl.formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
                : `${question.actorSiteId}@${question.actorOrdinal}`)}
          </span>
        ) : null}
        {/* The question body is human prose, not a technical value, so it is typeset as body text; pre-wrap preserves any line breaks the model may bring along. */}
        <span className="whitespace-pre-wrap break-words">{question.question}</span>
        {question.context === undefined ? null : (
          <p
            className="mt-0.5 whitespace-pre-wrap break-words text-ui-xs opacity-80"
            data-testid="workflow-run-question-context"
          >
            {question.context}
          </p>
        )}
      </div>
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-ui-xs">
        {/* How long has been waited. Deliberately **not** colored as a warning: a long wait is a
            normal state by design, not an alert. When askedAt is absent (replaying an old journal)
            the whole block is not rendered — never fabricate a "just now".
            */}
        {waited === undefined ? null : (
          <span data-testid="workflow-run-question-waited">{waited}</span>
        )}
        <span className="opacity-70">{question.qid}</span>
      </span>
    </div>
  );
}
