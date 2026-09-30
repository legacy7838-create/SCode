import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
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

/**
 * The artifact row (side panel): how a run's primary artifact looks on the completion card and in
 * the run side panel.
 *
 * It is a **tile lying on its side**: the same 16:10 preview frame (160 × 100, the same tier as the
 * tile — not a banner), and beside the frame a kind icon plus a title one step larger than the
 * description line, the author-written description (clamped to three lines), and one monospaced
 * `kind · size` line; the trailing slot is the tile's (v{n}, which yields to ↗ on hover). Emphasis
 * comes from position, form, and text — never from a larger preview, and never from a label: the
 * word "primary" does not appear anywhere in the UI.
 *
 * When the panel is narrower than 380px (container query `wf-artifacts`, declared by the sidebar's
 * section body) the frame shrinks to 136 × 85; the completion card declares no container, so it is
 * always 160 × 100.
 *
 * The whole row is a single `<button>`: when the host supplies no callback it is a disabled button,
 * on the same footing as the tile. It shares the tile's structure (see the file header of
 * WorkflowArtifactTile): the preview frame is a sibling of the button and is marked `inert`, the
 * button wraps only the text column, and a full-row `::after` catches the clicks. The trailing slot
 * and the details reuse the tile's testids (`workflow-artifact-tile-version` / `-open`,
 * `workflow-run-artifact-badge` / `-bytes` / `-items`): they are one shared vocabulary, and a
 * reader of the tests should not lose track of the version number just because the form changed.
 */
export function WorkflowArtifactRow({
  artifact,
  enterDelayMs,
  labels,
  onOpen,
  preview,
  testId = "workflow-artifact-row",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  labels: PresetLabels;
  /**
   * The contents of the preview frame; when absent, the blank page glyph (supplied by the caller as
   * `ArtifactSheetGlyph`, same as the tile).
   */
  preview?: ReactNode;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /**
   * Tooltip override (the side panel puts the workspace origin into it); when absent, it is "kind
   * label · title".
   */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const hasDetail = artifactDetailText(artifact, labels) !== undefined;
  const description = artifact.description?.trim();
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div
      className="wf-tile relative grid w-full min-w-0 grid-cols-[160px_minmax(0,1fr)] items-start gap-3 @max-[380px]/wf-artifacts:grid-cols-[136px_minmax(0,1fr)]"
      data-variant="row"
    >
      <div
        aria-hidden
        className="wf-tile-frame wf-arrive relative h-[100px] w-[160px] overflow-hidden rounded-lg border border-border bg-panel @max-[380px]/wf-artifacts:h-[85px] @max-[380px]/wf-artifacts:w-[136px]"
        data-testid="workflow-artifact-row-frame"
        inert
        style={style}
      >
        {preview}
      </div>
      <button
        aria-label={
          openable
            ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
            : undefined
        }
        className={cn(
          "wf-tile-hit wf-arrive flex min-w-0 flex-col gap-0.5 rounded-lg bg-transparent p-0 pt-px text-left outline-none",
          openable ? "wf-tile-open cursor-pointer" : "cursor-default",
        )}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-open={openable ? "true" : undefined}
        data-artifact-version={String(version)}
        data-testid={testId}
        data-variant="row"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        style={style}
        title={tooltip ?? `${kindLabel} · ${title}`}
        type="button"
      >
        <span className="flex h-5 min-w-0 items-center gap-1.5">
          <ArtifactKindIcon
            className="size-4 shrink-0 text-foreground-subtle"
            kind={artifact.kind}
          />
          <span
            className="wf-pill-name min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            data-testid="workflow-artifact-row-title"
          >
            {title}
          </span>
          {showVersion || openable ? (
            <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
              {showVersion ? (
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
        </span>
        {description === undefined || description.length === 0 ? null : (
          // When the author does not write a description, this line disappears and the line remains - no need to replace it with an id or placeholder sentence.
          <span
            className="line-clamp-3 text-ui-sm text-foreground-subtle [text-wrap:pretty]"
            data-testid="workflow-artifact-row-description"
          >
            {description}
          </span>
        )}
        <span
          className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-artifact-row-detail"
        >
          <span>{kindLabel}</span>
          {hasDetail ? (
            <>
              <span aria-hidden>·</span>
              <span className="flex min-w-0 items-center gap-1 truncate">
                <ArtifactDetail artifact={artifact} labels={labels} />
              </span>
            </>
          ) : null}
        </span>
      </button>
    </div>
  );
}
