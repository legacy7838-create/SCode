// Virtual scrolling core: v4 timeline row-height cache (pure data structure, no DOM/React dependencies).
//
// Why it is needed: @tanstack/react-virtual's own measurementsCache caches by itemKey,
// Rows are unloaded/remounted within the window without losing measurements; however, when the streaming row height continues to grow, the virtualizer resets
// (rows array reconstruction, component StrictMode rehang, error state ↔ timeline switching) will clear the cache
// The fixed value of estimateSize causes the scroll bar to jump and the bottom anchor to jitter. Here is the stability of render unit
// key (turnId) creates a layer of persistent cache within the component instance for the key to ensure "line unloading and re-mounting to ensure high caching".
//

/**
 * Fallback estimated height for unmeasured rows (same as the old ConversationTimeline's
 * ROW_ESTIMATE_PX).
 */
export const DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72;

/**
 * Cache size cap: guards against memory growth in very long conversations; evicts the least
 * recently written row (write order ≈ row order, so old rows are evicted first).
 */
const MAX_ROW_HEIGHT_CACHE_ENTRIES = 4000;

type TimelineRowHeightCacheKey = string | number;

export class TimelineRowHeightCache {
  private readonly sizes = new Map<TimelineRowHeightCacheKey, number>();

  constructor(private readonly maxEntries: number = MAX_ROW_HEIGHT_CACHE_ENTRIES) {}

  get size(): number {
    return this.sizes.size;
  }

  /**
   * Records one real measurement. A repeated write refreshes the eviction order (active rows are
   * not evicted).
   */
  set(key: TimelineRowHeightCacheKey, heightPx: number): void {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      return;
    }
    // Map iteration order = insertion order; delete first and then insert to move the row to the "latest" end.
    this.sizes.delete(key);
    this.sizes.set(key, heightPx);
    while (this.sizes.size > this.maxEntries) {
      const oldest = this.sizes.keys().next();
      if (oldest.done) break;
      this.sizes.delete(oldest.value);
    }
  }

  get(key: TimelineRowHeightCacheKey): number | undefined {
    return this.sizes.get(key);
  }

  /**
   * estimateSize entry point: uses the measurement when there is one and falls back to the estimate
   * when there is none.
   */
  estimate(
    key: TimelineRowHeightCacheKey | undefined,
    fallbackPx: number = DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  ): number {
    if (key === undefined) return fallbackPx;
    return this.sizes.get(key) ?? fallbackPx;
  }

  /**
   * Reset wholesale on session switch (turnId cannot be assumed globally unique across different
   * sessions either).
   */
  clear(): void {
    this.sizes.clear();
  }
}
