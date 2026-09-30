"use client";

import type {
  ComponentProps,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftFromLine,
  ArrowRightToLine,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type MarkdownTableNodeProp = {
  node?: unknown;
};

type MarkdownTableEdgeShadowState = "none" | "left" | "right" | "both";

export type MarkdownTableRows = string[][];

type MarkdownTableFrameDistances = {
  leftDistance: number;
  maxLeftOffset: number;
  scrollbarWidth: number;
  rightDistance: number;
  maxViewportWidth: number;
};

type MarkdownTableVirtualScrollbarMetrics = {
  contentWidth: number;
  thumbLeft: number;
  thumbWidth: number;
};

type MarkdownTableObservedRect = {
  left: number;
  right: number;
  width: number;
};

const MARKDOWN_TABLE_ROOT_SELECTOR =
  '[data-markdown-table-layout-root="true"], [data-testid="chat-view"]';
const MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR = '[data-markdown-table-sticky-scrollbar="disabled"]';
const MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR = '[data-v4-composer-dock="true"]';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR =
  '[data-v4-back-to-bottom-anchor="composer-dock"] button';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX = 8;
const MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX = 32;
const MARKDOWN_TABLE_CONTENT_PADDING_LG_PX = 16;
const MARKDOWN_TABLE_CONTENT_PADDING_MD_PX = 8;
const MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO = 0.8;
const MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY = "--markdown-table-layout-left-inset";
const MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY = "--markdown-table-layout-right-inset";

function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeCsvCell(value: string): string {
  // assistant markdown is an untrusted input, and CSV is used by Excel/Numbers/LibreOffice
  // Formula prefixes are interpreted when turned on. Uniformly downgrade formula cells to plain text before downloading.
  const safeValue = /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? "")),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  // Blob's charset will not write file bytes, and Excel will write UTF-8 CSV without BOM.
  // Parsing according to the local code page results in garbled Chinese characters; explicitly adding UTF-8 BOM allows spreadsheet software to reliably identify the encoding.
  return `\uFEFF${csv}`;
}

function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ""),
      ),
    )
    .filter((row) => row.length > 0);
}

function resolveMarkdownTableRoot(
  frame: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  // V4 will no longer render data-testid="chat-view" after deleting the old ChatView, and the table will return to its own width.
  // Therefore, there is no gain in misjudgment to enhance horizontal scrolling. Prefer explicit layout boundaries across versions, old selectors only remain compatible.
  return frame?.closest<HTMLElement>(MARKDOWN_TABLE_ROOT_SELECTOR) ?? fallbackRoot;
}

function getMarkdownTableContentInlineInsetPx() {
  if (typeof window === "undefined") {
    return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
  }

  // When the table width borrows the space on the right side of the ChatView root, the responsive right padding of the message column itself needs to be deducted.
  // px-8 max-lg:px-4 max-md:px-2 corresponding to ChatConversationContent.
  if (window.innerWidth < 768) {
    return MARKDOWN_TABLE_CONTENT_PADDING_MD_PX;
  }

  if (window.innerWidth < 1024) {
    return MARKDOWN_TABLE_CONTENT_PADDING_LG_PX;
  }

  return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
}

function getMarkdownTableRootInlineInsets(root: HTMLElement) {
  if (typeof window !== "undefined" && root.matches('[data-markdown-table-layout-root="true"]')) {
    return {
      leftInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY),
      rightInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY),
    };
  }

  const legacyInset = getMarkdownTableContentInlineInsetPx();
  return { leftInset: legacyInset, rightInset: legacyInset };
}

function readMarkdownTableObservedRect(
  element: HTMLElement | null,
): MarkdownTableObservedRect | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
  };
}

function isMarkdownTableObservedRectEqual(
  leftRect: MarkdownTableObservedRect | null,
  rightRect: MarkdownTableObservedRect | null,
) {
  return (
    leftRect?.left === rightRect?.left &&
    leftRect?.right === rightRect?.right &&
    leftRect?.width === rightRect?.width
  );
}

function readCssPixelValue(element: HTMLElement | null, propertyName: string) {
  if (!element || typeof window === "undefined") {
    return 0;
  }

  const value = window.getComputedStyle(element).getPropertyValue(propertyName);
  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
}

function readMarkdownTableDockHeight(root: HTMLElement | null) {
  const legacyDockHeight = readCssPixelValue(root, "--chat-bottom-dock-height");
  if (legacyDockHeight > 0) return legacyDockHeight;

  // The V4 composer dock is located inside the timeline scroll viewport but is no longer set up for the old ChatView
  // CSS variables. Read the real dock height directly to avoid the bottom scroll bar being covered by the input area.
  return (
    root
      ?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR)
      ?.getBoundingClientRect().height ?? 0
  );
}

function readMarkdownTableBackToBottomClearance(root: HTMLElement | null) {
  const button = root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR);
  if (!button) return 0;

  return button.getBoundingClientRect().height + MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX;
}

function resolveMarkdownTableVerticalViewport(
  element: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  if (typeof window === "undefined") {
    return fallbackRoot;
  }

  let currentElement = element?.parentElement ?? null;
  while (currentElement) {
    const style = window.getComputedStyle(currentElement);
    const canScrollY = /auto|scroll|overlay/u.test(style.overflowY);
    // Horizontal scrolling viewport may cause the browser to calculate overflow-y as auto due to overflow-x-auto;
    // If it is not confirmed that there is really vertical scrolling space, the short form will mistake its own height for the height of the visible area, causing the 80% judgment to always be true.
    const hasVerticalScrollRange = currentElement.scrollHeight > currentElement.clientHeight + 1;
    if (canScrollY && currentElement.clientHeight > 0 && hasVerticalScrollRange) {
      return currentElement;
    }
    currentElement = currentElement.parentElement;
  }

  return fallbackRoot;
}

export function resolveMarkdownTableStickyScrollbarMode({
  stickyScrollbarDisabled,
  viewportHeight,
  dockHeight,
  tableHeight,
}: {
  stickyScrollbarDisabled: boolean;
  viewportHeight: number;
  dockHeight: number;
  tableHeight: number;
}) {
  if (stickyScrollbarDisabled) {
    return false;
  }

  const visibleHeight = Math.max(0, viewportHeight - dockHeight);
  return (
    visibleHeight > 0 && tableHeight > visibleHeight * MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO
  );
}

export function resolveMarkdownTableStickyScrollbarOffset({
  frameTop,
  frameBottom,
  scrollbarHeight,
  viewportBottom,
}: {
  frameTop: number;
  frameBottom: number;
  scrollbarHeight: number;
  viewportBottom: number;
}) {
  const minimumBottom = Math.min(frameBottom, frameTop + Math.max(0, scrollbarHeight));
  const pinnedBottom = Math.min(frameBottom, Math.max(minimumBottom, viewportBottom));
  return Math.min(0, pinnedBottom - frameBottom);
}

function shouldUseMarkdownTableStickyScrollbar({
  root,
  table,
}: {
  root: HTMLElement | null;
  table: HTMLTableElement | null;
}) {
  if (!table) {
    return false;
  }

  const viewport = resolveMarkdownTableVerticalViewport(table, root);
  const viewportHeight =
    viewport?.clientHeight ||
    viewport?.getBoundingClientRect().height ||
    (typeof window === "undefined" ? 0 : window.innerHeight);
  const dockHeight = readMarkdownTableDockHeight(root);
  const tableHeight = table.getBoundingClientRect().height;

  // subagent prompt/output will inherit the session dock height; if sticky is also enabled, the virtual scroll bar will
  // Errors in nested containers are raised to the middle of the table. Explicit opt-out does not depend on whether the container currently has vertical overflow.
  return resolveMarkdownTableStickyScrollbarMode({
    stickyScrollbarDisabled: table.closest(MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR) !== null,
    viewportHeight,
    dockHeight,
    tableHeight,
  });
}

export function resolveMarkdownTableFrameDistances({
  frameWidth,
  frameLeft,
  frameRight,
  rootLeft,
  rootRight,
  leftInset = 0,
  rightInset = 0,
}: {
  frameWidth: number;
  frameLeft: number;
  frameRight: number;
  rootLeft: number;
  rootRight: number;
  leftInset?: number;
  rightInset?: number;
}): MarkdownTableFrameDistances {
  const leftDistance = Math.max(0, frameLeft - rootLeft);
  const rightDistance = Math.max(0, rootRight - frameRight);
  const maxLeftOffset = Math.max(0, leftDistance - leftInset);
  const scrollbarWidth = Math.max(0, frameWidth + rightDistance - rightInset);

  return {
    leftDistance,
    maxLeftOffset,
    scrollbarWidth,
    rightDistance,
    maxViewportWidth: scrollbarWidth,
  };
}

export function resolveMarkdownTableVirtualScrollbarMetrics({
  scrollLeft,
  scrollMax,
  tableWidth,
  trackWidth,
}: {
  scrollLeft: number;
  scrollMax: number;
  tableWidth: number;
  trackWidth: number;
}): MarkdownTableVirtualScrollbarMetrics {
  const safeTableWidth = Math.max(0, tableWidth);
  const safeTrackWidth = Math.max(0, trackWidth);
  const safeScrollMax = Math.max(0, scrollMax);
  const contentWidth = Math.max(safeTrackWidth, safeTableWidth);

  if (safeTrackWidth <= 0 || safeScrollMax <= 1 || safeTableWidth <= safeTrackWidth) {
    return {
      contentWidth: safeTrackWidth,
      thumbLeft: 0,
      thumbWidth: safeTrackWidth,
    };
  }

  const thumbWidth = Math.min(
    safeTrackWidth,
    Math.max(0, safeTrackWidth * (safeTrackWidth / safeTableWidth)),
  );
  const maxThumbLeft = Math.max(0, safeTrackWidth - thumbWidth);
  const thumbLeft = Math.min(
    maxThumbLeft,
    Math.max(0, Math.max(0, scrollLeft) * (safeTrackWidth / safeTableWidth)),
  );

  return {
    contentWidth,
    thumbLeft,
    thumbWidth,
  };
}

export function resolveMarkdownTableVirtualScrollMax({
  tableWidth,
  trackWidth,
}: {
  tableWidth: number;
  trackWidth: number;
}): number {
  return Math.max(0, tableWidth - trackWidth);
}

export type MarkdownTableProps = ComponentProps<"table"> & MarkdownTableNodeProp;

export function MarkdownTable({ className, children, node: _node, ...props }: MarkdownTableProps) {
  const { intl } = useZCodeIntl();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedScrollEnabled, setExpandedScrollEnabled] = useState(false);
  const [canToggleExpandedScroll, setCanToggleExpandedScroll] = useState(false);
  const [edgeShadowState, setEdgeShadowState] = useState<MarkdownTableEdgeShadowState>("none");
  const [viewportMaxWidth, setViewportMaxWidth] = useState<string>("100%");
  const [scrollbarWidth, setScrollbarWidth] = useState<string>("100%");
  const [viewportLeftOffset, setViewportLeftOffset] = useState(0);
  const [virtualScrollbarSticky, setVirtualScrollbarSticky] = useState(false);
  const [virtualScrollbarVisible, setVirtualScrollbarVisible] = useState(false);
  const [virtualScrollThumbStyle, setVirtualScrollThumbStyle] = useState<CSSProperties>({
    transform: "translateX(0px)",
    width: "100%",
  });
  const edgeShadowStateRef = useRef<MarkdownTableEdgeShadowState>("none");
  const expandedScrollEnabledRef = useRef(expandedScrollEnabled);
  const canToggleExpandedScrollRef = useRef(canToggleExpandedScroll);
  const viewportMaxWidthRef = useRef(viewportMaxWidth);
  const scrollbarWidthRef = useRef(scrollbarWidth);
  const viewportLeftOffsetRef = useRef(viewportLeftOffset);
  const virtualScrollbarStickyRef = useRef(virtualScrollbarSticky);
  const virtualScrollbarVisibleRef = useRef(virtualScrollbarVisible);
  const maxViewportLeftOffsetRef = useRef(0);
  const virtualScrollTrackWidthRef = useRef(0);
  const virtualScrollLeftRef = useRef(0);
  const virtualScrollThumbLeftRef = useRef(0);
  const virtualScrollThumbStyleRef = useRef(virtualScrollThumbStyle);
  const isVirtualScrollbarDraggingRef = useRef(false);
  const virtualScrollbarDragOffsetRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollTrackRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollbarWrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const setNextEdgeShadowState = useCallback(
    (nextEdgeShadowState: MarkdownTableEdgeShadowState) => {
      if (edgeShadowStateRef.current === nextEdgeShadowState) {
        return;
      }

      edgeShadowStateRef.current = nextEdgeShadowState;
      setEdgeShadowState(nextEdgeShadowState);
    },
    [],
  );
  const commitExpandedScrollEnabled = useCallback((nextExpandedScrollEnabled: boolean) => {
    if (expandedScrollEnabledRef.current === nextExpandedScrollEnabled) {
      return;
    }

    expandedScrollEnabledRef.current = nextExpandedScrollEnabled;
    setExpandedScrollEnabled(nextExpandedScrollEnabled);
  }, []);
  const commitCanToggleExpandedScroll = useCallback((nextCanToggleExpandedScroll: boolean) => {
    if (canToggleExpandedScrollRef.current === nextCanToggleExpandedScroll) {
      return;
    }

    canToggleExpandedScrollRef.current = nextCanToggleExpandedScroll;
    setCanToggleExpandedScroll(nextCanToggleExpandedScroll);
  }, []);
  const commitViewportMaxWidth = useCallback((nextViewportMaxWidth: string) => {
    if (viewportMaxWidthRef.current === nextViewportMaxWidth) {
      return;
    }

    viewportMaxWidthRef.current = nextViewportMaxWidth;
    setViewportMaxWidth(nextViewportMaxWidth);
  }, []);
  const commitScrollbarWidth = useCallback((nextScrollbarWidth: string) => {
    if (scrollbarWidthRef.current === nextScrollbarWidth) {
      return;
    }

    scrollbarWidthRef.current = nextScrollbarWidth;
    setScrollbarWidth(nextScrollbarWidth);
  }, []);
  const commitViewportLeftOffset = useCallback((nextViewportLeftOffset: number) => {
    if (viewportLeftOffsetRef.current === nextViewportLeftOffset) {
      return;
    }

    viewportLeftOffsetRef.current = nextViewportLeftOffset;
    setViewportLeftOffset(nextViewportLeftOffset);
  }, []);
  const commitVirtualScrollbarSticky = useCallback((nextVirtualScrollbarSticky: boolean) => {
    if (virtualScrollbarStickyRef.current === nextVirtualScrollbarSticky) {
      return;
    }

    virtualScrollbarStickyRef.current = nextVirtualScrollbarSticky;
    setVirtualScrollbarSticky(nextVirtualScrollbarSticky);
  }, []);
  const commitVirtualScrollbarVisible = useCallback((nextVirtualScrollbarVisible: boolean) => {
    if (virtualScrollbarVisibleRef.current === nextVirtualScrollbarVisible) {
      return;
    }

    virtualScrollbarVisibleRef.current = nextVirtualScrollbarVisible;
    setVirtualScrollbarVisible(nextVirtualScrollbarVisible);
  }, []);
  const commitVirtualScrollThumbStyle = useCallback(
    (nextVirtualScrollThumbStyle: CSSProperties) => {
      const currentStyle = virtualScrollThumbStyleRef.current;
      if (
        currentStyle.width === nextVirtualScrollThumbStyle.width &&
        currentStyle.transform === nextVirtualScrollThumbStyle.transform
      ) {
        return;
      }

      virtualScrollThumbStyleRef.current = nextVirtualScrollThumbStyle;
      setVirtualScrollThumbStyle(nextVirtualScrollThumbStyle);
    },
    [],
  );
  const resolveTableWidth = useCallback((viewport: HTMLDivElement) => {
    return tableRef.current?.getBoundingClientRect().width ?? viewport.scrollWidth;
  }, []);
  const resolveVirtualScrollLayoutWidth = useCallback((viewport: HTMLDivElement) => {
    return virtualScrollTrackWidthRef.current || viewport.clientWidth;
  }, []);
  const resolveRenderedVirtualScrollTrackWidth = useCallback(
    (viewport: HTMLDivElement) => {
      const trackWidth = virtualScrollTrackRef.current?.getBoundingClientRect().width ?? 0;
      if (trackWidth > 0) {
        return trackWidth;
      }

      return resolveVirtualScrollLayoutWidth(viewport);
    },
    [resolveVirtualScrollLayoutWidth],
  );
  const resolveVirtualScrollMax = useCallback(
    (viewport: HTMLDivElement) => {
      // The total distance of virtual scrolling should only be determined by the width of the table label itself minus the width of the scroll bar groove;
      // After mixing in viewportLeftOffset before, borrowing to the left will change the maximum value, causing the thumb and content scrolling progress to be inconsistent.
      // The DOM track after conditional mounting will use the CSS width; if it is different from the floating point layout width precision saved when it is not mounted,
      // Visibility will go back and forth on both sides of the same threshold. Whether overflow must always read the same round stable layout slot width.
      return resolveMarkdownTableVirtualScrollMax({
        tableWidth: resolveTableWidth(viewport),
        trackWidth: resolveVirtualScrollLayoutWidth(viewport),
      });
    },
    [resolveTableWidth, resolveVirtualScrollLayoutWidth],
  );
  const commitVirtualScrollLeft = useCallback(
    (nextVirtualScrollLeft: number) => {
      const viewport = scrollViewportRef.current;
      if (!viewport) {
        virtualScrollLeftRef.current = 0;
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const clampedVirtualScrollLeft = Math.min(
        Math.max(0, nextVirtualScrollLeft),
        virtualScrollMax,
      );
      const nextViewportLeftOffset = Math.min(
        clampedVirtualScrollLeft,
        maxViewportLeftOffsetRef.current,
      );
      const nextViewportScrollLeft = clampedVirtualScrollLeft - nextViewportLeftOffset;

      virtualScrollLeftRef.current = clampedVirtualScrollLeft;
      commitViewportLeftOffset(nextViewportLeftOffset);
      viewport.scrollLeft = nextViewportScrollLeft;
    },
    [commitViewportLeftOffset, resolveVirtualScrollMax],
  );
  const syncVirtualScrollMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollThumbStyle({
        transform: "translateX(0px)",
        width: "100%",
      });
      virtualScrollLeftRef.current = 0;
      virtualScrollThumbLeftRef.current = 0;
      return;
    }

    const virtualScrollMax = resolveVirtualScrollMax(viewport);
    // The virtual scroll bar is only meaningful when the width of the table exceeds the visual slot; if a small table also renders pill,
    // It will mislead users into thinking that there is still horizontal content to scroll.
    commitVirtualScrollbarVisible(virtualScrollMax > 1);
    const nextVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    const clampedVirtualScrollLeft = Math.min(Math.max(0, nextVirtualScrollLeft), virtualScrollMax);
    if (clampedVirtualScrollLeft !== nextVirtualScrollLeft) {
      // Status panel collapse/expand or window resize will change the slot width, and the old virtual scroll position may cross the new boundary.
      // Here, the unified entry is written back immediately to avoid the thumb reaching the boundary and the content still stopping at the old DOM scrollLeft.
      commitVirtualScrollLeft(clampedVirtualScrollLeft);
      return;
    }

    virtualScrollLeftRef.current = clampedVirtualScrollLeft;
    // The actual width of the rendered track is only used for thumb scale and position, and cannot be used to determine whether the track is mounted.
    const virtualScrollViewportWidth = resolveRenderedVirtualScrollTrackWidth(viewport);
    const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: clampedVirtualScrollLeft,
      scrollMax: virtualScrollMax,
      tableWidth: resolveTableWidth(viewport),
      trackWidth: virtualScrollViewportWidth,
    });
    commitVirtualScrollThumbStyle({
      transform: `translateX(${Math.round(metrics.thumbLeft)}px)`,
      width: `${Math.ceil(metrics.thumbWidth)}px`,
    });
    virtualScrollThumbLeftRef.current = metrics.thumbLeft;
  }, [
    commitVirtualScrollLeft,
    commitVirtualScrollbarVisible,
    commitVirtualScrollThumbStyle,
    resolveTableWidth,
    resolveVirtualScrollMax,
    resolveRenderedVirtualScrollTrackWidth,
  ]);
  const measureViewportMaxWidth = useCallback(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      commitCanToggleExpandedScroll(false);
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollbarSticky(false);
      maxViewportLeftOffsetRef.current = 0;
      virtualScrollTrackWidthRef.current = 0;
      commitViewportLeftOffset(0);
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    let maxLeftOffset = 0;
    let maxViewportWidth = frameRect.width;
    let measuredScrollbarWidth = frameRect.width;
    let expandedMaxLeftOffset = 0;
    let expandedScrollbarWidth = frameRect.width;

    if (root) {
      const rootRect = root.getBoundingClientRect();
      // V4's extended bounds are the full timeline viewport rather than the centered message content column; explicit root node
      // Responsive safe margins are provided through CSS variables, and the old root node continues to retain the original compatibility rules.
      const { leftInset, rightInset } = getMarkdownTableRootInlineInsets(root);
      const measuredDistances = resolveMarkdownTableFrameDistances({
        frameWidth: frameRect.width,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
        leftInset,
        rightInset,
      });
      expandedMaxLeftOffset = measuredDistances.maxLeftOffset;
      expandedScrollbarWidth = measuredDistances.scrollbarWidth;

      if (expandedScrollEnabledRef.current) {
        maxLeftOffset = measuredDistances.maxLeftOffset;
        maxViewportWidth = measuredDistances.maxViewportWidth;
        measuredScrollbarWidth = measuredDistances.scrollbarWidth;
      }
    }

    const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 0;
    const hasFrameHorizontalOverflow = tableWidth > frameRect.width + 1;
    const hasExpandedScrollBenefit =
      expandedScrollbarWidth > frameRect.width + 1 || expandedMaxLeftOffset > 1;
    // The switch only makes sense if there is actual horizontal overflow under normal frame width, and enhanced mode can provide additional visual width or left borrowing;
    // When enabled, the button remains, allowing the user to revert to normal scrolling range.
    commitCanToggleExpandedScroll(
      expandedScrollEnabledRef.current || (hasFrameHorizontalOverflow && hasExpandedScrollBenefit),
    );

    maxViewportLeftOffsetRef.current = maxLeftOffset;
    virtualScrollTrackWidthRef.current = measuredScrollbarWidth;
    commitViewportMaxWidth(`${Math.ceil(maxViewportWidth)}px`);
    // Rounding up will make the mounted track at most 1px wider than the slot width used for overflow judgment.
    // Subpixel overflow just close to the 1px threshold will cause the track to be mounted/unmounted every frame and perturb the timeline height.
    commitScrollbarWidth(`${measuredScrollbarWidth}px`);
    commitVirtualScrollbarSticky(
      shouldUseMarkdownTableStickyScrollbar({
        root,
        table: tableRef.current,
      }),
    );
    if (scrollViewportRef.current) {
      commitVirtualScrollLeft(virtualScrollLeftRef.current);
    } else {
      commitViewportLeftOffset(Math.min(viewportLeftOffsetRef.current, maxLeftOffset));
    }
    syncVirtualScrollMetrics();
  }, [
    commitScrollbarWidth,
    commitCanToggleExpandedScroll,
    commitVirtualScrollLeft,
    commitVirtualScrollbarSticky,
    commitVirtualScrollbarVisible,
    commitViewportLeftOffset,
    commitViewportMaxWidth,
    syncVirtualScrollMetrics,
  ]);

  const measureEdgeShadowState = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const maxScrollLeft = resolveVirtualScrollMax(viewport);
    if (maxScrollLeft <= 1) {
      setNextEdgeShadowState("none");
      return;
    }

    const currentVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    // Borrowing to the left only expands the table area to the left, but it does not mean that the table content has been obscured on the left side of the scroll container;
    // The left shadow should only appear after the real internal scrollLeft is generated, and the right shadow continues to be judged according to the virtual total progress.
    const hasHiddenLeft = viewport.scrollLeft > 1;
    const hasHiddenRight = currentVirtualScrollLeft < maxScrollLeft - 1;
    setNextEdgeShadowState(
      hasHiddenLeft && hasHiddenRight
        ? "both"
        : hasHiddenLeft
          ? "left"
          : hasHiddenRight
            ? "right"
            : "none",
    );
  }, [resolveVirtualScrollMax, setNextEdgeShadowState]);
  const latestMeasureEdgeShadowStateRef = useRef(measureEdgeShadowState);

  useEffect(() => {
    latestMeasureEdgeShadowStateRef.current = measureEdgeShadowState;
  });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!root || !frame || !viewport || !table) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      return;
    }

    // The table viewport needs to be arranged according to the natural width of the content first, and then expanded to the current frame width at most.
    // Plus the borrowable space on the right; using w-full directly will lose the layout semantics of small tables shrinking according to content.
    let rafId: number | null = null;
    let rectWatchRafId: number | null = null;
    let rectWatchUntil = 0;
    let latestRootRect = readMarkdownTableObservedRect(root);
    let latestFrameRect = readMarkdownTableObservedRect(frame);
    const scheduleMeasure = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestRootRect = readMarkdownTableObservedRect(root);
        latestFrameRect = readMarkdownTableObservedRect(frame);
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      });
    };
    const watchRectChanges = () => {
      rectWatchRafId = null;
      const nextRootRect = readMarkdownTableObservedRect(root);
      const nextFrameRect = readMarkdownTableObservedRect(frame);
      const rectChanged =
        !isMarkdownTableObservedRectEqual(latestRootRect, nextRootRect) ||
        !isMarkdownTableObservedRectEqual(latestFrameRect, nextFrameRect);

      if (rectChanged) {
        // Collapsing/expanding the status panel may only change the left/right position of the chat root.
        // ResizeObserver does not necessarily fire; polling the rect signature allows left and right borrowing and scroll slot width to update with the layout animation.
        latestRootRect = nextRootRect;
        latestFrameRect = nextFrameRect;
        scheduleMeasure();
      }

      if (performance.now() < rectWatchUntil) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const scheduleMeasureAndWatchRect = () => {
      scheduleMeasure();
      rectWatchUntil = performance.now() + 800;
      if (rectWatchRafId === null) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasureAndWatchRect);
    mutationObserver?.observe(root, {
      attributeFilter: ["style"],
      attributes: true,
    });

    measureViewportMaxWidth();
    scheduleMeasureAndWatchRect();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasureAndWatchRect);
      return () => {
        window.removeEventListener("resize", scheduleMeasureAndWatchRect);
        mutationObserver?.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
      };
    }

    const resizeObserver = new ResizeObserver(scheduleMeasureAndWatchRect);
    resizeObserver.observe(root);
    resizeObserver.observe(frame);
    resizeObserver.observe(viewport);
    resizeObserver.observe(table);
    window.addEventListener("resize", scheduleMeasureAndWatchRect);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasureAndWatchRect);
      mutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
    };
  }, [commitScrollbarWidth, commitViewportMaxWidth, measureViewportMaxWidth]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const updateViewportLayout = () => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    };
    const updateEdgeShadowState = () => {
      syncVirtualScrollMetrics();
      latestMeasureEdgeShadowStateRef.current();
    };
    const handleWheel = (event: WheelEvent) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) {
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      if (virtualScrollMax <= 1) {
        return;
      }

      event.preventDefault();
      // Borrowing to the left and scrolling the table content originally maintained their respective positions, and the boundaries would cover each other, making it impossible to roll back;
      // Now use virtual scrollLeft mapping uniformly: consume leftOffset first, and then give the remaining amount to the real viewport.scrollLeft.
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      updateViewportLayout();
    };

    // Performance fix: p12 trace shows that changes in the children of the streaming table will rebuild the observer and read the layout synchronously.
    // The observer life cycle is only bound to DOM nodes, and content changes are handed over to ResizeObserver and merged into the next frame for measurement.
    let rafId: number | null = null;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateEdgeShadowState();
      });
    };

    updateEdgeShadowState();
    viewport.addEventListener("scroll", updateEdgeShadowState, {
      passive: true,
    });
    viewport.addEventListener("wheel", handleWheel, { passive: false });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateEdgeShadowState);
        viewport.removeEventListener("wheel", handleWheel);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(table);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateEdgeShadowState);
      viewport.removeEventListener("wheel", handleWheel);
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    commitVirtualScrollLeft,
    measureViewportMaxWidth,
    resolveVirtualScrollMax,
    setNextEdgeShadowState,
    syncVirtualScrollMetrics,
  ]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const table = tableRef.current;
    const wrapper = virtualScrollbarWrapperRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame || !table || !wrapper || !virtualScrollbarSticky) {
      if (wrapper) wrapper.style.transform = "";
      return;
    }

    const verticalViewport = resolveMarkdownTableVerticalViewport(table, root);
    if (!verticalViewport) return;

    let rafId: number | null = null;
    let observedDock: HTMLElement | null = null;
    const updateStickyOffset = () => {
      rafId = null;
      const frameRect = frame.getBoundingClientRect();
      const viewportRect = verticalViewport.getBoundingClientRect();
      const dockHeight = readMarkdownTableDockHeight(root);
      // When off the bottom, the "Back to bottom" button is located above the composer dock; only pressing the dock will make the long table
      // The sticky scroll bar occupies the same horizontal strip as the button, causing the button to be obscured by the wide scroll groove.
      const backToBottomClearance = readMarkdownTableBackToBottomClearance(root);
      const offset = resolveMarkdownTableStickyScrollbarOffset({
        frameTop: frameRect.top,
        frameBottom: frameRect.bottom,
        scrollbarHeight: wrapper.getBoundingClientRect().height,
        viewportBottom: viewportRect.bottom - dockHeight - backToBottomClearance,
      });
      wrapper.style.transform = offset === 0 ? "" : `translateY(${Math.round(offset)}px)`;
    };
    const scheduleStickyOffset = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateStickyOffset);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleStickyOffset);
    const syncDockObservation = () => {
      const nextDock =
        root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR) ?? null;
      // MutationObserver is also responsible for sensing the mount/unmount of the return to bottom button in the dock; even if the dock
      // A geometry update must be scheduled even if the node itself does not change.
      if (nextDock === observedDock) {
        scheduleStickyOffset();
        return;
      }
      if (observedDock) resizeObserver?.unobserve(observedDock);
      observedDock = nextDock;
      if (observedDock) resizeObserver?.observe(observedDock);
      scheduleStickyOffset();
    };

    // V4 virtual row uses transform positioning, and native sticky will be transformed ancestor
    // Confined to natural location. Instead, it follows the timeline scroll to calculate vertical compensation, and is still constrained by the upper and lower boundaries of the current table.
    updateStickyOffset();
    verticalViewport.addEventListener("scroll", scheduleStickyOffset, { passive: true });
    window.addEventListener("resize", scheduleStickyOffset);
    resizeObserver?.observe(frame);
    resizeObserver?.observe(verticalViewport);
    syncDockObservation();
    // draft/empty switching will conditionally mount or replace the V4 composer dock; only observing the initial node will make
    // Increasing the input of a new dock no longer triggers bottom recalculation, so the subtree changes of the root node are tracked and re-binded at the same time.
    const dockMutationObserver =
      typeof MutationObserver === "undefined" || !root
        ? null
        : new MutationObserver(syncDockObservation);
    if (dockMutationObserver && root) {
      dockMutationObserver.observe(root, { childList: true, subtree: true });
    }

    return () => {
      verticalViewport.removeEventListener("scroll", scheduleStickyOffset);
      window.removeEventListener("resize", scheduleStickyOffset);
      resizeObserver?.disconnect();
      dockMutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      wrapper.style.transform = "";
    };
  }, [virtualScrollbarSticky, virtualScrollbarVisible]);

  const getRows = useCallback(() => readRowsFromTable(tableRef.current), []);
  const commitVirtualScrollLeftFromClientX = useCallback(
    (clientX: number, thumbDragOffset: number | null = null) => {
      const track = virtualScrollTrackRef.current;
      const viewport = scrollViewportRef.current;
      if (!track || !viewport) return;

      const trackRect = track.getBoundingClientRect();
      const trackWidth = trackRect.width;
      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
        scrollLeft: virtualScrollLeftRef.current,
        scrollMax: virtualScrollMax,
        tableWidth: resolveTableWidth(viewport),
        trackWidth,
      });
      const maxThumbLeft = Math.max(0, trackWidth - metrics.thumbWidth);
      const rawThumbLeft =
        thumbDragOffset === null
          ? clientX - trackRect.left - metrics.thumbWidth / 2
          : clientX - trackRect.left - thumbDragOffset;
      const nextThumbLeft = Math.min(maxThumbLeft, Math.max(0, rawThumbLeft));
      const nextVirtualScrollLeft =
        maxThumbLeft <= 0 ? 0 : (nextThumbLeft / maxThumbLeft) * virtualScrollMax;

      commitVirtualScrollLeft(nextVirtualScrollLeft);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveTableWidth, resolveVirtualScrollMax],
  );
  const handleVirtualScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = true;
      virtualScrollbarDragOffsetRef.current = null;
      event.currentTarget.setPointerCapture(event.pointerId);
      commitVirtualScrollLeftFromClientX(event.clientX);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = false;
      virtualScrollbarDragOffsetRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const track = virtualScrollTrackRef.current;
      if (!track) return;

      const trackRect = track.getBoundingClientRect();
      isVirtualScrollbarDraggingRef.current = true;
      // Thumb is a child element of track. When pressing and holding thumb, the click jump logic of track cannot bubble up;
      // Record the position of the pointer within the thumb and maintain this relative offset when dragging to avoid the thumb suddenly jumping in the center.
      virtualScrollbarDragOffsetRef.current = Math.max(
        0,
        event.clientX - trackRect.left - virtualScrollThumbLeftRef.current,
      );
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarThumbPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      handleVirtualScrollbarPointerEnd(event);
    },
    [handleVirtualScrollbarPointerEnd],
  );
  const handleVirtualScrollbarWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) return;

      const viewport = scrollViewportRef.current;
      if (!viewport || resolveVirtualScrollMax(viewport) <= 1) return;

      event.preventDefault();
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveVirtualScrollMax],
  );

  const handleCopyMarkdown = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "markdownTable.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(buildMarkdownTableText(getRows()));
      toast(intl.formatMessage({ id: "markdownTable.copySucceeded" }));
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "markdownTable.copyFailed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }, [getRows, intl]);

  const handleDownloadCsv = useCallback(() => {
    if (
      typeof document === "undefined" ||
      typeof Blob === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      toast(intl.formatMessage({ id: "markdownTable.downloadFailed" }));
      return;
    }

    const blob = new Blob([buildCsvTableText(getRows())], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "table.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [getRows, intl]);
  const handleToggleExpandedScroll = useCallback(() => {
    const nextExpandedScrollEnabled = !expandedScrollEnabledRef.current;
    commitExpandedScrollEnabled(nextExpandedScrollEnabled);

    if (!nextExpandedScrollEnabled) {
      maxViewportLeftOffsetRef.current = 0;
      commitViewportLeftOffset(0);
      const viewport = scrollViewportRef.current;
      if (viewport) {
        // When returning to normal mode from enhanced mode, the existing virtual scroll position may be consumed by left borrowing;
        // First clear leftOffset and then map the same virtual scrollLeft back to the real scrollLeft to prevent the table content from jumping back to the beginning.
        viewport.scrollLeft = virtualScrollLeftRef.current;
      }
    }

    requestAnimationFrame(() => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    });
  }, [commitExpandedScrollEnabled, commitViewportLeftOffset, measureViewportMaxWidth]);

  const copyLabel = intl.formatMessage({ id: "markdownTable.copyMarkdown" });
  const downloadLabel = intl.formatMessage({ id: "markdownTable.downloadCsv" });
  const previewLabel = intl.formatMessage({ id: "markdownTable.openPreview" });
  const scrollModeLabel = intl.formatMessage({
    id: expandedScrollEnabled
      ? "markdownTable.collapseScrollMode"
      : "markdownTable.expandScrollMode",
  });
  const previewTitle = intl.formatMessage({ id: "markdownTable.previewTitle" });
  const previewDescription = intl.formatMessage({
    id: "markdownTable.previewDescription",
  });
  // viewportMaxWidth is the virtual scroll groove width, used to calculate virtualScrollMax and thumb;
  // The content layer itself will borrow translateX to the left, so the borrowed width needs to be added to the right side to prevent the visual right boundary from moving to the left.
  const contentViewportMaxWidth =
    viewportLeftOffset > 0
      ? `calc(${viewportMaxWidth} + ${Math.ceil(viewportLeftOffset)}px)`
      : viewportMaxWidth;

  return (
    <div ref={rootRef} className="my-0 flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-end gap-1" data-markdown-table-toolbar="">
        <MarkdownTableActionButton
          label={copyLabel}
          onClick={() => {
            void handleCopyMarkdown();
          }}
        >
          <CopyIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={downloadLabel} onClick={handleDownloadCsv}>
          <DownloadIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={previewLabel} onClick={() => setPreviewOpen(true)}>
          <Maximize2Icon className="size-3.5" />
        </MarkdownTableActionButton>
        {canToggleExpandedScroll ? (
          <MarkdownTableActionButton label={scrollModeLabel} onClick={handleToggleExpandedScroll}>
            {expandedScrollEnabled ? (
              <ArrowLeftFromLine className="size-3.5" />
            ) : (
              <ArrowRightToLine className="size-3.5" />
            )}
          </MarkdownTableActionButton>
        ) : null}
      </div>
      <div
        ref={frameRef}
        className="group/markdown-table-frame relative w-full"
        data-markdown-table-frame=""
        data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
      >
        <div
          className={cn(
            "min-w-full w-max",
            viewportLeftOffset <= 0 &&
              "transition-[max-width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={{
            maxWidth: contentViewportMaxWidth,
            transform: viewportLeftOffset > 0 ? `translateX(-${viewportLeftOffset}px)` : undefined,
          }}
        >
          <div
            // The table already has edge shadow prompts for horizontal overflow, and displaying the system scroll bar will produce additional visual noise at the bottom of the message block;
            // The outer width container calculates the maximum width based on frame width + rightDistance, and the scrolling viewport only fills up the container.
            className="relative w-full overflow-hidden rounded-xl border border-border"
          >
            <div
              ref={scrollViewportRef}
              className="!scrollbar-hide w-full overflow-x-auto overflow-y-visible"
            >
              <table
                ref={tableRef}
                className={cn(
                  "w-max min-w-full border-separate border-spacing-0 text-ui-base",
                  className,
                )}
                {...props}
                data-streamdown="table"
              >
                {children}
              </table>
            </div>
            <MarkdownTableEdgeShadow side="left" state={edgeShadowState} />
            <MarkdownTableEdgeShadow side="right" state={edgeShadowState} />
          </div>
        </div>
        <div
          ref={virtualScrollbarWrapperRef}
          aria-hidden={!virtualScrollbarVisible}
          // Sticky under V4 transformed virtual row is simulated by relative + translateY,
          // Computed position cannot express product semantics; explicit state is read by cross-implementation E2E and accessibility diagnostics.
          data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
          data-markdown-table-virtual-scroll-visible={virtualScrollbarVisible ? "true" : "false"}
          // The scroll bar slot width must be equal to frameRect.width + rightDistance and then deduct the message column responsive right padding;
          // Long tables need to be able to scroll horizontally when reading vertically, and the sticky bottom must avoid composer and bottom panels.
          // When overflow measures changes, it only switches visibility, retaining nodes and vertical occupancies to avoid disturbing the timeline height.
          style={{ width: scrollbarWidth }}
          className={cn(
            "pointer-events-none py-1 opacity-0 transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
            virtualScrollbarVisible
              ? "visible group-hover/markdown-table-frame:pointer-events-auto group-hover/markdown-table-frame:opacity-100"
              : "invisible",
            virtualScrollbarSticky && "relative z-20",
          )}
        >
          <div
            ref={virtualScrollTrackRef}
            aria-hidden="true"
            className="mt-1 h-3.5 w-full touch-none rounded-full bg-foreground/3"
            data-markdown-table-virtual-scroll-track=""
            onPointerCancel={handleVirtualScrollbarPointerEnd}
            onPointerDown={handleVirtualScrollbarPointerDown}
            onPointerMove={handleVirtualScrollbarPointerMove}
            onPointerUp={handleVirtualScrollbarPointerEnd}
            onWheel={handleVirtualScrollbarWheel}
          >
            <div
              className="h-3 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/40"
              onPointerCancel={handleVirtualScrollbarThumbPointerEnd}
              onPointerDown={handleVirtualScrollbarThumbPointerDown}
              onPointerMove={handleVirtualScrollbarThumbPointerMove}
              onPointerUp={handleVirtualScrollbarThumbPointerEnd}
              style={virtualScrollThumbStyle}
            />
          </div>
        </div>
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] w-max max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden rounded-2xl p-4 sm:max-h-[calc(100vh-8rem)] sm:max-w-[calc(100vw-8rem)] md:min-w-[640px] lg:min-w-[720px]">
          <DialogHeader className="pr-8">
            <DialogTitle>{previewTitle}</DialogTitle>
            <DialogDescription>{previewDescription}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto rounded-xl border border-border bg-background">
            <table
              className={cn(
                "w-max min-w-full border-separate border-spacing-0 text-ui-base [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background",
                className,
              )}
              {...props}
              data-streamdown="table-preview"
            >
              {children}
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MarkdownTableEdgeShadow({
  side,
  state,
}: {
  side: "left" | "right";
  state: MarkdownTableEdgeShadowState;
}) {
  const visible = state === side || state === "both";
  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-6",
        side === "left"
          ? "left-0 rounded-l-xl shadow-[inset_12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]"
          : "right-0 rounded-r-xl shadow-[inset_-12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]",
      )}
      data-markdown-table-edge-shadow={side}
    />
  );
}

function MarkdownTableActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <Button type="button" variant="ghost" size="icon-md" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

export type MarkdownTableHeaderProps = ComponentProps<"thead"> & MarkdownTableNodeProp;

export function MarkdownTableHeader({
  className,
  node: _node,
  ...props
}: MarkdownTableHeaderProps) {
  return <thead className={cn("", className)} {...props} />;
}

export type MarkdownTableBodyProps = ComponentProps<"tbody"> & MarkdownTableNodeProp;

export function MarkdownTableBody({ className, node: _node, ...props }: MarkdownTableBodyProps) {
  return <tbody className={cn("", className)} {...props} />;
}

export type MarkdownTableRowProps = ComponentProps<"tr"> & MarkdownTableNodeProp;

export function MarkdownTableRow({ className, node: _node, ...props }: MarkdownTableRowProps) {
  return (
    <tr
      className={cn("transition-colors last:[&>td]:border-b-0 hover:bg-hover/20", className)}
      {...props}
    />
  );
}

export type MarkdownTableHeadProps = ComponentProps<"th"> & MarkdownTableNodeProp;

export function MarkdownTableHead({ className, node: _node, ...props }: MarkdownTableHeadProps) {
  return (
    <th
      className={cn(
        "border-border border-b px-3 py-2 text-left font-normal text-foreground-subtlest min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}

export type MarkdownTableCellProps = ComponentProps<"td"> & MarkdownTableNodeProp;

export function MarkdownTableCell({ className, node: _node, ...props }: MarkdownTableCellProps) {
  return (
    <td
      className={cn(
        "border-border border-b px-3 py-2 text-foreground align-top min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}
