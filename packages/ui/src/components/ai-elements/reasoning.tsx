/*
 * Derived from vercel/ai-elements (packages/elements/src/reasoning.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import { TID_CHAT_REASONING_CONTENT, TID_CHAT_REASONING_TRIGGER } from "@zcode/shared";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { QueuedSummaryContent } from "@/ToolCallBlocks/QueuedSummaryContent.js";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import {
  EMPTY_SCROLL_MASK_STATE,
  getVerticalScrollMaskStyle,
  resolveVerticalScrollMaskState,
  type ScrollMetrics,
  type ScrollMaskState,
} from "@/mentions/components/scrollMask.js";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  shouldRenderContent: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  autoCollapseKey?: string | number | null;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const MS_IN_S = 1000;
const REASONING_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;
const REASONING_BOTTOM_LOCK_DISTANCE_PX = 2;

export function shouldAutoCollapseReasoning({
  autoCollapseKey,
  previousAutoCollapseKey,
  userInteracted,
}: {
  autoCollapseKey: string | number | null | undefined;
  previousAutoCollapseKey: string | number | null | undefined;
  userInteracted: boolean;
}) {
  return autoCollapseKey != null && autoCollapseKey !== previousAutoCollapseKey && !userInteracted;
}

export function getReasoningBottomDistance({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function isReasoningScrollAtBottom(metrics: ScrollMetrics) {
  return getReasoningBottomDistance(metrics) <= REASONING_BOTTOM_LOCK_DISTANCE_PX;
}

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    autoCollapseKey = null,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const isOpenControlled = open !== undefined;
    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const startTimeRef = useRef<number | null>(null);
    const contentUnmountDelayRef = useRef<number | null>(null);
    const userInteractedRef = useRef(false);
    const previousAutoCollapseKeyRef = useRef<string | number | null>(null);
    const [shouldRenderContent, setShouldRenderContent] = useState(() => isOpen);
    const handleOpenChange = useCallback(
      (nextOpen: boolean) => {
        userInteractedRef.current = true;
        if (nextOpen) {
          setShouldRenderContent(true);
        }
        setIsOpen(nextOpen);
      },
      [setIsOpen],
    );

    useEffect(() => {
      if (!isStreaming) {
        if (startTimeRef.current !== null) {
          setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        }
        startTimeRef.current = null;
        return;
      }

      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }

      // Display streaming summary in the collapsed state, without triggering the entire reasoning re-rendering every second to hide the time consuming;
      // When expanded, the same start time will be used to calculate and continue to update the time.
      if (!isOpen) {
        return;
      }

      const updateDuration = () => {
        if (startTimeRef.current === null) {
          return;
        }
        setDuration(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S)));
      };

      updateDuration();
      const durationTimer = window.setInterval(updateDuration, MS_IN_S);
      return () => window.clearInterval(durationTimer);
    }, [isOpen, isStreaming, setDuration]);

    useEffect(() => {
      const previousAutoCollapseKey = previousAutoCollapseKeyRef.current;
      previousAutoCollapseKeyRef.current = autoCollapseKey;

      if (isOpenControlled) {
        return;
      }

      // The output boundary is a supplementary signal to end the collapse; automatic rules cannot overwrite the selection after manual operation by the user.
      if (
        shouldAutoCollapseReasoning({
          autoCollapseKey,
          previousAutoCollapseKey,
          userInteracted: userInteractedRef.current,
        })
      ) {
        setIsOpen(false);
      }
    }, [autoCollapseKey, isOpenControlled, setIsOpen]);

    useEffect(() => {
      if (isOpen) {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
          contentUnmountDelayRef.current = null;
        }
        setShouldRenderContent(true);
        return;
      }

      if (!shouldRenderContent) {
        return;
      }

      // Children cannot be uninstalled immediately when the thinking content is collapsed. Radix height animation requires
      // The real content height can still be read in the closed stage; let the 300ms closing animation run out first, and then unload the heavy DOM.
      contentUnmountDelayRef.current = window.setTimeout(() => {
        setShouldRenderContent(false);
        contentUnmountDelayRef.current = null;
      }, REASONING_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);

      return () => {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
          contentUnmountDelayRef.current = null;
        }
      };
    }, [isOpen, shouldRenderContent]);

    useEffect(() => {
      return () => {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
        }
      };
    }, []);

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen, shouldRenderContent }),
      [duration, isOpen, isStreaming, setIsOpen, shouldRenderContent],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose flex flex-col", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
  streamingText?: string;
};

export function scrollReasoningSummaryToEnd(
  viewport: Pick<HTMLElement, "scrollLeft" | "scrollWidth">,
) {
  viewport.scrollLeft = viewport.scrollWidth;
}

export function isReasoningSummaryOverflowing({
  clientWidth,
  scrollWidth,
}: Pick<HTMLElement, "clientWidth" | "scrollWidth">) {
  return scrollWidth > clientWidth + 1;
}

export function resolveReasoningStreamingSummary(
  streamingText: string,
): { key: string; text: string } | null {
  const lines = streamingText.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]?.trim() ?? "";
    if (text.length > 0) {
      return { key: String(index), text };
    }
  }
  return null;
}

const REASONING_SUMMARY_MASK =
  "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

export function getReasoningSummaryMaskStyle(isOverflowing: boolean): CSSProperties | undefined {
  if (!isOverflowing) {
    return undefined;
  }
  return {
    WebkitMaskImage: REASONING_SUMMARY_MASK,
    maskImage: REASONING_SUMMARY_MASK,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    streamingText = "",
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    const { intl } = useZCodeIntl();
    const streamingSummary =
      isStreaming && !isOpen ? resolveReasoningStreamingSummary(streamingText) : null;
    const streamingSummaryRef = useRef<HTMLSpanElement | null>(null);
    const streamingSummaryTextRef = useRef<HTMLSpanElement | null>(null);
    const [isStreamingSummaryOverflowing, setIsStreamingSummaryOverflowing] = useState(false);

    useEffect(() => {
      const viewport = streamingSummaryRef.current;
      if (!viewport || !streamingSummary) {
        return;
      }

      const syncSummaryViewport = () => {
        setIsStreamingSummaryOverflowing((current) => {
          const next = isReasoningSummaryOverflowing(viewport);
          return current === next ? current : next;
        });
        // After the streaming summary exceeds the available width, ordinary overflow-hidden will display the old prefix fixedly.
        // The latest token is cropped on the right. Push the single-line viewport to the end after each content growth, and move the old content to the left.
        scrollReasoningSummaryToEnd(viewport);
      };

      syncSummaryViewport();
      if (typeof ResizeObserver === "undefined") {
        return;
      }
      const resizeObserver = new ResizeObserver(syncSummaryViewport);
      resizeObserver.observe(viewport);
      if (streamingSummaryTextRef.current) {
        resizeObserver.observe(streamingSummaryTextRef.current);
      }
      return () => resizeObserver.disconnect();
    }, [streamingSummary?.text]);

    const thinkingMessage =
      getThinkingMessage?.(isStreaming, duration) ??
      (isStreaming && !isOpen ? (
        <span className="animated-gradient-text font-medium">
          {intl.formatMessage({ id: "chat.reasoning.thinking" })}
        </span>
      ) : duration === undefined ? (
        <span className="inline-flex items-center gap-2">
          {/* The perfect "thinking" uses semibold alone, which is bolder than the tool type label in the same column.
              Unify to medium to keep the visual hierarchy of the conversation timeline consistent. */}
          <span className="font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.reasoning.thought" })}
          </span>
          <span className="font-normal text-foreground-subtlest">·</span>
          <span className="font-normal text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.reasoning.durationFewSeconds" })}
          </span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.reasoning.thought" })}
          </span>
          <span className="font-normal text-foreground-subtlest">·</span>
          <span className="font-normal text-foreground-subtlest">
            {intl.formatMessage(
              { id: "chat.reasoning.durationSeconds" },
              { seconds: String(duration) },
            )}
          </span>
        </span>
      ));

    return (
      <CollapsibleTrigger
        data-testid={TID_CHAT_REASONING_TRIGGER}
        className={cn(
          "group/reasoning inline-flex max-w-full min-w-0 items-center gap-2 self-start text-ui-base transition-colors",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            {/* Thinking will continue to exist in long streaming replies, and rotating loaders will occupy rendering resources for a long time;
            The running state retains the copywriting sweep, and the icons are fixed to static thinking semantics. */}
            <BrainIcon className="size-4 shrink-0 text-foreground-subtlest" />
            {/* The flow summary on the right is scalable content; if the label on the left also participates in flex shrink,
                A long summary will squeeze the thought status label into multiple lines. Fixed semantic label width, allowing only the abstract to take up the remaining space. */}
            <span className="shrink-0 whitespace-nowrap" data-reasoning-label="true">
              {thinkingMessage}
            </span>
            {streamingSummary ? <span className="shrink-0 text-foreground-subtlest">·</span> : null}
            {streamingSummary ? (
              <span
                ref={streamingSummaryRef}
                className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-foreground-subtle"
                data-reasoning-streaming-mask={isStreamingSummaryOverflowing ? "both" : "none"}
                data-reasoning-streaming-line="true"
                data-reasoning-streaming-roll="true"
                style={getReasoningSummaryMaskStyle(isStreamingSummaryOverflowing)}
              >
                <QueuedSummaryContent
                  contentKey={`reasoning-line:${streamingSummary.key}`}
                  contentRefreshVersion={streamingSummary.text}
                  primaryText={
                    <span
                      ref={streamingSummaryTextRef}
                      className="inline-block min-w-max"
                      data-reasoning-streaming-text="true"
                    >
                      {streamingSummary.text}
                    </span>
                  }
                  enabled
                />
              </span>
            ) : null}
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-foreground-subtlest transition-opacity transition-transform",
                isOpen
                  ? "rotate-90 opacity-100"
                  : "rotate-0 opacity-0 group-hover/reasoning:opacity-100",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
  variant?: "default" | "nested";
};

export const ReasoningContent = memo(
  ({ className, children, forceMount, variant = "default", ...props }: ReasoningContentProps) => {
    const { isOpen, shouldRenderContent } = useReasoning();
    const shouldRenderChildren = isOpen || shouldRenderContent || Boolean(forceMount);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const autoFollowBottomRef = useRef(true);
    const [scrollMaskState, setScrollMaskState] =
      useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);
    const updateScrollMaskState = useCallback(() => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) {
        setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
        return;
      }

      setScrollMaskState(
        resolveVerticalScrollMaskState({
          clientHeight: scrollNode.clientHeight,
          scrollHeight: scrollNode.scrollHeight,
          scrollTop: scrollNode.scrollTop,
        }),
      );
    }, []);
    const scrollToReasoningBottom = useCallback(() => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) {
        return;
      }

      scrollNode.scrollTop = scrollNode.scrollHeight;
      updateScrollMaskState();
    }, [updateScrollMaskState]);
    const handleScroll = useCallback(() => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) {
        return;
      }

      autoFollowBottomRef.current = isReasoningScrollAtBottom({
        clientHeight: scrollNode.clientHeight,
        scrollHeight: scrollNode.scrollHeight,
        scrollTop: scrollNode.scrollTop,
      });
      updateScrollMaskState();
    }, [updateScrollMaskState]);

    useEffect(() => {
      if (!shouldRenderChildren) {
        autoFollowBottomRef.current = true;
        setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
        return;
      }

      const scrollNode = scrollRef.current;
      if (!scrollNode || typeof ResizeObserver === "undefined") {
        if (autoFollowBottomRef.current) {
          scrollToReasoningBottom();
        } else {
          updateScrollMaskState();
        }
        return;
      }

      // Thought scrollHeight will change when content is appended in a streaming manner; both container and content sizes are monitored.
      // By default, the bottom is followed by the latest thinking; the user takes the initiative to leave the bottom and pauses until the user rolls back to the bottom before resuming.
      const syncScrollPosition = () => {
        if (autoFollowBottomRef.current) {
          scrollToReasoningBottom();
          return;
        }
        updateScrollMaskState();
      };
      syncScrollPosition();
      const resizeObserver = new ResizeObserver(syncScrollPosition);
      resizeObserver.observe(scrollNode);
      if (contentRef.current) {
        resizeObserver.observe(contentRef.current);
      }

      return () => {
        resizeObserver.disconnect();
      };
    }, [scrollToReasoningBottom, shouldRenderChildren, updateScrollMaskState]);

    useEffect(() => {
      if (!shouldRenderChildren) {
        return;
      }
      if (autoFollowBottomRef.current) {
        scrollToReasoningBottom();
        return;
      }
      updateScrollMaskState();
    }, [children, scrollToReasoningBottom, shouldRenderChildren, updateScrollMaskState]);

    const scrollMaskStyle = getVerticalScrollMaskStyle(scrollMaskState);
    const scrollMaskData =
      scrollMaskState.showTop && scrollMaskState.showBottom
        ? "both"
        : scrollMaskState.showTop
          ? "top"
          : scrollMaskState.showBottom
            ? "bottom"
            : "none";

    return (
      <CollapsibleContent
        data-reasoning-content="true"
        data-reasoning-content-variant={variant}
        data-testid={TID_CHAT_REASONING_CONTENT}
        forceMount={forceMount}
        className={className}
        {...props}
      >
        {shouldRenderChildren ? (
          <div className="pt-3">
            <div
              ref={scrollRef}
              className={cn(
                "max-h-60 space-y-2 overflow-auto text-ui-base text-foreground-subtlest",
                // CUA Group has provided a clear parent boundary; child reflections continue to display left traverses and indentations resulting in repeated hierarchies.
                variant === "default" && "ml-2 border-border border-l pl-3.5",
              )}
              data-reasoning-scroll-mask={scrollMaskData}
              onScroll={handleScroll}
              style={scrollMaskStyle}
            >
              {/* When the thinking block is opened before, mount the Radix content together on demand and force forceMount.
                  The first frame of content is already in the open state, and the height animation does not have time to transition from the closed state, and it looks like it suddenly expands.
                  This is consistent with the tool details: CollapsibleContent is only responsible for presence/height animation, and heavy content is delayed and unloaded separately;
                  The spacing is placed inside the animation content to avoid the last frame jumping caused by the parent gap/padding being removed at the end of the closed animation.
                  Performance fix: Thought content may be very long and will be appended in a streaming manner. If you continue to use MessageResponse/Streamdown after expansion,
                  Each chunk will rerun Markdown parsing and plug-in rendering, and the more words there are, the more stuck it will be; here it is displayed as plain text and retains line breaks. */}
              <div
                ref={contentRef}
                className="min-w-0 whitespace-pre-wrap break-words text-foreground-subtlest"
              >
                {children}
              </div>
            </div>
          </div>
        ) : null}
      </CollapsibleContent>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
