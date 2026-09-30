import { MessageCircleQuestion } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const ESCALATE_TOOL_ICON = (
  <MessageCircleQuestion className="size-4 shrink-0 text-foreground-subtle" />
);

/**
 * Cap on the single-line summary in the collapsed header: the summary is only a rough sense of
 * “what was asked”; the full question lives in the expanded body.
 */
const INLINE_PREVIEW_MAX_LENGTH = 160;

/**
 * Normalize input into an object when reading: for a string, first try one lenient `JSON.parse`
 * (following the read-side convention of submit-result).
 */
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Single-line summary in the collapsed header: newlines collapse to spaces, and overlong text is
 * truncated.
 */
function toInlinePreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * The escalate tool card. A sub-agent escalates a **genuinely blocking** question to the main agent
 * and parks inside this call waiting for an answer; the nested read-only SessionPane docked in the
 * main agent's side pane goes through the same ToolCallBlocks pipeline, so both surfaces share this
 * card.
 *
 * Collapsed row: kindLabel (asking/asked) + a single-line summary of the question. Expanded: the
 * question (+ context when present) + the answer area.
 *
 * Key point: a rejection because the budget is exhausted **is an ordinary tool result** (not an
 * error tool_result, see the handler comment), so the card must never render it as a failure based
 * on the output text content—only `status==="failed"` (wiring failures and the like) gets the
 * failure styling. While parked (running) the answer has not arrived yet, so the in-progress label
 * is all the information there is; this card may park for a long time, so the running state must
 * look calm rather than broken.
 */
export function EscalateToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  const question = readText(input?.question);
  const questionContext = readText(input?.context);

  const isFailed = toolCall.status === "failed";
  // Pending: still running / pending / in_progress and not failing - the answer has not come back yet.
  const isAsking =
    !isFailed &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  // Answer text = model content: when answered, it is the original answer text of the main agent; when refused, it is the copy written by the port.
  // Both are ordinary results (handler's formatModelContent only returns message), and can only be read by output.
  const answerText = isAsking ? undefined : readText(toolCall.output);

  const kindLabel = intl.formatMessage({
    id: isAsking
      ? "chat.toolCall.workflow.escalate.asking"
      : "chat.toolCall.workflow.escalate.asked",
  });
  const questionHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.question" });
  const contextHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.context" });
  const answerHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.answer" });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.fallbackName" });

  const inlinePreview = useMemo(() => toInlinePreview(question), [question]);
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? fallbackName}</span>
    ),
    [inlinePreview, toolCall.title, fallbackName],
  );

  // Expand door: As long as there is a question, context or answer, any content can be expanded. The input in the first frame may still be `{}`. At that time
  // Do not give an empty panel an expansion entry (follow the flow gate of submit-result).
  const hasDetails =
    question !== undefined || questionContext !== undefined || answerText !== undefined;

  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {question !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{questionHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {question}
            </p>
          </section>
        ) : null}
        {questionContext !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{contextHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground-subtle">
              {questionContext}
            </p>
          </section>
        ) : null}
        {answerText !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{answerHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {answerText}
            </p>
          </section>
        ) : null}
      </div>
    ),
    [question, questionContext, answerText, questionHeading, contextHeading, answerHeading],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ESCALATE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isFailed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isFailed ? context.errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
