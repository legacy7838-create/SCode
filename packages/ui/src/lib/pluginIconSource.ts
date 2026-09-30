import documentsIconUrl from "@/assets/plugin-icons/documents.png";
import imageSearchIconUrl from "@/assets/plugin-icons/image-search.png";
import pdfIconUrl from "@/assets/plugin-icons/pdf.png";
import pluginCreatorIconUrl from "@/assets/plugin-icons/plugin-creator.png";
import presentationsIconUrl from "@/assets/plugin-icons/presentations.png";
import spreadsheetsIconUrl from "@/assets/plugin-icons/spreadsheets.png";
import { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

const OFFICIAL_PLUGIN_ICON_BY_ID: Readonly<Record<string, string>> = {
  "documents@zcode-plugins-official": documentsIconUrl,
  "image-search@zcode-plugins-official": imageSearchIconUrl,
  "pdf@zcode-plugins-official": pdfIconUrl,
  "plugin-creator@zcode-plugins-official": pluginCreatorIconUrl,
  "presentations@zcode-plugins-official": presentationsIconUrl,
  "spreadsheets@zcode-plugins-official": spreadsheetsIconUrl,
};

const TRUSTED_BUNDLED_PLUGIN_ICONS = new Set(Object.values(OFFICIAL_PLUGIN_ICON_BY_ID));

/**
 * Resolves client-owned icons by full identity, so the store, the candidates and messages do not
 * each maintain their own exceptions.
 */
export function resolvePluginIconSource(
  pluginId: string | undefined,
  icon?: string,
): string | undefined {
  if (pluginId) {
    const bundledIcon = OFFICIAL_PLUGIN_ICON_BY_ID[pluginId];
    if (bundledIcon) return bundledIcon;
  }
  return isTrustedImageUrl(icon) ? icon : undefined;
}

/**
 * The Session projection has already completed identity matching; only fixed bundled resources are
 * let through, arbitrary local URLs are not.
 */
export function isTrustedPluginIconSource(icon: string | undefined): icon is string {
  return Boolean(icon && TRUSTED_BUNDLED_PLUGIN_ICONS.has(icon)) || isTrustedImageUrl(icon);
}
