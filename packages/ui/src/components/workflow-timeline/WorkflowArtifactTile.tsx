import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ArtifactPillData } from "./WorkflowArtifactPill.js";

/**
 * Artifact tile: one artifact = preview area + caption row. The caption row is the artifact pill's
 * syntax as-is (square kind tile, title, monospace detail, version trailing slot, replaced on hover
 * by ↗); the preview area is a thumbnail of the artifact **itself** — a scaled render of the
 * document's opening, the first rows of a CSV, the board itself — handed in by the caller per kind;
 * when the caller cannot produce one (PDF / binary / the bytes have not arrived) a quiet paper-page
 * glyph is drawn instead.
 *
 * The pill is what an artifact looks like in one line; the tile is what it looks like when it has
 * room. Today only one place still draws it: the gallery on the run side panel when there are **no
 * deliverables** (one column of 130–180px, legible). When there are deliverables, the remaining
 * artifacts go through the index row (`WorkflowArtifactIndex`) — a preview is either legible or not
 * drawn; the former "mini tile" (small boxes in six columns) was removed precisely because it was
 * not legible.
 *
 * ⚠ Terminology: artifact = the output a script publishes for the user to see via `artifact.*`.
 *
 * The whole tile is always one `<button>`: when the host supplies no callback it is a **disabled**
 * button ("what was delivered" is a fact, "whether it can be opened" is a capability), behind the
 * same gate as the pill.
 *
 * The preview frame used to be a child node of the button, and a markdown thumbnail may contain its
 * own controls (a table's "Copy Markdown", file links), so a `<button>` ended up nested inside a
 * `<button>` — React reported a DOM nesting error. The preview frame is now a **sibling** node of
 * the button and marked `inert` (it is a thumbnail: not interactive and not in the accessibility
 * tree), the button wraps only the caption row, and a `::after` that covers the entire tile
 * (`.wf-tile-hit`) catches the whole block's click, hover, and focus; the frame's lift on hover is
 * driven by `.wf-tile:has(.wf-tile-hit:hover)`.
 */
export interface WorkflowCompletionArtifact extends ArtifactPillData {
  contentType?: string;
  bytes?: number;
  sourcePath?: string;
  /**
   * The item count fed in by a preset board; it is absent from the notification payload and only
   * present after the live projection / journal has filled it in.
   */
  itemCount?: number;
  /** The preset board's spec (only the journal can bring it back); the preview area draws from it. */
  spec?: unknown;
  /**
   * The one or two sentences the author wrote; only the deliverable row reads them out (the tile
   * has no room for them).
   */
  description?: string;
  /** The run's deliverable. */
  primary?: true;
}

/**
 * The paper-page glyph used when the content cannot be obtained: a small sheet of paper + a
 * file-extension badge in the bottom-right corner. Honest, not decorated.
 */
export function ArtifactSheetGlyph({ badge }: { badge?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center" data-testid="workflow-artifact-sheet">
      <div className="flex aspect-[3/4] w-[38%] max-w-[72px] flex-col gap-1.5 rounded-[4px] border border-border bg-card p-2.5 shadow-[0_1px_0_var(--color-workflow-rule)]">
        <i className="block h-[5px] w-[55%] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] w-[70%] rounded-sm bg-surface-hover" />
      </div>
      {badge === undefined ? null : (
        <span
          className="absolute bottom-2 right-2 rounded-[4px] bg-surface-hover px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
          data-testid="workflow-artifact-sheet-badge"
        >
          {badge}
        </span>
      )}
    </div>
  );
}

export function WorkflowArtifactTile({
  artifact,
  detail,
  enterDelayMs,
  onOpen,
  preview,
  testId = "workflow-artifact-tile",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  /** The preview area's content; when absent, the paper-page glyph is drawn. */
  preview?: ReactNode;
  /**
   * Monospace secondary information after the name and before the trailing slot (`CSV · 6 KB` / `4
   * items`).
   */
  detail?: ReactNode;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /**
   * The tooltip override (the side panel puts the workspace origin into it); when absent it is
   * "kind word · title".
   */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div className="wf-tile relative flex min-w-0 flex-col gap-1.5" data-variant="tile">
      {/* Preview frame: the bottom fade is decided by the preview content itself (a document thumbnail wants the "there is more" hint, boards and images do not). */}
      <div
        aria-hidden
        className="wf-tile-frame wf-arrive relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-panel"
        data-testid="workflow-artifact-tile-frame"
        inert
        style={style}
      >
        {preview ?? <ArtifactSheetGlyph />}
      </div>
      <button
        aria-label={
          openable
            ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
            : undefined
        }
        className={cn(
          "wf-tile-hit wf-arrive flex min-w-0 items-center gap-1.5 rounded-lg bg-transparent p-0 px-0.5 text-left text-ui-sm outline-none",
          openable ? "wf-tile-open cursor-pointer" : "cursor-default",
        )}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-open={openable ? "true" : undefined}
        data-artifact-version={String(version)}
        data-testid={testId}
        data-variant="tile"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        style={style}
        title={tooltip ?? `${kindLabel} · ${title}`}
        type="button"
      >
        <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
        <span className="wf-pill-name min-w-0 flex-1 truncate text-foreground">{title}</span>
        {detail === undefined || detail === null ? null : (
          <span
            className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
            data-testid="workflow-artifact-tile-detail"
          >
            {detail}
          </span>
        )}
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
    </div>
  );
}
