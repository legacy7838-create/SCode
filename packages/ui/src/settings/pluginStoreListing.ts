import type {
  PluginStoreModeOrder,
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginStoreListing,
} from "@zcode/shared";
import {
  sortPluginStoreEntries,
  compareDocumentPluginPriority,
  resolvePluginStoreCategory as resolveStoreCategory,
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  isPublicStoreMarketplaceId,
  resolveLocalizedText,
  resolvePluginDisplayName,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
} from "@zcode/shared";
import { pluginSearchMatches } from "@/settings/pluginSearch.js";

export {
  formatCanonicalPluginName,
  resolveLocalizedText,
  resolvePluginDisplayName,
} from "@zcode/shared";

export { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";
export { isPublicStoreMarketplaceId };

/**
 * A listing is only allowed to fall back to resolving from a catalog entry when the name is unique.
 * Older payloads of the capability protocol may carry no pluginId; when same-named plugins coexist,
 * continuing to join on the bare name can misattach a third-party entry's brand and icon to another
 * marketplace, so degrading safely to the slug is more reliable.
 */
export function resolveUniquePluginListingByName(
  plugins: readonly Pick<ZCodeAvailablePluginSummary, "name" | "listing">[],
  name: string,
): ZCodePluginStoreListing | undefined {
  const normalizedName = name.trim().toLocaleLowerCase();
  let match: ZCodePluginStoreListing | undefined;
  let count = 0;
  for (const plugin of plugins) {
    if (plugin.name.trim().toLocaleLowerCase() !== normalizedName) continue;
    count += 1;
    match = plugin.listing;
  }
  return count === 1 ? match : undefined;
}

/**
 * A store entry: joins the overview's catalog entries (listing/install state), the runtime plugin
 * info (enabled state/components), and the installed records (update badge/install time) by id into
 * a single view model for the UI.
 */
export interface StorePluginItem {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  /** An uninstalled built-in plugin (restorable): the install button goes through restoreBuiltin. */
  restorable: boolean;
  /**
   * Installed, but its original marketplace has been removed; it can still run and be managed, but
   * not updated.
   */
  orphaned: boolean;
  listing?: ZCodePluginStoreListing;
  summary?: ZCodeAvailablePluginSummary;
  /**
   * Runtime info (only discovered installed plugins have any): enabled state, components, manifest
   * fallback fields.
   */
  info?: ZCodePluginInfo;
  installedMeta?: ZCodeInstalledPluginSummary;
}

export type PluginUpdateStatus = NonNullable<ZCodeInstalledPluginSummary["updateStatus"]>;

export function isPluginUpdatePending(
  updateStatus: PluginUpdateStatus | undefined,
): updateStatus is Exclude<PluginUpdateStatus, "none"> {
  return updateStatus === "update-available" || updateStatus === "version-changed";
}

/**
 * An orphaned plugin may keep the updateStatus it had before its source was removed; if every entry
 * point judges only that cached state, the details page still shows an update button while the menu
 * has updates disabled. Update capability must satisfy both "the source exists" and "there is an
 * update".
 */
export function canUpdatePluginItem(
  item: Pick<StorePluginItem, "installedMeta" | "orphaned"> | null | undefined,
): boolean {
  return Boolean(item && !item.orphaned && isPluginUpdatePending(item.installedMeta?.updateStatus));
}

export function resolveLocalizedList(
  locale: string,
  base: string[] | undefined,
  i18n: Record<string, string[]> | undefined,
): string[] | undefined {
  if (i18n) {
    const exact = i18n[locale];
    if (exact && exact.length > 0) return exact;
    const language = locale.split("-")[0];
    if (language) {
      const match = Object.entries(i18n).find(([key]) => key.split("-")[0] === language);
      if (match?.[1] && match[1].length > 0) return match[1];
    }
  }
  return base && base.length > 0 ? base : undefined;
}

export function resolveItemDisplayName(item: StorePluginItem, locale: string): string {
  return resolvePluginDisplayName(item, locale);
}

export function resolveItemDescription(item: StorePluginItem, locale: string): string | undefined {
  const base =
    item.summary?.description ?? item.info?.description ?? item.installedMeta?.description;
  return resolveLocalizedText(locale, base, item.listing?.descriptionI18n);
}

/**
 * The management list and the store reuse the display info associated by full ID, so an English
 * manifest cannot bypass localization.
 */
export function resolveManagedPluginDisplay(
  plugin: ZCodePluginInfo,
  item: StorePluginItem | undefined,
  locale: string,
): { name: string; description: string | undefined } {
  const matchingItem = item?.id === plugin.id ? item : undefined;
  return {
    name: resolvePluginDisplayName(matchingItem ?? plugin, locale),
    description: matchingItem ? resolveItemDescription(matchingItem, locale) : plugin.description,
  };
}

/**
 * i18n mapping for known categories; unknown categories are shown as-is. No category → the "other"
 * section (sorted last).
 */
export const KNOWN_CATEGORY_LABEL_IDS: Record<string, string> = {
  "developer-tools": "settings.plugins.store.category.developerTools",
  productivity: "settings.plugins.store.category.productivity",
  utilities: "settings.plugins.store.category.utilities",
  legal: "settings.plugins.store.category.legal",
  template: "settings.plugins.store.category.template",
  finance: "settings.plugins.store.category.finance",
  other: "settings.plugins.store.category.other",
};

export {
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  PLUGIN_STORE_CATEGORY_ORDER as KNOWN_CATEGORY_ORDER,
  resolvePluginStoreCategory as resolveStoreCategory,
} from "@zcode/shared";

interface StoreCategoryGroup {
  category: string;
  items: StorePluginItem[];
}

/**
 * A marketplace group in the profile section: marketplace is the sort key, title is the display
 * name.
 */
export interface PersonalMarketplaceGroup {
  marketplace: string;
  title: string;
  items: StorePluginItem[];
}

const OFFICIAL_MARKETPLACE_ORDER: readonly string[] = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID];

/**
 * Marketplace source management order: official sources are pinned to the top; custom sources run
 * by most recent refresh, with never-refreshed ones sunk to the bottom. Equal times fall back
 * stably to the localized name, so the source order does not drift with the history of the
 * persisted array.
 */
export function sortMarketplaceSources(
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): ZCodePluginMarketplaceSummary[] {
  const officialRank = new Map(OFFICIAL_MARKETPLACE_ORDER.map((id, index) => [id, index]));
  return marketplaces.toSorted((left, right) => {
    const leftRank = officialRank.get(left.id);
    const rightRank = officialRank.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }

    const leftAt = left.lastUpdated ?? "";
    const rightAt = right.lastUpdated ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    const byName = left.name.localeCompare(right.name, locale);
    return byName !== 0 ? byName : left.id.localeCompare(right.id, locale);
  });
}

/**
 * Marketplace group order in the profile section: by lastUpdated descending — the most recently
 * refreshed or added marketplace sits on top, so the first thing a user sees after being sent here
 * from a successful add is the one they just added; those without lastUpdated (official seeds never
 * refreshed) sink to the bottom, and when the instants match or are all missing the order falls
 * back stably to the display name alphabetically. The lexicographic order of ISO time strings is
 * chronological order.
 */
export function sortPersonalMarketplaceGroups(
  groups: PersonalMarketplaceGroup[],
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): PersonalMarketplaceGroup[] {
  const lastUpdatedById = new Map(
    marketplaces.flatMap((marketplace) =>
      marketplace.lastUpdated ? ([[marketplace.id, marketplace.lastUpdated]] as const) : [],
    ),
  );
  return groups.toSorted((left, right) => {
    const leftAt = lastUpdatedById.get(left.marketplace) ?? "";
    const rightAt = lastUpdatedById.get(right.marketplace) ?? "";
    // The lexicographic order of the empty string is smaller than any time string, and the reverse order comparison will naturally sink the missing time to the bottom.
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return left.title.localeCompare(right.title, locale);
  });
}

/**
 * Joins the overview data into the set of store entries. The entry universe = availablePlugins ∪
 * restorableBuiltins ∪ the plugin packages actually discovered (covering inline / orphaned
 * plugins).
 */
export function buildStoreItems(input: {
  marketplaces: ZCodePluginMarketplaceSummary[];
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  plugins: ZCodePluginInfo[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
}): StorePluginItem[] {
  const infoById = new Map(input.plugins.map((plugin) => [plugin.id, plugin]));
  const metaById = new Map(input.installedPlugins.map((item) => [item.id, item]));
  const marketplaceIds = new Set(input.marketplaces.map((item) => item.id));
  const items = new Map<string, StorePluginItem>();

  for (const summary of input.availablePlugins) {
    const info = infoById.get(summary.id);
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed:
        info?.packageStatus === "missing" ? false : summary.installed || info !== undefined,
      restorable: false,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
      ...(info ? { info } : {}),
      ...(metaById.get(summary.id) ? { installedMeta: metaById.get(summary.id) } : {}),
    });
  }
  for (const summary of input.restorableBuiltins) {
    const existing = items.get(summary.id);
    if (existing) {
      // The built-in uninstall state exists in both the full Catalog and restorable lists: only no actual
      // Marketplace ownership is only overridden to restorable. If installed/installedMeta/info
      // It has been indicated that the CDN plug-in with the same name belongs to the user and must be kept installed to avoid Restore being displayed incorrectly on the details page.
      const hasMarketplaceOwnership =
        existing.installed || existing.installedMeta !== undefined || existing.info !== undefined;
      if (hasMarketplaceOwnership) continue;
      items.set(summary.id, {
        ...existing,
        installed: false,
        restorable: true,
        ...(existing.listing || summary.listing
          ? { listing: existing.listing ?? summary.listing }
          : {}),
        ...(existing.summary ? {} : { summary }),
      });
      continue;
    }
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed: false,
      restorable: true,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
    });
  }
  // Plugins discovered at runtime but not in any directory (inline, legacy installations removed from the market) should also be visible/searchable.
  for (const info of input.plugins) {
    if (items.has(info.id)) continue;
    // After the old plugin is split/removed, the configuration will still generate missing package diagnostics; it is not an installable directory source.
    // Keep the original plugins for settings page diagnosis, but do not generate store installation entries based on this; entries with directory/recovery source have been retained above.
    if (info.packageStatus === "missing") continue;
    items.set(info.id, {
      id: info.id,
      name: info.name,
      marketplace: info.marketplace,
      installed: true,
      restorable: false,
      // Missing directory entries do not mean that the Marketplace Source has been deleted, and the source status is unknown when the overview fails.
      // The official/inline plug-in cannot be deduced into an orphan installation due to a missing directory.
      orphaned:
        input.marketplaceAvailabilityKnown &&
        info.source === "cache" &&
        !marketplaceIds.has(info.marketplace),
      info,
      ...(metaById.get(info.id) ? { installedMeta: metaById.get(info.id) } : {}),
    });
  }
  return [...items.values()];
}

/**
 * The public section: Featured (the CDN featured list, in order) + category rollups (no category
 * goes to other, sorted last).
 */
export function selectFeaturedItems(
  publicItems: StorePluginItem[],
  marketplaces: ZCodePluginMarketplaceSummary[],
): StorePluginItem[] {
  const byName = new Map<string, StorePluginItem>();
  for (const item of publicItems) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  const featured: StorePluginItem[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    if (!isPublicStoreMarketplaceId(marketplace.id)) continue;
    for (const name of marketplace.featured ?? []) {
      const item = byName.get(name);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        featured.push(item);
      }
    }
  }
  return featured;
}

export function groupItemsByCategory(
  items: StorePluginItem[],
  locale: string,
  order?: PluginStoreModeOrder,
): StoreCategoryGroup[] {
  const groups = new Map<string, StorePluginItem[]>();
  const sorted = sortPluginStoreEntries(
    items,
    (item) => ({
      id: item.id,
      category: item.listing?.category,
      displayName: resolveItemDisplayName(item, locale),
    }),
    locale,
    order,
  );
  for (const item of sorted) {
    const category = resolveStoreCategory(item.listing?.category) ?? FALLBACK_CATEGORY;
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}

export function storeItemMatches(item: StorePluginItem, keyword: string, locale: string): boolean {
  return pluginSearchMatches(
    keyword,
    [
      item.name,
      item.id,
      item.marketplace,
      resolveItemDisplayName(item, locale),
      resolveItemDescription(item, locale) ?? "",
      item.listing?.category ?? "",
      item.listing?.author ?? "",
    ],
    [item.name, item.listing?.displayName, ...Object.values(item.listing?.displayNameI18n ?? {})],
  );
}

/**
 * Installed icon strip order: official documentation plugins first, then the remaining built-in /
 * inline ones sorted stably by name; marketplace-installed plugins follow, by install time
 * descending, then by name for equal times.
 */
export function sortInstalledStripItems(
  items: StorePluginItem[],
  locale: string,
): StorePluginItem[] {
  return items.toSorted((left, right) => {
    const documentPriority = compareDocumentPluginPriority(left.id, right.id);
    if (documentPriority !== 0) return documentPriority;

    const leftIsBuiltin = Boolean(left.info && left.info.source !== "cache");
    const rightIsBuiltin = Boolean(right.info && right.info.source !== "cache");
    if (leftIsBuiltin !== rightIsBuiltin) return leftIsBuiltin ? -1 : 1;

    const compareByName = () =>
      resolveItemDisplayName(left, locale).localeCompare(
        resolveItemDisplayName(right, locale),
        locale,
      );
    if (leftIsBuiltin) return compareByName();

    const leftAt = left.installedMeta?.installedAt ?? "";
    const rightAt = right.installedMeta?.installedAt ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return compareByName();
  });
}
