// Throttling criteria for "Catalog Auto-Refresh" on store pages.
//
// Requirement: The ZCode official market will be refreshed by default every time you enter the store page, so that newly launched plug-ins on the CDN can be seen without manually clicking refresh;
// But it needs to be throttled (if the window is less than the last successful refresh, it will be skipped) and anti-shake (after the refresh fails, the request will not be triggered again while it is still in flight).
//
// Criterion = now - max(lastUpdated, lastAttemptAt) >= window.
// - lastUpdated from agent persisted known_marketplaces.json, any successful refresh (manual, session recommendation plugin
//   path) will rewrite it, so it is naturally shared across windows and restarts, and the automatic window will be reset after manual refresh.
// - lastAttemptAt is the "initiation time" in the memory of this module. The UI side PluginMarketplaceSummary cannot get the failure timestamp.
//   Relying solely on lastUpdated will allow offline users to retry a long timeout request every time they enter; the attempt time will be recorded immediately when initiated.
//   At the same time, it blocks the two repetitions of "it just failed" and "it was still flying last time". It is acceptable for the process to be reset to zero (it is allowed to try again after restarting).
// - The store page is remounted every time it is entered (the key has pluginStoreOpenVersion), and the ref in the component cannot carry the throttling state.
//   So put it at the module level.

const OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS = 10 * 60_000;

const lastAttemptAtByMarketplace = new Map<string, number>();

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function shouldAutoRefreshMarketplace(params: {
  lastUpdated?: string;
  lastAttemptAt?: number;
  now: number;
}): boolean {
  const lastUpdatedAt = parseTimestamp(params.lastUpdated);
  const lastKnownAt = Math.max(lastUpdatedAt ?? -Infinity, params.lastAttemptAt ?? -Infinity);
  return params.now - lastKnownAt >= OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS;
}

/**
 * Decides whether an automatic refresh should happen; when it passes, it immediately takes the slot
 * (recording the time of this attempt) and returns true. The decision and the slot reservation
 * happen in one step, so that re-running the effect during the same mount, or rapidly entering and
 * leaving the marketplace page, does not start it twice.
 */
export function claimMarketplaceAutoRefresh(
  marketplaceId: string,
  lastUpdated: string | undefined,
  now: number = Date.now(),
): boolean {
  const shouldRefresh = shouldAutoRefreshMarketplace({
    lastUpdated,
    lastAttemptAt: lastAttemptAtByMarketplace.get(marketplaceId),
    now,
  });
  if (shouldRefresh) {
    lastAttemptAtByMarketplace.set(marketplaceId, now);
  }
  return shouldRefresh;
}
