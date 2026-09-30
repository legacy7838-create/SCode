/* eslint-disable max-lines -- commandsService needs to centrally handle directory source priority, reads/writes and command resolution; splitting it would weaken the consistency of the read order */
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ZCODE_COMMAND_AGENT_SOURCE,
  ZCODE_COMMAND_AGENT_SOURCES,
  type CommandAgentSource,
  type CommandCreateParams,
  type CommandDeleteParams,
  type CommandConfig,
  type CommandSetEnabledParams,
  type CommandUpdateParams,
  type CommandsListResult,
  type PluginCommand,
  type SettingsDirectoryLocation,
  type SettingsDirectorySource,
  type UserCommand,
  type ZCodeCommand,
} from "@zcode/shared";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "@zcode/shared";
import type { ICommandsService } from "./commands.js";
import { CommandFileParser, type CommandFileFormat } from "./commandFileParser.js";
import { readInstalledPluginRoots } from "#src/plugins/installedPluginRoots.js";

function resolveUserHomeDir() {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

interface CommandAgentSourceDescriptor {
  agentSource: CommandAgentSource;
  directorySource: SettingsDirectorySource;
  userDirectorySegments: readonly string[];
  workspaceDirectorySegments: readonly string[];
  fileExtension: ".md" | ".toml";
  format: CommandFileFormat;
  namespaceSeparator: "/" | ":";
  supportsArgumentHint: boolean;
}

const DEFAULT_COMMAND_AGENT_SOURCE: CommandAgentSource = ZCODE_COMMAND_AGENT_SOURCE;
const COMMAND_AGENT_SOURCE_ORDER: readonly CommandAgentSource[] = ZCODE_COMMAND_AGENT_SOURCES;
const ENABLE_OVERRIDE_KEY = "enable";
const HOME_PREFIX = "~/";
const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
const ZCODE_PLUGIN_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_PLUGIN_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_PLUGIN_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const ZCODE_COMMAND_DESCRIPTOR: CommandAgentSourceDescriptor = {
  agentSource: "zcodeAgent",
  directorySource: "zcode",
  userDirectorySegments: [".zcode", "commands"],
  workspaceDirectorySegments: [".zcode", "commands"],
  fileExtension: ".md",
  format: "markdown",
  namespaceSeparator: "/",
  supportsArgumentHint: true,
};

const COMMAND_AGENT_SOURCE_DESCRIPTORS: Record<CommandAgentSource, CommandAgentSourceDescriptor> = {
  zcodeAgent: ZCODE_COMMAND_DESCRIPTOR,
};

const COMMAND_DIRECTORY_SOURCE_DESCRIPTORS: readonly CommandAgentSourceDescriptor[] = [
  ZCODE_COMMAND_DESCRIPTOR,
  {
    ...ZCODE_COMMAND_DESCRIPTOR,
    directorySource: "agents",
    userDirectorySegments: [".agents", "commands"],
    workspaceDirectorySegments: [".agents", "commands"],
  },
];

function getCommandSourceDescriptor(
  agentSource: CommandAgentSource = DEFAULT_COMMAND_AGENT_SOURCE,
): CommandAgentSourceDescriptor {
  return COMMAND_AGENT_SOURCE_DESCRIPTORS[agentSource];
}

function getUserCommandsRoot(agentSource?: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

function getUserCliConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readUserCliConfig(): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(getUserCliConfigPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  const filePath = getUserCliConfigPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function readCommandEnabledOverrides(config: Record<string, unknown>): Map<string, boolean> {
  const commandConfig = config.command;
  const overrides = new Map<string, boolean>();
  if (!isRecord(commandConfig)) {
    return overrides;
  }

  for (const [filePath, entry] of Object.entries(commandConfig)) {
    if (isRecord(entry) && typeof entry[ENABLE_OVERRIDE_KEY] === "boolean") {
      overrides.set(filePath, entry[ENABLE_OVERRIDE_KEY]);
    }
  }
  return overrides;
}

async function readCommandEnabledOverridesFromUserConfig(): Promise<Map<string, boolean>> {
  return readCommandEnabledOverrides(await readUserCliConfig());
}

function getCommandEnabled(filePath: string, overrides: ReadonlyMap<string, boolean>): boolean {
  return overrides.get(filePath) ?? true;
}

function setCommandEnabledOverride(
  config: Record<string, unknown>,
  filePath: string,
  enabled: boolean,
): Record<string, unknown> {
  const commandConfig = isRecord(config.command) ? { ...config.command } : {};

  if (enabled) {
    delete commandConfig[filePath];
  } else {
    commandConfig[filePath] = { [ENABLE_OVERRIDE_KEY]: false };
  }

  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(commandConfig).length > 0) {
    nextConfig.command = commandConfig;
  } else {
    delete nextConfig.command;
  }
  return nextConfig;
}

interface PluginConfigSummary {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  storageDir: string;
  suppressedBuiltins: string[];
}

interface PluginRootCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

interface PluginManifestSummary {
  commands?: unknown;
  name: string;
}

interface PluginCommandRootDescriptor {
  pluginEnabled: boolean;
  pluginMarketplace: string;
  pluginName: string;
  rootPath: string;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readBooleanRecord(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      result[key] = enabled;
    }
  }
  return result;
}

function readStorageDirFromConfig(config: Record<string, unknown>): string {
  const storage = isRecord(config.storage) ? config.storage : {};
  return typeof storage.dir === "string" && storage.dir.trim().length > 0
    ? storage.dir
    : "~/.zcode";
}

function readPluginConfigFromConfig(config: Record<string, unknown>): PluginConfigSummary {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  return {
    dirs: readStringArray(plugins.dirs),
    enabled: typeof plugins.enabled === "boolean" ? plugins.enabled : true,
    enabledPlugins: readBooleanRecord(plugins.enabledPlugins),
    storageDir: readStorageDirFromConfig(config),
    suppressedBuiltins: readStringArray(plugins.suppressedBuiltins),
  };
}

function resolveConfigPath(path: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function resolveCliStorageRoot(storageDir: string): string {
  const storageRoot = resolveConfigPath(storageDir);
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

function resolvePluginStorageRoot(storageDir: string): string {
  return join(resolveCliStorageRoot(storageDir), "plugins");
}

function parsePathList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return readStringArray(value);
}

function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) {
    return null;
  }
  const resolved = resolve(rootPath, rawPath);
  const relativePath = relative(rootPath, resolved);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`))
  ) {
    return resolved;
  }
  return null;
}

async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries: string[] = [];
  try {
    pluginEntries = await readdir(cacheRoot);
  } catch {
    return [];
  }

  const roots: string[] = [];
  for (const pluginEntry of pluginEntries) {
    const pluginDir = join(cacheRoot, pluginEntry);
    let versionEntries: string[] = [];
    try {
      versionEntries = await readdir(pluginDir);
    } catch {
      continue;
    }
    for (const versionEntry of versionEntries) {
      const rootPath = join(pluginDir, versionEntry);
      try {
        if ((await lstat(rootPath)).isDirectory()) {
          roots.push(rootPath);
        }
      } catch {
        // ignore inaccessible plugin cache entries
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<PluginManifestSummary | null> {
  const manifestPath = await findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
      return null;
    }
    return { commands: parsed.commands, name };
  } catch {
    return null;
  }
}

async function findPluginManifestPath(rootPath: string): Promise<string | null> {
  for (const manifestPath of [
    join(rootPath, ZCODE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CODEX_PLUGIN_MANIFEST_PATH),
  ]) {
    if (existsSync(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

function resolvePluginCommandRoots(params: {
  manifest: PluginManifestSummary;
  rootPath: string;
}): string[] {
  const roots: string[] = [];
  for (const rawPath of parsePathList(params.manifest.commands)) {
    const rootPath = resolveInside(params.rootPath, rawPath);
    if (rootPath) {
      roots.push(rootPath);
    }
  }
  if (roots.length === 0 && params.manifest.commands === undefined) {
    const defaultRoot = join(params.rootPath, "commands");
    if (existsSync(defaultRoot)) {
      roots.push(defaultRoot);
    }
  }
  return roots;
}

async function resolvePluginCommandRootDescriptors(): Promise<PluginCommandRootDescriptor[]> {
  const config = readPluginConfigFromConfig(await readUserCliConfig());
  if (!config.enabled) {
    return [];
  }

  const pluginStorageRoot = resolvePluginStorageRoot(config.storageDir);
  const officialCacheRoots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
  const installedRoots = await readInstalledPluginRoots(pluginStorageRoot);
  const candidates: PluginRootCandidate[] = [
    ...config.dirs.map((dir) => ({
      defaultEnabled: true,
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath: resolveConfigPath(dir),
    })),
    ...officialCacheRoots.map((rootPath) => ({
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
    })),
    ...installedRoots,
  ];
  const descriptors: PluginCommandRootDescriptor[] = [];
  const seenPluginIds = new Set<string>();

  for (const candidate of candidates) {
    const manifest = await readPluginManifest(candidate.rootPath);
    if (!manifest) {
      continue;
    }
    const pluginId = `${manifest.name}@${candidate.marketplace}`;
    // After the built-in official plug-in is "uninstalled", only suppressedBuiltins is written in the CLI config; desktop scans directly
    // The official cache is not filtered by CLI resolve and needs to be skipped here, otherwise the built-in plug-in will be uninstalled.
    // Commands will still be contributed from cache.
    if (
      candidate.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      config.suppressedBuiltins.includes(pluginId)
    ) {
      continue;
    }
    if (seenPluginIds.has(pluginId)) {
      continue;
    }
    seenPluginIds.add(pluginId);
    const defaultEnabled =
      candidate.defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId);
    const enabled = config.enabledPlugins[pluginId] ?? defaultEnabled;
    if (!enabled) {
      continue;
    }

    // In the past, the command management page only displayed local commands, and plug-in scanning only covered the built-in official cache.
    // The official/self-built market plug-ins in marketplace installed_plugins.json must also be included in the read-only command source.
    for (const rootPath of resolvePluginCommandRoots({
      manifest,
      rootPath: candidate.rootPath,
    })) {
      descriptors.push({
        pluginEnabled: enabled,
        pluginMarketplace: candidate.marketplace,
        pluginName: manifest.name,
        rootPath,
      });
    }
  }

  return descriptors;
}

function getUserCommandsRootForDescriptor(descriptor: CommandAgentSourceDescriptor): string {
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

function getCommandsRootForStorage(params: {
  descriptor: CommandAgentSourceDescriptor;
  storageLevel?: "user" | "project";
  workspacePath?: string;
}): {
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
} {
  if (params.storageLevel === "project") {
    if (!params.workspacePath) {
      throw new Error("Missing workspace path for project command");
    }
    return {
      commandsRoot: join(params.workspacePath, ...params.descriptor.workspaceDirectorySegments),
      scope: "project",
      projectPath: params.workspacePath,
    };
  }

  return {
    commandsRoot: getUserCommandsRootForDescriptor(params.descriptor),
    scope: "global",
  };
}

function getLocationScope(scope: UserCommand["scope"]): SettingsDirectoryLocation["scope"] {
  return scope === "project" ? "project" : "user";
}

function buildCommandLocation(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
}): SettingsDirectoryLocation {
  return {
    source: params.descriptor.directorySource,
    scope: getLocationScope(params.scope),
    directoryPath: params.commandsRoot,
    ...(params.projectPath ? { projectPath: params.projectPath } : {}),
  };
}

// ============================================================================
// CommandsService implementation
// ============================================================================

interface CommandsServiceOptions {
  isDesktopRuntime?: boolean;
}

function getCommandName(
  rootDir: string,
  filePath: string,
  descriptor: CommandAgentSourceDescriptor,
): string {
  const relativePath = relative(rootDir, filePath);
  const extensionPattern = new RegExp(`${descriptor.fileExtension.replace(".", "\\.")}$`, "i");
  const withoutExtension = relativePath.replace(extensionPattern, "");
  return `/${withoutExtension
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(descriptor.namespaceSeparator)}`;
}

function getCommandFileName(config: CommandConfig, agentSource: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  const rawName = config.name.replace(/^\//, "");
  const relativeName = descriptor.namespaceSeparator === ":" ? rawName.replace(/:/g, "/") : rawName;
  return `${relativeName}${descriptor.fileExtension}`;
}

function getWritableCommandConfig(
  config: CommandConfig,
  descriptor: CommandAgentSourceDescriptor,
): CommandConfig {
  return descriptor.supportsArgumentHint ? config : { ...config, argumentHint: undefined };
}

function getCommandAgentSources(agentSource?: CommandAgentSource): readonly CommandAgentSource[] {
  return agentSource ? [agentSource] : COMMAND_AGENT_SOURCE_ORDER;
}

function buildCommandId(
  agentSource: CommandAgentSource,
  scope: UserCommand["scope"],
  name: string,
  location: SettingsDirectoryLocation,
): string {
  return `${agentSource}:${location.source}:${scope}:${name}`;
}

export function createCommandsService(_options?: CommandsServiceOptions): ICommandsService {
  async function list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult> {
    const userCommands: UserCommand[] = [];
    const agentSources = getCommandAgentSources(params.agentSource);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();

    // ZCode Agent needs to merge all workspace directories first, and then merge all user directories;
    // Interleaving the reading of project/user on a per-directory basis will put user .zcode ahead of workspace .agents.
    for (const agentSource of agentSources) {
      const descriptors =
        agentSource === ZCODE_COMMAND_AGENT_SOURCE
          ? COMMAND_DIRECTORY_SOURCE_DESCRIPTORS
          : [getCommandSourceDescriptor(agentSource)];

      if (params.workspacePath) {
        const workspacePath = params.workspacePath;
        await discoverCommandsFromDirectorySources({
          descriptors,
          commandsRootForDescriptor: (descriptor) =>
            join(workspacePath, ...descriptor.workspaceDirectorySegments),
          commands: userCommands,
          enabledOverrides,
          projectPath: workspacePath,
          scope: "project",
        });
      }

      await discoverCommandsFromDirectorySources({
        descriptors,
        commandsRootForDescriptor: getUserCommandsRootForDescriptor,
        commands: userCommands,
        enabledOverrides,
        scope: "global",
      });
    }

    const dedupedUserCommands = dedupeCommandsByName(userCommands);
    const pluginCommands =
      !params.agentSource || params.agentSource === ZCODE_COMMAND_AGENT_SOURCE
        ? await discoverPluginCommands(enabledOverrides)
        : [];

    return {
      commands: [...dedupedUserCommands, ...pluginCommands] as ZCodeCommand[],
      userCommands: dedupedUserCommands,
      pluginCommands,
      capability: { userScopeAvailable: true },
    };
  }

  async function writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
    await mkdir(commandsRoot, { recursive: true });

    const fileName = getCommandFileName(params.config, agentSource);
    const filePath = join(commandsRoot, fileName);

    // Check if the file already exists
    try {
      await access(filePath);
      throw new Error(`Command file already exists: ${fileName}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
    );
    await writeFile(filePath, content, "utf-8");
    await writeUserCliConfig(setCommandEnabledOverride(await readUserCliConfig(), filePath, true));

    const parsed = CommandFileParser.parseCommandFile(content, filePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
    const name = getCommandName(commandsRoot, filePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: true,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

  async function updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
    const newFileName = getCommandFileName(params.config, agentSource);
    const newFilePath = join(commandsRoot, newFileName);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();
    const existingContent = params.oldFilePath
      ? await readFile(params.oldFilePath, "utf-8").catch(() => undefined)
      : undefined;

    // If the file name has changed, you need to delete the old file
    if (params.oldFilePath && params.oldFilePath !== newFilePath) {
      try {
        await rm(params.oldFilePath);
      } catch {
        // Old files may have been removed, ignoring deletion failures (ENOENT is normal).
      }
    }

    // Check if new file already exists (excluding own old path)
    if (newFilePath !== params.oldFilePath) {
      try {
        await access(newFilePath);
        throw new Error(`Command file already exists: ${newFileName}`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
      existingContent,
    );
    await mkdir(dirname(newFilePath), { recursive: true });
    await writeFile(newFilePath, content, "utf-8");

    if (
      params.oldFilePath &&
      params.oldFilePath !== newFilePath &&
      enabledOverrides.has(params.oldFilePath)
    ) {
      // The disabled state is stored according to the command file path; editing the command name will change the file path, and override must be migrated.
      // Otherwise, the command just disabled by the user will be re-enabled due to the name change.
      const migratedConfig = setCommandEnabledOverride(
        setCommandEnabledOverride(await readUserCliConfig(), params.oldFilePath, true),
        newFilePath,
        enabledOverrides.get(params.oldFilePath) ?? true,
      );
      await writeUserCliConfig(migratedConfig);
    }

    const parsed = CommandFileParser.parseCommandFile(content, newFilePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
    const name = getCommandName(commandsRoot, newFilePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: getCommandEnabled(newFilePath, await readCommandEnabledOverridesFromUserConfig()),
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

  async function deleteCommandFile(params: CommandDeleteParams): Promise<void> {
    try {
      await rm(params.filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        // The file does not exist, treat it as successful
      } else {
        throw error;
      }
    }
    await writeUserCliConfig(
      setCommandEnabledOverride(await readUserCliConfig(), params.filePath, true),
    );
  }

  async function setCommandEnabled(params: CommandSetEnabledParams): Promise<void> {
    const nextConfig = setCommandEnabledOverride(
      await readUserCliConfig(),
      params.filePath,
      params.enabled,
    );
    await writeUserCliConfig(nextConfig);
  }

  async function getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }> {
    const path = getUserCommandsRoot(params?.agentSource);
    // open-in-file-manager does not reliably open non-existent paths on Windows,
    // Here, first ensure that the command directory is placed on the disk, and then give the path to the system file manager.
    await mkdir(path, { recursive: true });
    return { path };
  }

  return {
    list,
    writeCommandFile,
    updateCommandFile,
    deleteCommandFile,
    setCommandEnabled,
    getPrimaryUserCommandsDirectory,
  };
}

function dedupeCommandsByName(commands: UserCommand[]): UserCommand[] {
  const selected = new Map<string, UserCommand>();
  for (const command of commands) {
    if (!selected.has(command.name)) {
      selected.set(command.name, command);
    }
  }
  return Array.from(selected.values());
}

function buildPluginCommandId(params: {
  filePath: string;
  name: string;
  pluginMarketplace: string;
  pluginName: string;
}): string {
  return `plugin:${params.pluginMarketplace}:${params.pluginName}:${params.name}:${params.filePath}`;
}

async function discoverPluginCommands(
  enabledOverrides: ReadonlyMap<string, boolean>,
): Promise<PluginCommand[]> {
  const rootDescriptors = await resolvePluginCommandRootDescriptors();
  const commands: PluginCommand[] = [];
  const seenFilePaths = new Set<string>();
  for (const descriptor of rootDescriptors) {
    await discoverPluginCommandsRecursive(descriptor.rootPath, descriptor.rootPath, commands, {
      descriptor,
      enabledOverrides,
      seenFilePaths,
    });
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

// ============================================================================
// Helper function
// ============================================================================

async function discoverPluginCommandsRecursive(
  rootDir: string,
  currentDir: string,
  commands: PluginCommand[],
  options: {
    descriptor: PluginCommandRootDescriptor;
    enabledOverrides: ReadonlyMap<string, boolean>;
    seenFilePaths: Set<string>;
  },
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }

    const fullPath = join(currentDir, entry);
    let isDir = false;
    try {
      const stat = await lstat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      await discoverPluginCommandsRecursive(rootDir, fullPath, commands, options);
      continue;
    }

    if (!entry.toLowerCase().endsWith(ZCODE_COMMAND_DESCRIPTOR.fileExtension)) {
      continue;
    }

    try {
      const content = await readFile(fullPath, "utf-8");
      const parsed = CommandFileParser.parseCommandFile(
        content,
        fullPath,
        ZCODE_COMMAND_DESCRIPTOR.format,
      );
      if (!parsed) {
        continue;
      }
      const name = getCommandName(rootDir, fullPath, ZCODE_COMMAND_DESCRIPTOR);
      const commandKey = fullPath.replaceAll("\\", "/").toLowerCase();
      if (options.seenFilePaths.has(commandKey)) {
        continue;
      }
      options.seenFilePaths.add(commandKey);
      commands.push({
        ...parsed,
        enabled:
          options.descriptor.pluginEnabled && getCommandEnabled(fullPath, options.enabledOverrides),
        filePath: fullPath,
        id: buildPluginCommandId({
          filePath: fullPath,
          name,
          pluginMarketplace: options.descriptor.pluginMarketplace,
          pluginName: options.descriptor.pluginName,
        }),
        name,
        pluginEnabled: options.descriptor.pluginEnabled,
        pluginMarketplace: options.descriptor.pluginMarketplace,
        pluginName: options.descriptor.pluginName,
        scope: "global",
        source: "plugin",
      });
    } catch {
      // The plug-in command itself is managed by the plug-in; failure to parse a single file does not block the display of other commands.
    }
  }
}

async function discoverUserCommandsRecursive(
  rootDir: string,
  currentDir: string,
  commands: UserCommand[],
  options: {
    descriptor: CommandAgentSourceDescriptor;
    scope: UserCommand["scope"];
    enabledOverrides: ReadonlyMap<string, boolean>;
    projectPath?: string;
  },
): Promise<void> {
  const descriptor = options.descriptor;
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry);

    // Skip hidden files and directories
    if (entry.startsWith(".")) {
      continue;
    }

    let isDir = false;
    try {
      const stat = await lstat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      // Inaccessible, skip
      continue;
    }

    if (isDir) {
      // Scan subdirectories recursively
      await discoverUserCommandsRecursive(rootDir, fullPath, commands, options);
      continue;
    }

    if (entry.toLowerCase().endsWith(descriptor.fileExtension)) {
      try {
        const content = await readFile(fullPath, "utf-8");
        const parsed = CommandFileParser.parseCommandFile(content, fullPath, descriptor.format);
        if (parsed) {
          const name = getCommandName(rootDir, fullPath, descriptor);
          const location = buildCommandLocation({
            descriptor,
            commandsRoot: rootDir,
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
          commands.push({
            ...parsed,
            name,
            agentSource: descriptor.agentSource,
            location,
            id: buildCommandId(descriptor.agentSource, options.scope, name, location),
            source: "user",
            enabled: getCommandEnabled(fullPath, options.enabledOverrides),
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
        }
      } catch {
        // Skip if parsing fails
      }
    }
  }
}

async function discoverCommandsRoot(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<number> {
  const beforeCount = params.commands.length;
  try {
    await access(params.commandsRoot);
  } catch {
    return 0;
  }

  try {
    await discoverUserCommandsRecursive(params.commandsRoot, params.commandsRoot, params.commands, {
      descriptor: params.descriptor,
      scope: params.scope,
      enabledOverrides: params.enabledOverrides,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
  } catch {
    // Returns discovered commands when scanning fails
  }
  return params.commands.length - beforeCount;
}

async function discoverCommandsFromDirectorySources(params: {
  descriptors: readonly CommandAgentSourceDescriptor[];
  commandsRootForDescriptor: (descriptor: CommandAgentSourceDescriptor) => string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<void> {
  for (const descriptor of params.descriptors) {
    const discoveredCount = await discoverCommandsRoot({
      descriptor,
      commandsRoot: params.commandsRootForDescriptor(descriptor),
      commands: params.commands,
      enabledOverrides: params.enabledOverrides,
      scope: params.scope,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
    // `.zcode` is a strong priority source; as long as a valid command is read, `.agents` in the same scope will no longer participate.
    if (descriptor.directorySource === "zcode" && discoveredCount > 0) {
      break;
    }
  }
}
