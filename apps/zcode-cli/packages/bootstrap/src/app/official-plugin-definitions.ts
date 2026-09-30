import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

// Store listing seed for the built-in plugins (written verbatim into the official
// marketplace.json entry, parsed via the adapter's parseEntryStoreListing).
// icon points at the official assets CDN; the UI safely falls back to a default
// icon when the request fails. Descriptions come from each plugin's manifest.
export interface OfficialPluginListingSeed {
  displayName?: string;
  category?: string;
  author?: { name: string; url?: string };
  icon?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  heroImage?: string;
  examplePrompts?: string[];
}

const OFFICIAL_BROWSER_USE_PLUGIN_NAME = "browser-use";
export const OFFICIAL_BROWSER_USE_PLUGIN_ID = `${OFFICIAL_BROWSER_USE_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
/**
 * The node_repl host. It is not a user-facing plugin: no skill, no listing, no marketplace
 * presence — its only job is to carry `dist/mcp/server.js`, the runtime artifact shared by
 * Browser Use and Computer Use.
 *
 * Why it has to become its own seed unit: the host artifact used to live inside the
 * browser-use package, so resolveBuiltInNodeReplMcpServers could only look for it under
 * browser-use's rootPath — with the browser-use package missing, even Computer Use could not
 * get the host when enabled on its own. As a separate seed unit, each of the two plugins
 * contributes only its own domain assets, and whichever is enabled gets the same host.
 */
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME = "node-repl-host";
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_ID = `${OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
const OFFICIAL_CUA_PLUGIN_NAME = "computer-use";
export const OFFICIAL_CUA_PLUGIN_ID = `${OFFICIAL_CUA_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export interface OfficialPluginDefinition {
  // Content-based plugin (no MCP server / no system dependencies) can be set to true,
  // In this way, users can use `/skill <name>` for the first time without having to `zcode plugins enable` first.
  // The default is false to maintain the original behavior of heavy-load plugins such as ios-simulator / android-emulator.
  defaultEnabled?: boolean;
  listing?: OfficialPluginListingSeed;
  /**
   * MCP servers the host provides for this official plugin but that are not part of its
   * plugin manifest. Used only for product attribution and the settings page's status
   * display; at runtime the host identity is still what is kept.
   */
  hostMcpServerNames?: readonly string[];
  name: string;
  /** Refuse to generate a half-built official plugin cache when any filesystem/SEA seed is missing. */
  requiredSeedPaths?: readonly string[];
  rootCandidates: readonly string[];
  /** Extra top-level paths intentionally staged as plugin runtime assets. */
  runtimeTopLevelPaths?: readonly string[];
  version: string;
}

const ZAI_AUTHOR = { name: "Z.ai", url: "https://z.ai" } as const;
const OFFICIAL_PLUGIN_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets";

const OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS = ["dist/mcp/server.js"] as const;

export const OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS = [
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json has registered recording lookup; if the text is not forcibly verified, incomplete plug-ins that cannot read the screen recording guide will be seeded.
  "docs/recording.md",
  "docs/workflow.md",
  "scripts/browser-client.mjs",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
] as const;

const OFFICIAL_CUA_REQUIRED_SEED_PATHS = [
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
] as const;

// zcode-guide originally does not have requiredSeedPaths, and seed will silently install one when it loses files.
// There is no plugin for the /workflow command - the symptom is that the command does not exist without any diagnostics. commands/ are pinned to the skill text.
const OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS = [
  "commands/workflow.md",
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/examples.md",
  "skills/dynamic-workflows/patterns.md",
] as const;

export const OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = [
  {
    // No listing: The host does not enter the market and is not exposed to users. It must always be available because of node_repl's registration gate
    // It is "enable either Browser Use or Computer Use", and the host itself does not participate in that judgment.
    //
    // The defaultEnabled here does not violate the "content-based plug-ins only" agreement (see the description of computer-use below):
    // The agreement is to prevent "injecting the entire tool set and pulling up the Helper upon first startup", but the seed host does neither - whether the tool
    // The entry into the model tool pool is determined by the start and stop of the two capability plug-ins, and the Helper is only started when the SDK calls it for the first time.
    defaultEnabled: true,
    name: OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/node-repl-host",
      "../node-repl-host",
      "../../node-repl-host",
      "../../../node-repl-host",
    ],
    version: "0.6.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "Android Emulator",
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/android-emulator/icon.png`,
    },
    name: "android-emulator",
    rootCandidates: [
      "packages/android-emulator-plugin",
      "../android-emulator-plugin",
      "../../android-emulator-plugin",
      "../../../android-emulator-plugin",
    ],
    version: "0.1.0",
  },
  {
    // The manifest only declares the browser-use skill; the host node_repl MCP is injected independently, and the package also carries its server/client
    // runtime assets. Skills and browser bridges that only control "when/how to use the built-in browser" are enabled by default.
    defaultEnabled: true,
    hostMcpServerNames: ["node_repl"],
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Browser Use",
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/browser-use/icon.png`,
    },
    name: OFFICIAL_BROWSER_USE_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/browser-use-plugin",
      "../browser-use-plugin",
      "../../browser-use-plugin",
      "../../../browser-use-plugin",
    ],
    // The official seed version is omitted when the plug-in package/manifest is upgraded, and the old cache directory will continue to be loaded.
    // The three versions of package, manifest, and definition should be consistent to avoid the release content and installation version from bifurcating again.
    version: "0.5.1",
  },
  ...(
    [
      ["documents", "docx", "Documents"],
      ["pdf", "pdf", "PDF"],
      ["presentations", "pptx", "Presentations"],
      ["spreadsheets", "xlsx", "Spreadsheets"],
    ] as const
  ).map(
    ([name, skill, displayName]): OfficialPluginDefinition => ({
      defaultEnabled: true,
      listing: {
        author: ZAI_AUTHOR,
        category: "productivity",
        displayName,
        // Reuse the published document icon so the split-out plugins need no new CDN asset.
        icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/document-skills/icon.png`,
      },
      name,
      requiredSeedPaths: ["agents/visual-judge.md", `skills/${skill}/SKILL.md`],
      rootCandidates: [
        `packages/${name}-plugin`,
        `../${name}-plugin`,
        `../../${name}-plugin`,
        `../../../${name}-plugin`,
      ],
      version: "0.1.7",
    }),
  ),
  {
    // The official image search capability of the original aggregation document plug-in is still used, and only the independent switch is removed; the authentication is still injected by the official MCP adapter.
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Image Search",
    },
    name: "image-search",
    requiredSeedPaths: [".mcp.json"],
    rootCandidates: [
      "packages/image-search-plugin",
      "../image-search-plugin",
      "../../image-search-plugin",
      "../../../image-search-plugin",
    ],
    version: "0.1.1",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "iOS Simulator",
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/ios-simulator/icon.png`,
    },
    name: "ios-simulator",
    rootCandidates: [
      "packages/ios-simulator-plugin",
      "../ios-simulator-plugin",
      "../../ios-simulator-plugin",
      "../../../ios-simulator-plugin",
    ],
    version: "0.1.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Restore Legacy Sessions",
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/restore-legacy-sessions/icon.png`,
    },
    name: "restore-legacy-sessions",
    rootCandidates: [
      "packages/restore-legacy-sessions-plugin",
      "../restore-legacy-sessions-plugin",
      "../../restore-legacy-sessions-plugin",
      "../../../restore-legacy-sessions-plugin",
    ],
    version: "0.1.0",
  },
  {
    defaultEnabled: true,
    name: "plugin-creator",
    version: "0.1.1",
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Plugin Creator",
      // The creator uses the client's own icon and no longer borrows the remote image from skill-creator.
    },
    rootCandidates: [
      "packages/plugin-creator-plugin",
      "../plugin-creator-plugin",
      "../../plugin-creator-plugin",
      "../../../plugin-creator-plugin",
    ],
    requiredSeedPaths: [
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ],
  },
  {
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Skill Creator",
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/skill-creator/icon.png`,
    },
    name: "skill-creator",
    rootCandidates: [
      "packages/skill-creator-plugin",
      "../skill-creator-plugin",
      "../../skill-creator-plugin",
      "../../../skill-creator-plugin",
    ],
    version: "0.1.0",
  },
  {
    // Pure content plug-in (only commands + skills, no MCP / no system dependencies), enabled by default,
    // Let users/agents get ZCode configuration guide, self-diagnosis skills and dynamic workflow writing guide out of the box.
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "ZCode Guide",
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-guide/icon.png`,
      examplePrompts: [
        "How do I configure MCP servers in ZCode?",
        "Diagnose my current ZCode setup",
      ],
    },
    name: "zcode-guide",
    requiredSeedPaths: OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/zcode-guide-plugin",
      "../zcode-guide-plugin",
      "../../zcode-guide-plugin",
      "../../../zcode-guide-plugin",
    ],
    version: "0.2.0",
  },
  {
    // Product decision: Computer control fallback is turned off by default, and users need to explicitly turn it on on the settings page.
    // Therefore, defaultEnabled is not declared here—computer-use carries MCP server and system Helper dependencies.
    // Turning on by default means that every new user will inject the entire tool set and start the Helper upon first startup.
    // The old convention of "defaultEnabled content-based plug-ins only" is restored to integrity.
    // The judgment formula is enabledPlugins[id] ?? defaultEnabled: Users who have manually opened it on the settings page have already placed it.
    // Explicitly true, not affected by this change to the default value. When changing back to the default enabled, synchronization is required
    // The list of packages/shared/src/plugin-marketplaces.ts (bootstrap single test machine compares the two),
    // The linkage semantics between isZCodeCuaInternalFeatureEnabled (packaging layer default is true) and the input box entrance hidden default value.
    name: "computer-use",
    hostMcpServerNames: ["node_repl"],
    // The user-facing name is "Computer Use". The package name and producer repo
    // stay zcode-cua to keep the native Helper identity stable; the English
    // description baseline comes from the manifest.
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Computer Use",
      // After the plug-in is renamed computer-use, the CDN icon is still published in the zcode-cua directory; use the resource path to avoid 404.
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-cua/icon.png`,
    },
    rootCandidates: [
      "packages/zcode-cua-plugin",
      "../zcode-cua-plugin",
      "../../zcode-cua-plugin",
      "../../../zcode-cua-plugin",
    ],
    requiredSeedPaths: OFFICIAL_CUA_REQUIRED_SEED_PATHS,
    // The current CUA is an unavailable placeholder package, so there is no need to copy the native runtime; it avoids bringing old local dependencies into the cache.
    runtimeTopLevelPaths: [],
    // The version here tracks the upstream zcode-cua runtime version to enable plug-in UI display, cache path,
    // Marketplace entries are all aligned; specific versions are maintained by the atomic producer bump workflow.
    version: "0.6.3",
  },
];

// If defaultEnabled: true is marked in the official plugin definition, it should be spelled in the form of `<name>@<marketplace>`.
// Pass it transparently to the adapter so that it is enabled by default when the user does not configure it explicitly (only applicable to content-based plugins).
// Note: Any entry point for resolving plugins (CLI subcommand resolveZCodePlugins, application startup resolveStartupPlugins)
// This collection must be passed to discoverNodePluginsSync, otherwise defaultEnabled will not take effect.
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set(
  OFFICIAL_PLUGIN_DEFINITIONS.filter((definition) => definition.defaultEnabled).map(
    (definition) => `${definition.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
  ),
);

export function resolveOfficialPluginHostMcpServerNames(pluginId: string): string[] {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(
    (candidate) => `${candidate.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}` === pluginId,
  );
  return definition?.hostMcpServerNames ? [...definition.hostMcpServerNames] : [];
}

/**
 * MCP servers the host CLI injects for an official plugin (such as browser-use's
 * `node_repl`) carry a server name without the `plugin:` prefix, so the resource manager has
 * to look up the owning official plugin's name in reverse when attributing plugins.
 */
export function resolveOfficialPluginNameByHostMcpServerName(
  serverName: string,
): string | undefined {
  return OFFICIAL_PLUGIN_DEFINITIONS.find((definition) =>
    definition.hostMcpServerNames?.includes(serverName),
  )?.name;
}
