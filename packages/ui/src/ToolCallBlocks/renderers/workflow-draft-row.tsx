import { useMemo, type ReactNode } from "react";
import type { ToolCallCreateWorkflowDisplay } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { cn } from "@/components/lib/utils.js";
import { DRAFT_FEEDBACK_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  formatWorkflowFeedbackTooltip,
  workflowDiagnosticLines,
} from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  WorkflowDiagnosticsSection,
  workflowFeedbackLedeMessageId,
} from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";

/**
 * What the compile feedback row says in each ToolLayout slot. Split out of `create-workflow.tsx`
 * (oxlint max-lines 400 gate, same as the `createWorkflowInput.ts` precedent).
 *
 * Only uses slots the row already has — kind word, name, detail, status — and adds no new element
 * to the conversation: the previous notification redesign was judged "flashy" on real devices
 * precisely because it introduced a new visual grammar.
 */
interface WorkflowDraftRowSlots {
  /** Detail slot: "draft n". */
  secondaryText: ReactNode | undefined;
  /** The status word "n to fix · not run", shown only when the code does not compile. */
  statusLabel: ReactNode | undefined;
  /** The empty ring lamp in front of the status word, shown only when the code does not compile. */
  statusIndicator: ReactNode | undefined;
  /**
   * Hover tooltip: that sentence plus the itemized diagnostics; shown only when the code does not
   * compile.
   */
  statusTooltip: string | undefined;
  /**
   * The draft-number text that an in-flight row (the card header while validating) writes into the
   * detail slot from draft 2 onward.
   */
  inFlightOrdinalText: string | undefined;
}

interface WorkflowDraftRowInput {
  draft: WorkflowDraftPosition | undefined;
  compileErrors: boolean;
  /**
   * In-flight rows (authoring, awaiting confirmation): numbering starts at draft 2; draft 1 does
   * not announce that a draft 2 will follow.
   */
  inFlight: boolean;
  errorCount: number;
  diagnostics: readonly { line: number; column: number; message: string }[];
  saved: boolean;
}

export function useWorkflowDraftRowSlots({
  draft,
  compileErrors,
  inFlight,
  errorCount,
  diagnostics,
  saved,
}: WorkflowDraftRowInput): WorkflowDraftRowSlots {
  const { intl } = useZCodeIntl();
  const ordinal = workflowDraftOrdinalShown(draft, { compileErrors, inFlight });
  const inFlightOrdinal = workflowDraftOrdinalShown(draft, { compileErrors: false, inFlight });
  const inFlightOrdinalText =
    inFlightOrdinal === undefined
      ? undefined
      : intl.formatMessage(
          { id: "chat.toolCall.workflow.draftOrdinal" },
          { ordinal: String(inFlightOrdinal) },
        );
  const superseded = draft?.superseded === true;
  const lede = intl.formatMessage({ id: workflowFeedbackLedeMessageId(saved) });
  const words = compileErrors
    ? `${intl.formatMessage({ id: "chat.toolCall.workflow.toFix" }, { count: errorCount })} · ${intl.formatMessage({ id: "chat.toolCall.workflow.notRun" })}`
    : undefined;

  // ToolLayout is a memo component: the nodes handed to it must be remembered by value, otherwise the entire row will be re-rendered every time the parent renders.
  const secondaryText = useMemo(
    () => (ordinal === undefined ? undefined : <WorkflowDraftOrdinal ordinal={ordinal} />),
    [ordinal],
  );
  const statusLabel = useMemo(
    () =>
      words === undefined ? undefined : <span data-testid="workflow-draft-status">{words}</span>,
    [words],
  );
  const statusIndicator = useMemo(
    () => (compileErrors ? <WorkflowDraftLamp superseded={superseded} /> : undefined),
    [compileErrors, superseded],
  );
  const statusTooltip = useMemo(
    () => (compileErrors ? formatWorkflowFeedbackTooltip(lede, diagnostics) : undefined),
    [compileErrors, diagnostics, lede],
  );
  return { secondaryText, statusLabel, statusIndicator, statusTooltip, inFlightOrdinalText };
}

/**
 * The content shown when the feedback row is expanded: the script (with line numbers, the lines
 * named by diagnostics colored as warnings) and the compile feedback card; with no display it falls
 * back to plain-text output. Awaiting-confirmation rows reuse the same block (there are no
 * diagnostics then, only the script).
 */
export function WorkflowFeedbackContent({
  display,
  fallbackOutputText,
  saved,
  scriptText,
}: {
  display: ToolCallCreateWorkflowDisplay | null;
  fallbackOutputText: string | null;
  saved: boolean;
  scriptText: string | undefined;
}) {
  // Memory by content: The display remains the same array, and the injection style of the code block will not be reconstructed accordingly.
  const flaggedLines = useMemo(
    () => (display?.ok === false ? workflowDiagnosticLines(display.diagnostics) : undefined),
    [display],
  );
  return (
    <div className="mb-2 space-y-3">
      {scriptText ? (
        <div data-testid="workflow-script-codeblock">
          <CodeBlock
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            code={scriptText}
            language="typescript"
            showLineNumbers
            {...(flaggedLines === undefined ? {} : { markedLines: flaggedLines })}
          >
            <CodeBlockHeader className="pl-3 pr-2 pt-2" language="typescript" />
          </CodeBlock>
        </div>
      ) : null}
      {display && display.diagnostics.length > 0 ? (
        <WorkflowDiagnosticsSection
          count={display.errorCount}
          diagnostics={display.diagnostics}
          saved={saved}
          truncated={display.truncated}
        />
      ) : null}
      {!display && fallbackOutputText ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-panel px-3 py-2 font-mono text-ui-base text-foreground-subtle">
          {fallbackOutputText}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Whether the detail slot carries the draft number: rows that fail to compile always carry it (when
 * the host provides a position); in-flight rows carry it from draft 2 onward. Run cards, launch
 * summaries, and confirmation dialogs never come through here, so they never carry a draft number.
 */
function workflowDraftOrdinalShown(
  draft: WorkflowDraftPosition | undefined,
  phase: { compileErrors: boolean; inFlight: boolean },
): number | undefined {
  if (draft === undefined) return undefined;
  if (phase.compileErrors) return draft.ordinal;
  return phase.inFlight && draft.ordinal >= 2 ? draft.ordinal : undefined;
}

function WorkflowDraftOrdinal({ ordinal }: { ordinal: number }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="workflow-draft-ordinal">
      {intl.formatMessage(
        { id: "chat.toolCall.workflow.draftOrdinal" },
        { ordinal: String(ordinal) },
      )}
    </span>
  );
}

/**
 * The empty ring lamp: the shape says "nothing has run yet", the color says whether attention is
 * still pending (warning color on the latest draft, fading to neutral once a newer draft exists).
 * `wf-lamp` makes the color change transition rather than jump.
 */
function WorkflowDraftLamp({ superseded }: { superseded: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp size-2 shrink-0 rounded-full",
        superseded ? DRAFT_FEEDBACK_DOT.settled : DRAFT_FEEDBACK_DOT.open,
      )}
      data-draft-lamp={superseded ? "settled" : "open"}
      data-testid="workflow-draft-lamp"
    />
  );
}
