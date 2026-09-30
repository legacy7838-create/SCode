import { isIP } from "node:net";
import type { BrowserInfo } from "./facade.js";

type BrowserTabsByBrowserId = ReadonlyMap<string, readonly string[]>;

function isPreferredExtension(info: BrowserInfo): boolean {
  return (
    info.type === "extension" &&
    (info.metadata?.preferred === "true" ||
      info.metadata?.preferredInstance === "true" ||
      info.metadata?.profileIsLastUsed === "true" ||
      info.metadata?.profileOrdering === "0")
  );
}

function backendFallbackRank(info: BrowserInfo): number {
  if (info.type === "iab") return 0;
  if (isPreferredExtension(info)) return 1;
  if (info.type === "extension") return 2;
  return 3;
}

export function selectDefaultBrowser(infos: readonly BrowserInfo[]): BrowserInfo | undefined {
  return [...infos].sort(
    (left, right) => backendFallbackRank(left) - backendFallbackRank(right),
  )[0];
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid browser target URL: ${value}`);
  }
}

function isLocalTarget(url: URL): boolean {
  if (url.protocol === "file:") return true;
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function urlMatchRank(target: URL, candidate: URL): number | undefined {
  if (withoutHash(target) === withoutHash(candidate)) return 0;
  if (target.origin === candidate.origin && target.pathname === candidate.pathname) return 1;
  if (target.hostname === candidate.hostname) return 2;
  const targetHost = target.hostname.toLowerCase();
  const candidateHost = candidate.hostname.toLowerCase();

  const isParentHost = (parent: string, child: string) =>
    parent.includes(".") && isIP(parent) === 0 && child.endsWith(`.${parent}`);
  if (isParentHost(candidateHost, targetHost) || isParentHost(targetHost, candidateHost)) return 3;
  return undefined;
}

/**
 * The tab reuse match for open(url): it picks the one agent-owned tab most worth navigating in place.
 * The reuse threshold is rank <= 2 (the same hostname); at rank 3 a parent/child domain pair may well be different sites and the risk of mis-navigation is high, so it is not reused.
 * Among equal ranks the active tab wins, otherwise the newest (latest) entry in the list is taken.
 * Like selectBrowserForUrl it is a pure function, so the same contract cases can be shared.
 */
export function selectTabForUrl<T extends { url?: string; active?: boolean }>(
  targetValue: string,
  tabs: readonly T[],
): T | undefined {
  const target = parseUrl(targetValue);
  let best: { tab: T; rank: number } | undefined;
  for (const tab of tabs) {
    if (!tab.url) continue;
    let rank: number | undefined;
    try {
      rank = urlMatchRank(target, parseUrl(tab.url));
    } catch {
      continue; // A single bad URL should not invalidate a reuse match.
    }
    if (rank === undefined || rank > 2) continue;
    if (
      best === undefined ||
      rank < best.rank ||
      // Same as rank: active takes priority; when neither is active, the one at the bottom of the list (updated) wins.
      (rank === best.rank && (tab.active === true || best.tab.active !== true))
    ) {
      best = { tab, rank };
    }
  }
  return best?.tab;
}

/**
 * URL selection is a pure function, so that IAB/extension/CDP can be constrained by one and the same set of contract cases.
 * An explicit browser selection does not come through here, so the fallback here cannot cause a silent switch across backends.
 */
export function selectBrowserForUrl(
  infos: readonly BrowserInfo[],
  targetValue: string,
  tabsByBrowserId: BrowserTabsByBrowserId,
): BrowserInfo {
  if (infos.length === 0) {
    throw new Error("No browser backend is available");
  }
  if (infos.length === 1) {
    return infos[0];
  }

  const target = parseUrl(targetValue);
  if (isLocalTarget(target)) {
    const iab = infos.find((info) => info.type === "iab");
    if (iab) return iab;
  }

  const matches = infos.flatMap((info) => {
    let best: number | undefined;
    for (const value of tabsByBrowserId.get(info.id) ?? []) {
      try {
        const rank = urlMatchRank(target, parseUrl(value));
        if (rank !== undefined && (best === undefined || rank < best)) best = rank;
      } catch {
        // A single bad URL returned by the backend should not invalidate the entire registry.
      }
    }
    return best === undefined ? [] : [{ info, matchRank: best }];
  });
  matches.sort(
    (left, right) =>
      left.matchRank - right.matchRank ||
      backendFallbackRank(left.info) - backendFallbackRank(right.info),
  );
  return matches[0]?.info ?? selectDefaultBrowser(infos) ?? infos[0];
}
