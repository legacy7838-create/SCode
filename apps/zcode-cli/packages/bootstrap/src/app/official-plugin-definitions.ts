import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

// 内置插件的商店信息 seed（原样写入官方 marketplace.json 的条目 raw，键名与 CDN 目录
// schema 一致：displayName_i18n / examplePrompts_i18n 等），解析复用 adapter 的
// parseEntryStoreListing。icon 指向官方 assets CDN；请求失败时 UI 会安全降级为默认图标。
export interface OfficialPluginListingSeed {
  displayName?: string;
  displayName_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  category?: string;
  author?: { name: string; url?: string };
  icon?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  heroImage?: string;
  examplePrompts?: string[];
  examplePrompts_i18n?: Record<string, string[]>;
}

export interface OfficialPluginDefinition {
  defaultEnabled?: boolean;
  listing?: OfficialPluginListingSeed;
  hostMcpServerNames?: readonly string[];
  name: string;
  requiredSeedPaths?: readonly string[];
  rootCandidates: readonly string[];
  runtimeTopLevelPaths?: readonly string[];
  version: string;
}

const ZAI_AUTHOR = { name: "Z.ai", url: "https://z.ai" } as const;
const OFFICIAL_PLUGIN_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets";

const OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS = [
  "commands/workflow.md",
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/examples.md",
  "skills/dynamic-workflows/patterns.md",
] as const;

export const OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = [
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "Android Emulator",
      displayName_i18n: { "zh-CN": "Android 模拟器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/android-emulator/icon.png`,
      description_i18n: {
        "zh-CN": "提供 Android 开发工作流与模拟器自动化能力。",
      },
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
  ...(
    [
      ["documents", "docx", "Documents", "Word文档"],
      ["pdf", "pdf", "PDF", "PDF"],
      ["presentations", "pptx", "Presentations", "演示文档"],
      ["spreadsheets", "xlsx", "Spreadsheets", "电子表格"],
    ] as const
  ).map(
    ([name, skill, displayName, chineseName]): OfficialPluginDefinition => ({
      defaultEnabled: true,
      listing: {
        author: ZAI_AUTHOR,
        category: "productivity",
        displayName,
        displayName_i18n: { "zh-CN": chineseName },
        // 复用已发布的文档图标，拆分插件无需依赖新 CDN 资源。
        icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/document-skills/icon.png`,
        description_i18n: { "zh-CN": `创建、编辑与审阅${chineseName}（${skill.toUpperCase()}）。` },
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
    // 沿用原聚合文档插件的官方搜图能力，仅拆出独立开关；认证仍由官方 MCP adapter 注入。
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Image Search",
      displayName_i18n: { "zh-CN": "搜图" },
      description_i18n: { "zh-CN": "查找插图与参考配图。" },
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
      displayName_i18n: { "zh-CN": "iOS 模拟器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/ios-simulator/icon.png`,
      description_i18n: {
        "zh-CN": "提供 iOS 开发工作流与模拟器自动化能力。",
      },
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
      displayName_i18n: { "zh-CN": "恢复旧版会话" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/restore-legacy-sessions/icon.png`,
      description_i18n: {
        "zh-CN": "将旧版会话恢复为 ZCode 任务与会话记录。",
      },
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
      // 创建器使用客户端自带图标，不再借用 skill-creator 的远端图片。
      displayName_i18n: { "zh-CN": "插件创建器" },
      description_i18n: {
        "zh-CN": "开发、校验 ZCode 插件，完成本地 dev 市场安装、试用与更新。",
      },
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
      displayName_i18n: { "zh-CN": "技能创建器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/skill-creator/icon.png`,
      description_i18n: { "zh-CN": "创建、编辑和验证可复用的 ZCode 技能。" },
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
    // 纯内容型插件（只有 commands + skills，无 MCP / 无系统依赖），默认启用，
    // 让用户/agent 开箱即用地拿到 ZCode 配置指南、自诊断技能与 dynamic workflow 编写指南。
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "ZCode Guide",
      displayName_i18n: { "zh-CN": "ZCode 使用指南" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-guide/icon.png`,
      description_i18n: {
        "zh-CN": "提供 ZCode 配置指南与插件、技能、MCP、命令和钩子诊断。",
      },
      examplePrompts: [
        "How do I configure MCP servers in ZCode?",
        "Diagnose my current ZCode setup",
      ],
      examplePrompts_i18n: {
        "zh-CN": ["ZCode 里怎么配置 MCP 服务器？", "帮我诊断当前的 ZCode 配置"],
      },
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
];

// 在 official plugin 定义里标了 defaultEnabled: true 的, 拼成 `<name>@<marketplace>` 形式,
// 透传给 adapter 让它在用户没显式配置时默认开启 (内容型 plugin 才适用)。
// 注意: 任何解析 plugin 的入口 (CLI 子命令 resolveZCodePlugins、应用启动 resolveStartupPlugins)
// 都必须把这个集合传给 discoverNodePluginsSync, 否则 defaultEnabled 不生效。
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
 * 官方插件由 host CLI 注入的 MCP（如 `node_repl`）server name 不带 `plugin:` 前缀，
 * 资源管理器归属插件时需要反查所属官方插件名。
 */
export function resolveOfficialPluginNameByHostMcpServerName(
  serverName: string,
): string | undefined {
  return OFFICIAL_PLUGIN_DEFINITIONS.find((definition) =>
    definition.hostMcpServerNames?.includes(serverName),
  )?.name;
}
