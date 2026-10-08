// Plugin 对话引用 catalog 的协议 handler。
// 与 plugins.ts（安装/市场/启停等管理面）分文件：本查询是会话/草稿 Picker 的只读投影，
// 且 plugins.ts 已接近 max-lines 门禁。
import {
  zcodePluginsReferenceCatalogParamsSchema,
  type ZCodePluginReferenceCatalogEntry,
  type ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import type { PluginReferenceCatalogEntry } from "@zcode/contracts";
import { buildPluginReferenceCatalog } from "@zcode/core";
import { getZCodePluginsOverview, resolveZCodePlugins } from "../plugins.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// Picker 权威：带 sessionId → 该 Session 创建时冻结的 identity catalog（session-owned）；
// 不带 → workspace 当前 catalog（新建草稿）。session 不存在时按协议错误 fail closed，
// 禁止静默回退 workspace authority——否则草稿/会话两种权威会被混淆。
export async function getPluginReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  includeCategory = false,
): Promise<ZCodePluginsReferenceCatalogResult> {
  const params = parseParams(zcodePluginsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const displayByPluginId = resolveReferenceListingDisplayByPluginId(
      params.workspace.workspacePath,
    );
    return {
      authority: "session",
      plugins: record.app
        .getPluginReferenceCatalog()
        .plugins.map((entry) => toReferenceCatalogEntry(entry, displayByPluginId, includeCategory)),
    };
  }
  const outcome = resolveZCodePlugins({
    workingDirectory: params.workspace.workspacePath,
  });
  const displayByPluginId = resolveReferenceListingDisplayByPluginId(
    params.workspace.workspacePath,
  );
  return {
    authority: "workspace",
    plugins: buildPluginReferenceCatalog(outcome.plugins).plugins.map((entry) =>
      toReferenceCatalogEntry(entry, displayByPluginId, includeCategory),
    ),
  };
}

/**
 * icon/displayName(I18n) 是目标 Host Marketplace listing 的可变展示投影，不属于冻结
 * Session 身份。根因：商店 listing 才是原始图标/本地化显示名的事实源，plugin
 * manifest/runtime metadata 不携带它们。workingDirectory 只用于沿既有 Host/config
 * 边界定位数据；这里按 stable ID join，只用于 Picker/chip 展示与搜索，
 * reminder 仍只消费 core identity catalog。
 */
interface PluginReferenceListingDisplay {
  category?: string;
  icon?: string;
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
}

function resolveReferenceListingDisplayByPluginId(
  workspacePath: string,
): Map<string, PluginReferenceListingDisplay> {
  const overview = getZCodePluginsOverview({ workingDirectory: workspacePath });
  const displayByPluginId = new Map<string, PluginReferenceListingDisplay>();
  for (const plugin of [
    ...overview.availablePlugins,
    ...overview.installedPlugins,
    ...overview.restorableBuiltins,
  ]) {
    const category = plugin.listing?.category?.trim();
    const icon = plugin.listing?.icon?.trim();
    const displayName = plugin.listing?.displayName?.trim();
    const displayNameI18n = plugin.listing?.displayNameI18n;
    const description = plugin.description?.trim();
    const descriptionI18n = plugin.listing?.descriptionI18n;
    if (!category && !icon && !displayName && !displayNameI18n && !description && !descriptionI18n)
      continue;
    displayByPluginId.set(plugin.id, {
      ...displayByPluginId.get(plugin.id),
      ...(category ? { category } : {}),
      ...(icon ? { icon } : {}),
      ...(displayName ? { displayName } : {}),
      ...(displayNameI18n ? { displayNameI18n } : {}),
      ...(description ? { description } : {}),
      ...(descriptionI18n ? { descriptionI18n } : {}),
    });
  }
  return displayByPluginId;
}

// 身份/能力投影显式丢弃 rootPath（仅 runtime 内部 provenance 用，路径不出协议）；
// icon/displayName(I18n)/description(I18n) 仅供展示，不改变 identifiers-only reminder 契约。
function toReferenceCatalogEntry(
  entry: PluginReferenceCatalogEntry,
  displayByPluginId: ReadonlyMap<string, PluginReferenceListingDisplay>,
  includeCategory = false,
): ZCodePluginReferenceCatalogEntry {
  const display = displayByPluginId.get(entry.pluginId);
  return {
    ...(includeCategory ? { category: display?.category ?? "other" } : {}),
    pluginId: entry.pluginId,
    name: entry.name,
    marketplace: entry.marketplace,
    ...(display?.icon ? { icon: display.icon } : {}),
    ...(display?.displayName ? { displayName: display.displayName } : {}),
    ...(display?.displayNameI18n ? { displayNameI18n: display.displayNameI18n } : {}),
    ...(display?.description ? { description: display.description } : {}),
    ...(display?.descriptionI18n ? { descriptionI18n: display.descriptionI18n } : {}),
    enabled: entry.enabled,
    conflictingPluginIds: entry.conflictingPluginIds,
    skillQualifiedNames: entry.skillQualifiedNames,
    mcpServerNames: entry.mcpServerNames,
    subagentNames: entry.subagentNames ?? [],
  };
}
