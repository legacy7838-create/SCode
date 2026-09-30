"use client";

import type { FileMediaPreview } from "@zcode/shared";
import { decodeMarkdownArtifactImageSource } from "@zcode/shared";
import { ImageIcon, ImageOffIcon } from "lucide-react";
import { Children, isValidElement } from "react";
import type { ComponentProps, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  sanitizeImageSourceForLog,
  type ImagePreviewDialogItem,
} from "@/components/ai-elements/image-preview-dialog.js";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImagePreviewPath } from "@/lib/codeViewer.js";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";
import { logger } from "@/logger.js";

export { clampImagePreviewOffset as clampMarkdownImagePreviewOffset } from "@/components/ai-elements/image-preview-dialog.js";

export type MarkdownImageProps = ComponentProps<"img"> & {
  node?: unknown;
  workspacePath?: string;
  workspaceHomePath?: string;
  sessionId?: string;
  readAttachment?: (params: {
    sessionId: string;
    ref: string;
  }) => Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
};

const markdownImageOnlyLinePattern = /^\s*!\[[^\]]*]\([^\n]+\)\s*$/;
const markdownFenceLinePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Streamdown splits blocks on blank lines before rehype. Only the blank lines between consecutive
 * image-only lines are removed, so a group of images lands in the same Markdown block; similar text
 * inside code fences must be left exactly as it is.
 */
export function normalizeConsecutiveMarkdownImageBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let activeFenceMarker: "`" | "~" | null = null;
  let activeFenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(markdownFenceLinePattern);
    const fenceRun = fenceMatch?.[2];
    if (fenceRun) {
      const marker = fenceRun[0] as "`" | "~";
      const suffix = fenceMatch[3] ?? "";
      if (
        activeFenceMarker === marker &&
        fenceRun.length >= activeFenceLength &&
        suffix.trim() === ""
      ) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      } else if (!activeFenceMarker && (marker === "~" || !suffix.includes("`"))) {
        activeFenceMarker = marker;
        activeFenceLength = fenceRun.length;
      }
      normalized.push(line);
      continue;
    }

    if (!activeFenceMarker && markdownImageOnlyLinePattern.test(line)) {
      normalized.push(line);
      let nextIndex = index + 1;
      while (nextIndex < lines.length && !(lines[nextIndex] ?? "").trim()) {
        nextIndex += 1;
      }
      if (
        nextIndex > index + 1 &&
        nextIndex < lines.length &&
        markdownImageOnlyLinePattern.test(lines[nextIndex] ?? "")
      ) {
        index = nextIndex - 1;
      }
      continue;
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

/**
 * Streamdown's harden pass filters rehype custom attributes, so image-only paragraphs are
 * recognized at the React component mapping layer to make sure gallery markers and responsive
 * classes are not stripped by the sanitizing layer.
 */
export function MarkdownImageParagraph({
  children,
  node: _node,
  ...props
}: ComponentProps<"p"> & { node?: unknown }) {
  const meaningfulChildren = Children.toArray(children).filter(
    (child) => typeof child !== "string" || child.trim().length > 0,
  );
  const isImageGallery =
    meaningfulChildren.length >= 2 &&
    meaningfulChildren.every(
      (child) =>
        isValidElement(child) &&
        (child.props as { node?: { tagName?: string } }).node?.tagName === "img",
    );

  if (isImageGallery) {
    return (
      <ImageThumbnailGallery data-markdown-image-gallery="">
        {meaningfulChildren}
      </ImageThumbnailGallery>
    );
  }

  return <p {...props}>{children}</p>;
}

function formatMediaPreviewDataUrl(preview: FileMediaPreview): string {
  return `data:${preview.mediaType};base64,${preview.dataBase64}`;
}

function readPreviewGroup(target: HTMLButtonElement): ImagePreviewDialogItem[] {
  const gallery = target.closest("[data-markdown-image-gallery]");
  const buttons = gallery
    ? Array.from(gallery.querySelectorAll<HTMLButtonElement>("[data-markdown-image-trigger]"))
    : [target];
  return buttons.flatMap((button) => {
    const image = button.querySelector<HTMLImageElement>("img[data-markdown-image]");
    return image?.src ? [{ alt: image.alt, filename: image.alt, src: image.src }] : [];
  });
}

export function MarkdownImage({
  alt,
  className,
  node: _node,
  onError,
  onLoad,
  readAttachment,
  sessionId,
  src,
  workspacePath,
  workspaceHomePath,
  ...props
}: MarkdownImageProps) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const resolvedSrc = typeof src === "string" ? src : "";
  const artifactRef = useMemo(() => decodeMarkdownArtifactImageSource(resolvedSrc), [resolvedSrc]);
  const localImageLink = useMemo(() => {
    const fileLink = resolveMarkdownFileLink(workspacePath, resolvedSrc, {
      homePath: workspaceHomePath,
    });
    return fileLink && isImagePreviewPath(fileLink.path) ? fileLink : null;
  }, [resolvedSrc, workspaceHomePath, workspacePath]);
  const [localImageDataUrl, setLocalImageDataUrl] = useState<string | null>(null);
  const [localImageFailed, setLocalImageFailed] = useState(false);
  const [artifactImageUrl, setArtifactImageUrl] = useState<string | null>(null);
  const [artifactImageFailed, setArtifactImageFailed] = useState(false);
  const [previewItems, setPreviewItems] = useState<ImagePreviewDialogItem[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [browserImageState, setBrowserImageState] = useState<{
    source: string;
    status: "loading" | "loaded" | "error";
  }>({ source: "", status: "loading" });
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setLocalImageDataUrl(null);
    setLocalImageFailed(false);
    if (!localImageLink || !services) return;

    let disposed = false;
    services.fileService
      .readMediaPreview({ path: localImageLink.path })
      .then((preview) => {
        if (!disposed) setLocalImageDataUrl(formatMediaPreviewDataUrl(preview));
      })
      .catch((error) => {
        if (disposed) return;
        setLocalImageFailed(true);
        logger.warn("[MarkdownImage] markdown local image preview failed", {
          path: localImageLink.path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [localImageLink, services]);

  useEffect(
    () => () => {
      // Asynchronous focus restoration after closing preview may occur later than message node unloading,
      // Old tasks must be canceled to avoid focus falling on image buttons that are no longer in the document.
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setArtifactImageUrl(null);
    setArtifactImageFailed(false);
    if (!artifactRef) return;
    if (!sessionId || !readAttachment) {
      setArtifactImageFailed(true);
      return;
    }

    let disposed = false;
    let objectUrl: string | null = null;
    readAttachment({ sessionId, ref: artifactRef })
      .then((result) => {
        if (disposed) return;
        if ("url" in result) {
          setArtifactImageUrl(result.url);
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
        );
        setArtifactImageUrl(objectUrl);
      })
      .catch((error) => {
        if (disposed) return;
        setArtifactImageFailed(true);
        logger.warn("[MarkdownImage] assistant artifact image preview failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactRef, readAttachment, sessionId]);

  const displaySrc = artifactRef
    ? artifactImageUrl
    : localImageLink
      ? localImageDataUrl
      : resolvedSrc;
  if (!resolvedSrc) return null;
  if ((artifactRef || localImageLink) && !displaySrc) {
    const failed = artifactRef ? artifactImageFailed : localImageFailed;
    return (
      <div
        aria-label={failed ? intl.formatMessage({ id: "codeViewer.imageUnavailable" }) : undefined}
        className={cn(
          "flex min-h-32 w-full items-center justify-center rounded-xl border border-border bg-surface px-3 py-2 text-center text-ui-base text-foreground-subtle md:h-44 md:w-56 md:shrink-0",
          className,
        )}
        data-markdown-local-image={failed ? "error" : "loading"}
        role={failed ? "img" : "status"}
        title={localImageLink?.path}
      >
        {failed ? (
          <ImageOffIcon aria-hidden="true" className="size-6" />
        ) : (
          intl.formatMessage({ id: "common.loading" })
        )}
      </div>
    );
  }
  const effectiveImageStatus =
    browserImageState.source === displaySrc ? browserImageState.status : "loading";
  if (effectiveImageStatus === "error") {
    return (
      <div
        aria-label={intl.formatMessage({ id: "codeViewer.imageUnavailable" })}
        className={cn(
          "flex min-h-32 w-full items-center justify-center rounded-xl border border-border bg-surface px-3 py-2 text-center text-ui-base text-foreground-subtle md:h-44 md:w-56 md:shrink-0",
          className,
        )}
        data-markdown-image-state="error"
        role="img"
        title={localImageLink?.path}
      >
        <ImageOffIcon aria-hidden="true" className="size-6" />
      </div>
    );
  }

  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    const items = readPreviewGroup(event.currentTarget);
    setPreviewItems(items);
    setPreviewIndex(
      Math.max(
        0,
        items.findIndex((item) => item.src === displaySrc),
      ),
    );
    setPreviewOpen(true);
  };
  const imageAlt = alt || intl.formatMessage({ id: "chat.attachments.preview.title" });
  const handlePreviewOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (!open) {
      // After the Dialog is closed, manually return the focus to the picture trigger button to avoid the focus falling on the body.
      // Allows keyboard users to continue browsing messages from the original image.
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = window.setTimeout(() => {
        previewTriggerRef.current?.focus();
        focusTimerRef.current = null;
      }, 0);
    }
  };

  return (
    <>
      <button
        ref={previewTriggerRef}
        type="button"
        aria-label={intl.formatMessage({ id: "chat.attachments.preview.open" })}
        className={cn(
          imageThumbnailTriggerClassName,
          effectiveImageStatus === "loading" &&
            // Gallery parent's responsive w-auto/h-44 selector takes precedence over normal size classes,
            // The inside of the loading state is absolute positioning, causing the button width to collapse; the square shape is forced to be fixed only during loading.
            "relative !h-44 !w-44 !max-w-full cursor-default",
        )}
        data-image-thumbnail-trigger=""
        data-markdown-image-trigger=""
        onClick={openPreview}
        title={localImageLink?.path}
      >
        {effectiveImageStatus === "loading" ? (
          <span
            aria-label={intl.formatMessage({ id: "common.loading" })}
            className="markdown-image-loading-shimmer absolute inset-0 flex size-full items-center justify-center text-foreground-subtle"
            data-markdown-image-state="loading"
            role="status"
          >
            <ImageIcon aria-hidden="true" className="size-6" />
          </span>
        ) : null}
        <img
          // When React reuses the same img, asynchronous events from the old resource may hit the handler of the new src.
          // Rebuild the node by resource and ensure that load/error only updates the image state that triggered the event.
          key={displaySrc}
          alt={imageAlt}
          className={cn(
            imageThumbnailClassName,
            effectiveImageStatus === "loading" && "invisible",
            className,
          )}
          data-markdown-image=""
          data-streamdown="image"
          draggable={false}
          loading="lazy"
          onError={(event) => {
            // Remote Markdown images cannot be directly rendered by the browser: there is no status when loading fails.
            // There is also no runtime trace, and the user only sees empty space.
            setBrowserImageState({ source: displaySrc ?? "", status: "error" });
            logger.warn("[MarkdownImage] markdown image failed to load", {
              source: sanitizeImageSourceForLog(displaySrc ?? ""),
            });
            onError?.(event);
          }}
          onLoad={(event) => {
            setBrowserImageState({ source: displaySrc ?? "", status: "loaded" });
            onLoad?.(event);
          }}
          src={displaySrc ?? undefined}
          {...props}
        />
      </button>
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onOpenChange={handlePreviewOpenChange}
        open={previewOpen}
      />
    </>
  );
}
