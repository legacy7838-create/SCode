import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderAsync, type Options } from "docx-preview";
import {
  calculateDocxPreviewFit,
  installDocumentLinkSafety,
  type DocxPreviewFit,
} from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

const DOCX_RENDER_OPTIONS = {
  breakPages: true,
  debug: false,
  experimental: true,
  ignoreFonts: false,
  ignoreHeight: false,
  // docx-preview@0.4.0 will merge files with the same paper size when this option is false.
  // However, adjacent sections with different page margins will cause the main text after the cover to lose pagination and use the zero margin of the cover.
  // Keep the default behavior of the official preview, giving priority to retaining OOXML section boundaries and pgMar of each page.
  ignoreLastRenderedPageBreak: true,
  ignoreWidth: false,
  inWrapper: true,
  renderAltChunks: false,
  renderChanges: false,
  renderComments: false,
  renderEndnotes: true,
  renderFooters: true,
  renderFootnotes: true,
  renderHeaders: true,
  useBase64URL: true,
} satisfies Partial<Options>;

const DOCX_PAGE_BOX_SHADOW = "0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)";

let nextDocxPreviewClassId = 0;

function createDocxPreviewClassName(): string {
  nextDocxPreviewClassId += 1;
  return `zcode-docx-preview-${nextDocxPreviewClassId}`;
}

function isSameDocxPreviewFit(current: DocxPreviewFit | null, next: DocxPreviewFit): boolean {
  return (
    current !== null &&
    Math.abs(current.scale - next.scale) < 0.001 &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5
  );
}

export function PreviewPaneOfficeDocxContent({
  buffer,
  errorMessage,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewClassName] = useState(createDocxPreviewClassName);
  const [fit, setFit] = useState<DocxPreviewFit | null>(null);
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading");

  const updateFit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || renderState !== "ready") {
      return;
    }

    const next = calculateDocxPreviewFit({
      availableWidth: viewport.clientWidth,
      naturalHeight: content.offsetHeight,
      naturalWidth: content.offsetWidth,
    });
    if (!next) {
      return;
    }

    setFit((current) => {
      if (isSameDocxPreviewFit(current, next)) {
        return current;
      }
      // Debugging instructions: When dragging the Preview Pane, the ResizeObserver will be triggered by frame; only debug is used for high-frequency size tracks.
      // Production builds are not dropped to disk to prevent responsive layout from amplifying the log volume to the same order of magnitude as the resize event.
      logger.debug("[PreviewPane] docx preview width synced", {
        path: sourcePath,
        availableWidth: viewport.clientWidth,
        naturalWidth: content.offsetWidth,
        scale: next.scale,
      });
      return next;
    });
  }, [renderState, sourcePath]);

  useEffect(() => {
    const visibleContainer = renderContainerRef.current;
    if (!visibleContainer) {
      return;
    }

    let active = true;
    let disposeLinkSafety: (() => void) | undefined;
    const className = previewClassName;
    const renderRoot = document.createElement("div");
    const styleContainer = document.createElement("div");
    const bodyContainer = document.createElement("div");
    renderRoot.dataset.docxRenderRoot = "";
    styleContainer.dataset.docxRenderStyles = "";
    bodyContainer.dataset.docxRenderBody = "";
    renderRoot.append(styleContainer, bodyContainer);

    setRenderState("loading");
    setFit(null);
    visibleContainer.replaceChildren();

    void renderAsync(buffer, bodyContainer, styleContainer, {
      ...DOCX_RENDER_OPTIONS,
      className,
    })
      .then(() => {
        if (!active) {
          return;
        }

        const wrapper = bodyContainer.querySelector<HTMLElement>(`.${className}-wrapper`);
        if (wrapper) {
          // docx-preview writes a gray background and fixed 30px padding to the page packaging layer by default.
          // It will conflict with the Preview Pane theme, and will also cause narrow screen scaling to calculate the decorative spacing into the paper width.
          wrapper.style.background = "transparent";
          wrapper.style.padding = "0";
          wrapper.style.width = "max-content";
        }

        // docx-preview uses 50% black page shadow by default, which will form too dark black edges in the Preview Pane;
        // The appended scope style reuses the light paper shadow of the original react-docx and covers all pages of the current document at once.
        const pageSurfaceStyle = document.createElement("style");
        pageSurfaceStyle.dataset.docxPageSurfaceStyle = "";
        pageSurfaceStyle.textContent = `.${className}-wrapper>section.${className} { box-shadow: ${DOCX_PAGE_BOX_SHADOW}; }`;
        styleContainer.append(pageSurfaceStyle);

        disposeLinkSafety = installDocumentLinkSafety(renderRoot, onOpenBrowserUrl);

        visibleContainer.replaceChildren(renderRoot);
        setRenderState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error("[PreviewPane] failed to parse docx file", {
          path: sourcePath,
          error: message,
        });
        visibleContainer.replaceChildren();
        setRenderState("error");
      });

    return () => {
      // renderAsync does not provide cancellation capabilities; only the latest source is allowed to submit the visible DOM after switching files.
      // Even if the old task is completed later, it can only stay in a temporary container detached from the document tree.
      active = false;
      disposeLinkSafety?.();
      renderRoot.remove();
      visibleContainer.replaceChildren();
    };
  }, [buffer, onOpenBrowserUrl, previewClassName, sourcePath]);

  useLayoutEffect(() => {
    if (renderState !== "ready") {
      return;
    }

    updateFit();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateFit);
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current);
    }
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }
    return () => {
      resizeObserver.disconnect();
    };
  }, [renderState, updateFit]);

  return (
    <div
      aria-busy={renderState === "loading" ? "true" : undefined}
      className="h-full min-h-0 w-full min-w-0 bg-background"
      data-office-preview-kind="docx"
      data-office-preview-pending={renderState === "loading" ? "" : undefined}
    >
      {renderState === "error" ? (
        <div className="p-3 text-ui-base text-destructive" role="alert">
          {errorMessage}
        </div>
      ) : null}
      <div
        className={
          renderState === "error"
            ? "hidden"
            : "h-full min-h-0 w-full min-w-0 overflow-auto p-4 max-sm:p-2"
        }
      >
        <div ref={viewportRef} className="w-full min-w-0" data-docx-fit-viewport>
          <div
            className="relative mx-auto"
            data-docx-fit-frame
            style={fit ? { width: fit.width, height: fit.height } : undefined}
          >
            {/* docx-preview retains the original width of the paper; the narrow Preview Pane needs to be reduced but not enlarged.
                And synchronize the width and height of the wrapping layer to avoid retaining unscaled horizontal scrolling area after separate transform. */}
            <div
              ref={contentRef}
              className="w-max"
              data-docx-fit-content
              style={
                fit
                  ? {
                      position: "absolute",
                      left: 0,
                      top: 0,
                      transform: `scale(${fit.scale})`,
                      transformOrigin: "top left",
                    }
                  : undefined
              }
            >
              <div ref={renderContainerRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
