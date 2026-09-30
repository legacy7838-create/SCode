import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

interface ConversationTimelineLiveTailSplit {
  virtualizedUnits: readonly ConversationTurnRenderUnit[];
  liveUnit: ConversationTurnRenderUnit | null;
  liveUnitIndex: number | null;
}

/**
 * While a running turn stays in the absolutely positioned virtual rows, the body DOM grows first
 * and only the next frame does the ResizeObserver write back totalSize/scrollTop, which makes the
 * ChatLoading at the tail jump back and forth. Only the genuinely last running unit is split out as
 * a normal-flow live tail; historical or stale running rows still belong to the virtual list, so
 * the resident DOM does not grow.
 */
export function splitConversationTimelineLiveTail(
  units: readonly ConversationTurnRenderUnit[],
): ConversationTimelineLiveTailSplit {
  const liveUnitIndex = units.length - 1;
  const liveUnit = units[liveUnitIndex];
  if (!liveUnit?.isRunning) {
    return { virtualizedUnits: units, liveUnit: null, liveUnitIndex: null };
  }
  return {
    virtualizedUnits: units.slice(0, liveUnitIndex),
    liveUnit,
    liveUnitIndex,
  };
}
