import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { buildPresetLabels } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workDurationParts } from "@/lib/workDuration.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import {
  WORKFLOW_RUN_KIND_ID,
  WorkflowCardHeader,
  WorkflowRunStatus,
} from "./WorkflowCardChrome.js";
import {
  completionArtifactCellCount,
  completionArtifactLayout,
  WorkflowCompletionArtifacts,
} from "./WorkflowCompletionArtifacts.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

export { COMPLETION_INDEX_MAX } from "./WorkflowCompletionArtifacts.js";

/**
 * Completion card: the turn in which the main agent digests a **completed** workflow notification
 * drops this card at the end of the turn. The order is the argument — header → what this run
 * **delivered** (the deliverables row) → what **else** it produced (the artifact index, one row per
 * artifact) → **what it cost** (the four numbers). A hairline separates the three sections, like a
 * receipt. The artifact area is `WorkflowCompletionArtifacts`.
 *
 * Pure presentation: the artifact list, the four numbers, and each artifact's preview are all
 * handed in by the host (a preview has to read bytes, which is the host's job). There is no chevron
 * — there is nothing to expand; the whole card is not a toggle.
 *
 * Honest numbers: a cell that cannot be obtained reads `—`, never 0.
 */
export interface WorkflowCompletionFigures {
  durationMs?: number;
  tokens?: number;
  subagents?: number;
  /**
   * Number of phases entered (`run.phases`); a script with no phase() markers cannot supply it, so
   * it reads `—`.
   */
  phases?: number;
}

export interface WorkflowCompletionCardProps {
  name: string;
  figures: WorkflowCompletionFigures;
  artifacts: readonly WorkflowCompletionArtifact[];
  /** Truncated on the emit side: the N in "N more" is written as `…`. */
  artifactsTruncated?: boolean;
  /**
   * A preview of the drawn frame (only the deliverables row has one); absent (or returning
   * undefined) means the paper-page glyph.
   */
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenRun?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  testIdKey: string;
}

/**
 * How long the numbers take to roll up; all four cells land on the same beat, continuing the rhythm
 * of the pills dropping in sequence on the strip.
 */
const COUNT_UP_MS = 640;

/**
 * Compact token notation: `812` / `386.4k` / `1.30M`. One decimal place for thousands, two for
 * millions — the fixed digit count keeps the four cells' monospaced numbers aligned from run to
 * run. The full value goes in the title.
 */
export function formatCompactCount(count: number): { value: string; unit: string } {
  if (count < 1_000) return { value: count.toLocaleString(), unit: "" };
  if (count < 1_000_000) return { value: (count / 1_000).toFixed(1), unit: "k" };
  return { value: (count / 1_000_000).toFixed(2), unit: "M" };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * The numbers roll only when the browser has **explicitly** said to reduce motion; when the
 * question cannot be asked (static rendering, jsdom) they go straight to their final values.
 */
function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  );
}

/**
 * Rolls a number from 0 up to its target. **The first frame is the target value** (static
 * rendering, tests, and reduced-motion all see the final value); only after mounting does it go
 * back to 0 and roll up again — "the page is complete at rest".
 */
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (target === undefined || !motionAllowed() || typeof requestAnimationFrame !== "function") {
      setShown(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      setShown(Math.round(target * easeOutCubic(progress)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setShown(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

function Figure({
  delayMs,
  label,
  parts,
  testKey,
  title,
}: {
  testKey: string;
  label: string;
  /** Alternates `[number, unit]`; when absent, `—`. */
  parts: readonly { value: string; unit: string }[] | undefined;
  title?: string;
  delayMs: number;
}) {
  const { intl } = useZCodeIntl();
  const unavailable = intl.formatMessage({ id: "chat.toolCall.workflow.completion.unavailable" });
  const style: CSSProperties = { animationDelay: `${delayMs}ms`, animationFillMode: "backwards" };
  return (
    <div
      className="wf-arrive flex min-w-0 flex-col"
      data-testid={`workflow-completion-figure-${testKey}`}
      data-value={
        parts === undefined ? undefined : parts.map((part) => part.value + part.unit).join(" ")
      }
      style={style}
    >
      <span
        aria-label={parts === undefined ? unavailable : undefined}
        className={cn(
          "whitespace-nowrap font-mono text-ui-lg leading-tight tabular-nums",
          parts === undefined ? "text-foreground-subtlest" : "font-medium text-foreground",
        )}
        title={title}
      >
        {parts === undefined
          ? "—"
          : parts.map((part, index) => (
              <span key={index}>
                {index > 0 ? " " : null}
                {part.value}
                {part.unit.length === 0 ? null : (
                  <span className="text-ui-sm font-normal text-foreground-subtle">{part.unit}</span>
                )}
              </span>
            ))}
      </span>
      <span className="truncate text-ui-sm text-foreground-subtle">{label}</span>
    </div>
  );
}

export function WorkflowCompletionCard({
  artifacts,
  artifactsTruncated = false,
  figures,
  name,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
  testIdKey,
}: WorkflowCompletionCardProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );

  const layout = useMemo(
    () => completionArtifactLayout(artifacts, artifactsTruncated),
    [artifacts, artifactsTruncated],
  );

  // Turn up the four-digit number; turn up the duration in milliseconds, and then split it into "11m 48s".
  const durationMs = useCountUp(figures.durationMs);
  const tokens = useCountUp(figures.tokens);
  const subagents = useCountUp(figures.subagents);
  const phases = useCountUp(figures.phases);
  const timeParts =
    durationMs === undefined
      ? undefined
      : workDurationParts(durationMs, format).map((part) => ({
          value: String(part.value),
          unit: part.unit,
        }));
  const tokenParts = tokens === undefined ? undefined : [formatCompactCount(tokens)];
  const plain = (value: number | undefined) =>
    value === undefined ? undefined : [{ value: value.toLocaleString(), unit: "" }];

  const figureDelay = PILL_STAGGER_MS * (completionArtifactCellCount(layout) + 1);

  return (
    <section
      aria-label={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
      className="wf-motion wf-arrive flex w-full min-w-0 flex-col gap-2.5 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-3 pt-1.5"
      data-testid={`workflow-completion-card-${testIdKey}`}
      data-workflow-completion-card="true"
    >
      <WorkflowCardHeader
        expanded={false}
        kind={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
        name={name}
        status={<WorkflowRunStatus status="completed" testId="workflow-completion-status" />}
        {...(onOpenRun === undefined ? {} : { onOpenDetails: onOpenRun })}
      />
      <WorkflowCompletionArtifacts
        artifactsTruncated={artifactsTruncated}
        labels={labels}
        layout={layout}
        {...(renderPreview === undefined ? {} : { renderPreview })}
        {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        {...(onOpenRun === undefined ? {} : { onOpenRun })}
      />
      <div
        className="grid grid-cols-4 gap-x-3 border-t border-[var(--color-workflow-rule)] pt-2.5"
        data-testid="workflow-completion-figures"
      >
        <Figure
          delayMs={figureDelay}
          label={format({ id: "chat.toolCall.workflow.completion.time" })}
          parts={timeParts}
          testKey="time"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS}
          label={format({ id: "chat.toolCall.workflow.completion.tokens" })}
          parts={tokenParts}
          testKey="tokens"
          {...(figures.tokens === undefined
            ? {}
            : {
                title: format(
                  { id: "chat.toolCall.workflow.card.tokens" },
                  { count: figures.tokens.toLocaleString() },
                ),
              })}
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 2}
          label={format({ id: "chat.toolCall.workflow.completion.subagents" })}
          parts={plain(subagents)}
          testKey="subagents"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 3}
          label={format({ id: "chat.toolCall.workflow.completion.phases" })}
          parts={plain(phases)}
          testKey="phases"
        />
      </div>
    </section>
  );
}
