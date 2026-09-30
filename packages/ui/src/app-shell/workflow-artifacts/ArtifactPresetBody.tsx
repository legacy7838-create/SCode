import {
  ArtifactBoard,
  ArtifactChart,
  ArtifactMetrics,
  ArtifactTable,
  parseArtifactPresetSpec,
  type ArtifactItem,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/index.js";
import { isArtifactPresetKind } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * The body of a preset board.
 *
 * ⚠ Terminology: an artifact = the output a script publishes to the user through `artifact.*`; it
 * is not the homonym the engine uses internally for the "top-level return value of a script".
 *
 * This used to share a file with the side pane's artifact card; once the card became an artifact
 * pill, only this one dispatch — shared by the side pane's small preview and the full-size tab —
 * was left.
 */
/**
 * Hands the spec + entries to one of four renderers based on kind. The side pane's small card
 * (`compact`) and the full-size tab share it — if each site wrote its own switch, a skew like "the
 * small card drew the diagram while the large one drew nothing", which happens at only one of the
 * two sites, would show up eventually.
 */
export function ArtifactPresetBody({
  artifact,
  items,
  labels,
  compact,
  invalidLabel,
  missingLabel,
  className,
}: {
  artifact: Pick<WorkflowRunArtifactView, "kind" | "spec">;
  items: readonly ArtifactItem[];
  labels: PresetLabels;
  compact?: boolean;
  /**
   * Fallback copy for when the spec is present but **cannot be parsed**; when absent, the whole
   * block does not render.
   */
  invalidLabel?: string;
  /**
   * Copy for when the spec is **entirely absent**; when absent, the whole block does not render
   * (see the comment about loading below).
   */
  missingLabel?: string;
  className?: string;
}) {
  if (!isArtifactPresetKind(artifact.kind)) return null;
  // "spec is not present" and "spec is broken" must be said separately.
  //
  // spec can only be brought back by journal query (living projection deliberately does not bring it), so **the first few frames of the panel are opened each time**
  // spec is still undefined. The result of merging the two into a sentence of "unable to render" is that each Kanban board is first
  // Flash the wrong copy once. So: Not present ⇒ Leave it to the caller to decide (the side panel card passes undefined, keep quiet;
  // Full-size tab (missingLabel is only passed after the metadata has been read).
  if (artifact.spec === undefined) {
    return missingLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-missing"
      >
        {missingLabel}
      </p>
    );
  }
  const spec = parseArtifactPresetSpec(artifact.kind, artifact.spec);
  if (spec === undefined) {
    return invalidLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-invalid"
      >
        {invalidLabel}
      </p>
    );
  }
  // The four `as` are all guaranteed by the same kind: `parseArtifactPresetSpec(kind, …)` is verified by kind,
  // The shape it recognizes is the spec of that kind. This function of 4b does not have overloading by kind (only
  // `applyArtifactItems` has), so this layer of narrowing can only be done on the caller side.
  const shared = { compact, items, labels, className };
  switch (artifact.kind) {
    case "chart":
      return <ArtifactChart spec={spec as ChartSpec} {...shared} />;
    case "table":
      return <ArtifactTable spec={spec as TableSpec} {...shared} />;
    case "metrics":
      return <ArtifactMetrics spec={spec as MetricsSpec} {...shared} />;
    default:
      return <ArtifactBoard spec={spec as BoardSpec} {...shared} />;
  }
}
