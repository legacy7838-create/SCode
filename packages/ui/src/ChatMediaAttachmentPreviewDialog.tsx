import { lazy, Suspense, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// react-pdf/pdfjs relies on the browser DOMMatrix during the module import phase; the dialog list will also load this component.
// Causes Node tests and non-PDF conversations to trigger browser-specific dependencies before actually opening the preview. Lazy loading only when rendering PDF,
// Keep the loading behavior of the image/video branch unchanged while avoiding unconditional PDF.js side effects from the dialog module.
const LazyPdfViewer = lazy(async () => {
  const module = await import("@/components/ui/pdf-viewer.js");
  return { default: module.PdfViewer };
});

export interface ChatMediaAttachmentPreviewTarget {
  filename: string;
  mediaType: string;
  url?: string;
  pdfSource?: PdfViewerSource;
}

export function ChatMediaAttachmentPreviewDialog({
  attachment,
  open,
  onOpenChange,
  loading = false,
  error = false,
}: {
  attachment: ChatMediaAttachmentPreviewTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isVideo = attachment?.mediaType.startsWith("video/") === true;
  const isPdf = attachment?.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  useEffect(() => {
    setVideoState("loading");
  }, [attachment?.mediaType, attachment?.url, open]);
  const title = intl.formatMessage({
    id: "chat.attachments.preview.title",
  });
  const loadingLabel = intl.formatMessage({
    id: isVideo
      ? "chat.attachments.preview.videoLoading"
      : isPdf
        ? "chat.attachments.preview.pdfLoading"
        : "chat.attachments.preview.loading",
  });
  const unavailableLabel = intl.formatMessage({
    id: isVideo
      ? "chat.attachments.preview.videoUnavailable"
      : isPdf
        ? "chat.attachments.preview.pdfUnavailable"
        : "chat.attachments.preview.unavailable",
  });
  const unsupportedVideoLabel = intl.formatMessage({
    id: "chat.attachments.preview.videoUnsupported",
  });
  const pdfViewerLabels: Partial<PdfViewerLabels> | undefined = isPdf
    ? {
        loading: loadingLabel,
        loadError: unavailableLabel,
        noData: intl.formatMessage({ id: "codeViewer.pdf.noData" }),
        previousPage: intl.formatMessage({ id: "codeViewer.pdf.previousPage" }),
        nextPage: intl.formatMessage({ id: "codeViewer.pdf.nextPage" }),
        pageInput: intl.formatMessage({ id: "codeViewer.pdf.pageInput" }),
        zoomIn: intl.formatMessage({ id: "codeViewer.pdf.zoomIn" }),
        zoomOut: intl.formatMessage({ id: "codeViewer.pdf.zoomOut" }),
      }
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-xl max-w-5xl gap-0 overflow-hidden p-0" showCloseButton>
        <DialogHeader className="gap-1 border-b border-popover-border px-4 py-3 pr-12">
          <DialogTitle className="truncate">{attachment?.filename ?? title}</DialogTitle>
          <DialogDescription className="truncate text-ui-base">
            {attachment?.mediaType ?? title}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[72vh] min-h-64 items-center justify-center bg-background-alt p-4">
          {attachment?.pdfSource || attachment?.url ? (
            isPdf ? (
              <Suspense
                fallback={
                  <p className="text-ui-base text-muted-foreground" role="status">
                    {loadingLabel}
                  </p>
                }
              >
                <LazyPdfViewer
                  source={attachment.pdfSource ?? attachment.url!}
                  className="h-[calc(72vh-2rem)] w-full"
                  labels={pdfViewerLabels}
                />
              </Suspense>
            ) : isVideo ? (
              videoState === "unsupported" ? (
                <p
                  className="max-w-xl px-6 text-center text-ui-base text-muted-foreground"
                  role="alert"
                >
                  {unsupportedVideoLabel}
                </p>
              ) : (
                <>
                  {videoState === "loading" ? (
                    <p className="text-ui-base text-muted-foreground" role="status">
                      {loadingLabel}
                    </p>
                  ) : null}
                  {/* Being able to send MIME does not mean that the current Chromium can decode the container or codec;
                  media error only closes the preview status and cannot reversely modify attachments or send facts. */}
                  <video
                    controls
                    playsInline
                    className={`max-h-[calc(72vh-2rem)] max-w-full rounded-lg ${
                      videoState === "loading" ? "invisible absolute" : ""
                    }`}
                    src={attachment.url}
                    onLoadedMetadata={() => setVideoState("ready")}
                    onError={() => setVideoState("unsupported")}
                  />
                </>
              )
            ) : (
              <img
                alt={attachment.filename}
                className="max-h-[calc(72vh-2rem)] max-w-full rounded-lg object-contain"
                src={attachment.url}
              />
            )
          ) : error ? (
            <p className="px-6 text-center text-ui-base text-destructive" role="alert">
              {unavailableLabel}
            </p>
          ) : loading ? (
            <p className="text-ui-base text-muted-foreground" role="status">
              {loadingLabel}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
