import type { CSSProperties } from "react";
import { ArrowUpRightIcon, EllipsisIcon } from "lucide-react";
import {
  ArtifactDetail,
  ArtifactKindIcon,
  artifactDetailText,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * Artifact index (side panel): the **remaining artifacts** after the deliverable row, one per row.
 *
 * There is only one rule: **a preview either reads clearly or is not drawn at all**. The
 * deliverable keeps its frame; the remaining artifacts drop the frame and keep only the tile
 * caption row's vocabulary — kind icon, full title, monospace detail (the mini tile used to hide it
 * in a tooltip), trailing slot (v{n}, which gives way to ↗ on hover) — as standalone rows. The
 * hierarchy comes from **shape** that way (one item with an image vs. the rest with text only), not
 * from a big frame versus a small one.
 *
 * 26px per row. On a card they flow into two columns via `repeat(auto-fit, minmax(220px, 1fr))`
 * (one column on a narrow card); the side panel is always a single column. A hairline separates
 * them from the deliverable row (`--color-workflow-rule`, the one in front of the four-slot
 * figures), so the card reads as the three parts of a receipt: what was delivered, what else was
 * done, what it cost.
 *
 * The "{n} more" row is a door, not an artifact: an ellipsis icon, secondary-color text, and a ↗
 * that is there without waiting for a hover (the same rule as the roster's "{n} more" row);
 * clicking it opens the run side panel to see all of them.
 *
 * Every row is always a `<button>`: when the host supplies no callback it is a **disabled** button
 * ("what was delivered" is a fact, "whether it can be opened" is a capability), the same door as
 * pills and tiles. On hover / focus the whole row is filled with `surface-hover` (like a sidebar
 * row), and the fill extends 6px past the text on each side (negative margin), while the text
 * itself stays aligned with the left edge of the deliverable frame.
 *
 * ⚠ Terminology: artifact = an output a script publishes to the user through `artifact.*`.
 */
function enterStyle(enterDelayMs: number | undefined): CSSProperties | undefined {
  return enterDelayMs === undefined || enterDelayMs <= 0
    ? undefined
    : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };
}

const LINE_CLASS =
  "wf-line wf-arrive -mx-1.5 flex h-[26px] min-w-0 items-center gap-2 rounded-md bg-transparent px-1.5 text-left text-ui-sm outline-none";

function WorkflowArtifactLine({
  artifact,
  enterDelayMs,
  labels,
  onOpen,
  testId = "workflow-artifact-line",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  labels: PresetLabels;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /**
   * Tooltip override (the side panel folds the workspace origin into it); when absent it is "kind
   * word · title".
   */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const hasDetail = artifactDetailText(artifact, labels) !== undefined;
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;

  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
          : undefined
      }
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-testid={testId}
      data-variant="line"
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={enterStyle(enterDelayMs)}
      title={tooltip ?? `${kindLabel} · ${title}`}
      type="button"
    >
      <ArtifactKindIcon
        className="wf-line-icon size-3.5 shrink-0 text-foreground-subtle"
        kind={artifact.kind}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      {hasDetail ? (
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-artifact-line-detail"
        >
          <ArtifactDetail artifact={artifact} labels={labels} />
        </span>
      ) : null}
      {showVersion || openable ? (
        <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          {showVersion ? (
            // Rehang by version: When re-releasing with the same id, the tail slot will pop in once (the entry of wf-mark), and give way to ↗ when hovering.
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-artifact-tile-version"
              key={version}
              title={intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.version" },
                { version: String(version) },
              )}
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.versionTail" },
                { version: String(version) },
              )}
            </span>
          ) : null}
          {openable ? (
            <span
              aria-hidden
              className="wf-pill-go flex items-center justify-center text-foreground-subtlest"
              data-testid="workflow-artifact-tile-open"
            >
              <ArrowUpRightIcon className="size-3" />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** The "{n} more" door, not an artifact. A folded list does not know N, so it writes `…`. */
function WorkflowArtifactMoreLine({
  count,
  enterDelayMs,
  onOpen,
  testId = "workflow-artifact-more-line",
  truncated = false,
}: {
  count: number;
  /** Folded on the emitting side (over 8): N is unknown, so write `…`. */
  truncated?: boolean;
  onOpen?: () => void;
  enterDelayMs?: number;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const openable = onOpen !== undefined;
  return (
    <button
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-testid={testId}
      data-variant="more"
      disabled={!openable}
      onClick={onOpen}
      style={enterStyle(enterDelayMs)}
      title={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      type="button"
    >
      <EllipsisIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
      <span className="min-w-0 flex-1 truncate text-foreground-subtle">
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.completion.moreArtifacts" },
          { count: truncated ? "…" : count.toLocaleString() },
        )}
      </span>
      {openable ? (
        // A door has no status flag to give way to: ↗ Be present, don't wait for hover (wf-pill-go-rest).
        <span className="grid size-3 shrink-0 place-items-center">
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex items-center justify-center text-foreground-subtlest"
            data-testid="workflow-artifact-tile-open"
          >
            <ArrowUpRightIcon className="size-3" />
          </span>
        </span>
      ) : null}
    </button>
  );
}

type WorkflowArtifactIndexColumns = "auto" | "one";

/**
 * The index itself: rows plus an optional door. `columns="auto"` is the card's two-column flow (it
 * only becomes two columns at ≥ 2 × 220px), `"one"` is the side panel's single column. `rule` draws
 * that hairline above (needed when it follows the deliverable row; not when the index owns the
 * card). Rows land in sequence, each staggered by 30ms starting from `firstDelayMs`, with the door
 * after the last row.
 */
export function WorkflowArtifactIndex({
  artifacts,
  columns = "auto",
  firstDelayMs = 0,
  folded = 0,
  labels,
  lineTestId,
  more = false,
  moreTestId,
  onOpenArtifact,
  onOpenRun,
  rule = false,
  testId = "workflow-artifact-index",
  tooltipOf,
  truncated = false,
}: {
  artifacts: readonly WorkflowCompletionArtifact[];
  labels: PresetLabels;
  columns?: WorkflowArtifactIndexColumns;
  rule?: boolean;
  /** Draws the "{n} more" door; `folded` is N. */
  more?: boolean;
  folded?: number;
  truncated?: boolean;
  firstDelayMs?: number;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
  testId?: string;
  lineTestId?: string;
  moreTestId?: string;
  tooltipOf?: (artifact: WorkflowCompletionArtifact) => string;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-5",
        columns === "auto" ? "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]" : "grid-cols-1",
        rule && "border-t border-[var(--color-workflow-rule)] pt-1.5",
      )}
      data-columns={columns}
      data-testid={testId}
    >
      {artifacts.map((artifact, index) => (
        <WorkflowArtifactLine
          artifact={artifact}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * index}
          key={artifact.id}
          labels={labels}
          {...(lineTestId === undefined ? {} : { testId: lineTestId })}
          {...(tooltipOf === undefined ? {} : { title: tooltipOf(artifact) })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {more ? (
        <WorkflowArtifactMoreLine
          count={folded}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * artifacts.length}
          truncated={truncated}
          {...(moreTestId === undefined ? {} : { testId: moreTestId })}
          {...(onOpenRun === undefined ? {} : { onOpen: onOpenRun })}
        />
      ) : null}
    </div>
  );
}
