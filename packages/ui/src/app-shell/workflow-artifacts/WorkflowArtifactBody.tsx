import { lazy, Suspense, useMemo } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import {
  ArtifactMetadataCard,
  ArtifactNotice,
  WorkflowArtifactHtmlCard,
} from "@/app-shell/workflow-artifacts/WorkflowArtifactCards.js";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { encodeBytesToBase64 } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import type { Theme } from "@/useTheme.js";

/**
 * The body of the `workflow-artifact` tab.
 *
 * ⚠ Terminology: artifact = the output of a script published to users via `artifact.*`.
 *
 * **Zero new rendering dependencies**: pdf/picture/markdown/office/all text will run through the existing leaf viewer and the preset Kanban board
 * Four renderers for 4b. The criterion for dispatch is the `contentType` on the journal record - it is calculated by the driver according to the extension table.
 * It can be overridden by `opts.contentType` and is the only type truth of this link (the store will sniff it again when it is read back.
 * That value is intentionally not used).
 *
 * **Deliberately not making iframe**: renderer does not have CSP, sandbox combination of `allow-scripts allow-same-origin`
 * Equivalent to escape. html therefore uses existing browser tabs (see `WorkflowArtifactHtmlCard`).
 */

// Three heavyweight viewers are lazy loading: pdf.js / docx-preview / xlsx wasm are each hundreds of KB,
// And the vast majority of sessions never open the product tab. The existing previewPane* package itself already comes with Suspense.
const PdfPreviewContent = lazy(() =>
  import("@/previewPanePdfContent.js").then((module) => ({ default: module.PdfPreviewContent })),
);
const PptxPreviewContent = lazy(() =>
  import("@/previewPanePptxContent.js").then((module) => ({ default: module.PptxPreviewContent })),
);
const PreviewPaneOfficeContent = lazy(() =>
  import("@/previewPaneOfficeContent.js").then((module) => ({
    default: module.PreviewPaneOfficeContent,
  })),
);

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Text class: The main text is rendered using a fixed-width code viewer. `text/markdown` is not among them - it uses MessageResponse. */
function textLanguageFor(contentType: string): string | undefined {
  if (contentType === "application/json") return "json";
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain") return "text";
  if (contentType.startsWith("text/")) return "text";
  return undefined;
}

interface WorkflowArtifactBodyProps {
  artifact: WorkflowRunArtifactView;
  /** The version being viewed; the bytes of the content product are read against it. */
  version: number;
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  objectUrl: string | null;
  /** The status of byte reading: loading and error are both presented by this component (each viewer's own loading only covers parsing). */
  loading: boolean;
  error: string | null;
  /** The entry stream of the preset billboard; the content product is empty. */
  items: readonly ArtifactItem[];
  theme: Theme;
  resolvedTheme: "light" | "dark";
  /** "Open in browser" of html; if absent, only the prompt will be displayed. */
  onOpenBrowserUrl?: (url: string) => void;
  /** An absolute path on the local file system (only if desktop-local ∧ `sourcePath` is present). */
  localSourcePath?: string;
  /** "Show in workspace": reveal the file tree with a bound path; this button will not appear on cards that are absent or have no renderer. */
  onReveal?: () => void;
  /** Check whether you are viewing the latest version - the original files of the old version of the workspace have long been overwritten, so the html preview is only open to the latest version. */
  isLatestVersion: boolean;
  /** The metadata (including the spec of the preset kanban board) is still being read; the preset text is used to distinguish "not yet" from "really not yet". */
  metadataLoading: boolean;
}

export function WorkflowArtifactBody(props: WorkflowArtifactBodyProps) {
  const { intl } = useZCodeIntl();
  const { artifact } = props;

  // The preset kanban board does not read bytes and is drawn directly.
  if (isArtifactPresetKind(artifact.kind)) {
    const labels = buildPresetLabels((descriptor, values) =>
      intl.formatMessage(descriptor, values),
    );
    return (
      <div className="h-full min-h-0 overflow-auto p-4" data-artifact-body="preset">
        <ArtifactPresetBody
          artifact={artifact}
          items={props.items}
          labels={labels}
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          // Spec can only be brought back by journal query, so you cannot say "cannot read" before the metadata is read——
          // Otherwise, the wrong copy will flash once every time the board is opened.
          {...(props.metadataLoading
            ? {}
            : {
                missingLabel: intl.formatMessage({
                  id: "chat.toolCall.workflow.run.artifacts.unavailable",
                }),
              })}
        />
      </div>
    );
  }

  if (props.error !== null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-error"
        tone="error"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
        detail={props.error}
      />
    );
  }
  if (props.loading || props.bytes === null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-loading"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loading" })}
      />
    );
  }

  return <WorkflowArtifactContent {...props} bytes={props.bytes} />;
}

/**
 * Dispatch after the byte is ready. The reason for splitting into the second component is hooks: markdown decoding, office base64
 * `useMemo` must be used for the return trip, and they cannot be skipped in the frame where "the bytes have not been read yet" (the number of hooks must be constant).
 */
function WorkflowArtifactContent({
  artifact,
  bytes,
  blob,
  objectUrl,
  theme,
  resolvedTheme,
  onOpenBrowserUrl,
  onReveal,
  localSourcePath,
  isLatestVersion,
}: WorkflowArtifactBodyProps & { bytes: Uint8Array<ArrayBuffer> }) {
  const { intl } = useZCodeIntl();
  const pdfLabels = usePdfViewerLabels();
  const pptxLabels = usePptxViewerLabels();
  const contentType = artifact.contentType ?? "application/octet-stream";

  // The three text states (markdown/code/html source) share one decoding. TextDecoder is always present in renderer.
  const text = useMemo(() => {
    if (
      contentType !== "text/markdown" &&
      contentType !== "text/html" &&
      textLanguageFor(contentType) === undefined
    ) {
      return undefined;
    }
    return new TextDecoder().decode(bytes);
  }, [bytes, contentType]);

  // The office viewer only eats `FileBinaryPreview.dataBase64`, so a return encoding is performed here.
  // Only counts if it's really an office file - 20 MiB of base64 shouldn't be counted for a PDF.
  const officePreview = useMemo<FileBinaryPreview | null>(() => {
    if (contentType !== DOCX_CONTENT_TYPE && contentType !== XLSX_CONTENT_TYPE) return null;
    return {
      path: artifact.sourcePath ?? artifact.id,
      dataBase64: encodeBytesToBase64(bytes),
      totalBytes: bytes.length,
    };
  }, [artifact.id, artifact.sourcePath, bytes, contentType]);

  // pptx viewer eats ArrayBuffer. `slice` creates an independent buffer: Uint8Array's buffer may have an offset.
  const pptxBuffer = useMemo(
    () =>
      contentType === PPTX_CONTENT_TYPE
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : null,
    [bytes, contentType],
  );

  if (contentType === "text/markdown") {
    return (
      // Markdown must **pass the theme**: the portfolio has been modified once with a deep background and deep characters (the renderer selects the color of the code block according to the theme).
      <div className="h-full min-h-0 overflow-y-auto px-4 py-4" data-artifact-body="markdown">
        <MessageResponse
          className="mx-auto w-full min-w-0 max-w-4xl break-words text-foreground"
          theme={theme}
        >
          {text ?? ""}
        </MessageResponse>
      </div>
    );
  }

  if (contentType === "application/pdf") {
    return (
      <div className="h-full min-h-0" data-artifact-body="pdf">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          {/* PdfViewerSource accepts Blobs - no need to convert them to files or use range transport. */}
          <PdfPreviewContent labels={pdfLabels} source={blob ?? new Blob([bytes])} />
        </Suspense>
      </div>
    );
  }

  if (contentType.startsWith("image/")) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background-alt p-4"
        data-artifact-body="image"
      >
        {objectUrl === null ? (
          <ArtifactNotice
            text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
            tone="error"
          />
        ) : (
          <img
            alt={artifact.title ?? artifact.id}
            className="max-h-full max-w-full object-contain"
            data-testid="workflow-artifact-image"
            src={objectUrl}
          />
        )}
      </div>
    );
  }

  if (contentType === PPTX_CONTENT_TYPE && pptxBuffer !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="pptx">
        <Suspense fallback={<ArtifactNotice text={pptxLabels.loading} />}>
          <PptxPreviewContent
            data={pptxBuffer}
            fileName={artifact.sourcePath ?? artifact.id}
            labels={pptxLabels}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (officePreview !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="office">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          <PreviewPaneOfficeContent
            error={null}
            kind={contentType === XLSX_CONTENT_TYPE ? "excel" : "docx"}
            loading={false}
            preview={officePreview}
            resolvedTheme={resolvedTheme}
            sourcePath={artifact.sourcePath ?? artifact.id}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (contentType === "text/html") {
    return (
      <WorkflowArtifactHtmlCard
        artifact={artifact}
        bytes={bytes.length}
        isLatestVersion={isLatestVersion}
        {...(localSourcePath === undefined ? {} : { localSourcePath })}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onReveal === undefined ? {} : { onReveal })}
      />
    );
  }

  const language = textLanguageFor(contentType);
  if (language !== undefined && text !== undefined) {
    return (
      <div className="h-full min-h-0 overflow-auto" data-artifact-body="text">
        <CodeBlock appTheme={theme} code={text} language={language} showLineNumbers />
      </div>
    );
  }

  // Off-table types (`application/octet-stream` and everything no one recognizes): give a **metadata card**,
  // Don’t pretend to be able to render. The card says "show in workspace" - that's the only thing this product can do with it (no "download":
  // The renderer does not have any hosting capabilities for saving bytes to user files).
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes.length}
      note={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.unsupported" })}
      testId="workflow-artifact-unsupported"
      {...(onReveal === undefined
        ? {}
        : {
            action: {
              label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
              onActivate: onReveal,
              testId: "workflow-artifact-unsupported-reveal",
            },
          })}
    />
  );
}
