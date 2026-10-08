import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = [] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // 开发态远程插件复制使用独立白名单，遗漏 agents 会只在远端丢失子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // 官方插件运行时宿主（如 node_repl）依赖插件根目录下的 scripts 资产；
  // 开发态 SSH 部署若漏掉 scripts，会出现 MCP server 已启动但宿主绑定无法初始化的半成品状态。
  "scripts",
  "skills",
  "templates",
] as const;

// 修复依据：官方插件包名列表清空后，此处由空数组 .map 派生的结果不再是字面量，
// 不能再施加 `as const`（TS1355：const 断言只允许用于枚举成员或字面量）。空源列表映射结果恒为空数组，
// 消费方（for...of / map / 展开）只按普通字符串数组使用，去掉断言不改变运行期行为。
export const REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS = REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.map(
    (packageName) => `${packageName}/.zcode-plugin/plugin.json`,
  );

export function buildRemoteAgentOfficialPluginDir(remoteProviderDir: string): string {
  return posix.join(remoteProviderDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
}

export function buildRemoteAgentOfficialPluginSourceRelativePath(params: {
  runtimeResourceDir: string;
  platformArch: string;
}): string {
  return posix.join(
    params.runtimeResourceDir,
    params.platformArch,
    REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  );
}

export function buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir: string): string[] {
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  return REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.map((relativePath) =>
    posix.join(remoteOfficialPluginDir, relativePath),
  );
}
