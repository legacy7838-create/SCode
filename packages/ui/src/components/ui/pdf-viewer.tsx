"use client";

import type { HTMLAttributes, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import * as pdfZoom from "@/components/ui/usePdfZoomOverlay.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { createPdfJsDocumentOptions } from "@/lib/pdfJsAssets.js";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

// Aligned with the default segment size of service layer readFileRange, one range request corresponds to one RPC call.
const RANGE_CHUNK_BYTES = 256 * 1024;

// ReportLab's STSong-Light and other Type0 fonts only declare predefined CMap and are not embedded in the PDF.
// Character map; the browser's native PDF preview comes with this resource, while PDF.js must explicitly pass in cMapUrl.
// Using Vite base parsing, Desktop's file:// and Web/mobile phone remote control sub-path deployments both read their respective static resources.
const DOCUMENT_OPTIONS = createPdfJsDocumentOptions(
  typeof import.meta.env?.BASE_URL === "string" ? import.meta.env.BASE_URL : "./",
  globalThis.location?.href ?? "http://localhost/",
);

// The range mode turns off the whole file prefetching and streaming loading, and maintains "only pulling the required pages"; module-level constants ensure reference stability.
// Prevent react-pdf from reloading the document due to changes in options reference.
const RANGE_DOCUMENT_OPTIONS = {
  ...DOCUMENT_OPTIONS,
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: RANGE_CHUNK_BYTES,
};

export interface PdfViewerRangeSource {
  totalBytes: number;
  initialData?: Uint8Array;
  requestRange: (offset: number, length: number) => Promise<Uint8Array>;
}

export type PdfViewerSource = string | Blob | ArrayBuffer | Uint8Array | PdfViewerRangeSource;

function isPdfViewerRangeSource(source: PdfViewerSource): source is PdfViewerRangeSource {
  return (
    typeof source === "object" &&
    source !== null &&
    "requestRange" in source &&
    typeof (source as PdfViewerRangeSource).requestRange === "function"
  );
}

class PdfViewerRangeTransport extends pdfjs.PDFDataRangeTransport {
  private readonly rangeSource: PdfViewerRangeSource;
  private readonly onRequestError: (error: Error) => void;

  constructor(rangeSource: PdfViewerRangeSource, onRequestError: (error: Error) => void) {
    super(rangeSource.totalBytes, rangeSource.initialData ?? null);
    this.rangeSource = rangeSource;
    this.onRequestError = onRequestError;
  }

  override requestDataRange(begin: number, end: number): void {
    this.rangeSource
      .requestRange(begin, end - begin)
      .then((chunk) => {
        this.onDataRange(begin, chunk);
      })
      .catch((error: unknown) => {
        this.onRequestError(error instanceof Error ? error : new Error(String(error)));
      });
  }
}

export interface PdfViewerLabels {
  loading: string;
  loadError: string;
  noData: string;
  previousPage: string;
  nextPage: string;
  pageInput: string;
  zoomIn: string;
  zoomOut: string;
}

const DEFAULT_LABELS: PdfViewerLabels = {
  loading: "Loading PDF…",
  loadError: "Failed to load PDF",
  noData: "No PDF data",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageInput: "Page number",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
};

export interface PdfViewerProps extends HTMLAttributes<HTMLDivElement> {
  source: PdfViewerSource;
  labels?: Partial<PdfViewerLabels>;
  onLoadError?: (error: Error) => void;
}

type PdfDocumentFile = string | Blob | { data: Uint8Array } | { range: PdfViewerRangeTransport };

function normalizePdfSource(
  source: Exclude<PdfViewerSource, PdfViewerRangeSource>,
): PdfDocumentFile {
  if (typeof source === "string" || source instanceof Blob) {
    return source;
  }

  // pdf.js will transfer binary data to the worker, causing the original buffer to be detached;
  // Make a copy to ensure that the caller will not report an error when reusing the same data and reopening the preview.
  if (source instanceof ArrayBuffer) {
    return { data: new Uint8Array(source.slice(0)) };
  }
  return { data: new Uint8Array(source) };
}

export function PdfViewer({ source, labels, onLoadError, className, ...props }: PdfViewerProps) {
  const mergedLabels = { ...DEFAULT_LABELS, ...labels };
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  // renderScale is the value actually passed to <Page>; displayScale is the target magnification seen by the user.
  // Only displayScale (CSS transform preview) is updated during the zoom gesture, and then submitted to renderScale after a pause.
  const [renderScale, setRenderScale] = useState(pdfZoom.DEFAULT_SCALE);
  const [displayScale, setDisplayScale] = useState(pdfZoom.DEFAULT_SCALE);
  const [pageIntrinsicSize, setPageIntrinsicSize] = useState<pdfZoom.PdfPageSize | null>(null);
  const [rangeError, setRangeError] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToTopRef = useRef(false);
  const displayScaleRef = useRef(pdfZoom.DEFAULT_SCALE);
  const renderScaleRef = useRef(pdfZoom.DEFAULT_SCALE);
  const pendingZoomAnchorRef = useRef<pdfZoom.PdfZoomAnchor | null>(null);
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;
  const { clearZoomOverlay, pageViewportRef, stageZoomOverlay } = pdfZoom.usePdfZoomOverlay();

  const rangeTransport = useMemo(() => {
    if (!isPdfViewerRangeSource(source)) {
      return null;
    }
    return new PdfViewerRangeTransport(source, (error) => {
      setRangeError(true);
      onLoadErrorRef.current?.(error);
    });
  }, [source]);

  const file = useMemo<PdfDocumentFile>(() => {
    if (rangeTransport) {
      return { range: rangeTransport };
    }
    return normalizePdfSource(source as Exclude<PdfViewerSource, PdfViewerRangeSource>);
  }, [rangeTransport, source]);

  useEffect(() => {
    return () => {
      // Abort range transfers when document switching/unloading, allowing pdf.js to stop waiting for outstanding segmentation requests
      rangeTransport?.abort();
    };
  }, [rangeTransport]);

  useEffect(() => {
    setNumPages(null);
    setPageNumber(1);
    setPageInput("1");
    setRenderScale(pdfZoom.DEFAULT_SCALE);
    setDisplayScale(pdfZoom.DEFAULT_SCALE);
    setPageIntrinsicSize(null);
    setRangeError(false);
    displayScaleRef.current = pdfZoom.DEFAULT_SCALE;
    renderScaleRef.current = pdfZoom.DEFAULT_SCALE;
    pendingScrollToTopRef.current = false;
    pendingZoomAnchorRef.current = null;
    clearZoomOverlay();
  }, [clearZoomOverlay, file]);

  const goToPage = useCallback(
    (target: number) => {
      if (numPages === null) {
        return;
      }
      const clamped = Math.min(Math.max(1, Math.round(target)), numPages);
      setPageInput(String(clamped));
      if (clamped !== pageNumber) {
        clearZoomOverlay();
        setPageIntrinsicSize(null);
        pendingZoomAnchorRef.current = null;
        pendingScrollToTopRef.current = true;
        setPageNumber(clamped);
      }
    },
    [clearZoomOverlay, numPages, pageNumber],
  );

  const handlePageRenderSuccess = useCallback(
    (completedScale: number, originalWidth: number, originalHeight: number) => {
      // The old render task of react-pdf may call back only after the new magnification is submitted, and the old callback cannot be allowed to remove the overlay in advance.
      if (Math.abs(completedScale - renderScaleRef.current) > 0.001) {
        return;
      }

      setPageIntrinsicSize((current) =>
        pdfZoom.resolvePdfPageSize(current, originalWidth, originalHeight),
      );
      clearZoomOverlay();
      const container = scrollContainerRef.current;
      const pendingScrollToTop = pendingScrollToTopRef.current;
      pendingScrollToTopRef.current = false;
      if (!container) {
        return;
      }
      if (pendingScrollToTop) {
        container.scrollTop = 0;
      }
    },
    [clearZoomOverlay],
  );

  const commitPageInput = useCallback(() => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(parsed)) {
      setPageInput(String(pageNumber));
      return;
    }
    goToPage(parsed);
  }, [goToPage, pageInput, pageNumber]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // The cursor semantics of the arrow keys are retained in the page number input box.
      if ((event.target as HTMLElement).tagName === "INPUT") {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToPage(pageNumber - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goToPage(pageNumber + 1);
      }
    },
    [goToPage, pageNumber],
  );

  const documentLoaded = numPages !== null;

  const zoomTo = useCallback(
    (target: number, pointer?: pdfZoom.PdfZoomPointer) => {
      const current = displayScaleRef.current;
      const next = pdfZoom.clampScale(target);
      if (next === current) {
        return;
      }
      const container = scrollContainerRef.current;
      const pageViewport = pageViewportRef.current;
      pendingZoomAnchorRef.current =
        container && pageViewport
          ? pdfZoom.capturePdfZoomAnchor(container, pageViewport, pointer)
          : null;
      displayScaleRef.current = next;
      setDisplayScale(next);
    },
    [pageViewportRef],
  );

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const container = scrollContainerRef.current;
    const pageViewport = pageViewportRef.current;
    pendingZoomAnchorRef.current = null;
    if (anchor && container && pageViewport) {
      // The zoom layout is corrected after submission to keep the content point under the pointer stable when crossing the "center/horizontal scroll" boundary.
      pdfZoom.restorePdfZoomAnchor(container, pageViewport, anchor);
    }
  }, [displayScale, pageViewportRef]);

  // After the gesture pauses, the preview magnification is submitted to <Page> for re-rendering at once; the timer is reset every time displayScale changes.
  useEffect(() => {
    if (displayScale === renderScale) {
      return;
    }
    const timer = window.setTimeout(() => {
      // react-pdf will unload the old canvas when the scale key changes and hide the new canvas that has not yet been drawn.
      // Copies the current bitmap as a double-buffered overlay before submitting until the new canvas's onRenderSuccess arrives.
      const pageViewport = pageViewportRef.current;
      if (pageViewport) {
        stageZoomOverlay(pageViewport.offsetWidth, pageViewport.offsetHeight);
      }
      renderScaleRef.current = displayScale;
      setRenderScale(displayScale);
    }, pdfZoom.ZOOM_COMMIT_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [displayScale, renderScale, stageZoomOverlay]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !documentLoaded) {
      return;
    }

    const zoomWithAppleModifier = isAppleKeyboardPlatform();
    const handleWheelZoom = (event: WheelEvent) => {
      // macOS is bound to command, and other platforms (Windows/Linux) are bound to ctrl
      const zoomModifierPressed = zoomWithAppleModifier ? event.metaKey : event.ctrlKey;
      if (!zoomModifierPressed) {
        return;
      }
      // Modifier keys + scroll wheel are exclusively used as zoom gestures and no longer scroll the page content
      event.preventDefault();
      if (event.deltaY === 0) {
        return;
      }
      zoomTo(
        displayScaleRef.current * Math.exp(-event.deltaY * pdfZoom.WHEEL_ZOOM_SENSITIVITY),
        event,
      );
    };

    // React's onWheel delegate is a passive listener on the root, and preventDefault does not take effect;
    // Directly hang non-passive native monitoring here to avoid simultaneous scrolling of the page during zooming.
    container.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheelZoom);
    };
  }, [documentLoaded, zoomTo]);

  const controlsDisabled = numPages === null;
  const zoomPercent = Math.round(displayScale * 100);
  const zoomPreviewScale = displayScale / renderScale;
  const pageDisplaySize = pdfZoom.getPdfPageDisplaySize(pageIntrinsicSize, displayScale);
  const pagePreviewStyle = pdfZoom.getPdfPagePreviewStyle(
    pageDisplaySize !== undefined,
    zoomPreviewScale,
  );

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn("flex h-full min-h-0 flex-col outline-none", className)}
      {...props}
    >
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-max p-4">
          {rangeError ? (
            <div className="p-3 text-ui-base text-destructive">{mergedLabels.loadError}</div>
          ) : (
            <div ref={pageViewportRef} className="relative" style={pageDisplaySize}>
              <div style={pagePreviewStyle}>
                <Document
                  file={file}
                  options={rangeTransport ? RANGE_DOCUMENT_OPTIONS : DOCUMENT_OPTIONS}
                  onLoadSuccess={(document) => {
                    setNumPages(document.numPages);
                    const clamped = Math.min(pageNumber, document.numPages);
                    setPageNumber(clamped);
                    setPageInput(String(clamped));
                  }}
                  onLoadError={onLoadError}
                  loading={
                    <div className="p-3 text-ui-base text-foreground-subtle">
                      {mergedLabels.loading}
                    </div>
                  }
                  error={
                    <div className="p-3 text-ui-base text-destructive">
                      {mergedLabels.loadError}
                    </div>
                  }
                  noData={
                    <div className="p-3 text-ui-base text-foreground-subtle">
                      {mergedLabels.noData}
                    </div>
                  }
                >
                  <Page
                    pageNumber={pageNumber}
                    scale={renderScale}
                    renderAnnotationLayer={false}
                    onRenderSuccess={(page) =>
                      handlePageRenderSuccess(
                        page.width / page.originalWidth,
                        page.originalWidth,
                        page.originalHeight,
                      )
                    }
                    className="shadow-md"
                  />
                </Document>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-1 border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.previousPage}
          disabled={controlsDisabled || pageNumber <= 1}
          onClick={() => goToPage(pageNumber - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex items-center gap-1 text-ui-base text-foreground-subtle">
          <input
            value={pageInput}
            inputMode="numeric"
            disabled={controlsDisabled}
            aria-label={mergedLabels.pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPageInput();
              }
            }}
            onBlur={commitPageInput}
            className="h-6 w-10 rounded-md border border-input-border bg-input px-1 text-center text-ui-base text-foreground outline-none transition-colors hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused disabled:pointer-events-none disabled:opacity-50"
          />
          <span>/ {numPages ?? "-"}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.nextPage}
          disabled={controlsDisabled || numPages === null || pageNumber >= numPages}
          onClick={() => goToPage(pageNumber + 1)}
        >
          <ChevronRightIcon />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.zoomOut}
          disabled={controlsDisabled || displayScale <= pdfZoom.MIN_SCALE}
          onClick={() => zoomTo(displayScale - pdfZoom.ZOOM_STEP)}
        >
          <ZoomOutIcon />
        </Button>
        <span className="w-11 text-center text-ui-base text-foreground-subtle tabular-nums">
          {zoomPercent}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.zoomIn}
          disabled={controlsDisabled || displayScale >= pdfZoom.MAX_SCALE}
          onClick={() => zoomTo(displayScale + pdfZoom.ZOOM_STEP)}
        >
          <ZoomInIcon />
        </Button>
      </div>
    </div>
  );
}
