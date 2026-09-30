import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, type RefObject } from "react";
import type { ZCodeModelTrajectoryRecord } from "@zcode/services";
import {
  type TrajectorySearchMatch,
  type TrajectorySearchTimelineItem,
} from "@/ModelTrajectorySearch.js";
import {
  applyTrajectorySearchHighlights,
  clearTrajectorySearchHighlights,
  isTrajectorySearchTargetMounted,
  scrollTrajectorySearchRangeIntoView,
} from "@/ModelTrajectorySearchHighlight.js";
import { CallCard, type IntlShape } from "@/ModelTrajectoryPaneParts.js";

export function ModelTrajectoryTimeline({
  items,
  searchQuery,
  searchMatches,
  activeSearchMatch,
  intl,
  scrollContainerRef,
}: {
  items: TrajectorySearchTimelineItem[];
  searchQuery: string;
  searchMatches: TrajectorySearchMatch[];
  activeSearchMatch: TrajectorySearchMatch | null;
  intl: IntlShape;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => items[index]?.key ?? index,
    estimateSize: () => 240,
    overscan: 3,
  });
  // Search switching will collapse old hits and expand new hits at the same time; at this time, virtualizer is prohibited from calling back continuously based on each height measurement.
  // The scroll anchor point is corrected, and the scrolling is completed once the layout is stabilized from the text-level positioning below.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => !searchQuery;
  const roleWidthLabels = ["system", "user", "assistant", "tool"].map((role) =>
    intl.formatMessage({ id: `modelTrajectory.role.${role}` }),
  );
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems.at(-1);
  const topSpacerHeight = firstVirtualItem?.start ?? 0;
  const bottomSpacerHeight = lastVirtualItem ? virtualizer.getTotalSize() - lastVirtualItem.end : 0;
  // Only track mount collections. Putting start into the dependency will reschedule an accurate scroll for each dynamic height measurement.
  const mountedRowsKey = virtualItems.map((item) => item.key).join("|");

  useEffect(() => () => clearTrajectorySearchHighlights(), []);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (
      !activeSearchMatch ||
      !root ||
      isTrajectorySearchTargetMounted(root, activeSearchMatch.expansionKey)
    ) {
      return;
    }
    // Skip the Call-level pre-rolling when the target is mounted, otherwise subsequent text-level positioning will cause two consecutive jumps.
    virtualizer.scrollToIndex(activeSearchMatch.callIndex, { align: "center" });
  }, [activeSearchMatch, scrollContainerRef, virtualizer]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !searchQuery) {
      clearTrajectorySearchHighlights();
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      virtualizer.measure();
      secondFrame = window.requestAnimationFrame(() => {
        const activeRange = applyTrajectorySearchHighlights({
          root,
          query: searchQuery,
          matches: searchMatches,
          activeMatch: activeSearchMatch,
        });
        if (activeRange) scrollTrajectorySearchRangeIntoView(activeRange, root);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [
    activeSearchMatch,
    mountedRowsKey,
    scrollContainerRef,
    searchMatches,
    searchQuery,
    virtualizer,
  ]);

  return (
    <ol
      data-trajectory-timeline=""
      className="grid grid-cols-[max-content_minmax(0,1fr)_auto] gap-x-2"
    >
      {roleWidthLabels.map((label) => (
        <li
          key={label}
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 h-0 overflow-hidden whitespace-nowrap font-mono text-ui-sm"
        >
          {label}
        </li>
      ))}
      {topSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: topSpacerHeight }} />
      ) : null}
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <li
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-trajectory-virtual-row=""
            className="col-span-full grid w-full grid-cols-subgrid"
          >
            <CallCard
              record={item.record}
              index={virtualItem.index}
              inputMessages={item.inputMessages}
              expansionKeyPrefix={item.key}
              intl={intl}
            />
          </li>
        );
      })}
      {bottomSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: bottomSpacerHeight }} />
      ) : null}
    </ol>
  );
}

export function resolveTrajectoryTimelineItems(records: ZCodeModelTrajectoryRecord[]) {
  let previousConversationMessageCount = 0;

  return records.map((record, index) => {
    const resolvedInput = resolveTrajectoryInputMessages({
      index,
      previousConversationMessageCount,
      record,
    });
    previousConversationMessageCount = resolvedInput.nextConversationMessageCount;

    return {
      key: `${record.requestId}:${index}`,
      record,
      inputMessages: resolvedInput.inputMessages,
    };
  });
}

export function resolveTrajectoryInputMessages({
  record,
  index,
  previousConversationMessageCount,
}: {
  record: ZCodeModelTrajectoryRecord;
  index: number;
  previousConversationMessageCount: number;
}): {
  inputMessages: ZCodeModelTrajectoryRecord["request"]["messages"];
  nextConversationMessageCount: number;
} {
  const messages = record.request.messages;
  const usesConversationDelta = shouldUseConversationDelta(record);
  const deltaMessages = usesConversationDelta
    ? computeDeltaMessages(messages, previousConversationMessageCount, index)
    : messages;

  return {
    // The first one shows the complete starting context; subsequent main sessions only show new additions other than assistant (assistant is presented by the previous Output).
    // Auxiliary requests such as sidecar/compact have independent prompts. The message number delta of the main session cannot be applied, otherwise the title will be hidden and the prompt will be generated.
    inputMessages: usesConversationDelta
      ? index === 0
        ? deltaMessages
        : deltaMessages.filter((message) => message.role !== "assistant")
      : deltaMessages,
    nextConversationMessageCount: usesConversationDelta
      ? messages.length
      : previousConversationMessageCount,
  };
}

function shouldUseConversationDelta(record: ZCodeModelTrajectoryRecord): boolean {
  const kind = record.callSource?.kind;
  return kind === undefined || kind === "main" || kind === "subagent";
}

function computeDeltaMessages(
  messages: ZCodeModelTrajectoryRecord["request"]["messages"],
  previousMessageCount: number,
  index: number,
): ZCodeModelTrajectoryRecord["request"]["messages"] {
  if (index === 0) return messages;
  if (messages.length > previousMessageCount) return messages.slice(previousMessageCount);
  if (messages.length < previousMessageCount) return messages;
  return [];
}
