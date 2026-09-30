import { useMemo } from "react";
import type { PdfViewerLabels } from "@/components/ui/pdf-viewer.js";
import type { PptxPreviewViewerLabels } from "@/components/ui/pptx-preview-viewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Localized labels for the two heavyweight leaf viewers (PDF / PPTX).
 *
 * The reason for extracting this: both `PreviewPane` and dwf's `workflow-artifact` tab feed the
 * same `codeViewer.*` copy to the same pair of components. Writing one copy each means one of the
 * two misses a translation or a key — and both label objects are interfaces that **require every
 * field**, so a missing one is a type error while a missing translation only shows up at runtime as
 * a message id.
 */
export function usePdfViewerLabels(): PdfViewerLabels {
  const { intl } = useZCodeIntl();
  return useMemo(
    () => ({
      loading: intl.formatMessage({ id: "codeViewer.pdf.loading" }),
      loadError: intl.formatMessage({ id: "codeViewer.pdf.loadError" }),
      noData: intl.formatMessage({ id: "codeViewer.pdf.noData" }),
      previousPage: intl.formatMessage({ id: "codeViewer.pdf.previousPage" }),
      nextPage: intl.formatMessage({ id: "codeViewer.pdf.nextPage" }),
      pageInput: intl.formatMessage({ id: "codeViewer.pdf.pageInput" }),
      zoomIn: intl.formatMessage({ id: "codeViewer.pdf.zoomIn" }),
      zoomOut: intl.formatMessage({ id: "codeViewer.pdf.zoomOut" }),
    }),
    [intl],
  );
}

export function usePptxViewerLabels(): PptxPreviewViewerLabels {
  const { intl } = useZCodeIntl();
  return useMemo<PptxPreviewViewerLabels>(
    () => ({
      loading: intl.formatMessage({ id: "codeViewer.pptx.loading" }),
      loadError: intl.formatMessage({ id: "codeViewer.pptx.loadError" }),
      noSlides: intl.formatMessage({ id: "codeViewer.pptx.noSlides" }),
      previousPage: intl.formatMessage({ id: "codeViewer.pptx.previousPage" }),
      nextPage: intl.formatMessage({ id: "codeViewer.pptx.nextPage" }),
      pageInput: intl.formatMessage({ id: "codeViewer.pptx.pageInput" }),
      zoomIn: intl.formatMessage({ id: "codeViewer.pptx.zoomIn" }),
      zoomOut: intl.formatMessage({ id: "codeViewer.pptx.zoomOut" }),
      thumbnails: intl.formatMessage({ id: "codeViewer.pptx.thumbnails" }),
      thumbnail: (pageNumber) =>
        intl.formatMessage({ id: "codeViewer.pptx.thumbnail" }, { pageNumber: String(pageNumber) }),
      exportPdf: intl.formatMessage({ id: "codeViewer.pptx.exportPdf" }),
      exportingPdf: intl.formatMessage({ id: "codeViewer.pptx.exportingPdf" }),
      exportPdfSuccess: (path) =>
        intl.formatMessage({ id: "codeViewer.pptx.exportPdfSuccess" }, { path }),
      exportPdfFailed: intl.formatMessage({ id: "codeViewer.pptx.exportPdfFailed" }),
      selectElement: intl.formatMessage({ id: "codeViewer.pptx.selectElement" }),
      exitElementSelection: intl.formatMessage({ id: "codeViewer.pptx.exitElementSelection" }),
      aiEdit: intl.formatMessage({ id: "codeViewer.pptx.aiEdit" }),
      commentPlaceholder: intl.formatMessage({ id: "codeViewer.pptx.commentPlaceholder" }),
      cancelAiEdit: intl.formatMessage({ id: "codeViewer.pptx.cancelAiEdit" }),
      addToConversation: intl.formatMessage({ id: "codeViewer.pptx.addToConversation" }),
      referencedPageMissing: (pageNumber) =>
        intl.formatMessage(
          { id: "chat.pptxElements.previewPageMissing" },
          { pageNumber: String(pageNumber) },
        ),
      referencedSourceChanged: (pageNumber) =>
        intl.formatMessage(
          { id: "chat.pptxElements.previewSourceChanged" },
          { pageNumber: String(pageNumber) },
        ),
    }),
    [intl],
  );
}
