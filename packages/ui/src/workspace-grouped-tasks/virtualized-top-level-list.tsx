import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ZCodeGroupedTaskViewNode } from "@zcode/services";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/workspace-grouped-tasks/virtualized-scroll.js";

const GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX = 32;
const GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX = 40;
const GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD = 80;
const GROUPED_TOP_LEVEL_VIRTUALIZATION_OVERSCAN = 12;

function shouldVirtualizeGroupedTopLevelNodes(nodeCount: number): boolean {
  return nodeCount > GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD;
}

function getTopLevelNodeKey(node: ZCodeGroupedTaskViewNode | undefined, index: number): string {
  if (!node) {
    return `missing:${index}`;
  }
  return node.type === "group" ? `group:${node.group.id}` : `task:${taskKey(node.task)}`;
}

function estimateTopLevelNodeSize(
  node: ZCodeGroupedTaskViewNode | undefined,
  isGroupCollapsed: (groupId: string) => boolean,
): number {
  if (!node || node.type === "task") {
    return GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX;
  }
  if (isGroupCollapsed(node.group.id)) {
    return GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX;
  }
  return (
    GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX +
    Math.min(node.tasks.length, 24) * GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX
  );
}

function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isPotentialVerticalScrollContainer(style.overflowY)) {
      // When folding/expanding, the height of the top row will change first, and the scroll height will change later; only "Currently scrollable" will be recognized.
      // This will cause the virtual machine to lose the scrollElement in the transition frame, and after expansion, the header will appear stateful but with blank content.
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveScrollMargin(listElement: HTMLElement, scrollElement: HTMLElement): number {
  return (
    listElement.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop
  );
}

function VirtualizedGroupedTopLevelList({
  nodes,
  isGroupCollapsed,
  renderNode,
}: {
  nodes: ZCodeGroupedTaskViewNode[];
  isGroupCollapsed: (groupId: string) => boolean;
  renderNode: (node: ZCodeGroupedTaskViewNode, index: number) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = shouldVirtualizeGroupedTopLevelNodes(nodes.length);
  const getItemKey = useCallback(
    (index: number) => getTopLevelNodeKey(nodes[index], index),
    [nodes],
  );
  const estimateSize = useCallback(
    (index: number) => estimateTopLevelNodeSize(nodes[index], isGroupCollapsed),
    [isGroupCollapsed, nodes],
  );

  const updateScrollMargin = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    const nextScrollElement = findNearestScrollableAncestor(listElement);
    setScrollElement(nextScrollElement);
    if (!nextScrollElement) {
      setScrollMargin(0);
      return;
    }
    setScrollMargin(resolveScrollMargin(listElement, nextScrollElement));
  }, []);
  const resolveInitialScrollOffset = useCallback(() => {
    const listElement = listRef.current;
    const currentScrollElement =
      scrollElement ?? (listElement ? findNearestScrollableAncestor(listElement) : null);
    return currentScrollElement?.scrollTop ?? 0;
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setScrollElement(null);
      setScrollMargin(0);
      return undefined;
    }
    updateScrollMargin();
    const listElement = listRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !listElement
        ? null
        : new ResizeObserver(updateScrollMargin);
    if (listElement) {
      resizeObserver?.observe(listElement);
    }
    const animationFrame = window.requestAnimationFrame(updateScrollMargin);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateScrollMargin);
      resizeObserver?.disconnect();
    };
  }, [nodes.length, shouldVirtualize, updateScrollMargin]);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? nodes.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize,
    getItemKey,
    overscan: GROUPED_TOP_LEVEL_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollToFn: scrollGroupedTaskVirtualizerToOffset,
    // The virtualizer may rebind the scrollElement after the shared scroll container has been scrolled.
    // The default initialOffset of react-virtual is 0. It will automatically scrollTo(0) when it is bound for the first time.
    // This causes the task list on the left to occasionally scroll to the top; here, the real scrollTop is checked from the DOM site.
    // Avoid caching 0 in advance when the scrollElement state in the first layout effect has not yet been written back.
    initialOffset: resolveInitialScrollOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  const renderedVirtualNodes = useMemo(
    () =>
      virtualRows.map((virtualRow) => {
        const node = nodes[virtualRow.index];
        if (!node) {
          return null;
        }
        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            data-index={virtualRow.index}
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderNode(node, virtualRow.index)}
          </div>
        );
      }),
    [nodes, renderNode, rowVirtualizer.measureElement, scrollMargin, virtualRows],
  );

  if (!shouldVirtualize) {
    return <>{nodes.map((node, index) => renderNode(node, index))}</>;
  }

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        overflowAnchor: "none",
      }}
    >
      {/* There may also be 2000+ non-group top-level tasks; in the past, only tasks within the group were virtualized.
          The top-level view.nodes still mounts all rows at once. The real index of dnd-kit is retained here.
          But only the nodes near the scrolling window are rendered, which reduces the initial rendering and scrolling CPU. */}
      {/* Virtual rows mount/unmount frequently while scrolling, Chrome's scroll anchoring occasionally
          Select these absolutely positioned nodes as anchor points and correct the scrollTop in the reverse direction to make the list suddenly return to the top.
          Anchor selection for the virtual list subtree is disabled here, and the scroll position is controlled only by the user's scroll wheel and the virtualizer. */}
      {renderedVirtualNodes}
    </div>
  );
}

export {
  GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD,
  VirtualizedGroupedTopLevelList,
  shouldVirtualizeGroupedTopLevelNodes,
};
