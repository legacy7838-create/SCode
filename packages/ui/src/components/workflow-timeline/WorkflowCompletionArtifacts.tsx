import type { ReactNode } from "react";
import { resolvePrimaryArtifact } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { WorkflowArtifactIndex } from "./WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "./WorkflowArtifactRow.js";
import { ArtifactSheetGlyph, type WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * The artifacts region of the completion card. Split out of `WorkflowCompletionCard`: the card
 * itself has to respect the 400-line cap.
 *
 * - **With a deliverable** (the one flagged primary, or the only entry in the list): a deliverable
 *   row, then the remaining artifacts as an **index** — one item per row, two columns when the card
 *   is wide; at most six rows, from the seventh item on five rows plus one "N more" row (open the
 *   run side pane to see them all).
 * - **Without a deliverable**: no item deserves a preview, so not one is drawn — the index takes
 *   over the artifacts region, under the same cap.
 *
 * Only the deliverable's box reads bytes (a preview either reads clearly or is not drawn); index
 * rows and the "N more" row never read.
 *
 * ⚠ Terminology: artifact = an output a script publishes to the user through `artifact.*`.
 */

/** Cap on the number of index rows on the card, which is also the cap when nothing is folded. */
export const COMPLETION_INDEX_MAX = 6;
/** The number of rows that sit alongside the "N more" row when one is needed. */
const COMPLETION_INDEX_WITH_MORE = COMPLETION_INDEX_MAX - 1;

export interface CompletionArtifactLayout {
  /** The deliverable; when absent, the index takes over alone. */
  primary?: WorkflowCompletionArtifact;
  /** The items drawn as rows (everything other than the deliverable). */
  lines: readonly WorkflowCompletionArtifact[];
  /** The number of items not drawn (the N of "N more"). */
  folded: number;
  /**
   * Whether the "N more" row is drawn: because items were folded, or because the list was cut on
   * the emitting side (N is unknowable then, so it is written as `…`).
   */
  more: boolean;
}

/**
 * The **single** decision about layout; the card (rhythm), the fetch gate (which items read bytes)
 * and the rendering all read from here.
 */
export function completionArtifactLayout(
  artifacts: readonly WorkflowCompletionArtifact[],
  truncated: boolean,
): CompletionArtifactLayout {
  if (artifacts.length === 0) return { lines: [], folded: 0, more: false };
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  // Chopped list (over 8) Don't know the true number of pieces: Still given a door, N writes `…` - the same thing as the ellipsis in the product bar.
  const more = rest.length > COMPLETION_INDEX_MAX || truncated;
  const lines = rest.slice(0, more ? COMPLETION_INDEX_WITH_MORE : COMPLETION_INDEX_MAX);
  return {
    ...(primary === undefined ? {} : { primary }),
    lines,
    folded: rest.length - lines.length,
    more,
  };
}

/**
 * The number of cells drawn on the card (a row counts as one cell, each index row one cell, the "N
 * more" row one cell): the four-cell figures land right after them.
 */
export function completionArtifactCellCount(layout: CompletionArtifactLayout): number {
  return (layout.primary === undefined ? 0 : 1) + layout.lines.length + (layout.more ? 1 : 0);
}

/**
 * The items whose bytes are read: only the deliverable's box reads; index rows and the gate never
 * read.
 */
export function completionPreviewIds(layout: CompletionArtifactLayout): ReadonlySet<string> {
  return new Set(layout.primary === undefined ? [] : [layout.primary.id]);
}

export function WorkflowCompletionArtifacts({
  artifactsTruncated,
  labels,
  layout,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
}: {
  layout: CompletionArtifactLayout;
  artifactsTruncated: boolean;
  labels: PresetLabels;
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
}) {
  const { primary, lines, folded, more } = layout;
  if (primary === undefined && lines.length === 0 && !more) return null;
  const hasPrimary = primary !== undefined;
  return (
    <>
      {hasPrimary ? (
        <WorkflowArtifactRow
          artifact={primary}
          enterDelayMs={PILL_STAGGER_MS}
          labels={labels}
          preview={renderPreview?.(primary) ?? <ArtifactSheetGlyph />}
          testId="workflow-completion-row"
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ) : null}
      {lines.length > 0 || more ? (
        // There is a thin line between the index and the deliverable line; not when the product area is exclusive (there is nothing to separate it).
        <WorkflowArtifactIndex
          artifacts={lines}
          columns="auto"
          firstDelayMs={PILL_STAGGER_MS * (hasPrimary ? 2 : 1)}
          folded={folded}
          labels={labels}
          lineTestId="workflow-completion-line"
          more={more}
          moreTestId="workflow-completion-more"
          rule={hasPrimary}
          testId="workflow-completion-index"
          truncated={artifactsTruncated}
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
          {...(onOpenRun === undefined ? {} : { onOpenRun })}
        />
      ) : null}
    </>
  );
}
