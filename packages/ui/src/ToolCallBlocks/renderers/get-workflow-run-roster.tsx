/**
 * The **subagent roster** of the GetWorkflowRun tool card (the other half of the situation panel;
 * the phase track and the health row live in get-workflow-run-situation.tsx).
 *
 * A row reads the same way the model-facing side
 * (apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts) reads in a
 * single sentence: "who · where · which phase · at which stage · what it is doing · how many tokens
 * it has cost", where "what it is doing" forks by phase — a running agent reports its progress and
 * its last tool, a waiting one reports what it waits for and how much longer it will have to wait,
 * a parked one reports which question it is parked on. That is exactly why this card exists: to see
 * at a glance who is stuck.
 *
 * The payload is a **flat row** (there is no nested `currentAsk`), so "is there an ask in flight"
 * is inferred from whether those readings are present; an absent reading is never drawn, and 0 is
 * never substituted for the unknown.
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatWorkflowAge,
  formatWorkflowDuration,
  formatWorkflowTokenCount,
} from "@/lib/workflowObservationFormat.js";
import {
  SITUATION_BLOCK_CLASS,
  SITUATION_ROW_CLASS,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";

type WorkflowRunSubagentView = NonNullable<ToolCallGetWorkflowRunDisplay["subagents"]>[number];
type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/**
 * Semantic colors for the phase word. The word is always present; color is only a second channel
 * (DESIGN: state must not be carried by color alone): anything in motion uses the activity color
 * warning, waiting and unfinished terminal states sit neutral, success is success and failure is
 * destructive. `parked` uses the activity color as well — it is waiting for a human answer, which
 * is a state worth noticing, not quiet idleness.
 */
const SUBAGENT_STATE_TEXT: Record<WorkflowRunSubagentView["state"], string> = {
  idle: "text-foreground-subtlest",
  executing: "text-warning",
  waiting: "text-foreground-subtle",
  parked: "text-warning",
  done: "text-success",
  failed: "text-destructive",
  unfinished: "text-foreground-subtle",
};

export function WorkflowRunSubagentRoster({
  subagents,
  generatedAt,
}: {
  subagents: readonly WorkflowRunSubagentView[];
  generatedAt: number | undefined;
}) {
  const { intl } = useZCodeIntl();
  // Empty rosters draw nothing: not creating a subagent yet is something that does not require a whole area to say.
  if (subagents.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-subagents">
      {subagents.map((subagent) => {
        const activity = subagentActivity(subagent, generatedAt, intl.formatMessage);
        return (
          <div className="min-w-0 space-y-0.5" key={`${subagent.siteId}@${subagent.ordinal}`}>
            <div className={`${SITUATION_ROW_CLASS} text-ui-sm`}>
              {/* Anonymous subagents get no synthesized fallback name: it stays empty, and the address still identifies it. */}
              {subagent.name === undefined ? null : (
                <span className="min-w-0 break-words text-foreground">{subagent.name}</span>
              )}
              <span className="break-all font-mono text-ui-xs text-foreground-subtlest">
                {subagent.siteId}@{subagent.ordinal}
              </span>
              <span className={`shrink-0 ${SUBAGENT_STATE_TEXT[subagent.state]}`}>
                {intl.formatMessage({ id: `${I18N_PREFIX}subagent.state.${subagent.state}` })}
              </span>
              {subagent.phaseName === undefined ? null : (
                <span className="min-w-0 break-words text-foreground-subtle">
                  {intl.formatMessage(
                    { id: `${I18N_PREFIX}subagent.phase` },
                    { name: subagent.phaseName },
                  )}
                </span>
              )}
              {activity.map((cell) => (
                <span className="min-w-0 break-words text-foreground-subtle" key={cell}>
                  {cell}
                </span>
              ))}
              {subagent.tokens > 0 ? (
                <span className="shrink-0 tabular-nums text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.usage.tokens" },
                    { tokens: formatWorkflowTokenCount(subagent.tokens) },
                  )}
                </span>
              ) : null}
            </div>
            {subagent.instructionsHead === undefined ||
            subagent.instructionsHead.length === 0 ? null : (
              // The task line is subordinate to the previous line, not a new line. Fact: indent instead of starting a new space.
              <p className="min-w-0 break-words pl-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: `${I18N_PREFIX}subagent.task` },
                  { task: subagent.instructionsHead },
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * When any one of those progress readings is present, there is an ask behind this row (the flat
 * payload carries no `currentAsk` marker).
 */
function hasCurrentAsk(subagent: WorkflowRunSubagentView): boolean {
  return (
    subagent.startedAt !== undefined ||
    subagent.turn !== undefined ||
    subagent.toolCalls !== undefined ||
    subagent.lastTool !== undefined ||
    subagent.instructionsHead !== undefined
  );
}

function subagentActivity(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    // Only qid, no question time: the card payload does not contain pendingQuestions, so this line cannot say "how long you have been waiting."
    return [formatMessage({ id: `${I18N_PREFIX}subagent.parkedOn` }, { qid: subagent.parkedOn })];
  }
  if (subagent.state === "waiting") return waitCells(subagent, generatedAt, formatMessage);
  if (subagent.state === "unfinished" && hasCurrentAsk(subagent)) {
    return [formatMessage({ id: `${I18N_PREFIX}subagent.inFlightAtStop` })];
  }
  if (hasCurrentAsk(subagent)) {
    const cells = executingCells(subagent, generatedAt, formatMessage);
    // Once the ask was flying but not getting a single reading (old journal): roll back the settled steps, don't leave a line with only phase words.
    return cells.length > 0 ? cells : settledCells(subagent, formatMessage);
  }
  return settledCells(subagent, formatMessage);
}

function executingCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  const cells: string[] = [];
  const onStep = formatWorkflowAge(generatedAt, subagent.startedAt);
  if (onStep !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.onStep` }, { age: onStep }));
  }
  if (subagent.turn !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.turn` }, { count: subagent.turn }));
  }
  if (subagent.toolCalls !== undefined) {
    cells.push(
      formatMessage(
        {
          id: `${I18N_PREFIX}subagent.${subagent.toolCalls === 1 ? "toolCallsOne" : "toolCalls"}`,
        },
        { count: subagent.toolCalls },
      ),
    );
  }
  if (subagent.lastTool !== undefined) {
    const { name, target, at } = subagent.lastTool;
    const age = formatWorkflowAge(generatedAt, at);
    cells.push(
      [
        formatMessage({ id: `${I18N_PREFIX}subagent.lastTool` }, { name }),
        target,
        age === undefined ? undefined : formatMessage({ id: `${I18N_PREFIX}age` }, { age }),
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" "),
    );
  }
  return cells;
}

function waitCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  if (subagent.waitCause === undefined) return [];
  const cells = [
    formatMessage({
      id: `${I18N_PREFIX}subagent.${subagent.waitCause === "slot" ? "waitingSlot" : "waitingBackoff"}`,
    }),
  ];
  // "How long have you been waiting" is followed by the reason, and "how long do you have to wait" is the end: when the two durations are next to each other, the reader can't tell which one is which.
  const waited = formatWorkflowAge(generatedAt, subagent.waitSince);
  if (waited !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.waitedFor` }, { age: waited }));
  }
  if (subagent.retryAfterMs !== undefined) {
    cells.push(
      formatMessage(
        { id: `${I18N_PREFIX}subagent.retryIn` },
        { duration: formatWorkflowDuration(subagent.retryAfterMs) },
      ),
    );
  }
  return cells;
}

function settledCells(subagent: WorkflowRunSubagentView, formatMessage: FormatMessage): string[] {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return [];
  const cells = [
    formatMessage(
      { id: `${I18N_PREFIX}subagent.${subagent.stepsSettled === 1 ? "stepsOne" : "steps"}` },
      { count: subagent.stepsSettled },
    ),
  ];
  if (subagent.stepsFailed > 0) {
    cells.push(
      formatMessage({ id: `${I18N_PREFIX}subagent.stepsFailed` }, { count: subagent.stepsFailed }),
    );
  }
  return cells;
}
