import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = ["browser-use-plugin"] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Dev-state remote plugin copying uses an independent whitelist; omitting agents would only lose subagents remotely.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser bootstrap dynamically imports scripts/browser-client.mjs from the plugin root directory.
  // If dev-state SSH deployment misses scripts, a half-baked state occurs where the MCP server has started but browser binding cannot initialize.
  "scripts",
  "skills",
  "templates",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS = [
  ...REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.map(
    (packageName) => `${packageName}/.zcode-plugin/plugin.json`,
  ),
  // Only the Browser Use manifest will be verified and the incomplete directory "with plug-in shell" will be
  // as reusable. Production remote, dev-state remote, and release source validation share this required asset contract.
  //
  // Here we can only list assets **produced by browser-use itself**. After the node_repl host was extracted to @zcode/node-repl-host,
  // browser-use no longer produces dist/mcp/server.js;
  // entries in this list pointing to non-existent files would cause remote asset validation to report missing against ghost paths.
  // Remote workspaces currently do not host Browser Use / Computer Use, so the host runtime is not included in this remote contract—
  // when supporting remote bua/cua, node-repl-host should be added to PACKAGE_NAMES above and its
  // dist/mcp/server.js declared here, rather than attaching host artifacts back under browser-use.
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // If the remote cache lacks the recording body, documents.json would still incorrectly declare that lookup available.
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // Only validating the manifest cannot discover that document plugins lack skill bodies or visual review Agents.
] as const;

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
