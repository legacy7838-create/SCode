import { existsSync } from "node:fs";
import { normalize } from "node:path";
import type { ZCodeAgentMcpServer } from "@zcode/shared";

function normalizePathForCompare(value: string): string {
  const normalized = normalize(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isFilesystemServer(
  server: ZCodeAgentMcpServer,
): server is Extract<ZCodeAgentMcpServer, { command: string }> {
  return (
    "command" in server &&
    server.name === "filesystem" &&
    server.args.some((arg) => arg.includes("@modelcontextprotocol/server-filesystem"))
  );
}

export function appendWorkspaceToFilesystemMcpServers(
  mcpServers: ZCodeAgentMcpServer[] | undefined,
  workspacePath: string,
): ZCodeAgentMcpServer[] | undefined {
  if (!mcpServers || mcpServers.length === 0) {
    return mcpServers;
  }

  const trimmedWorkspacePath = workspacePath.trim();
  if (!trimmedWorkspacePath || !existsSync(trimmedWorkspacePath)) {
    return mcpServers;
  }

  let changed = false;
  const workspaceKey = normalizePathForCompare(trimmedWorkspacePath);
  const nextServers = mcpServers.map((server) => {
    if (!isFilesystemServer(server)) {
      return server;
    }

    const hasWorkspace = server.args.some((arg) => normalizePathForCompare(arg) === workspaceKey);
    if (hasWorkspace) {
      return server;
    }

    changed = true;
    // The filesystem MCP in the user directory may only contain fixed directories,
    // The current workspace will not be automatically allowed, causing the agent to fail when writing the current project file.
    // "Access denied - path outside allowed directories". Here only if the native path exists
    // Non-persistently append the current workspace to avoid remote workspace being accidentally injected into the local MCP.
    return {
      ...server,
      args: [...server.args, trimmedWorkspacePath],
    };
  });

  return changed ? nextServers : mcpServers;
}
