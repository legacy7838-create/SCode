import type { McpServerConfig, NativeMcpServerRecord } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  fetchNativeMcpServers,
  persistCliMcpToUserDirectory,
  type McpPlatformService,
  type MigrateLegacyResult,
} from "@/store/mcpStoreDesktop.js";
import {
  clearLegacyCommonMcpServers,
  readLegacyCommonMcpServers,
} from "@/store/mcpStoreHelpers.js";

interface CommonMcpMigrationResult extends MigrateLegacyResult {
  completed: boolean;
  changed: boolean;
}

function isZCodeAgentUserServer(server: NativeMcpServerRecord): boolean {
  return (
    server.source === "zcodeagentmcp" &&
    server.scope === "user" &&
    (!server.location || server.location.source === "zcode")
  );
}

export async function importLegacyCommonServersToZCodeAgent(
  platform: McpPlatformService | null,
  legacyServers: Record<string, McpServerConfig>,
  nativeServers: NativeMcpServerRecord[],
  sourcePath?: string,
): Promise<CommonMcpMigrationResult> {
  const entries = Object.entries(legacyServers);
  const totalCount = entries.length;
  if (totalCount === 0) {
    return {
      totalCount: 0,
      importedCount: 0,
      skippedCount: 0,
      sourcePath,
      completed: true,
      changed: false,
    };
  }

  const existingNames = new Set(
    nativeServers.filter(isZCodeAgentUserServer).map((server) => server.name),
  );
  let importedCount = 0;
  let skippedCount = 0;

  for (const [name, config] of entries) {
    if (existingNames.has(name)) {
      skippedCount += 1;
      continue;
    }

    try {
      const persisted = await persistCliMcpToUserDirectory(platform, {
        action: "upsert",
        source: "zcodeagentmcp",
        name,
        config,
      });
      if (!persisted) {
        return {
          totalCount,
          importedCount,
          skippedCount,
          sourcePath,
          completed: false,
          changed: importedCount > 0,
        };
      }
    } catch (error) {
      logger.warn(`[mcpStore] migrate legacy common MCP ${name} failed`, String(error));
      return {
        totalCount,
        importedCount,
        skippedCount,
        sourcePath,
        completed: false,
        changed: importedCount > 0,
      };
    }

    existingNames.add(name);
    importedCount += 1;
  }

  return {
    totalCount,
    importedCount,
    skippedCount,
    sourcePath,
    completed: true,
    changed: importedCount > 0,
  };
}

export async function migrateStoredCommonMcpToZCodeAgent(
  platform: McpPlatformService | null,
  nativeServers: NativeMcpServerRecord[],
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const legacyServers = readLegacyCommonMcpServers();
  if (Object.keys(legacyServers).length === 0) {
    return nativeServers;
  }

  // The old common MCP is stored in localStorage. Removing the common read without migrating will cause the user configuration to disappear from the settings page and runtime.
  const migration = await importLegacyCommonServersToZCodeAgent(
    platform,
    legacyServers,
    nativeServers,
    "localStorage:zcode-mcp-config",
  );
  if (migration.completed) {
    // Only after confirming writing into the zcode agent directory, clean up the old data to avoid losing configuration when there is no desktop bridge on the web side.
    clearLegacyCommonMcpServers();
  }
  if (!migration.changed) {
    return nativeServers;
  }

  logger.info(
    `[mcpStore] migrated ${migration.importedCount} legacy common MCP servers to zcode agent config`,
  );
  return fetchNativeMcpServers(platform, { workspacePath });
}
