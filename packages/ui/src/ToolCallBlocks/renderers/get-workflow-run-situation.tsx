/**
 * The **situation slice** of the GetWorkflowRun tool card: phase track + health line (the roster is
 * in get-workflow-run-roster.tsx).
 *
 * Two disciplines, word for word identical to the model-facing side
 * (apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts):
 * 1. **Absence means no cell.** Without a timestamp there is no age; without a reading there is no
 *    cell. `0` is a fact, and "don't know" is a different one — never substitute 0 for the latter.
 * 2. All ages are computed against the **snapshot moment** `generatedAt`, not against `Date.now()`:
 *    when a card from three days ago is reopened, its readings must not drift forward to today. If
 *    `generatedAt` is missing, no age is drawn at all.
 *
 * Layout: wrapping rows throughout (flex-wrap), no fixed-width table — on narrow phone screens the
 * rows have to wrap rather than overflow horizontally.
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { throttleReasonLabel } from "@/app-shell/workflowRunThrottle.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge, formatWorkflowDuration } from "@/lib/workflowObservationFormat.js";

type WorkflowRunPhaseView = NonNullable<ToolCallGetWorkflowRunDisplay["phases"]>[number];
type WorkflowRunHealthView = NonNullable<ToolCallGetWorkflowRunDisplay["health"]>;

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/**
 * Container for the situation block: the same low-level container the log panel uses on the same
 * card, not a second kind of card surface.
 */
export const SITUATION_BLOCK_CLASS =
  "min-w-0 space-y-1 rounded-lg border border-border bg-surface px-2 py-1.5";

/**
 * A row inside the situation block: wraps on narrow screens and is baseline-aligned (so numbers and
 * text mixed in one line do not push each other out of line).
 */
export const SITUATION_ROW_CLASS = "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5";

/**
 * Semantic color for a phase's status word. Same decision set as the run's overall status
 * (run-status-presentation.ts): anything in motion uses the active color warning, completed uses
 * success, not-yet-happened is the weakest, and an unsettled terminal state sits in the middle.
 */
const PHASE_STATE_TEXT: Record<WorkflowRunPhaseView["state"], string> = {
  done: "text-success",
  current: "text-warning",
  ahead: "text-foreground-subtlest",
  unfinished: "text-foreground-subtle",
};

/**
 * Phase track: one phase per row, in declaration order. An `ahead` row carries only its index, name
 * and status word — it has not happened yet, so there is no round or step count to report.
 */
export function WorkflowRunPhaseTrack({
  phases,
  generatedAt,
  terminal,
}: {
  phases: readonly WorkflowRunPhaseView[];
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (phases.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-phases">
      {phases.map((phase, index) => {
        const cells: string[] = [];
        // Rounds equal to 0 can only be `ahead`: it is impossible to say "how many times it has been entered" for a stage that has not been entered.
        if (phase.rounds > 0) {
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.${phase.rounds === 1 ? "roundsOne" : "rounds"}` },
              { count: phase.rounds },
            ),
          );
        }
        if (phase.nodesSettled > 0) {
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.settled` },
              { count: phase.nodesSettled },
            ),
          );
        }
        if (phase.nodesRunning > 0) {
          // The "still running" in the final state run means that it has not been settled and is not moving.
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.${terminal ? "unfinished" : "running"}` },
              { count: phase.nodesRunning },
            ),
          );
        }
        const duration = phaseDuration(phase, generatedAt, terminal, intl.formatMessage);
        return (
          <div className={SITUATION_ROW_CLASS} key={`${phase.name}-${index}`}>
            <span className="shrink-0 tabular-nums text-foreground-subtlest">{index + 1}.</span>
            <span className="min-w-0 break-words text-foreground">{phase.name}</span>
            <span className={`shrink-0 ${PHASE_STATE_TEXT[phase.state]}`}>
              {intl.formatMessage({ id: `${I18N_PREFIX}phase.state.${phase.state}` })}
            </span>
            {cells.map((cell) => (
              <span className="text-foreground-subtle" key={cell}>
                {cell}
              </span>
            ))}
            {duration === undefined ? null : (
              <span className="text-foreground-subtlest">{duration}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

function phaseDuration(
  phase: WorkflowRunPhaseView,
  generatedAt: number | undefined,
  terminal: boolean,
  formatMessage: FormatMessage,
): string | undefined {
  if (phase.enteredAt === undefined) return undefined;
  if (phase.exitedAt !== undefined) return formatWorkflowDuration(phase.exitedAt - phase.enteredAt);
  // There is no departure moment: the living run says "until now"; the final run says nothing - its departure moment is not recorded,
  // Subtracting the snapshot time is equivalent to counting the hours after the death of the process into this stage.
  if (terminal) return undefined;
  const soFar = formatWorkflowAge(generatedAt, phase.enteredAt);
  return soFar === undefined
    ? undefined
    : formatMessage({ id: `${I18N_PREFIX}phase.soFar` }, { duration: soFar });
}

/**
 * Health line: whether the run as a whole is still moving, in a single row of readings.
 *
 * `stalled` only means something for a live run (a terminal run is of course not moving); a
 * terminal run gets a **leftover note** instead — the roster rows still marked running are residue
 * from a process that died under them. This is the only place on this card that says "we don't
 * know" out loud (the other is the hint that pending questions are invisible): silence would be
 * read as "they are still running".
 *
 * `consecutiveFailures` / `cachedSteps` appear only when greater than 0: a reading of 0 is not
 * news, and the card surface is stingier with rows than the model-facing side is.
 */
export function WorkflowRunHealthLine({
  health,
  generatedAt,
  terminal,
}: {
  health: WorkflowRunHealthView;
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  const cells: string[] = [];

  const lastProgress = formatWorkflowAge(generatedAt, health.lastProgressAt);
  if (lastProgress !== undefined) {
    cells.push(
      intl.formatMessage({ id: `${I18N_PREFIX}health.lastProgress` }, { age: lastProgress }),
    );
  }

  if (health.concurrency !== undefined) {
    const { effective, cap, reason, since } = health.concurrency;
    cells.push(intl.formatMessage({ id: `${I18N_PREFIX}health.concurrency` }, { effective, cap }));
    // The reason and the starting moment each occupy one space, without brackets: the shape of the brackets is different in Chinese and English, and this line is originally read according to the case.
    // reason is an open string. If you know it, it will be mapped to a short label, and if you don't know it, it will be displayed as it is.
    if (reason !== undefined) cells.push(throttleReasonLabel(reason, intl.formatMessage));
    const sinceAge = formatWorkflowAge(generatedAt, since);
    if (sinceAge !== undefined) {
      cells.push(
        intl.formatMessage({ id: `${I18N_PREFIX}health.concurrencySince` }, { age: sinceAge }),
      );
    }
  }

  if (!terminal) {
    const stalledAge = formatWorkflowAge(generatedAt, health.stalledSince);
    cells.push(
      health.stalledSince === undefined
        ? intl.formatMessage({ id: `${I18N_PREFIX}health.notStalled` })
        : stalledAge === undefined
          ? intl.formatMessage({ id: `${I18N_PREFIX}health.stalledNoClock` })
          : intl.formatMessage({ id: `${I18N_PREFIX}health.stalled` }, { age: stalledAge }),
    );
  }

  if (health.consecutiveFailures > 0) {
    cells.push(
      intl.formatMessage(
        {
          id: `${I18N_PREFIX}health.${health.consecutiveFailures === 1 ? "failuresOne" : "failures"}`,
        },
        { count: health.consecutiveFailures },
      ),
    );
  }
  if (health.cachedSteps > 0) {
    cells.push(
      intl.formatMessage(
        {
          id: `${I18N_PREFIX}health.${health.cachedSteps === 1 ? "cachedStepsOne" : "cachedSteps"}`,
        },
        { count: health.cachedSteps },
      ),
    );
  }

  const leftover = terminal ? health.leftoverRunning : undefined;
  if (cells.length === 0 && leftover === undefined) return null;
  return (
    <div className="min-w-0 space-y-1" data-testid="workflow-run-health">
      {cells.length === 0 ? null : (
        <div className={`${SITUATION_ROW_CLASS} text-ui-sm text-foreground-subtlest`}>
          {cells.map((cell) => (
            <span key={cell}>{cell}</span>
          ))}
        </div>
      )}
      {leftover === undefined ? null : (
        <p className="break-words text-ui-sm text-warning" data-testid="workflow-run-leftover">
          {intl.formatMessage(
            { id: `${I18N_PREFIX}health.${leftover === 1 ? "leftoverOne" : "leftover"}` },
            { count: leftover },
          )}
        </p>
      )}
    </div>
  );
}
