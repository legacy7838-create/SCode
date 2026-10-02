import type { ZCodeTaskListItem, ZCodeTaskListSortBy } from "@zcode/services";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";

/**
 * Merge of per-workspace-shard listTaskList results into one global list.
 *
 * Each shard is queried against its own endpoint's tasks-index with the same kind/sortBy/search
 * and (when collapsed) the same limit. `total` must be the sum of shard totals — the shards only
 * return their own top-N rows, so counting merged rows would understate the list and break the
 * "show more" gate — and `hasMore` follows any shard reporting more.
 */
export interface GlobalTaskListShardResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export function mergeGlobalTaskListResults(params: {
  shards: GlobalTaskListShardResult[];
  sortBy: ZCodeTaskListSortBy;
  limit?: number;
}): { items: ZCodeTaskListItem[]; total: number; hasMore: boolean } {
  const merged = params.shards
    .flatMap((shard) => shard.items)
    .sort((left, right) => compareZCodeTaskListItems(left, right, params.sortBy));
  const mergedTotal = params.shards.reduce((sum, shard) => sum + shard.total, 0);
  const mergedHasMore = params.shards.some((shard) => shard.hasMore) || mergedTotal > merged.length;
  const visible = params.limit == null ? merged : merged.slice(0, params.limit);
  return { items: visible, total: mergedTotal, hasMore: mergedHasMore };
}
