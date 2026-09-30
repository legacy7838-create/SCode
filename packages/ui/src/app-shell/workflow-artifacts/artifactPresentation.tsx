import type { ReactNode } from "react";
import { ChartLineIcon, FileIcon, GaugeIcon, SquareKanbanIcon, TableIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type {
  ArtifactPresetKind,
  PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/index.js";

/**
 * Presentation rules that user-facing artifacts share across **several surfaces** (run side pane
 * tiles, completion card tiles, the `workflow-artifact` tab, notification row pills, and the hub).
 *
 * ⚠ Terminology: an artifact here is an output a script publishes to the user through `artifact.*`,
 * not the engine-internal namesake “top-level return value of a script”.
 *
 * There is exactly one reason to extract this: **the same artifact has to look the same in four
 * places**. If the icon or the kind word is written out separately each time, the notification
 * row's chip and the tab it opens will sooner or later point at one and the same thing with two
 * different icons.
 */

/**
 * The four preset board members. Content members (file / markdown) have bytes and versions; these
 * do not.
 */
const PRESET_KINDS = new Set<WorkflowRunArtifactKind>(["chart", "table", "metrics", "board"]);

export function isArtifactPresetKind(kind: WorkflowRunArtifactKind): kind is ArtifactPresetKind {
  return PRESET_KINDS.has(kind);
}

/**
 * The message id of the kind word. One word per member across the six (file / document / chart /
 * table / metrics / board).
 */
export function artifactKindMessageId(kind: WorkflowRunArtifactKind): string {
  return `chat.toolCall.workflow.run.artifacts.kind.${kind}`;
}

const MARKDOWN_ICON = resolveFileDisplayDescriptor("artifact.md").fileIconSrc;
const KIND_ICON: Record<Exclude<WorkflowRunArtifactKind, "markdown">, typeof FileIcon> = {
  file: FileIcon,
  chart: ChartLineIcon,
  table: TableIcon,
  metrics: GaugeIcon,
  board: SquareKanbanIcon,
};

/**
 * The kind icon. `className` takes the size from the caller (card size-4, chip size-3.5, tab header
 * size-4) — the size is decided by each surface's density, the glyph itself is not.
 */
export function ArtifactKindIcon({
  kind,
  className,
}: {
  kind: WorkflowRunArtifactKind;
  className?: string;
}): ReactNode {
  if (kind === "markdown") {
    return <FileDisplayIcon src={MARKDOWN_ICON} className={className} />;
  }
  const Icon = KIND_ICON[kind];
  return <Icon aria-hidden="true" className={className} />;
}

/**
 * How byte counts are written for display.
 *
 * Deliberately written a second time in this module rather than importing the same-named function
 * in `feedback/feedbackSubmissionJob.ts`: that is the feedback upload job module, and dragging the
 * whole upload chain into the app-shell dependency graph for five lines of arithmetic is not worth
 * it, while drift between the two would harm nobody anyway (one says how big a file is, the other
 * how much was uploaded).
 */
export function formatArtifactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Whether the body for this contentType is **human-readable text** — the gate for the “Copy”
 * action.
 *
 * `application/json` is singled out on purpose: IANA files it under application/, but what a script
 * hands over with `artifact.file("summary", "out/report.json")` is exactly the thing users want to
 * copy away. This is a different thing from the `textLanguageFor` used for body dispatch: that one
 * decides which code viewer to use, this one only decides “whether the whole thing can be copied”.
 */
export function isTextArtifactContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.startsWith("text/") || contentType === "application/json";
}

/**
 * The type badge of a file: the extension of the original workspace path wins (`out/book.pdf` →
 * `PDF`), falling back to the MIME subtype when there is no path.
 */
export function artifactFileBadge(artifact: {
  sourcePath?: string;
  contentType?: string;
}): string | undefined {
  const extension = artifact.sourcePath?.match(/\.([a-z0-9]{1,5})$/iu)?.[1];
  if (extension !== undefined) return extension.toUpperCase();
  const subtype = artifact.contentType?.split("/")[1]?.split(";")[0]?.trim();
  if (subtype === undefined || subtype.length === 0) return undefined;
  const KNOWN: Record<string, string> = {
    "x-markdown": "MD",
    markdown: "MD",
    plain: "TXT",
    json: "JSON",
    csv: "CSV",
    html: "HTML",
    pdf: "PDF",
  };
  return KNOWN[subtype] ?? (subtype.length <= 5 ? subtype.toUpperCase() : undefined);
}

/**
 * The monospaced detail in the pill / tile caption: for a file `PDF · 4.0 KB`, for a document the
 * size alone, and for a preset board the number of items fed in (its “size” is the data volume; the
 * count is absent when unknown). Shared by side pane tiles and completion cards — writing it once
 * in each of the two places means one of them will sooner or later show the badge while the other
 * does not. Returning null means the caller draws no detail slot.
 */
export function ArtifactDetail({
  artifact,
  labels,
}: {
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  };
  labels: PresetLabels;
}): ReactNode {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? null : (
      <span data-testid="workflow-run-artifact-items">{labels.itemsCount(artifact.itemCount)}</span>
    );
  }
  if (artifact.bytes === undefined) return null;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  return (
    <>
      {badge === undefined ? null : (
        <>
          <span data-testid="workflow-run-artifact-badge">{badge}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span data-testid="workflow-run-artifact-bytes">{formatArtifactBytes(artifact.bytes)}</span>
    </>
  );
}

/**
 * The **plain-text** form of the caption detail (`PDF · 4.0 KB` / `4 items`): mini tiles move the
 * detail into a tooltip, deliverable rows write it into the `kind · size` line. It follows the same
 * rules as `ArtifactDetail`, just without a testid.
 */
export function artifactDetailText(
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  },
  labels: PresetLabels,
): string | undefined {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? undefined : labels.itemsCount(artifact.itemCount);
  }
  if (artifact.bytes === undefined) return undefined;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  const size = formatArtifactBytes(artifact.bytes);
  return badge === undefined ? size : `${badge} · ${size}`;
}

/**
 * The deliverable: the one carrying the `primary` flag; when nothing is flagged and the manifest
 * holds a single item, that item is the deliverable — the **single-item rule holds only in the
 * UI**, and neither the protocol nor the engine ever infers the flag. Every other case has no
 * deliverable: a primary whose publication failed is never replaced by some other artifact, and two
 * or more unflagged items render the way they do today.
 */
export function resolvePrimaryArtifact<T extends { primary?: true }>(
  artifacts: readonly T[],
): T | undefined {
  const flagged = artifacts.find((artifact) => artifact.primary === true);
  if (flagged !== undefined) return flagged;
  return artifacts.length === 1 ? artifacts[0] : undefined;
}

/**
 * The deliverable leads, everything else keeps its original order. The three CLI projections
 * (journal → port, notification manifest, GetWorkflowRun) already order it this way; this is the
 * only sort point on the **live projection path** (`workflowRuns[].artifacts`, upserted in
 * publication order).
 */
export function orderArtifactsPrimaryFirst<T extends { primary?: true }>(
  artifacts: readonly T[],
): T[] {
  const index = artifacts.findIndex((artifact) => artifact.primary === true);
  if (index <= 0) return [...artifacts];
  return [artifacts[index]!, ...artifacts.slice(0, index), ...artifacts.slice(index + 1)];
}

/**
 * Card title: the author-written title wins, falling back to the id when absent (the facade's
 * default title is the id anyway).
 */
export function artifactDisplayTitle(artifact: { id: string; title?: string }): string {
  return artifact.title?.trim() || artifact.id;
}

/** The title truncation length on a chip. */
const ARTIFACT_CHIP_TITLE_MAX_LENGTH = 24;

/** How many chips a notification row / hub row shows at once, with the rest folded into “+N”. */
export const ARTIFACT_CHIP_MAX_VISIBLE = 3;

export function truncateArtifactChipTitle(title: string): string {
  return title.length > ARTIFACT_CHIP_TITLE_MAX_LENGTH
    ? `${title.slice(0, ARTIFACT_CHIP_TITLE_MAX_LENGTH)}…`
    : title;
}

/**
 * The three translated strings fed to the four preset renderers. The renderers do not look up i18n
 * themselves (they have to be reusable from the side pane / tab / hub), so each surface builds its
 * own copy in its own intl context.
 */
export function buildPresetLabels(
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): PresetLabels {
  return {
    otherColumn: formatMessage({
      id: "chat.toolCall.workflow.run.artifacts.preset.otherColumn",
    }),
    empty: formatMessage({ id: "chat.toolCall.workflow.run.artifacts.preset.empty" }),
    itemsCount: (count: number) =>
      formatMessage(
        { id: "chat.toolCall.workflow.run.artifacts.preset.items" },
        { count: String(count) },
      ),
  };
}

/**
 * Whether the artifact can be located on the **local filesystem** (the gate for “Show in workspace”
 * and for html's “Open in browser”).
 *
 * The criteria are shared with `shouldOpenAssistantHtmlInBrowser`: paths in a remote workspace (SSH
 * / WSL) do not exist on this machine, and phone remote control has no file tree to jump to either.
 * When `sourcePath` is absent there is not even a path — markdown artifacts and preset boards
 * inherently have no source.
 */
export function canRevealArtifactInWorkspace(params: {
  sourcePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    Boolean(params.sourcePath?.trim()) &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}
