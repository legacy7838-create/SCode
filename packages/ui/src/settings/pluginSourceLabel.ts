import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";

/**
 * Resolves a marketplace id into a user-friendly display name: the name from the marketplaces
 * overview is preferred, falling back to the raw id when it is missing. A pure function, so the
 * catalog title bar and the installed-source label can share the same naming.
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
): string {
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}
