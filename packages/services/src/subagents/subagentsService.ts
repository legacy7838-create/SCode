/* eslint-disable max-lines */
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentStateId,
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  modelSelectionSchema,
  type AgentCreateParams,
  type AgentDeleteParams,
  type AgentDiagnostic,
  type AgentScope,
  type AgentSummary,
  type AgentUpdateParams,
  type AgentsCapability,
  type AgentsListResult,
  type BuiltInSubagentModelOverrideParams,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelOverrideParams,
  type PluginSubagentModelSelectionOverrides,
  type SubAgentConfig,
  type SubagentsListMode,
  type ZCodeProvider,
} from "@zcode/shared";
import { normalizeSubagentModelSelection } from "./subagentModelSelection.js";
import { serializeSubagentMarkdown, parseSubagentMarkdown } from "./subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserHomeDir,
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
  resolveZCodeStorageRoot,
  type SubagentStorageOptions,
} from "./subagentStorage.js";
import type { ISubagentsService } from "./subagents.js";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
  scanOfficialPluginCacheRoots,
} from "@zcode/shared/node";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const subagentLogger = createServiceLogger("subagents");

interface AgentsStateFile {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: string[];
  // It is only reserved for rollback of the old version; after the selection field exists in the new version, it is prohibited to restore overwriting from these two fields.
  builtInModelOverrides?: unknown;
  builtInThoughtLevelOverrides?: unknown;
}

interface InstalledPluginsStateFile {
  plugins?: unknown;
}

interface PluginConfigSummary {
  enabledPlugins: Record<string, boolean>;
  suppressedBuiltins: string[];
}

interface InstalledPluginRecord {
  id: string;
  installPath: string;
  name: string;
  scope?: "user" | "workspace";
  projectPath?: string;
}

interface SubagentsServiceOptions extends SubagentStorageOptions {
  isDesktopRuntime?: boolean;
}

interface PluginAgentDiscovery {
  profiles: AgentSummary[];
  runtimeAgents: AgentSummary[];
}

const BUILT_IN_AGENT_NAMES = new Set(["general-purpose", "Explore"]);
const PLUGIN_MANIFEST_PATHS = [
  join(".zcode-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
] as const;

function createBuiltInAgents(
  modelSelectionOverrides: BuiltInSubagentModelSelectionOverrides = {},
): AgentSummary[] {
  const generalPurposeOverride = modelSelectionOverrides["general-purpose"];
  const exploreOverride = modelSelectionOverrides.Explore;
  return [
    {
      id: createAgentStateId({
        name: "general-purpose",
        scope: "built-in",
        source: "built-in",
      }),
      name: "general-purpose",
      description:
        "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
      // The built-in sub-agent uses explicit identity color to prevent the UI from displaying the general-purpose in red after hashing by name.
      color: "blue",
      injectAgentsMd: true,
      modelSelection: generalPurposeOverride,
      modelSelectionOverride: generalPurposeOverride,
      systemPrompt: "",
      tools: ["*"],
      path: "built-in:general-purpose",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
    {
      id: createAgentStateId({
        name: "Explore",
        scope: "built-in",
        source: "built-in",
      }),
      name: "Explore",
      description: "Read-only search agent for broad fan-out searches.",
      color: "cyan",
      injectAgentsMd: false,
      modelSelection: exploreOverride,
      modelSelectionOverride: exploreOverride,
      systemPrompt: "",
      tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
  ];
}

function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    disabledAgentIds: [],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readAgentStateFile(options?: SubagentsServiceOptions): Promise<AgentsStateFile> {
  await migrateSubagentStateFile(await resolveSubagentStateFile(options));
  try {
    const raw = await readFile(await resolveSubagentStateFile(options), "utf-8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      builtInModelOverrides?: unknown;
      builtInThoughtLevelOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    const selections = normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides);
    return {
      ...parsed,
      builtInModelSelectionOverrides: selections,
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      disabledAgentIds: Array.isArray(parsed.disabledAgentIds)
        ? parsed.disabledAgentIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          )
        : [],
    };
  } catch {
    return emptyAgentsState();
  }
}

async function writeAgentStateFile(
  next: AgentsStateFile,
  options?: SubagentStorageOptions,
): Promise<void> {
  const stateFile = await resolveSubagentStateFile(options);
  await mkdir(dirname(stateFile), { recursive: true });
  await atomicWriteText(stateFile, JSON.stringify(next, null, 2));
}

async function discoverFileAgents(params: {
  diagnostics: AgentDiagnostic[];
  includeUserAgents: boolean;
  includeWorkspaceAgents: boolean;
  storageOptions?: SubagentStorageOptions;
  workspacePath: string;
}): Promise<AgentSummary[]> {
  const roots: Array<{ scope: AgentScope; rootPath: string }> = [];
  if (params.includeUserAgents) {
    roots.push({
      scope: "user",
      rootPath: await resolveUserSubagentRoot(params.storageOptions),
    });
  }
  if (params.includeWorkspaceAgents) {
    roots.push({
      scope: "workspace",
      rootPath: resolveWorkspaceSubagentRoot(params.workspacePath),
    });
  }

  const agents: AgentSummary[] = [];
  for (const root of roots) {
    for (const agentPath of await collectAgentMarkdownPaths(root.rootPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: root.scope,
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          agents.push({
            ...parsed.agent,
            projectPath: root.scope === "workspace" ? params.workspacePath : undefined,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  return agents;
}

async function collectAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  if (!(await exists(rootPath))) {
    return [];
  }

  const rootStat = await lstat(rootPath).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return [];
  }

  const result: string[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectAgentMarkdownPaths(entryPath)));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(entryPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function resolveCapabilities(options?: SubagentsServiceOptions): AgentsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

function attachEnabledState(agents: AgentSummary[], state: AgentsStateFile): AgentSummary[] {
  const disabledSet = new Set(state.disabledAgentIds);
  return agents.map((agent) => ({
    ...agent,
    enabled: agent.scope === "user" ? !disabledSet.has(agent.id) : true,
  }));
}

function applyRuntimePrecedence(agents: AgentSummary[]): AgentSummary[] {
  const byName = new Map<string, AgentSummary>();
  for (const agent of agents) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

async function discoverPluginAgents(params: {
  diagnostics: AgentDiagnostic[];
  state: AgentsStateFile;
  reservedNames: Iterable<string>;
  storageOptions?: SubagentStorageOptions;
}): Promise<PluginAgentDiscovery> {
  const storageRoot = await resolveZCodeStorageRoot(params.storageOptions);
  const cliStorageRoot = basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
  const pluginConfig = await readPluginConfig(params.storageOptions);
  const records = await readEnabledPluginRecords(join(cliStorageRoot, "plugins"), pluginConfig);
  const parsedAgents: Array<{
    agent: AgentSummary;
    bareName: string;
    pluginName: string;
  }> = [];

  for (const record of records) {
    for (const agentPath of await collectPluginAgentMarkdownPaths(record.installPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: record.scope === "workspace" ? "workspace" : "user",
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          const id = createPluginAgentStateId(record.id, parsed.agent.name);
          parsedAgents.push({
            agent: applyPluginAgentOverrides(
              {
                ...parsed.agent,
                id,
                name: `${record.name}:${parsed.agent.name}`,
                readOnly: true,
                source: "plugin",
                pluginId: record.id,
                pluginName: record.name,
                projectPath: record.scope === "workspace" ? record.projectPath : undefined,
              },
              params.state,
            ),
            bareName: parsed.agent.name,
            pluginName: record.name,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read plugin agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  const reservedNames = new Set([...BUILT_IN_AGENT_NAMES, ...params.reservedNames]);
  const bareNameCounts = new Map<string, number>();
  for (const parsed of parsedAgents) {
    bareNameCounts.set(parsed.bareName, (bareNameCounts.get(parsed.bareName) ?? 0) + 1);
  }

  const profiles: AgentSummary[] = [];
  const runtimeAgents: AgentSummary[] = [];
  for (const parsed of parsedAgents) {
    profiles.push(parsed.agent);
    runtimeAgents.push(parsed.agent);
    if (bareNameCounts.get(parsed.bareName) === 1 && !reservedNames.has(parsed.bareName)) {
      runtimeAgents.push({
        ...parsed.agent,
        id: createPluginAgentStateId(`${parsed.agent.id}:alias`, parsed.bareName),
        name: parsed.bareName,
      });
    } else if (reservedNames.has(parsed.bareName)) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    } else if ((bareNameCounts.get(parsed.bareName) ?? 0) > 1) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    }
  }

  return {
    // The naked name is just a runtime call alias for the same plug-in agent, and cannot enter the UI resource projection of one file per file.
    profiles: profiles.sort((left, right) => left.name.localeCompare(right.name)),
    runtimeAgents: runtimeAgents.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function readPluginConfig(options?: SubagentStorageOptions): Promise<PluginConfigSummary> {
  try {
    const configPath = join(resolveUserHomeDir(options), ".zcode", "cli", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { enabledPlugins: {}, suppressedBuiltins: [] };
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
    return {
      enabledPlugins: Object.fromEntries(
        Object.entries(enabledPlugins).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
      suppressedBuiltins: Array.isArray(plugins.suppressedBuiltins)
        ? plugins.suppressedBuiltins.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { enabledPlugins: {}, suppressedBuiltins: [] };
  }
}

/** There is no installation record of the built-in plug-in, and it will be missed if you only scan the installed file; the cache only compensates for missing identities, and cannot resurrect the disabled/uninstalled plug-in. */
async function readEnabledPluginRecords(
  pluginStorageRoot: string,
  config: PluginConfigSummary,
): Promise<InstalledPluginRecord[]> {
  const installed = await readInstalledPluginRecords(pluginStorageRoot);
  const records = installed.filter(
    (record) =>
      config.enabledPlugins[record.id] === true &&
      // Uninstall suppression takes precedence over legacy installation/enablement records, and official plugins cannot be resurrected just to check for cache hits.
      !(
        record.id.endsWith(`@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`) &&
        config.suppressedBuiltins.includes(record.id)
      ),
  );
  const seenIds = new Set(installed.map((record) => record.id));
  for (const cacheRoot of await scanOfficialPluginCacheRoots(pluginStorageRoot)) {
    const id = `${cacheRoot.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;
    if (seenIds.has(id) || config.suppressedBuiltins.includes(id)) continue;
    const enabled = config.enabledPlugins[id] ?? DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(id);
    if (!enabled) continue;
    for (const versionRoot of cacheRoot.versionRoots) {
      const manifest = await readPluginManifest(versionRoot);
      if (manifest?.name !== cacheRoot.name) continue;
      records.push({ id, installPath: versionRoot, name: cacheRoot.name, scope: "user" });
      seenIds.add(id);
      break;
    }
  }
  return records;
}

async function readInstalledPluginRecords(
  pluginStorageRoot: string,
): Promise<InstalledPluginRecord[]> {
  try {
    const raw = await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf-8");
    const parsed = JSON.parse(raw) as InstalledPluginsStateFile;
    if (!Array.isArray(parsed.plugins)) return [];
    return parsed.plugins.filter(isInstalledPluginRecord);
  } catch {
    return [];
  }
}

function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.installPath === "string" &&
    typeof value.name === "string"
  );
}

async function collectPluginAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  const manifest = await readPluginManifest(rootPath);
  const roots = collectPluginAgentRoots(rootPath, manifest?.agents);
  const paths = await Promise.all(roots.map((root) => collectAgentMarkdownPaths(root)));
  return paths.flat().sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<Record<string, unknown> | null> {
  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    try {
      const raw = await readFile(join(rootPath, relativePath), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next supported manifest path.
    }
  }
  return null;
}

function collectPluginAgentRoots(rootPath: string, manifestAgents: unknown): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const root = resolve(rootPath);
  const add = (relativePath: string) => {
    const resolved = resolve(root, relativePath.replace(/^\.\//u, ""));
    const relativeToRoot = relative(root, resolved);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) return;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push(resolved);
    }
  };
  add("agents");
  if (typeof manifestAgents === "string") add(manifestAgents);
  if (Array.isArray(manifestAgents)) {
    for (const value of manifestAgents) {
      if (typeof value === "string") add(value);
    }
  }
  return roots;
}

function applyPluginAgentOverrides(agent: AgentSummary, state: AgentsStateFile): AgentSummary {
  const override = state.pluginAgentModelSelectionOverrides[agent.id];
  // The plug-in file only provides default values; it overwrites and replaces the entire selection and cannot be mixed into the original model's gears.
  return {
    ...agent,
    defaultModelSelection: agent.modelSelection,
    ...(override ? { modelSelection: override, modelSelectionOverride: override } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]).data;
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore).data;
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

export function createSubagentsService(options?: SubagentsServiceOptions): ISubagentsService & {
  /** One-time storage import before Host starts Agent, not exposed as Renderer RPC. */
  prepareRuntimeState(): Promise<void>;
} {
  let writeQueue = Promise.resolve();
  const storageOptions: SubagentsServiceOptions = {
    homeDir: options?.homeDir,
  };

  return {
    async prepareRuntimeState() {
      const markdownMigration = await migrateUserSubagentMarkdown(
        await resolveUserSubagentRoot(storageOptions),
      );
      for (const failure of markdownMigration.failures)
        subagentLogger.warn(
          undefined,
          "user Subagent Markdown migration failed, keeping the original file",
          failure,
        );
      const runImport = async () =>
        migrateSubagentStateFile(await resolveSubagentStateFile(storageOptions));
      const queued = writeQueue.then(runImport, runImport);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      mode?: SubagentsListMode;
    }): Promise<AgentsListResult> {
      const capability = resolveCapabilities(options);
      const mode = params.mode ?? "allRuntimeScopes";
      const diagnostics: AgentDiagnostic[] = [];
      if (capability.userScopeAvailable) {
        const migration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of migration.failures)
          diagnostics.push({
            code: "agent_read_failed",
            message: "Subagent Markdown migration failed; original file preserved",
            path: failure.path,
          });
      }
      const state = await readAgentStateFile(storageOptions);
      const builtInAgents = createBuiltInAgents(state.builtInModelSelectionOverrides);
      const fileAgents = await discoverFileAgents({
        diagnostics,
        includeUserAgents: capability.userScopeAvailable,
        includeWorkspaceAgents: mode === "allRuntimeScopes",
        storageOptions,
        workspacePath: params.workspacePath,
      });
      const sortedUserAgents = fileAgents
        .filter((agent) => agent.scope === "user")
        .sort((left, right) => left.name.localeCompare(right.name));
      const sortedWorkspaceAgents = fileAgents
        .filter((agent) => agent.scope === "workspace")
        .sort((left, right) => left.name.localeCompare(right.name));
      // The user page cannot read the project profile, but it still needs to display the read-only overlay entry of the local plug-in; the two cannot be cut off at the same time.
      const pluginAgentDiscovery = await discoverPluginAgents({
        diagnostics,
        state,
        reservedNames: [
          ...builtInAgents.map((agent) => agent.name),
          ...sortedUserAgents.map((agent) => agent.name),
          ...sortedWorkspaceAgents.map((agent) => agent.name),
        ],
        storageOptions,
      });
      const discoveredAgents =
        mode === "settingsUserOnly"
          ? [...builtInAgents, ...sortedUserAgents]
          : applyRuntimePrecedence([
              ...builtInAgents,
              ...sortedUserAgents,
              ...sortedWorkspaceAgents,
              ...pluginAgentDiscovery.runtimeAgents,
            ]);
      const agents = attachEnabledState(discoveredAgents, state);

      return {
        agents,
        userAgents: agents.filter((agent) => agent.source === "user"),
        pluginAgents: attachEnabledState(pluginAgentDiscovery.profiles, state),
        capability,
        diagnostics,
      };
    },

    async setEnabled(params: { agentId: string; enabled: boolean }): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const previous = new Set(state.disabledAgentIds);
        if (params.enabled) {
          previous.delete(params.agentId);
        } else {
          previous.add(params.agentId);
        }
        state.disabledAgentIds = [...previous].sort();
        await writeAgentStateFile(state, storageOptions);
      };

      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const builtInModelSelectionOverrides = {
          ...state.builtInModelSelectionOverrides,
        };
        const modelSelection = normalizeSubagentModelSelection(params.modelSelection);
        if (modelSelection) {
          builtInModelSelectionOverrides[params.agentName] = modelSelection;
        } else {
          delete builtInModelSelectionOverrides[params.agentName];
        }
        await writeAgentStateFile(
          {
            ...state,
            builtInModelSelectionOverrides,
          },
          storageOptions,
        );
      };

      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void> {
      if (!params.agentId.startsWith("plugin:") || params.agentId.trim() !== params.agentId)
        throw new Error("Invalid plugin Subagent identity");
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const overrides = { ...state.pluginAgentModelSelectionOverrides };
        const selection = normalizeSubagentModelSelection(params.modelSelection);
        if (selection) overrides[params.agentId] = selection;
        else delete overrides[params.agentId];
        await writeAgentStateFile(
          { ...state, pluginAgentModelSelectionOverrides: overrides },
          storageOptions,
        );
      };
      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async getPrimaryUserAgentsDirectory(_params: { provider: ZCodeProvider }): Promise<{
      path: string;
    }> {
      const path = await resolveUserSubagentRoot(storageOptions);
      await mkdir(path, { recursive: true });
      return { path };
    },

    async createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });
      if (await exists(filePath)) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // First verify that the Markdown to be written can be parsed to avoid dropping bad profiles when the serializer returns.
      await writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
      return { agent };
    },

    async updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });

      if (params.oldFilePath && params.oldFilePath !== filePath && (await exists(filePath))) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // When updating, parse first and then overwrite the old file to avoid failure to save and destroy existing user agents.
      await writeFile(filePath, content, "utf-8");
      // The enabled state is stored by agent id; renaming will generate a new id, and old disabled records must be migrated.
      // Otherwise, after the user-disabled agent is renamed, the runtime will treat it as a newly enabled profile and reload it.
      await migrateDisabledAgentId(params.agentId, agent.id, storageOptions);
      if (params.oldFilePath && params.oldFilePath !== filePath) {
        await rm(params.oldFilePath, { force: true });
      }
      return { agent };
    },

    async deleteAgent(params: AgentDeleteParams): Promise<void> {
      await rm(params.filePath, { force: true });

      const state = await readAgentStateFile(storageOptions);
      const disabledSet = new Set(state.disabledAgentIds);
      disabledSet.delete(params.agentId);
      state.disabledAgentIds = [...disabledSet].sort();
      await writeAgentStateFile(state, storageOptions);
    },
  };
}

function validateUserAgentConfig(config: SubAgentConfig): void {
  const trimmedName = config.name.trim();
  const nameRegex = /^[a-zA-Z0-9-]+$/;
  const minNameLength = 3;
  const maxNameLength = 50;
  if (trimmedName.length < minNameLength || trimmedName.length > maxNameLength) {
    throw new Error(`Name must be between ${minNameLength} and ${maxNameLength} characters`);
  }
  if (!nameRegex.test(trimmedName)) {
    throw new Error("Name can only contain letters, numbers, and hyphens");
  }
  if (config.description.trim().length === 0) {
    throw new Error("Description is required");
  }
  if (config.systemPrompt.trim().length === 0) {
    throw new Error("System prompt is required");
  }
}

function assertNotBuiltInName(name: string): void {
  if (BUILT_IN_AGENT_NAMES.has(name.trim())) {
    throw new Error(`Agent name "${name.trim()}" is reserved by a built-in agent`);
  }
}

async function migrateDisabledAgentId(
  previousAgentId: string,
  nextAgentId: string,
  options?: SubagentStorageOptions,
): Promise<void> {
  if (previousAgentId === nextAgentId) {
    return;
  }
  const state = await readAgentStateFile(options);
  const disabledSet = new Set(state.disabledAgentIds);
  if (!disabledSet.has(previousAgentId)) {
    return;
  }
  disabledSet.delete(previousAgentId);
  disabledSet.add(nextAgentId);
  await writeAgentStateFile(
    {
      ...state,
      disabledAgentIds: [...disabledSet].sort(),
    },
    options,
  );
}

function normalizeConfig(config: SubAgentConfig): SubAgentConfig {
  return {
    ...config,
    name: config.name.trim(),
    description: config.description.trim(),
    systemPrompt: config.systemPrompt.trim(),
    modelSelection: normalizeSubagentModelSelection(config.modelSelection),
  };
}

function requireWorkspacePath(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  if (!value) throw new Error("Workspace path is required for workspace subagents");
  return value;
}

function parseSavedAgent(
  content: string,
  path: string,
  scope: "user" | "workspace",
  workspacePath?: string,
): AgentSummary {
  const parsed = parseSubagentMarkdown({
    content,
    path,
    scope,
  });
  if (parsed.diagnostic || !parsed.agent) {
    throw new Error(parsed.diagnostic?.message ?? `Failed to parse saved agent: ${path}`);
  }
  return {
    ...parsed.agent,
    projectPath: scope === "workspace" ? workspacePath : undefined,
  };
}
