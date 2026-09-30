import { memo, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  TID_WORKFLOW_ARTIFACTS_SECTION,
  TID_WORKFLOW_ARTIFACTS_TOGGLE,
  TID_WORKFLOW_ARTIFACT_CARD,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { WorkflowArtifactIndex } from "@/components/workflow-timeline/WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "@/components/workflow-timeline/WorkflowArtifactRow.js";
import { WorkflowArtifactTile } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  ArtifactDetail,
  artifactDisplayTitle,
  artifactKindMessageId,
  buildPresetLabels,
  resolvePrimaryArtifact,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactTilePreview } from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

/**
 * The artifacts section of the workflow run detail page.
 *
 * ⚠ Terminology: the artifacts in this section are the outputs a script delivers to the **user**
 * via `artifact.*`. That is a different thing from the "result" panel above (the script's top-level
 * return value, which goes to the model) — by convention the two must be visible on screen at the
 * same time and worded distinguishably.
 *
 * The section header follows the rhythm of the phase list (same height, same inset, same chevron).
 * The section body has two renderings:
 * - **There is a deliverable** (the one flagged primary, or a list holding a single item): a
 *   deliverable row (the same `WorkflowArtifactRow` as on the completion card; when the panel is
 *   narrower than 380px the frame shrinks to 136 × 85, decided by the section body's container
 *   query), and below a hairline the remaining artifacts act as an **index**: one row per artifact,
 *   single column, all of them listed (the same `WorkflowArtifactIndex` as on the completion card,
 *   which caps at six rows while this one does not). Twelve artifacts are twelve rows, within one
 *   screen.
 * - **There is no deliverable**: a **gallery**: one tile per artifact (preview frame + caption
 *   line, `WorkflowArtifactTile`), with the column count adapting to the panel width — one column
 *   from 130px, at most 180px for a single column; thumbnails at this size are readable, which is
 *   why it stays. Inside the preview frame is the artifact itself: boards centered at natural size,
 *   growing live with the report entries; documents scaled down to show their beginning; the first
 *   rows of a CSV; PDFs and binaries drawn as paper-page glyphs. The list already puts the
 *   deliverable first and the rest in first-published order (a hook sorted them).
 *
 * **Expanded by default** (the opposite of the phase sections): artifacts are what this run
 * **delivered to the user**, so collapsing them hides the deliverable, and that is precisely what
 * users most often open this panel for. It can still be collapsed by hand, and the collapsed header
 * carries the count. **Failed and cancelled runs render the same way**: a run that died at step 12
 * may still have published a pdf.
 */
export const WorkflowRunArtifactsSection = memo(function WorkflowRunArtifactsSection({
  artifacts,
  sessionId,
  runId,
  onOpenArtifact,
}: {
  /**
   * Confirmed non-empty; when it is empty the caller renders no section at all (the "absent when
   * there is none" convention, no empty shell).
   */
  artifacts: readonly WorkflowRunArtifactView[];
  sessionId: string;
  runId: string;
  /** Absent means the tile is disabled (the host did not inject the ability to open a tab). */
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(true);
  // For markdown abbreviations, you need to select the code block color according to the theme; the host without Provider (single test) gets the system.
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const title = intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.title" });
  // Stable reference: The four renderers are all memo. Changing labels to a new object every frame will make that layer of comparison never hit.
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  const preview = (artifact: WorkflowRunArtifactView) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version}`}
      runId={runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // The source of the workspace is entered into the tooltip: it is a path, indicating that the row cannot be placed, and the position of the title should not be occupied.
  const tooltipOf = (
    artifact: Pick<WorkflowRunArtifactView, "id" | "kind" | "title" | "sourcePath">,
  ) => {
    const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
    return (
      `${kindLabel} · ${artifactDisplayTitle(artifact)}` +
      (artifact.sourcePath === undefined ? "" : `\n${artifact.sourcePath}`)
    );
  };

  return (
    <section
      className="wf-motion shrink-0 border-t border-border/60"
      data-artifacts-open={expanded ? "true" : "false"}
      data-testid={TID_WORKFLOW_ARTIFACTS_SECTION}
    >
      <button
        aria-expanded={expanded}
        aria-label={intl.formatMessage({
          id: expanded
            ? "chat.toolCall.workflow.run.artifacts.collapse"
            : "chat.toolCall.workflow.run.artifacts.expand",
        })}
        className="flex h-9 w-full items-center gap-2 px-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid={TID_WORKFLOW_ARTIFACTS_TOGGLE}
        onClick={() => setExpanded((previous) => !previous)}
        type="button"
      >
        <span className="min-w-0 shrink-0 truncate text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* The count is **present even while collapsed** — collapsing must not make "what exactly did this run deliver" invisible. */}
        <span
          className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-run-artifacts-count"
        >
          {artifacts.length.toLocaleString()}
        </span>
        {/* When collapsed, the deliverable's name is still on the section header: it is the one item users most often come to this panel to find. */}
        {!expanded && primary !== undefined ? (
          <span
            className="min-w-0 truncate text-ui-sm text-foreground-subtle"
            data-testid="workflow-run-artifacts-primary-title"
          >
            · {artifactDisplayTitle(primary)}
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-foreground-subtlest transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && primary !== undefined ? (
        // `@container/wf-artifacts`: The deliverable row box is selected as 160 × 100 or 136 × 85 according to the width of this container.
        <div
          className="wf-unfold @container/wf-artifacts flex max-h-[50vh] flex-col gap-2.5 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-primary-body"
        >
          <WorkflowArtifactRow
            artifact={primary}
            enterDelayMs={PILL_STAGGER_MS}
            labels={labels}
            preview={preview(primary)}
            // The same testid as the tile (`data-variant="row"` to distinguish the state): it is still "a card of a product".
            testId={TID_WORKFLOW_ARTIFACT_CARD}
            title={tooltipOf(primary)}
            {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
          />
          {rest.length > 0 ? (
            // Single column, no cap: The side panel is where all products are allowed to be listed. A line is also a "card of a product" (`data-variant="line"`).
            <WorkflowArtifactIndex
              artifacts={rest}
              columns="one"
              firstDelayMs={PILL_STAGGER_MS * 2}
              labels={labels}
              lineTestId={TID_WORKFLOW_ARTIFACT_CARD}
              rule
              testId="workflow-run-artifact-index"
              tooltipOf={tooltipOf}
              {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
            />
          ) : null}
        </div>
      ) : expanded ? (
        <div
          className="wf-unfold grid max-h-[50vh] grid-cols-[repeat(auto-fill,minmax(130px,180px))] gap-3 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-gallery"
        >
          {artifacts.map((artifact, index) => (
            <WorkflowArtifactTile
              artifact={artifact}
              detail={<ArtifactDetail artifact={artifact} labels={labels} />}
              enterDelayMs={PILL_STAGGER_MS * (index + 1)}
              key={artifact.id}
              preview={preview(artifact)}
              testId={TID_WORKFLOW_ARTIFACT_CARD}
              title={tooltipOf(artifact)}
              {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
});
