import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * "Details shown for {shown} of {total} steps": once a run runs into
 * `WORKFLOW_RUNS_LIMITS.maxNodes`, the instance table stops at the limit, while the numbers above
 * it (step count, settled count) have already counted the rows that fell outside the table. This
 * line says exactly that difference — **the run is not what stopped; the per-step details are**.
 *
 * The card and the detail page share one implementation: the same run must say the same thing on
 * both surfaces.
 *
 * It appears only when instances really were kept out of the table. `truncated` itself is also set
 * when smaller tables such as reports / artifacts / phases hit their limit (workflow-runs.ts); not
 * a single step is missing then, so repeating "Details shown for 40 of 40 steps" would be
 * pointless.
 */
export function WorkflowTruncatedNotice({
  className,
  run,
  testId,
}: {
  className?: string;
  /**
   * This run in the live projection; if absent (the run was evicted from the projection), there is
   * nothing to say.
   */
  run: WorkflowRunState | undefined;
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  if (run?.truncated !== true) return null;
  const shown = run.nodes.length;
  const { total } = workflowRunStepCounts(run);
  if (shown >= total) return null;
  return (
    <p
      className={cn("min-w-0 text-ui-xs text-foreground-subtlest", className)}
      data-testid={testId}
    >
      {/* Neither number gets a thousands separator: the summary-line segment right next to them
          (`{done}/{total} steps`) is bare digits, and a "2,001" next to a "2001" in the same block
          is more jarring than one extra separator.
          */}
      {intl.formatMessage({ id: "chat.toolCall.workflow.run.truncated" }, { shown, total })}
    </p>
  );
}
