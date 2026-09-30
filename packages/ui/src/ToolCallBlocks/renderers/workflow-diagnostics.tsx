import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * A single TS diagnostic (the CreateWorkflow and EvalWorkflowSnippet displays share the same
 * shape).
 */
interface WorkflowDiagnosticEntry {
  line: number;
  column: number;
  code: number;
  message: string;
}

/**
 * Code range for the analyzer's own rules (starting at 9001). It must not be written as "≥ 9000":
 * TypeScript's own 18xxx codes (such as TS18048) are still TypeScript codes; in the 9xxx range
 * TypeScript only produces declaration-emit diagnostics, and the workflow compiler produces no
 * declarations, so on the card this range belongs to the analyzer alone.
 */
const ANALYZER_RULE_CODE_MIN = 9001;
const ANALYZER_RULE_CODE_MAX = 9099;

function isWorkflowAnalyzerRuleCode(code: number): boolean {
  return code >= ANALYZER_RULE_CODE_MIN && code <= ANALYZER_RULE_CODE_MAX;
}

/**
 * Copy for the one-line feedback card: it spells out what did not happen and who moves next. A
 * saved source that fails to compile is a problem with the **file**, so the sentence names the
 * file, taking the same stance as the sentence handed to the model in the tool result. The card and
 * the row's hover tip read the same id, so the two cannot end up telling different stories.
 */
export function workflowFeedbackLedeMessageId(saved: boolean): string {
  return saved
    ? "chat.toolCall.workflow.feedback.lede.saved"
    : "chat.toolCall.workflow.feedback.lede";
}

/**
 * Compile feedback card: shared by the CreateWorkflow card and the EvalWorkflowSnippet card (the
 * same compile pipeline, the same diagnostic shape, the same length limit — implementing the two
 * separately is a breeding ground for drift).
 *
 * Failing to compile is not a failure: nothing ran, and the feedback went back to the model. So
 * this card uses a neutral border and the body foreground color rather than destructive — in this
 * feature, red belongs only to runs that errored; a whole block of red text would paint the least
 * fatal event as the loudest thing on the page. When the diagnostics are empty, the whole block is
 * not rendered.
 */
export function WorkflowDiagnosticsSection({
  diagnostics,
  truncated,
  count,
  saved = false,
}: {
  diagnostics: readonly WorkflowDiagnosticEntry[];
  truncated?: boolean;
  /**
   * Count; when the display carries `errorCount` (the total before truncation) pass that, otherwise
   * derive it from the line count.
   */
  count?: number;
  /**
   * The script came from a saved workflow file: that sentence names the file rather than this call.
   */
  saved?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (diagnostics.length === 0) {
    return null;
  }

  const total = count ?? diagnostics.length;
  const countLabel = intl.formatMessage(
    {
      id:
        total === 1
          ? "chat.toolCall.workflow.feedback.countOne"
          : "chat.toolCall.workflow.feedback.count",
    },
    { count: total },
  );
  // Codes are passed to ICU as strings: numeric parameters are grouped by localization ("9,003").
  const codeLabel = (code: number) =>
    isWorkflowAnalyzerRuleCode(code)
      ? intl.formatMessage({ id: "chat.toolCall.workflow.feedback.rule" }, { code: String(code) })
      : `TS${code}`;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-panel px-3 py-2"
      data-testid="workflow-compiler-feedback"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-ui-xs font-medium text-foreground-subtle">
        <span className="min-w-0 truncate" data-testid="workflow-compiler-feedback-title">
          {intl.formatMessage({ id: "chat.toolCall.workflow.feedback" })}
        </span>
        <span
          className="shrink-0 font-normal tabular-nums"
          data-testid="workflow-compiler-feedback-count"
        >
          {countLabel}
        </span>
      </div>
      <p
        className="text-ui-sm text-foreground-subtle"
        data-testid="workflow-compiler-feedback-lede"
      >
        {intl.formatMessage({ id: workflowFeedbackLedeMessageId(saved) })}
      </p>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.line}:${diagnostic.column}:${index}`}
          className="flex items-start gap-2 text-ui-base"
          data-testid="workflow-compiler-feedback-line"
        >
          <code className="shrink-0 rounded-sm bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            L{diagnostic.line}:C{diagnostic.column}
          </code>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
            {diagnostic.message}
          </span>
          <code className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
            {codeLabel(diagnostic.code)}
          </code>
        </div>
      ))}
      {truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
