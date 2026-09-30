import { useMemo } from "react";
import {
  sortPluginStoreEntries,
  isPublicStoreMarketplaceId,
  type PluginStoreModeOrder,
  resolvePluginDisplayName,
  resolveLocalizedText,
  type ZCodePluginReferenceCatalogEntry,
} from "@zcode/shared";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface PluginMentionLabels {
  conflictReason: string;
}

// - Only enabled Plugins in the catalog are displayed; disabled entries cannot be referenced and are not candidates.
// - Manifest conflicts with the same name (conflictingPluginIds is not empty) remain visible but disabled, displaying the cause of the conflict (V1 fail closed).
// - markdown carrier fixed `[@Label](plugin://stable-id)`; label is only displayed, the identity is in destination.
//   The panel display name displayLabel is unified across the app according to the current locale resolvePluginDisplayName; label and
//   The carrier label is fixed entry.name, chip/canonical text/reminder does not change with the locale (chip node reuse
//   item.label, if the localized label will be separated from the message bubble copy reconstructed according to markdown).
// - keywords are incorporated into all language display names of the listing (regardless of the current locale): type Chinese in the English interface
//   You can also search for official plug-ins (plug-in @ refers to Chinese search).
function mapPluginCatalogToMentionItemsForTest(
  entries: ZCodePluginReferenceCatalogEntry[],
  labels: PluginMentionLabels,
  locale: string,
  order?: PluginStoreModeOrder,
): MentionItem[] {
  const sorted =
    order && entries.some((entry) => entry.category !== undefined)
      ? [
          ...sortPluginStoreEntries(
            entries.filter((entry) => isPublicStoreMarketplaceId(entry.marketplace)),
            (entry) => ({
              id: entry.pluginId,
              category: entry.category,
              displayName: resolvePluginDisplayName(
                {
                  name: entry.name,
                  listing: {
                    displayName: entry.displayName,
                    displayNameI18n: entry.displayNameI18n,
                  },
                },
                locale,
              ),
            }),
            locale,
            order,
          ),
          ...entries.filter((entry) => !isPublicStoreMarketplaceId(entry.marketplace)),
        ]
      : entries;
  return sorted
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const conflicted = entry.conflictingPluginIds.length > 0;
      return {
        id: `plugin:${entry.pluginId}`,
        category: "plugins" as const,
        label: entry.name,
        displayLabel: resolvePluginDisplayName(
          {
            name: entry.name,
            listing: {
              displayName: entry.displayName,
              displayNameI18n: entry.displayNameI18n,
            },
          },
          locale,
        ),
        description: resolveLocalizedText(locale, entry.description, entry.descriptionI18n) ?? "",
        value: entry.pluginId,
        markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
        keywords: [
          entry.name,
          entry.pluginId,
          entry.marketplace,
          ...(entry.displayName ? [entry.displayName] : []),
          ...Object.values(entry.displayNameI18n ?? {}),
        ],
        data: {
          pluginId: entry.pluginId,
          ...(entry.icon ? { icon: entry.icon } : {}),
        },
        ...(conflicted
          ? {
              disabled: true,
              disabledReason: labels.conflictReason,
            }
          : {}),
      };
    });
}

export function usePluginsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { intl, locale } = useZCodeIntl();
  const { order } = usePluginStoreOrder(enabled);
  const isOfficeMode = useIsOfficeMode();
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  const catalog = usePluginReferenceCatalog(workspacePath, workspaceIdentity, sessionId, enabled);

  const allItems = useMemo(
    () =>
      mapPluginCatalogToMentionItemsForTest(
        catalog.entries,
        {
          conflictReason: intl.formatMessage({ id: "chat.mention.plugins.conflict" }),
        },
        locale,
        modeOrder,
      ),
    [catalog.entries, intl, locale, modeOrder],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery: false,
      }),
    [allItems, query],
  );

  return {
    items: enabled ? items : [],
    loading: catalog.loading,
    error: catalog.error ? new Error(catalog.error) : null,
    emptyText,
    title,
  };
}
