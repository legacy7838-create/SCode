import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";
import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import type { ConversationStoreStatus } from "@/v4/conversationProjectionStore.js";

export function isSessionPluginCatalogReady(
  projectionStatus: ConversationStoreStatus,
  sessionId: string | null,
  snapshotSessionId: string | null | undefined,
): boolean {
  return Boolean(projectionStatus === "live" && sessionId && snapshotSessionId === sessionId);
}

export function hasPluginReferenceUserRows(
  rows: readonly { kind: string; text?: string }[],
): boolean {
  return rows.some((row) => row.kind === "userInput" && row.text?.includes("(plugin://"));
}

/**
 * A display-only projection for sent Plugin chips.
 *
 * A history message can only rebuild its display from the canonical stable ID; reaching for
 * workspace authority instead would let an existing Session show data outside its own identity
 * boundary after a Plugin is enabled or disabled. So only an explicit Session authority may build
 * the icon map, and everything else fails closed.
 */
export function buildSessionPluginIconMap(
  authority: "session" | "workspace" | null,
  entries: readonly ZCodePluginReferenceCatalogEntry[],
): ReadonlyMap<string, string> {
  if (authority !== "session") {
    return new Map();
  }

  const iconById = new Map<string, string>();
  for (const entry of entries) {
    const icon = resolvePluginIconSource(entry.pluginId, entry.icon);
    if (icon) {
      iconById.set(entry.pluginId, icon);
    }
  }
  return iconById;
}
