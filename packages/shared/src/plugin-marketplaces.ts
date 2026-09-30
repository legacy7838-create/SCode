export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";

/** Shared by all three Settings resource-discovery kinds; the Bootstrap unit test checks it mechanically against defaultEnabled in the official definitions. */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "image-search@zcode-plugins-official",
  "documents@zcode-plugins-official",
  "pdf@zcode-plugins-official",
  "presentations@zcode-plugins-official",
  "spreadsheets@zcode-plugins-official",
  // node_repl host: does not enter the market, is not exposed to users, and does not contribute any skills/command/subagent, but must
  // Always available - the registration access control of node_repl is "Either Browser Use or Computer Use is enabled", the host itself
  // Don’t get involved in that judgment. Browser Use is on by default. If the host is off by default, it means there will be no host when it comes up.
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "plugin-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
  // Computer control fallback is turned off by default, so computer-use is not included in this list.
  // This collection must correspond to the plugins marked defaultEnabled in official-plugin-definitions.ts.
  // Bootstrap's "Settings default enabled collection is consistent with the CLI's official plug-in statement." A single test machine compares the two.
]);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // The only official ZCode market: local seed shards and CDN shards are merged in Agent storage.
    // The name of the CDN manifest must be consistent with the canonical id.
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official ZCode plugins marketplace: built-in and community plugins for ZCode.",
    pluginCount: 0,
  },
];

// The "public" segment of the store has only one ZCode official market ID, and the built-in and CDN identities are no longer separated.
export const PUBLIC_STORE_MARKETPLACE_IDS = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
