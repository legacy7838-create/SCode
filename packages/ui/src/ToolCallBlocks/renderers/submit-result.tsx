import { ClipboardCheckIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const SUBMIT_RESULT_TOOL_ICON = (
  <ClipboardCheckIcon className="size-4 shrink-0 text-foreground-subtle" />
);

/** The upper limit of a single line summary of the collapsed header: the summary is just "roughly what was submitted", and the entire content is in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

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
 * Read-time normalization of submitted content: String is tried **once** tolerantly with `JSON.parse`, and the parsed value is used only after parsing the object/array.
 *
 * This is the read-side image of the engine-side real disk conclusion - `engine/scheduler.ts` file "Real models often serialize result into
 * JSON string" and do the same single-pass parse. Do not do multi-level recursive parse (the engine only does it once), if the parsing fails, press
 * String processing will never destroy the card by mistake, and will never overwrite any data.
 */
function normalizeSubmittedResult(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.trim().length === 0) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    // Literal strings for numeric/boolean/null remain as is: that's what the model wrote, not the structured payload.
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

/** Indented text for JSON branches. Pathological payloads such as circular references fall back to `String(...)`, and the card cannot crash due to the payload. */
function stringifyResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Single-line synopsis with collapsed header: newlines collapsed into spaces, extra long truncated. */
function toInlinePreview(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }

  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

export function SubmitResultToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  // The reason for the fix is as shown in send-message: the input of the first frame of streaming may still be `{}` and cannot be provided for an empty panel.
  // Expand the portal. The gate is "result key is present" rather than "result has value" - submitting null is also a real submission.
  const hasResult = input !== undefined && "result" in input;
  const normalizedResult = useMemo(
    () => (hasResult ? normalizeSubmittedResult(input?.result) : undefined),
    [hasResult, input?.result],
  );
  const isProse = typeof normalizedResult === "string";

  const isRejected = toolCall.status === "failed";
  // Rejection and stop have the same sentence on the card: the submission has not been completed. spec only defines four phases and does not create a fifth entry for denied.
  const isStopped = toolCall.status === "stopped" || toolCall.status === "denied";
  const isSubmitting =
    !isRejected &&
    !isStopped &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");
  const kindLabelId = isRejected
    ? "chat.toolCall.submitResult.rejected"
    : isStopped
      ? "chat.toolCall.submitResult.stopped"
      : isSubmitting
        ? "chat.toolCall.submitResult.submitting"
        : "chat.toolCall.submitResult.submitted";

  // Reject the original text: Error channel first, followed by the tool's own error field and plain text output. The output of the accepting state is always
  // "The result was accepted.", no information, never read.
  const rejectionText = isRejected
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : undefined;
  // The rejection state is a flat row, with no expansion entry; the rejection of the original text is in the failure state tooltip (can be hovered and copied), and there is no longer field-by-field
  // Violation panel. rejectionText only exists in the rejection state, so the expansion gate in the non-rejection state only depends on whether the result key is present.
  const hasDetails = !isRejected && hasResult;

  const resultLabel = intl.formatMessage({ id: "chat.toolCall.submitResult.resultHeading" });
  const inlinePreview = useMemo(
    () => (hasResult ? toInlinePreview(normalizedResult) : undefined),
    [hasResult, normalizedResult],
  );
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? "submit_result"}</span>
    ),
    [inlinePreview, toolCall.title],
  );

  const theme = context.theme;
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {hasResult ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{resultLabel}</h4>
            {isProse ? (
              // The human word is prose: DESIGN.md Leave mono to path/command/code/identifier/terminal-data.
              // Deliberately not doing markdown rendering - the result string has no markdown contract.
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
                {normalizedResult as string}
              </p>
            ) : (
              // The structured payload uses CodeBlock (respecting the user's code font size setting), and the container uses mcp.tsx verbatim.
              <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                <CodeBlock
                  appTheme={theme}
                  code={stringifyResult(normalizedResult)}
                  language="json"
                />
              </div>
            )}
          </section>
        ) : null}
      </div>
    ),
    [hasResult, isProse, normalizedResult, resultLabel, theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SUBMIT_RESULT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isRejected ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isRejected ? rejectionText : undefined}
        showFailureStatus={isRejected}
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
