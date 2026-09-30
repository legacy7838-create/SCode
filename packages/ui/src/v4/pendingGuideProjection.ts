import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";

interface PendingGuideQueueProjection {
  pendingGuides: readonly QueueItem[];
  visibleQueue: QueueState;
}

/**
 * The CLI reliably uses one and the same queue fact to carry both the guide and the future queue;
 * the legacy UI renders queue.items directly, which causes a guide awaiting model-step injection to
 * be misdrawn as the next turn's message. Here the display is split by authoritative admitted
 * delivery only, without copying or rewriting the accepted input state.
 */
export function projectPendingGuideQueue(queue: QueueState): PendingGuideQueueProjection {
  const pendingGuides: QueueItem[] = [];
  const visibleItems: QueueItem[] = [];
  for (const item of queue.items) {
    if (item.delivery.admitted === "guide") {
      pendingGuides.push(item);
    } else {
      visibleItems.push(item);
    }
  }
  return {
    pendingGuides,
    visibleQueue:
      visibleItems.length === queue.items.length ? queue : { ...queue, items: visibleItems },
  };
}
