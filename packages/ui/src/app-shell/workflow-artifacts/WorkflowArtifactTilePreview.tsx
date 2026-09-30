import { useMemo } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  artifactFileBadge,
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import { cn } from "@/components/lib/utils.js";
import {
  ArtifactSheetGlyph,
  type WorkflowCompletionArtifact,
} from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import { useWorkflowRunArtifactBytes } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";

/**
 * Preview area of ​​product tiles (commonly used in side panel galleries): an abbreviation of the product itself.
 *
 * - markdown / plain text: press 2× wide typesetting at the beginning of the document and then `scale(0.5)` - it is an abbreviation of the content, not to reduce the interface font size;
 * - CSV: mini table of first few rows;
 * - Image: the rendering itself;
 * - chart/table/metrics/board: `ArtifactPresetBody` compact, centered in the box according to natural size, with report
 *   Entries are real-time long;
 * - The rest (PDF / binary / very large file): paper glyph + extension emblem.
 *
 * The two frames are in the same frame and drawn in the same way: the frame for the delivery row (160 × 100) and the tile frame for the side panel gallery (130–180px for one column). no smaller
 * The file - the preview can either be read clearly or not drawn.
 *
 * When the bytes have not yet arrived, leave the entire block blank (no flashing the skeleton screen, no drawing a glyph first and then replacing it). The byte path is the same as the product tab
 * Chunked reading (journal-backed, cold recovery too); no reading beyond the upper limit - the card is part of the transcription and should not be 20 MiB per copy
 * The product pulls the entire link.
 */
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
/** Document thumbnails only decode so many bytes at the beginning: one screen of thumbnails cannot hold more, and the entire decoding is in vain. */
const TEXT_DECODE_BYTES = 8 * 1024;
const TEXT_PREVIEW_CHARS = 1_600;
const CSV_PREVIEW_ROWS = 6;
const CSV_PREVIEW_COLUMNS = 5;
const CSV_CELL_MAX_CHARS = 28;

type PreviewMode = "markdown" | "csv" | "text" | "image";

function previewModeFor(artifact: {
  kind: WorkflowCompletionArtifact["kind"];
  contentType?: string;
  bytes?: number;
}): PreviewMode | undefined {
  const contentType = artifact.contentType?.split(";")[0]?.trim() ?? "";
  const bytes = artifact.bytes;
  if (artifact.kind === "markdown" || contentType === "text/markdown") {
    return bytes !== undefined && bytes > TEXT_PREVIEW_MAX_BYTES ? undefined : "markdown";
  }
  if (contentType.startsWith("image/")) {
    return bytes !== undefined && bytes > IMAGE_PREVIEW_MAX_BYTES ? undefined : "image";
  }
  if (bytes !== undefined && bytes > TEXT_PREVIEW_MAX_BYTES) return undefined;
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain" || contentType === "application/json") return "text";
  return undefined;
}

/** The smallest CSV reading method: only recognizes commas and paired quotation marks, enough to draw an abbreviation; it is not a parser. */
function csvPreviewRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += char;
    }
    cells.push(cell);
    rows.push(
      cells.slice(0, CSV_PREVIEW_COLUMNS).map((value) => {
        const trimmed = value.trim();
        return trimmed.length > CSV_CELL_MAX_CHARS
          ? `${trimmed.slice(0, CSV_CELL_MAX_CHARS)}…`
          : trimmed;
      }),
    );
    if (rows.length >= CSV_PREVIEW_ROWS) break;
  }
  return rows;
}

function decodeHead(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes.subarray(0, TEXT_DECODE_BYTES))
    .slice(0, TEXT_PREVIEW_CHARS);
}

/** Empty placeholders: Bytes on the way. Testers and callers use it to distinguish between "not yet arrived" and "cannot draw". */
function Pending() {
  return <span className="absolute inset-0" data-testid="workflow-artifact-preview-pending" />;
}

/** The bottom of the document thumbnail fades into the panel color: the truncated document looks "still there", not "broken". Boards and pictures don't want it. */
function Fade() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[28%]"
      style={{ background: "linear-gradient(to bottom, transparent, var(--color-panel))" }}
    />
  );
}

export function WorkflowArtifactTilePreview({
  artifact,
  runId,
  sessionId,
  theme,
}: {
  artifact: WorkflowCompletionArtifact;
  sessionId: string;
  runId: string;
  theme: Theme;
}) {
  const { intl } = useZCodeIntl();
  const preset = isArtifactPresetKind(artifact.kind);
  const mode = preset ? undefined : previewModeFor(artifact);
  const bytesState = useWorkflowRunArtifactBytes({
    sessionId,
    runId,
    artifactId: artifact.id,
    version: artifact.version ?? 1,
    enabled: mode !== undefined,
  });
  const dataState = useWorkflowRunArtifactData({
    sessionId,
    runId,
    artifactId: artifact.id,
    ...(artifact.itemCount === undefined ? {} : { itemCount: artifact.itemCount }),
    enabled: preset,
  });
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );
  const text = useMemo(
    () =>
      bytesState.bytes !== null && (mode === "markdown" || mode === "csv" || mode === "text")
        ? decodeHead(bytesState.bytes)
        : undefined,
    [bytesState.bytes, mode],
  );
  const rows = useMemo(
    () => (mode === "csv" && text !== undefined ? csvPreviewRows(text) : []),
    [mode, text],
  );

  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  const glyph = <ArtifactSheetGlyph {...(badge === undefined ? {} : { badge })} />;

  if (preset) {
    // Spec can only be brought back by the journal; if it is not yet available, leave it blank without saying "cannot render". It's only when it's broken that it's broken.
    if (artifact.spec === undefined) return <Pending />;
    return (
      <div
        className="absolute inset-0 flex flex-col overflow-hidden p-2.5 [justify-content:safe_center]"
        data-preview-mode="preset"
        data-testid="workflow-artifact-preview-body"
      >
        <ArtifactPresetBody
          artifact={{ kind: artifact.kind, spec: artifact.spec }}
          compact
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          items={dataState.items}
          labels={labels}
        />
      </div>
    );
  }

  if (mode === undefined) return glyph;
  if (bytesState.loading || (bytesState.bytes === null && bytesState.error === null)) {
    return <Pending />;
  }
  if (bytesState.error !== null) return glyph;

  if (mode === "image") {
    return bytesState.objectUrl === null ? (
      glyph
    ) : (
      <img
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        data-preview-mode="image"
        data-testid="workflow-artifact-preview-body"
        src={bytesState.objectUrl}
      />
    );
  }

  if (mode === "csv") {
    return (
      <>
        <div
          className="wf-preview-doc"
          data-preview-mode="csv"
          data-testid="workflow-artifact-preview-body"
        >
          <table className="w-full border-collapse font-mono text-ui-caption tabular-nums">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      className={cn(
                        "whitespace-nowrap border-b py-1.5 pr-3 text-foreground",
                        rowIndex === 0
                          ? "border-border font-sans text-ui-sm font-medium uppercase tracking-wide text-foreground-subtlest"
                          : "border-[var(--color-workflow-rule)]",
                      )}
                      key={cellIndex}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Fade />
      </>
    );
  }

  return (
    <>
      <div
        className="wf-preview-doc"
        data-preview-mode={mode}
        data-testid="workflow-artifact-preview-body"
      >
        {mode === "markdown" ? (
          // markdown must **pass theme** (the renderer selects the code block color according to theme).
          <MessageResponse className="w-full min-w-0 break-words text-foreground" theme={theme}>
            {text ?? ""}
          </MessageResponse>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-ui-caption text-foreground">
            {text ?? ""}
          </pre>
        )}
      </div>
      <Fade />
    </>
  );
}
