import { Suspense, lazy } from "react";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";

// react-pdf (including pdf.js and worker) is large in size, and lazy loading allows it to enter the bundle only when the PDF preview is opened for the first time.
// Don't slow down the launch of sessions that don't use PDFs.
const PdfViewer = lazy(() =>
  import("@/components/ui/pdf-viewer.js").then((module) => ({
    default: module.PdfViewer,
  })),
);

interface PdfPreviewContentProps {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
}

export function PdfPreviewContent({ source, labels }: PdfPreviewContentProps) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      <PdfViewer source={source} labels={labels} className="h-full" />
    </Suspense>
  );
}
