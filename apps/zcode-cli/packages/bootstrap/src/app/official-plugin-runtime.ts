import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // Desktop packaged state process.execPath is ZCode Helper; missing Node mode will lead to Electron main by mistake.
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

interface OfficialRuntimeManifestInput {
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  const manifestPath = join(input.rootPath, ".zcode-plugin", "plugin.json");
  const currentContents = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(currentContents) as Record<string, unknown>;
  // Skill-only / command-only official plugins do not have mcpServers and skip rewrite directly.
  // Previously, the stupid asRecord(manifest.mcpServers) would throw an error for undefined.
  // The entire seed process is blocked, and listZCodeSkills cannot pull out the plugin skill.
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // Preserve generic overrides of other historical official plugin MCP; zcode-cua is currently skill/SDK-only,
  // This branch will not be entered, and a separate CUA MCP server will not be generated.
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    mcpServer.command = process.execPath;
    mcpServer.args = [...hostPrefixArgs, join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)];
    mcpServer.env = {
      ...mcpServerEnv,
      // Process.execPath in desktop packaged state is ZCode Helper.
      // When the official plug-in MCP server lacks the Node mode env, it will enter Electron main by mistake, triggering desktop side effects such as deep-link registration.
      ELECTRON_RUN_AS_NODE: "1",
      // Authoritatively writes the plugin identity (pluginName@marketplace, from the local plugin registry, manifest/user env is not overridable).
      // Other official plugins still carry unforgeable plugin identities; CUA broker credentials are shared
      // The trusted configuration injection of node_repl is no longer written to the independent server.
      [ZCODE_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // Unconditionally rename plugin.json with the same content at startup will enlarge the Windows antivirus/indexer
  // temporary file occupation. The file is not touched when the bytes are completely consistent; atomic failure semantics are maintained when there is an actual update.
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZCODE_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZCODE_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
