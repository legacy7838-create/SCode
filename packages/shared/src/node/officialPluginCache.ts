import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "../plugin-marketplaces.js";

interface OfficialPluginCacheRoot {
  /** The cache directory name, i.e. the official plugin name. */
  name: string;
  /** The available version directories in numeric-aware descending order; the first entry is the newest version. */
  versionRoots: string[];
}

/**
 * Scans `<plugins storage>/cache/zcode-plugins-official/<name>/<version>/`.
 * The CLI seeds the built-in official plugins here without any installed_plugins.json
 * record, so services that only read the install records would miss them. The version
 * directories skip the CLI's backup / seed lock / temp directories and are sorted in
 * numeric-aware descending order, matching the CLI's fallback selection.
 */
export async function scanOfficialPluginCacheRoots(
  pluginStorageRoot: string,
): Promise<OfficialPluginCacheRoot[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID);
  let pluginEntries;
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: OfficialPluginCacheRoot[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries;
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const versionRoots = versionEntries
      .filter((entry) => entry.isDirectory() && !isTransientCacheEntryName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map((version) => join(pluginDir, version));
    if (versionRoots.length > 0) {
      roots.push({ name: pluginEntry.name, versionRoots });
    }
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name));
}

function isTransientCacheEntryName(name: string): boolean {
  return name.includes(".backup") || name.includes(".seed-lock") || name.includes(".tmp-");
}
