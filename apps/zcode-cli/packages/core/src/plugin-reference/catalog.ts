// Session frozen Plugin identity catalog build.
// Built once by bootstrap from the result of resolveStartupPlugins when the App (Session runtime) is created,
// There will be no hot update with the workspace configuration later.
import type {
  PluginMetadata,
  PluginReferenceCatalog,
  PluginReferenceCatalogEntry,
} from "@zcode/contracts";

function collectDeclaredSkillQualifiedNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "skill") continue;
    for (const item of group.items) {
      const skillName = item.name.trim();
      if (!skillName) continue;
      names.add(`${plugin.name}:${skillName}`);
    }
  }
  return [...names].sort();
}

function collectDeclaredSubagentNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "agent") continue;
    for (const item of group.items) {
      const subagentName = item.name.trim();
      if (!subagentName) continue;
      names.add(`${plugin.name}:${subagentName}`);
    }
  }
  return [...names].sort();
}

/**
 * Build the identity catalog from the authoritative metadata of the plugin loader.
 * - Every discovered Plugin (including disabled ones) goes into the catalog: disabled entries support
 *   the `disabled_in_session` diagnostic and Picker filtering, and must not be referenceable.
 * - Conflict definition: several enabled Plugins with the same manifest.name mark each other in conflictingPluginIds
 *   (the machine-readable basis for V1 fail closed). Disabled entries take no part in conflicts — they are not in the runtime namespace.
 */
export function buildPluginReferenceCatalog(
  plugins: readonly PluginMetadata[],
): PluginReferenceCatalog {
  const enabledIdsByName = new Map<string, string[]>();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const ids = enabledIdsByName.get(plugin.name) ?? [];
    ids.push(plugin.id);
    enabledIdsByName.set(plugin.name, ids);
  }

  const entries: PluginReferenceCatalogEntry[] = plugins.map((plugin) => {
    const sameNameEnabledIds = plugin.enabled ? (enabledIdsByName.get(plugin.name) ?? []) : [];
    return {
      pluginId: plugin.id,
      name: plugin.name,
      marketplace: plugin.marketplace,
      enabled: plugin.enabled,
      conflictingPluginIds: sameNameEnabledIds.filter((id) => id !== plugin.id).sort(),
      skillQualifiedNames: collectDeclaredSkillQualifiedNames(plugin),
      // mcpServerNames comes from the namespaced servers parsed from the enabled branch (`plugin:${name}:${server}`);
      // disabled Plugin has no runtime MCP name, leaving an empty array.
      mcpServerNames: [...plugin.mcpServerNames].sort(),
      subagentNames: collectDeclaredSubagentNames(plugin),
      rootPath: plugin.rootPath,
    };
  });

  return { plugins: entries };
}

export function findPluginReferenceCatalogEntry(
  catalog: PluginReferenceCatalog | undefined,
  pluginId: string,
): PluginReferenceCatalogEntry | undefined {
  return catalog?.plugins.find((entry) => entry.pluginId === pluginId);
}
