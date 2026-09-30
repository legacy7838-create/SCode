"use client";

import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";
import type { FileContents, LineAnnotation, SupportedLanguages } from "@pierre/diffs";
import { File, type FileOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import { isDarkCodePreviewTheme } from "@/lib/codePreviewPreferences.js";
import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";
import {
  formatCommandShortcutLabel,
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";

export interface CodeCommentLabels {
  addComment: string;
  addCommentTooltip: string;
  commentPlaceholder: string;
  submitComment: string;
  cancelComment: string;
  deleteComment: string;
  commentLine: string;
  commentRange: string;
}

export interface CodeViewerProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  enableSyntaxHighlighting?: boolean;
  language: string;
  showLineNumbers?: boolean;
  theme?: BundledTheme;
  wrapLongLines?: boolean;
  fontSizePx?: number;
  firstLineNumber?: number;
  comments?: readonly CodeCommentPreview[];
  topComment?: CodeCommentPreview | null;
  topCommentShowRange?: boolean;
  topCommentNotice?: string;
  focusedRange?: CodeCommentRange | null;
  focusRequestId?: string;
  /**
   * Line numbers to call out (1-based, the same coordinate space as `firstLineNumber`): only the
   * **line numbers** of those rows are tinted with the warning color, the code itself is left
   * untouched. The compile feedback card uses it to mark the rows a diagnostic points at.
   */
  markedLines?: readonly number[];
  enableLineSelection?: boolean;
  enableGutterUtility?: boolean;
  labels?: Partial<CodeCommentLabels>;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  scrollContainerRef?: Ref<HTMLDivElement>;
}

export function resolveCodeViewerColorScheme(theme?: BundledTheme): "light" | "dark" {
  if (!theme) {
    if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
      return "dark";
    }
    return "light";
  }

  return isDarkCodePreviewTheme(theme) ? "dark" : "light";
}

function setOptionalRefValue<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  (ref as { current: T | null }).current = value;
}

type CodeViewerAnnotationMetadata =
  | {
      kind: "comment";
      comment: CodeCommentPreview;
    }
  | {
      kind: "draft";
      range: CodeCommentRange;
    };

interface SelectedLineRange {
  start: number;
  end: number;
}

type CodeViewerStyle = CSSProperties & {
  "--code-comment-add-tooltip"?: string;
  "--diffs-bg"?: string;
  "--diffs-light-bg"?: string;
  "--diffs-dark-bg"?: string;
  "--diffs-font-family"?: string;
  "--diffs-font-size"?: string;
};

const DEFAULT_CODE_COMMENT_LABELS: CodeCommentLabels = {
  addComment: "Add comment",
  addCommentTooltip: "Click or drag to comment",
  commentPlaceholder: "Comment",
  submitComment: "Add comment",
  cancelComment: "Cancel",
  deleteComment: "Delete comment",
  commentLine: "Line {line}",
  commentRange: "Lines {startLine}-{endLine}",
};

const CODE_VIEWER_UNSAFE_CSS = [
  "[data-gutter-utility-slot]{left:auto;right:4px;justify-content:flex-end;align-items:center;}",
  "[data-utility-button]{margin-left:0;margin-right:0;}",
  "@media (hover:hover) and (pointer:fine){",
  "[data-utility-button]::after{content:var(--code-comment-add-tooltip);position:absolute;left:calc(100% + 6px);top:50%;transform:translateY(-50%);max-width:16rem;white-space:nowrap;pointer-events:none;opacity:0;z-index:5;border:1px solid var(--color-border);border-radius:8px;background:var(--color-tooltip);color:var(--color-tooltip-foreground);padding:4px 8px;font-family:var(--diffs-header-font-family,var(--diffs-header-font-fallback));font-size:12px;line-height:16px;box-shadow:0 4px 12px rgb(0 0 0 / 0.14);}",
  "[data-utility-button]:hover::after,[data-utility-button]:focus-visible::after{opacity:1;}",
  "}",
].join("");

/**
 * Coloring rule for the called-out line numbers. The line number cell is the
 * `[data-column-number="<line number>"]` element that @pierre/diffs renders inside a Shadow DOM, so
 * an outer class cannot reach it and can only be injected together with unsafeCSS; the color comes
 * from app tokens (custom properties pierce the shadow root) and therefore follows the light/dark
 * theme automatically. Non-positive integers and duplicates are dropped, an empty set returns an
 * empty string.
 */
export function codeViewerMarkedLinesCss(lines: readonly number[] | undefined): string {
  const unique = [...new Set(lines ?? [])].filter((line) => Number.isInteger(line) && line > 0);
  if (unique.length === 0) return "";
  const selector = unique.map((line) => `[data-column-number="${line}"]`).join(",");
  return `${selector}{color:var(--color-warning);}`;
}

function toCssString(value: string) {
  return JSON.stringify(value);
}

function hashCodeViewerContent(code: string): string {
  let hash = 5381;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 33) ^ code.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function readCodeCommentShortcutPlatformInfo(): KeyboardShortcutPlatformInfo {
  if (typeof navigator === "undefined") {
    return {};
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

export function isCodeCommentSubmitShortcut(
  event: Pick<ReactKeyboardEvent<HTMLTextAreaElement>, "ctrlKey" | "key" | "metaKey">,
  platformInfo: KeyboardShortcutPlatformInfo = readCodeCommentShortcutPlatformInfo(),
) {
  if (event.key !== "Enter") {
    return false;
  }

  return isAppleKeyboardPlatform(platformInfo) ? event.metaKey : event.ctrlKey;
}

export function isCodeCommentCancelShortcut(
  event: Pick<ReactKeyboardEvent<HTMLTextAreaElement>, "key">,
) {
  return event.key === "Escape";
}

export function formatCodeCommentSubmitShortcutLabel(platformInfo?: KeyboardShortcutPlatformInfo) {
  return formatCommandShortcutLabel("↵", platformInfo);
}

export function formatCodeCommentCancelShortcutLabel() {
  return "Esc";
}

function patchCodeCommentUtilityButtons(root: ParentNode, label: string) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-utility-button]")) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

function walkShadowRoots(root: ParentNode, callback: (root: ShadowRoot) => void) {
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) {
      continue;
    }

    callback(element.shadowRoot);
    walkShadowRoots(element.shadowRoot, callback);
  }
}

export function findCodeViewerLineElement(
  root: ParentNode,
  lineNumber: number,
): HTMLElement | null {
  const target = root.querySelector<HTMLElement>(`[data-line="${lineNumber}"]`);
  if (target) return target;

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const shadowTarget = findCodeViewerLineElement(element.shadowRoot, lineNumber);
    if (shadowTarget) return shadowTarget;
  }
  return null;
}

export function findCodeViewerCommentElement(
  root: ParentNode,
  commentId: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-code-comment-id]")) {
    if (element.dataset.codeCommentId === commentId) {
      return element;
    }
  }

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const shadowTarget = findCodeViewerCommentElement(element.shadowRoot, commentId);
    if (shadowTarget) return shadowTarget;
  }
  return null;
}

function createCodeViewerFile(params: {
  code: string;
  enableSyntaxHighlighting: boolean;
  language: string;
  theme?: BundledTheme;
}): FileContents {
  const lang = params.enableSyntaxHighlighting
    ? (params.language as SupportedLanguages)
    : ("text" as SupportedLanguages);
  const name = params.language ? `preview.${params.language}` : "preview.txt";
  const themeCacheKey = params.theme ?? "auto";

  return {
    name,
    contents: params.code,
    lang,
    // @pierre/diffs will reuse the token according to file.cacheKey; the old key does not have a theme, resulting in the same task
    // The old highlight will continue to be hit when switching app light/dark, and will only be restored after switching tasks triggers a rebuild.
    cacheKey: `${themeCacheKey}:${name}:${lang}:${params.code.length}:${hashCodeViewerContent(params.code)}`,
  };
}

function normalizeRange(range: CodeCommentRange): CodeCommentRange {
  return {
    startLine: Math.min(range.startLine, range.endLine),
    endLine: Math.max(range.startLine, range.endLine),
  };
}

function selectedRangeToCodeCommentRange(
  range: SelectedLineRange,
  firstLineNumber: number,
): CodeCommentRange {
  return normalizeRange({
    startLine: firstLineNumber + range.start - 1,
    endLine: firstLineNumber + range.end - 1,
  });
}

function codeCommentRangeToSelectedRange(
  range: CodeCommentRange,
  firstLineNumber: number,
): SelectedLineRange {
  const normalizedRange = normalizeRange(range);
  return {
    start: normalizedRange.startLine - firstLineNumber + 1,
    end: normalizedRange.endLine - firstLineNumber + 1,
  };
}

function getTextForLineRange(code: string, firstLineNumber: number, range: CodeCommentRange) {
  const lines = code.split("\n");
  const normalizedRange = normalizeRange(range);
  const startIndex = Math.max(normalizedRange.startLine - firstLineNumber, 0);
  const endIndex = Math.min(normalizedRange.endLine - firstLineNumber, lines.length - 1);
  if (startIndex > endIndex) {
    return "";
  }

  return lines.slice(startIndex, endIndex + 1).join("\n");
}

function formatCommentRange(labels: CodeCommentLabels, range: CodeCommentRange) {
  const normalizedRange = normalizeRange(range);
  if (normalizedRange.startLine === normalizedRange.endLine) {
    return labels.commentLine.replaceAll("{line}", String(normalizedRange.startLine));
  }

  return labels.commentRange
    .replaceAll("{startLine}", String(normalizedRange.startLine))
    .replaceAll("{endLine}", String(normalizedRange.endLine));
}

function CommentDraft({
  range,
  labels,
  value,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  range: CodeCommentRange;
  labels: CodeCommentLabels;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelShortcutLabel = formatCodeCommentCancelShortcutLabel();
  const cancelLabel = `${labels.cancelComment} (${cancelShortcutLabel})`;
  const submitShortcutLabel = formatCodeCommentSubmitShortcutLabel();
  const submitLabel = `${labels.submitComment} (${submitShortcutLabel})`;

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <div className="m-2 rounded-lg border border-border bg-background p-3 font-sans shadow-sm">
      <div className="mb-2 text-ui-base text-foreground-subtle">
        {formatCommentRange(labels, range)}
      </div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (isCodeCommentSubmitShortcut(event)) {
            event.preventDefault();
            onSubmit();
            return;
          }

          if (!isCodeCommentCancelShortcut(event)) {
            return;
          }

          event.preventDefault();
          onCancel();
        }}
        placeholder={labels.commentPlaceholder}
        className="min-h-16 w-full resize-none rounded-lg border-input-border bg-input text-ui-base text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
        rows={3}
        autoFocus
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          title={cancelLabel}
          aria-label={cancelLabel}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button type="button" title={submitLabel} aria-label={submitLabel} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function CodeCommentAnnotation({
  comment,
  labels,
  onDelete,
  showRange = true,
}: {
  comment: CodeCommentPreview;
  labels: CodeCommentLabels;
  onDelete?: (commentId: string) => void;
  showRange?: boolean;
}) {
  return (
    <div
      data-code-comment-id={comment.id}
      className="m-2 rounded-lg border border-border bg-background p-3 font-sans shadow-sm"
    >
      {showRange ? (
        <div className="mb-2 text-ui-base text-foreground-subtle">
          {formatCommentRange(labels, comment)}
        </div>
      ) : null}
      {comment.comment.trim() ? (
        <div className="whitespace-pre-wrap text-ui-base leading-relaxed text-foreground">
          {comment.comment}
        </div>
      ) : null}
      {onDelete ? (
        <div className="mt-2 flex items-center justify-end">
          <Button
            type="button"
            variant="ghost"
            className="text-foreground-subtle hover:text-foreground"
            title={labels.deleteComment}
            aria-label={labels.deleteComment}
            onClick={() => onDelete(comment.id)}
          >
            <Trash2Icon className="size-4" />
            {labels.deleteComment}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function CodeViewer({
  code,
  enableSyntaxHighlighting = true,
  language,
  showLineNumbers = true,
  theme,
  wrapLongLines = false,
  fontSizePx = 12,
  firstLineNumber = 1,
  comments = [],
  topComment = null,
  topCommentShowRange = true,
  topCommentNotice,
  focusedRange = null,
  focusRequestId,
  markedLines,
  enableLineSelection = false,
  enableGutterUtility = false,
  labels: labelOverrides,
  onSubmitCodeComment,
  onDeleteCodeComment,
  scrollContainerRef,
  className,
  style,
  ...props
}: CodeViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const [activeDraftRange, setActiveDraftRange] = useState<CodeCommentRange | null>(null);
  const [draftText, setDraftText] = useState("");
  const canCreateComment = Boolean(onSubmitCodeComment);
  /* Markdown code blocks reuse CodeViewer too. Previously only the comment button was disabled but
     line hover was kept, which made read-only code still look like it could enter the comment
     interaction; here the official interaction switch is folded into the comment capability.
     */
  const canUseCommentLineSelection = canCreateComment && enableLineSelection;
  const canUseCommentGutterUtility = canCreateComment && enableGutterUtility;
  const labels = useMemo(
    () => ({ ...DEFAULT_CODE_COMMENT_LABELS, ...labelOverrides }),
    [labelOverrides],
  );
  const file = useMemo(
    () =>
      createCodeViewerFile({
        code,
        enableSyntaxHighlighting,
        language,
        theme,
      }),
    [code, enableSyntaxHighlighting, language, theme],
  );
  const lineAnnotations = useMemo<LineAnnotation<CodeViewerAnnotationMetadata>[]>(() => {
    const annotations: LineAnnotation<CodeViewerAnnotationMetadata>[] = [];

    for (const comment of comments) {
      const lineNumber = normalizeRange(comment).endLine - firstLineNumber + 1;
      if (lineNumber < 1) {
        continue;
      }

      annotations.push({
        lineNumber,
        metadata: {
          kind: "comment",
          comment,
        },
      });
    }

    if (canCreateComment && activeDraftRange) {
      annotations.push({
        lineNumber: normalizeRange(activeDraftRange).endLine - firstLineNumber + 1,
        metadata: {
          kind: "draft",
          range: activeDraftRange,
        },
      });
    }

    return annotations;
  }, [activeDraftRange, canCreateComment, comments, firstLineNumber]);
  const selectedLines = useMemo(() => {
    if (canCreateComment && activeDraftRange) {
      return codeCommentRangeToSelectedRange(activeDraftRange, firstLineNumber);
    }
    return focusedRange ? codeCommentRangeToSelectedRange(focusedRange, firstLineNumber) : null;
  }, [activeDraftRange, canCreateComment, firstLineNumber, focusedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!canCreateComment || !range) {
        return;
      }

      setActiveDraftRange(selectedRangeToCodeCommentRange(range, firstLineNumber));
      setDraftText("");
    },
    [canCreateComment, firstLineNumber],
  );
  const handleGutterUtilitySelection = useCallback(
    (range: SelectedLineRange) => {
      if (!canCreateComment) {
        return;
      }

      setActiveDraftRange(selectedRangeToCodeCommentRange(range, firstLineNumber));
      setDraftText("");
    },
    [canCreateComment, firstLineNumber],
  );
  const handleSubmitDraft = useCallback(() => {
    if (!activeDraftRange) {
      return;
    }

    const selectedText = getTextForLineRange(code, firstLineNumber, activeDraftRange);
    if (!selectedText.trim()) {
      return;
    }

    onSubmitCodeComment?.({
      range: normalizeRange(activeDraftRange),
      selectedText,
      comment: draftText.trim(),
    });
    setActiveDraftRange(null);
    setDraftText("");
  }, [activeDraftRange, code, draftText, firstLineNumber, onSubmitCodeComment]);
  useEffect(() => {
    if (!canUseCommentGutterUtility || !viewerRef.current) {
      return;
    }

    const root = viewerRef.current;
    const observers: MutationObserver[] = [];
    const observedRoots = new WeakSet<Node>();
    let animationFrame = 0;

    const observeRoot = (target: ParentNode) => {
      if (observedRoots.has(target)) {
        return;
      }

      observedRoots.add(target);
      const observer = new MutationObserver(schedulePatch);
      observer.observe(target, { childList: true, subtree: true });
      observers.push(observer);
    };

    const patch = () => {
      patchCodeCommentUtilityButtons(root, labels.addCommentTooltip);
      walkShadowRoots(root, (shadowRoot) => {
        observeRoot(shadowRoot);
        patchCodeCommentUtilityButtons(shadowRoot, labels.addCommentTooltip);
      });
    };

    function schedulePatch() {
      if (animationFrame) {
        return;
      }

      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        patch();
      });
    }

    // @pierre/diffs' built-in gutter button is generated by an internal InteractionManager.
    // Only the title/aria-label is added here, and the rendering or pointer events are not taken over to avoid damaging the drag-and-drop selection of multi-line comments.
    observeRoot(root);
    patch();
    schedulePatch();

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      for (const observer of observers) {
        observer.disconnect();
      }
    };
  }, [canUseCommentGutterUtility, labels.addCommentTooltip]);
  const focusedStartLine = focusedRange?.startLine;
  const focusedEndLine = focusedRange?.endLine;
  useEffect(() => {
    if (!focusRequestId || focusedStartLine === undefined || !viewerRef.current) {
      return;
    }

    let animationFrame = 0;
    let attempts = 0;
    const targetLine = focusedStartLine - firstLineNumber + 1;
    const scrollToFocusedLine = () => {
      const container = viewerRef.current;
      const line = viewerRef.current
        ? findCodeViewerLineElement(viewerRef.current, targetLine)
        : null;
      const comment =
        focusRequestId && viewerRef.current
          ? findCodeViewerCommentElement(viewerRef.current, focusRequestId)
          : null;
      if (container && comment) {
        const containerRect = container.getBoundingClientRect();
        const commentRect = comment.getBoundingClientRect();
        const horizontalScrollLeft = container.scrollLeft;
        const commentBottom = container.scrollTop + commentRect.bottom - containerRect.top;
        // The comments scroll with the code, but when the card is clicked, the bottom of the comment is placed at the bottom of the visual area.
        // Let the target row and the comments below it appear at the same time; just write scrollTop to avoid scrollIntoView changing the horizontal position.
        container.scrollTop = Math.max(0, commentBottom - container.clientHeight + 12);
        container.scrollLeft = horizontalScrollLeft;
        return;
      }
      if (container && line) {
        const containerRect = container.getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        const horizontalScrollLeft = container.scrollLeft;
        const lineCenter =
          container.scrollTop + lineRect.top - containerRect.top + lineRect.height / 2;
        container.scrollTop = Math.max(0, lineCenter - container.clientHeight / 2);
        container.scrollLeft = horizontalScrollLeft;
        return;
      }

      attempts += 1;
      if (attempts < 45) {
        animationFrame = window.requestAnimationFrame(scrollToFocusedLine);
      }
    };

    // The real lines of code for @pierre/diffs are in the asynchronously created Shadow DOM; just passing
    // selectedLines will be highlighted but not positioned. Retry briefly when requestId changes to ensure that new comments in the same tab can be scrolled.
    animationFrame = window.requestAnimationFrame(scrollToFocusedLine);
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [file.cacheKey, firstLineNumber, focusedEndLine, focusedStartLine, focusRequestId]);
  // The dependency is on CSS strings (content) rather than array references: options should not change every time the caller renders to a new array (File will reflow).
  const markedLinesCss = codeViewerMarkedLinesCss(markedLines);
  const options = useMemo<FileOptions<CodeViewerAnnotationMetadata>>(
    () => ({
      disableFileHeader: true,
      disableLineNumbers: !showLineNumbers,
      overflow: wrapLongLines ? "wrap" : "scroll",
      theme,
      preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
      enableLineSelection: canUseCommentLineSelection,
      enableGutterUtility: canUseCommentGutterUtility,
      lineHoverHighlight:
        canUseCommentLineSelection || canUseCommentGutterUtility ? "both" : "disabled",
      onLineSelectionEnd: handleLineSelectionEnd,
      // The custom renderGutterUtility can only take the hover line, and it will degenerate into a single line when dragging comment +.
      // Use the gutter selection callback of @pierre/diffs to make both click and drag go through the same set of range calculations.
      onGutterUtilityClick: canUseCommentGutterUtility ? handleGutterUtilitySelection : undefined,
      // The built-in comment + is posted to the right of the line number by default, and it is easy to get mixed up with the starting point of the code when the user drags it.
      // Here we only adjust the position of the gutter utility in the Shadow DOM and do not take over the pointer event to avoid damaging the multi-line drag range.
      unsafeCSS: CODE_VIEWER_UNSAFE_CSS + markedLinesCss,
    }),
    [
      canUseCommentGutterUtility,
      canUseCommentLineSelection,
      handleGutterUtilitySelection,
      handleLineSelectionEnd,
      markedLinesCss,
      showLineNumbers,
      theme,
      wrapLongLines,
    ],
  );
  const viewerStyle = useMemo<CodeViewerStyle>(
    () => ({
      // The mobile phone remote control page may have a dark theme, but the browser system preference is still light.
      // The token color of @pierre/diffs depends on color-scheme/light-dark() and must be specified explicitly following the code theme.
      // Otherwise the text code block will render as dark text in a light theme on a dark card, making it look like the main text is missing.
      colorScheme: resolveCodeViewerColorScheme(theme),
      "--diffs-bg": "var(--color-background)",
      "--diffs-light-bg": "var(--color-background)",
      "--diffs-dark-bg": "var(--color-background)",
      // @pierre/diffs uses its own equal-width fallback in Shadow DOM, and Windows Chinese will fall to Song Dynasty.
      // Explicitly pass through the application token so that Markdown code block, file preview and inline code use the same CJK fallback.
      "--diffs-font-family": "var(--font-mono)",
      "--diffs-font-size": `${fontSizePx}px`,
      "--code-comment-add-tooltip": toCssString(
        canUseCommentGutterUtility ? labels.addCommentTooltip : "",
      ),
      ...style,
    }),
    [canUseCommentGutterUtility, fontSizePx, labels.addCommentTooltip, style, theme],
  );
  const assignCodeViewerScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewerRef.current = node;
      setOptionalRefValue(scrollContainerRef, node);
    },
    [scrollContainerRef],
  );

  return (
    <div
      ref={assignCodeViewerScrollContainerRef}
      className={cn("h-full w-full overflow-auto", className)}
      data-language={language}
      style={viewerStyle}
      {...props}
    >
      {topCommentNotice ? (
        <div data-code-review-target-warning className="px-3 pt-3 text-ui-sm text-warning">
          {topCommentNotice}
        </div>
      ) : null}
      {topComment ? (
        <CodeCommentAnnotation
          comment={topComment}
          labels={labels}
          showRange={topCommentShowRange}
        />
      ) : null}
      <File
        key={file.cacheKey}
        file={file}
        options={options}
        lineAnnotations={lineAnnotations}
        selectedLines={selectedLines}
        className="min-h-full w-full"
        style={viewerStyle}
        renderAnnotation={(annotation) =>
          annotation.metadata.kind === "draft" ? (
            <CommentDraft
              range={annotation.metadata.range}
              labels={labels}
              value={draftText}
              onValueChange={setDraftText}
              onSubmit={handleSubmitDraft}
              onCancel={() => {
                setActiveDraftRange(null);
                setDraftText("");
              }}
            />
          ) : (
            <CodeCommentAnnotation
              comment={annotation.metadata.comment}
              labels={labels}
              onDelete={onDeleteCodeComment}
            />
          )
        }
      />
    </div>
  );
}
