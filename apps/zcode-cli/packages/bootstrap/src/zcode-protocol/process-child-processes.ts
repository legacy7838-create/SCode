import type { McpTrackedProcess } from "@zcode/adapters";
import type { ZCodeProcessChildProcessesResult } from "@zcode/shared";
import { resolveOfficialPluginNameByHostMcpServerName } from "../app/official-plugin-definitions.js";

/**
 * `process/childProcesses`: organizes the child process mappings held in the MCP process registry's memory into a protocol result.
 * It only completes attribution (builtin host MCP → the official plugin name) and performs no I/O at all; CPU/memory sampling is done by the desktop Host.
 */
export function listChildProcesses(
  tracked: readonly McpTrackedProcess[],
): ZCodeProcessChildProcessesResult {
  return {
    processes: tracked.map((process) => {
      const pluginName =
        process.pluginName ??
        (process.mcpSource === "builtin"
          ? resolveOfficialPluginNameByHostMcpServerName(process.serverName)
          : undefined);
      return {
        pid: process.pid,
        serverName: process.serverName,
        mcpSource: process.mcpSource,
        ...(pluginName ? { pluginName } : {}),
      };
    }),
  };
}
