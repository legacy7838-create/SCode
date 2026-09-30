/* eslint-disable max-lines -- The MCP sync service centrally maintains user directory reads/writes, remote imports and filesystem path rewriting; splitting it would increase the regression surface for remote config sync. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpScope,
  McpServerConfig,
  McpSyncCandidate,
  McpSyncExportedServer,
  McpSyncImportResult,
  McpSyncRemoteStatus,
  McpSyncSource,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
} from "@zcode/shared";
import type { IMcpSyncService } from "./mcpSync.js";
import { checkRemoteSyncDirectoryWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";

type McpConfigKeyName = "mcp.servers" | "mcpServers";

interface DirectoryMcpDescriptor {
  source: McpSyncSource;
  directorySource: SettingsDirectorySource;
  userConfigDirSegments: string[];
  workspaceConfigDirSegments: string[];
  fileName: string;
  configKeyName: McpConfigKeyName;
}

interface UserMcpRecord {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

const ZCODE_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcode",
  directorySource: "zcode",
  userConfigDirSegments: [".zcode", "cli"],
  workspaceConfigDirSegments: [".zcode"],
  fileName: "config.json",
  configKeyName: "mcp.servers",
};

const AGENTS_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "agents",
  directorySource: "agents",
  userConfigDirSegments: [".agents"],
  workspaceConfigDirSegments: [".agents"],
  fileName: "mcp.json",
  configKeyName: "mcpServers",
};

const ENABLED_KEY = "enabled";
// Historical legacy: In the early days of the desktop, the deactivation status was written as enable, and the CLI contract field (contracts McpServerConfigBase)
// It is always enabled, resulting in two sets of calibers appearing on the same server, and it is still pulled up by the agent after it is disabled.
// Now the read and write logic only recognizes enabled, and only one-time migration is retained here; the entire block is deleted after the stock configuration is cleared.
const LEGACY_ENABLE_KEY = "enable";
const SECRET_CONFIG_FILE_MODE = 0o600;
const DIRECTORY_MCP_DESCRIPTORS: readonly DirectoryMcpDescriptor[] = [
  ZCODE_MCP_DESCRIPTOR,
  AGENTS_MCP_DESCRIPTOR,
];

interface McpSyncServiceDependencies {
  /**
   * The execution surface for checking MCP server runtime state. A real connect/listTools must
   * happen in the agent process (the workspace's PATH/cwd environment); there is no substitute
   * implementation on the host side. Constructions without this dependency (directory-sync-only
   * uses / unit tests) explicitly throw when calling listWorkspaceMcpServerStatuses.
   */
  listMcpServerStatuses?: IMcpSyncService["listWorkspaceMcpServerStatuses"];
}

export function createMcpSyncService(
  dependencies: McpSyncServiceDependencies = {},
): IMcpSyncService {
  return {
    async loadMcpFromUserDirectory(request) {
      return loadMcpFromUserDirectory(request);
    },
    async listWorkspaceMcpServerStatuses(params) {
      if (!dependencies.listMcpServerStatuses) {
        throw new Error("MCP server status listing is unavailable in this runtime");
      }
      return dependencies.listMcpServerStatuses(params);
    },
    async saveMcpToUserDirectory(payload) {
      await saveMcpToUserDirectory(payload);
    },
    async listLocalUserMcpCandidates() {
      const localHomeDir = resolveUserHomeDir();
      return {
        candidates: (await collectEffectiveUserMcpRecords()).map(recordToCandidate),
        localHomeDir,
      };
    },
    async listRemoteUserMcpStatuses(params) {
      const remoteHomeDir = resolveUserHomeDir();
      const existingByName = await collectEffectiveUserMcpRecordByName();
      return {
        remoteHomeDir,
        statuses: params.names.map((name): McpSyncRemoteStatus => {
          const existing = existingByName.get(normalizeMcpNameKey(name));
          return existing ? { name, exists: true, path: existing.path } : { name, exists: false };
        }),
      };
    },
    async exportMcpServers(params) {
      const candidates = (await collectEffectiveUserMcpRecords()).map(recordToCandidate);
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      return {
        localHomeDir: resolveUserHomeDir(),
        servers: params.serverIds.map((id): McpSyncExportedServer => {
          const candidate = candidateById.get(id);
          if (!candidate) {
            throw new Error(`mcp sync candidate not found: ${id}`);
          }
          return {
            id: candidate.id,
            name: candidate.name,
            config: cloneMcpConfig(candidate.config),
            enabled: candidate.enabled,
            source: candidate.source,
            path: candidate.path,
          };
        }),
      };
    },
    async checkRemoteUserMcpWriteAccess() {
      return checkRemoteSyncDirectoryWriteAccess(dirname(getUserZcodeMcpConfigPath()));
    },
    async importMcpServers(params) {
      if (params.overwrite) {
        throw new Error("mcp sync overwrite is not supported");
      }
      return await importMcpServers(params);
    },
  };
}

function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

function buildDirectoryConfigPath(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const baseDir = scope === "user" ? resolveUserHomeDir() : workspacePath;
  if (!baseDir) {
    throw new Error(
      `Missing workspace path for ${descriptor.directorySource} workspace MCP config`,
    );
  }
  const segments =
    scope === "user" ? descriptor.userConfigDirSegments : descriptor.workspaceConfigDirSegments;
  return join(baseDir, ...segments, descriptor.fileName);
}

function buildUserConfigPath(descriptor: DirectoryMcpDescriptor): string {
  return buildDirectoryConfigPath(descriptor, "user");
}

function getUserZcodeMcpConfigPath(): string {
  return buildUserConfigPath(ZCODE_MCP_DESCRIPTOR);
}

function buildDirectoryMcpLocation(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  return {
    source: descriptor.directorySource,
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: dirname(filePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function findDescriptorByLocation(location: SettingsDirectoryLocation): DirectoryMcpDescriptor {
  const descriptor = DIRECTORY_MCP_DESCRIPTORS.find(
    (item) => item.directorySource === location.source,
  );
  if (!descriptor) {
    throw new Error(`Unsupported MCP settings directory source: ${location.source}`);
  }
  return descriptor;
}

async function collectEffectiveUserMcpRecords(): Promise<UserMcpRecord[]> {
  const zcodeRecords = await readUserMcpRecordsFromFile(ZCODE_MCP_DESCRIPTOR);
  if (zcodeRecords.length > 0) {
    return sortMcpRecords(zcodeRecords);
  }
  return sortMcpRecords(await readUserMcpRecordsFromFile(AGENTS_MCP_DESCRIPTOR));
}

async function collectEffectiveUserMcpRecordByName(): Promise<Map<string, UserMcpRecord>> {
  const result = new Map<string, UserMcpRecord>();
  for (const record of await collectEffectiveUserMcpRecords()) {
    const nameKey = normalizeMcpNameKey(record.name);
    if (!result.has(nameKey)) {
      result.set(nameKey, record);
    }
  }
  return result;
}

async function loadMcpFromUserDirectory(
  request?: LoadCliMcpFromUserDirectoryRequest,
): Promise<LoadCliMcpFromUserDirectoryResult> {
  const servers: NativeMcpServerRecord[] = [];
  if (request?.workspacePath) {
    servers.push(
      ...(await readDirectoryServersFromPreferredSources("workspace", request.workspacePath)),
    );
  }
  servers.push(...(await readDirectoryServersFromPreferredSources("user", request?.workspacePath)));
  return { servers };
}

async function saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void> {
  if (payload.action === "set-enabled") {
    if (typeof payload.enabled !== "boolean") {
      throw new Error("Missing enabled value for MCP set-enabled action");
    }
    const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
    const location =
      payload.location ??
      buildDirectoryMcpLocation(ZCODE_MCP_DESCRIPTOR, scope, payload.projectPath);
    await writeServerEnabledToFile(
      findDescriptorByLocation(location),
      location,
      payload.name,
      payload.enabled,
    );
    await cleanupLegacyMcpEnabledOverride(location, payload.name);
    return;
  }

  const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
  const existingServers = await readDirectoryServersFromFile(
    ZCODE_MCP_DESCRIPTOR,
    scope,
    payload.projectPath,
  );
  const nextServers = Object.fromEntries(
    existingServers.map((server) => [server.name, server.config as Record<string, unknown>]),
  );

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    nextServers[payload.name] = payload.config as Record<string, unknown>;
  } else {
    delete nextServers[payload.name];
  }

  await writeZCodeServersToFile(scope, nextServers, payload.projectPath);
}

function sortMcpRecords(records: UserMcpRecord[]): UserMcpRecord[] {
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

async function readDirectoryServersFromPreferredSources(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const zcodeServers = await readDirectoryServersFromFile(
    ZCODE_MCP_DESCRIPTOR,
    scope,
    workspacePath,
  );
  if (zcodeServers.length > 0) {
    return zcodeServers;
  }
  return readDirectoryServersFromFile(AGENTS_MCP_DESCRIPTOR, scope, workspacePath);
}

async function readDirectoryServersFromFile(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  const location = buildDirectoryMcpLocation(descriptor, scope, workspacePath);
  return Object.entries(serverMap).map(([name, config]) => ({
    source: "zcodeagentmcp",
    scope,
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    projectPath: scope === "workspace" ? workspacePath : undefined,
    location,
    file: {
      format: "json",
      filePath,
    },
  }));
}

async function writeZCodeServersToFile(
  scope: Exclude<McpScope, "common">,
  servers: Record<string, Record<string, unknown>>,
  workspacePath?: string,
): Promise<void> {
  const filePath = buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const next = writeServerMapToJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName, servers);
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

async function readUserCliConfig(): Promise<Record<string, unknown>> {
  return (await readJsonObject(getUserZcodeMcpConfigPath())) ?? {};
}

async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  await writeTextAtomic(getUserZcodeMcpConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function removeLegacyMcpEnabledOverride(
  config: Record<string, unknown>,
  location: SettingsDirectoryLocation,
  name: string,
): { config: Record<string, unknown>; changed: boolean } {
  if (!isRecord(config.mcp) || !isRecord(config.mcp[location.directoryPath])) {
    return { config, changed: false };
  }

  const mcpConfig = { ...config.mcp };
  const pathConfig = {
    ...(mcpConfig[location.directoryPath] as Record<string, unknown>),
  };
  if (!(name in pathConfig)) {
    return { config, changed: false };
  }

  delete pathConfig[name];
  if (Object.keys(pathConfig).length > 0) {
    mcpConfig[location.directoryPath] = pathConfig;
  } else {
    delete mcpConfig[location.directoryPath];
  }

  return {
    config: {
      ...config,
      mcp: mcpConfig,
    },
    changed: true,
  };
}

async function cleanupLegacyMcpEnabledOverride(
  location: SettingsDirectoryLocation,
  name: string,
): Promise<void> {
  const userConfig = await readUserCliConfig();
  const result = removeLegacyMcpEnabledOverride(userConfig, location, name);
  if (result.changed) {
    await writeUserCliConfig(result.config);
  }
}

async function writeServerEnabledToFile(
  descriptor: DirectoryMcpDescriptor,
  location: SettingsDirectoryLocation,
  name: string,
  enabled: boolean,
): Promise<void> {
  const scope: Exclude<McpScope, "common"> = location.scope === "project" ? "workspace" : "user";
  const workspacePath = scope === "workspace" ? location.projectPath : undefined;
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const serverMap = readServerMapFromJson(current, descriptor.configKeyName);
  const currentServer = serverMap[name];
  if (!isRecord(currentServer)) {
    return;
  }
  // MCP itself already has the mcp.servers/mcpServers structure; the disabled state is written in the server configuration object.
  // Avoid writing the directory path to the top level of mcp and mixing it with the real MCP configuration.
  const nextServerMap = {
    ...serverMap,
    [name]: setServerEnabled(currentServer as McpServerConfig, enabled) as Record<string, unknown>,
  };
  let next = writeServerMapToJson(current, descriptor.configKeyName, nextServerMap);
  const legacyCleanup = removeLegacyMcpEnabledOverride(next, location, name);
  if (legacyCleanup.changed) {
    next = legacyCleanup.config;
  }
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

async function readUserMcpRecordsFromFile(
  descriptor: DirectoryMcpDescriptor,
): Promise<UserMcpRecord[]> {
  const filePath = buildUserConfigPath(descriptor);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  return Object.entries(serverMap).map(([name, config]) => ({
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    source: descriptor.source,
    path: filePath,
  }));
}

function recordToCandidate(record: UserMcpRecord): McpSyncCandidate {
  return {
    id: createCandidateId(record),
    name: record.name,
    config: cloneMcpConfig(record.config),
    enabled: record.enabled,
    source: record.source,
    path: record.path,
  };
}

function createCandidateId(record: UserMcpRecord): string {
  return createHash("sha256")
    .update(`${record.source}:${record.path}:${record.name}`)
    .digest("hex");
}

function normalizeMcpNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function readServerEnabled(config: Record<string, unknown>): boolean {
  return config[ENABLED_KEY] !== false;
}

function setServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  // Enable is the default state, and redundant fields will not be written to the disk; at the same time, clear any remaining legacy enable.
  // Avoid contradictory configurations such as enable:false + enabled:true.
  const { [LEGACY_ENABLE_KEY]: _legacyEnable, [ENABLED_KEY]: _enabled, ...rest } = config;
  if (enabled) {
    return rest;
  }
  return { ...rest, [ENABLED_KEY]: false };
}

function migrateLegacyEnableFlag(serverMap: Record<string, Record<string, unknown>>): {
  servers: Record<string, Record<string, unknown>>;
  changed: boolean;
} {
  let changed = false;
  const migrated: Record<string, Record<string, unknown>> = {};

  for (const [name, config] of Object.entries(serverMap)) {
    if (!isRecord(config) || !(LEGACY_ENABLE_KEY in config)) {
      migrated[name] = config;
      continue;
    }
    changed = true;
    // When two fields conflict, "disable" shall prevail: writing enable:false on the desktop will not clean up the remaining external imports.
    // enabled: true, if enabled value is used, the server that the user shut down will be restarted.
    const disabled = config[LEGACY_ENABLE_KEY] === false || config[ENABLED_KEY] === false;
    migrated[name] = setServerEnabled(config as McpServerConfig, !disabled) as Record<
      string,
      unknown
    >;
  }

  return { servers: migrated, changed };
}

/**
 * Reads the server map and, along the way, collapses the legacy enable field in place into enabled
 * and writes it back to disk. When no legacy field remains, nothing is written, which keeps it
 * idempotent; a failed write does not block the read, since the in-memory result is already correct
 * and the next load will retry.
 */
async function readServerMapWithLegacyMigration(
  filePath: string,
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Promise<Record<string, Record<string, unknown>>> {
  const migration = migrateLegacyEnableFlag(readServerMapFromJson(parsed, configKeyName));
  if (!migration.changed) {
    return migration.servers;
  }

  try {
    const next = writeServerMapToJson(parsed, configKeyName, migration.servers);
    await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    console.warn("[mcp-sync] legacy enable migration failed:", filePath, formatErrorMessage(error));
  }
  return migration.servers;
}

function readServerMapFromJson(
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Record<string, Record<string, unknown>> {
  if (configKeyName === "mcp.servers") {
    const mcp = parsed.mcp;
    if (!isRecord(mcp)) {
      return {};
    }
    const servers = mcp.servers;
    return isRecord(servers) ? (servers as Record<string, Record<string, unknown>>) : {};
  }

  const rawServerMap = parsed[configKeyName];
  return isRecord(rawServerMap) ? (rawServerMap as Record<string, Record<string, unknown>>) : {};
}

function writeServerMapToJson(
  current: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
  servers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (configKeyName !== "mcp.servers") {
    return {
      ...current,
      [configKeyName]: servers,
    };
  }

  const currentMcp = isRecord(current.mcp) ? current.mcp : {};
  return {
    ...current,
    mcp: {
      ...currentMcp,
      servers,
    },
  };
}

async function importMcpServers(params: {
  servers: McpSyncExportedServer[];
  localHomeDir: string;
  localWorkspacePath?: string;
  remoteWorkspacePath?: string;
}): Promise<McpSyncImportResult> {
  const targetPath = getUserZcodeMcpConfigPath();
  const current = (await readJsonObject(targetPath)) ?? {};
  const targetServers = readServerMapFromJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName);
  const existingByName = await collectEffectiveUserMcpRecordByName();
  const results: McpSyncImportResult["results"] = [];
  let changed = false;

  for (const server of params.servers) {
    const nameKey = normalizeMcpNameKey(server.name);
    const existingTarget = targetServers[server.name];
    if (existingTarget) {
      results.push({ name: server.name, status: "skipped", path: targetPath });
      continue;
    }

    const existing = existingByName.get(nameKey);
    if (existing) {
      results.push({
        name: server.name,
        status: "skipped",
        path: existing.path,
      });
      continue;
    }

    try {
      const rewrittenConfig = rewriteFilesystemMcpConfig(
        server.name,
        setServerEnabled(cloneMcpConfig(server.config), server.enabled),
        {
          localHomeDir: params.localHomeDir,
          localWorkspacePath: params.localWorkspacePath,
          remoteHomeDir: resolveUserHomeDir(),
          remoteWorkspacePath: params.remoteWorkspacePath,
        },
      );
      targetServers[server.name] = rewrittenConfig as Record<string, unknown>;
      existingByName.set(nameKey, {
        name: server.name,
        config: rewrittenConfig,
        enabled: server.enabled,
        source: "zcode",
        path: targetPath,
      });
      results.push({ name: server.name, status: "synced", path: targetPath });
      changed = true;
    } catch (error) {
      results.push({
        name: server.name,
        status: "failed",
        path: targetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (changed) {
    await writeTextAtomic(
      targetPath,
      `${JSON.stringify(writeServerMapToJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName, targetServers), null, 2)}\n`,
    );
  }

  return { results };
}

function rewriteFilesystemMcpConfig(
  name: string,
  config: McpServerConfig,
  paths: {
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteHomeDir: string;
    remoteWorkspacePath?: string;
  },
): McpServerConfig {
  if (!isStdioMcpConfig(config) || !isFilesystemMcpServer(name, config)) {
    return config;
  }
  if (!Array.isArray(config.args)) {
    return config;
  }
  return {
    ...config,
    args: config.args.map((arg) => rewritePathArgForRemote(arg, paths)),
  };
}

function isStdioMcpConfig(config: McpServerConfig): boolean {
  const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
  if (!type && typeof config.command === "string" && config.command.trim()) {
    return true;
  }
  return type === "stdio";
}

function isFilesystemMcpServer(name: string, config: McpServerConfig): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (
    normalizedName === "filesystem" ||
    normalizedName === "file-system" ||
    normalizedName === "fs"
  ) {
    return true;
  }
  const haystack = [config.command, ...(Array.isArray(config.args) ? config.args : [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("@modelcontextprotocol/server-filesystem") ||
    haystack.includes("mcp-server-filesystem")
  );
}

function rewritePathArgForRemote(
  arg: string,
  paths: {
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteHomeDir: string;
    remoteWorkspacePath?: string;
  },
): string {
  const workspaceRelative = getRelativePathIfWithin(paths.localWorkspacePath, arg);
  if (workspaceRelative !== null && paths.remoteWorkspacePath?.trim()) {
    return joinRemotePath(paths.remoteWorkspacePath, workspaceRelative);
  }

  const homeRelative = getRelativePathIfWithin(paths.localHomeDir, arg);
  if (homeRelative !== null) {
    return joinRemotePath(paths.remoteHomeDir, homeRelative);
  }

  return arg;
}

function getRelativePathIfWithin(
  basePath: string | undefined,
  candidatePath: string,
): string | null {
  if (!basePath?.trim()) {
    return null;
  }
  const base = normalizeComparablePath(basePath);
  const candidate = normalizeComparablePath(candidatePath);
  if (!base || !candidate) {
    return null;
  }
  const baseValue = base.caseInsensitive ? base.value.toLowerCase() : base.value;
  const candidateValue = base.caseInsensitive ? candidate.value.toLowerCase() : candidate.value;
  if (candidateValue === baseValue) {
    return "";
  }
  const prefix = baseValue.endsWith("/") ? baseValue : `${baseValue}/`;
  if (!candidateValue.startsWith(prefix)) {
    return null;
  }
  return candidate.value.slice(prefix.length);
}

function normalizeComparablePath(
  rawPath: string,
): { value: string; caseInsensitive: boolean } | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const isWindowsPath = /^[a-zA-Z]:[\\/]/u.test(trimmed) || trimmed.startsWith("\\\\");
  const isPosixPath = trimmed.startsWith("/");
  if (!isWindowsPath && !isPosixPath) {
    return null;
  }

  let value = trimmed.replaceAll("\\", "/");
  value = value.replace(/\/+$/u, "");
  if (value === "") {
    value = "/";
  }
  return {
    value,
    caseInsensitive: isWindowsPath,
  };
}

function joinRemotePath(remoteBasePath: string, relativePath: string): string {
  if (!relativePath) {
    return remoteBasePath;
  }
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  // MCP synchronization runs in the local process, but remoteWorkspacePath describes the remote host path.
  // Process.platform cannot be used to determine the splicing style, otherwise the Windows client will write /srv/... as \srv\... when synchronizing to Linux/WSL.
  const normalizedBasePath = remoteBasePath.trim();
  if (normalizedBasePath.startsWith("/")) {
    return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
  }
  if (/^[a-zA-Z]:[\\/]/u.test(normalizedBasePath) || normalizedBasePath.startsWith("\\\\")) {
    return win32.join(normalizedBasePath, ...segments);
  }
  return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
}

function cloneMcpConfig(config: McpServerConfig): McpServerConfig {
  return JSON.parse(JSON.stringify(config)) as McpServerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw new Error(`failed to read MCP config file ${filePath}: ${formatErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // The remote MCP import must first confirm that the existing config.json is readable and mergeable;
    // If JSON is damaged and continues to be written as an empty object, the provider, MCP and secret configurations will be silently overwritten.
    throw new Error(`failed to parse MCP config file ${filePath}: ${formatErrorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`MCP config file ${filePath} must be a JSON object`);
  }
  return parsed;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    // The remote MCP configuration will persist secrets such as env/header/token;
    // Temporary file permissions cannot rely on remote umask, otherwise config.json may be read by the same group or other users after rename.
    await writeFile(tempPath, content, {
      encoding: "utf-8",
      mode: SECRET_CONFIG_FILE_MODE,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
