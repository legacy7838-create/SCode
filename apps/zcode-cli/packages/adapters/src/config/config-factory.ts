// Config Factory - Load and merge all config sources

import type {
  ConfigPort,
  LoggerFactory,
  McpServerConfig,
  RuntimeConfig,
  RuntimeConfigPatch,
} from "@zcode/contracts";
import { ConfigScope, DefaultRuntimeConfig } from "@zcode/contracts";
import { createConfigPort } from "./index.js";
import { loadFileConfig, getDefaultConfigPath, type LoadedConfig } from "./file-config.adapter.js";
import { parseEnvConfig } from "./env-config.adapter.js";
import { mergeConfigs, createPrioritizedConfig } from "./config-merger.js";
import { createNodeLoggerFactory } from "../logging/index.js";
import {
  loadProjectConfigFile,
  loadProjectConfigs,
  summarizeProjectConfigs,
  type ProjectConfigDiscovery,
  type ProjectConfigFile,
} from "./project-config.adapter.js";

export interface ConfigFactoryOptions {
  /** Path to user config file (default: ~/.zcode/cli/config.json) */
  userConfigPath?: string;
  /** Path to project config file */
  projectConfigPath?: string;
  /** Working directory used to discover project config files */
  workingDirectory?: string;
  /** Environment variables (default: process.env) */
  env?: Record<string, string | undefined>;
  /** CLI overrides (highest priority) */
  cliOverrides?: RuntimeConfigPatch;
  /** Skip loading user config file */
  skipUserConfig?: boolean;
  /** Optional logger factory for tests or embedding runtimes. Defaults to the node JSONL logger. */
  loggerFactory?: LoggerFactory;
}

export interface ConfigResult {
  configPort: ConfigPort;
  config: RuntimeConfig;
  sources: {
    user: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string;
      loaded: boolean;
      hasMcpServers: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      mcpServerNames: string[];
    };
    project: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string | undefined;
      paths: string[];
      loaded: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      hasMcpServers: boolean;
      mcpServerNames: string[];
      uiLocalePath: string | undefined;
      uiThemePath: string | undefined;
    };
    plugins: PluginConfigSources;
    mcp: {
      serverSources: Record<string, McpServerConfigSource>;
    };
    env: boolean;
    cli: boolean;
  };
}

type OptionalPathLoadedConfig = Omit<LoadedConfig, "path"> & {
  path: string | undefined;
};

export type McpServerConfigSource = "system" | "project" | "user" | "env" | "cli";
export type PluginConfigScope = "user" | "workspace";

export interface PluginConfigSources {
  dirs: {
    user: string[];
    workspace: string[];
  };
  enabled: Record<string, PluginConfigScope>;
  marketplaces: Record<string, PluginConfigScope>;
  options: Record<string, Record<string, PluginConfigScope>>;
  paths: {
    user: string;
    workspace: string | undefined;
  };
}

/**
 * Create ConfigPort with all sources merged
 *
 * Priority (lowest to highest):
 * 1. System defaults
 * 2. User config file (~/.zcode/cli/config.json)
 * 3. Project config files (root to cwd, then explicit projectConfigPath)
 * 4. Environment variables (ZCODE_*)
 * 5. CLI overrides
 */
export function createConfig(options: ConfigFactoryOptions = {}): ConfigResult {
  // 1. System defaults
  const configs: ReturnType<typeof createPrioritizedConfig>[] = [
    createPrioritizedConfig(DefaultRuntimeConfig, ConfigScope.System),
  ];

  // 2. User config file
  const userConfigResult: LoadedConfig = options.skipUserConfig
    ? { config: {}, diagnostics: [], path: getDefaultConfigPath(), loaded: false }
    : loadFileConfig(options.userConfigPath);

  if (userConfigResult.loaded) {
    configs.push(createPrioritizedConfig(userConfigResult.config, ConfigScope.User));
  }

  // 3. Project config files
  const discoveredProjectConfigs: ProjectConfigDiscovery = options.workingDirectory
    ? loadProjectConfigs(options.workingDirectory, options.projectConfigPath)
    : options.projectConfigPath
      ? summarizeProjectConfigs([loadProjectConfigFile(options.projectConfigPath)])
      : summarizeProjectConfigs([]);
  // explicit 配置曾在 auto-discovery 之后手工追加并自行编号，绕过 canonical-path
  // dedup；同一文件会以两个来源进入合并结果。现在有 workspace 时统一由
  // loadProjectConfigs 走本地 discoverProjectConfigPaths，去重与 root→cwd 顺序同源。
  const projectConfigFiles = discoveredProjectConfigs.files;
  const projectSummary = discoveredProjectConfigs;
  const projectDiagnostics = discoveredProjectConfigs.diagnostics;
  // 配置 diagnostics 过去只返回给调用方，用户导出日志时看不到加载失败或被跳过的 MCP server。
  // 在汇总入口统一写 warn，保留具体文件路径和 JSON path，方便定位迁移配置问题。
  logConfigDiagnostics({
    env: options.env,
    loggerFactory: options.loggerFactory,
    projectDiagnostics,
    userDiagnostics: userConfigResult.diagnostics,
  });
  const projectConfigResult: OptionalPathLoadedConfig =
    summarizeOptionalProjectConfig(projectConfigFiles);
  const projectUiLocalePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.locale !== undefined)?.path;
  const projectUiThemePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.theme !== undefined)?.path;

  for (const projectConfig of projectConfigFiles) {
    configs.push(createPrioritizedConfig(projectConfig.config, ConfigScope.Project));
  }

  // 4. Environment variables
  const envConfig = parseEnvConfig(options.env ?? process.env);
  if (Object.keys(envConfig).length > 0) {
    configs.push(createPrioritizedConfig(envConfig, ConfigScope.Env));
  }

  // 5. CLI overrides (applied last = highest priority)
  if (options.cliOverrides) {
    configs.push(createPrioritizedConfig(options.cliOverrides, ConfigScope.Cli));
  }

  const merged = mergeConfigs(...configs);
  const pluginConfigSources = resolvePluginConfigSources({
    projectConfig: projectConfigResult.config,
    projectPath: projectConfigResult.path,
    userConfig: userConfigResult.config,
    userPath: userConfigResult.path,
  });
  const mcpServerResolution = resolveEffectiveMcpServers({
    cliOverrides: options.cliOverrides,
    envConfig,
    projectConfig: projectConfigResult.config,
    userConfig: userConfigResult.config,
  });
  merged.mcp = {
    ...merged.mcp,
    servers: mcpServerResolution.servers,
  };

  // Create ConfigPort with merged config
  const configPort = createConfigPort(merged);

  return {
    configPort,
    config: configPort.getAll(),
    sources: {
      user: {
        diagnostics: userConfigResult.diagnostics,
        path: userConfigResult.path,
        loaded: userConfigResult.loaded,
        hasMcpServers: userConfigResult.config.mcp?.servers !== undefined,
        hasUiLocale: userConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: userConfigResult.config.ui?.theme !== undefined,
        mcpServerNames: Object.keys(userConfigResult.config.mcp?.servers ?? {}),
      },
      project: {
        diagnostics: projectDiagnostics,
        path: projectConfigResult.path,
        paths: projectSummary.paths,
        loaded: projectConfigResult.loaded,
        hasUiLocale: projectConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: projectConfigResult.config.ui?.theme !== undefined,
        hasMcpServers: projectConfigResult.config.mcp?.servers !== undefined,
        mcpServerNames: projectSummary.mcpServerNames,
        uiLocalePath: projectUiLocalePath,
        uiThemePath: projectUiThemePath,
      },
      plugins: pluginConfigSources,
      mcp: {
        serverSources: mcpServerResolution.sources,
      },
      env: Object.keys(envConfig).length > 0,
      cli: !!options.cliOverrides,
    },
  };
}

function resolvePluginConfigSources(input: {
  projectConfig: RuntimeConfigPatch;
  projectPath: string | undefined;
  userConfig: RuntimeConfigPatch;
  userPath: string;
}): PluginConfigSources {
  const enabled: Record<string, PluginConfigScope> = {};
  const marketplaces: Record<string, PluginConfigScope> = {};
  const options: Record<string, Record<string, PluginConfigScope>> = {};

  for (const pluginId of Object.keys(input.userConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "user";
  }
  for (const pluginId of Object.keys(input.projectConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "workspace";
  }

  for (const marketplaceId of Object.keys(input.userConfig.plugins?.extraKnownMarketplaces ?? {})) {
    marketplaces[marketplaceId] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(input.userConfig.plugins?.options ?? {})) {
    options[pluginId] = {};
    for (const key of Object.keys(pluginOptions)) options[pluginId][key] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(
    input.projectConfig.plugins?.options ?? {},
  )) {
    const sourceByKey = (options[pluginId] ??= {});
    for (const key of Object.keys(pluginOptions)) sourceByKey[key] = "workspace";
  }

  return {
    dirs: {
      user: input.userConfig.plugins?.dirs ?? [],
      workspace: input.projectConfig.plugins?.dirs ?? [],
    },
    enabled,
    marketplaces,
    options,
    paths: {
      user: input.userPath,
      workspace: input.projectPath,
    },
  };
}

export function resolveWorkspaceStorageDir(input: {
  env?: Record<string, string | undefined>;
  workingDirectory: string;
}): string {
  const baseStorageDir = createConfig({ env: input.env }).config.storage.dir;
  const projectConfig = loadProjectConfigs(input.workingDirectory);
  let projectStorageDir: string | undefined;
  for (const file of projectConfig.files) {
    projectStorageDir = file.config.storage?.dir ?? projectStorageDir;
  }
  const envStorageDir = parseEnvConfig(input.env ?? process.env).storage?.dir;
  return envStorageDir ?? projectStorageDir ?? baseStorageDir;
}

function resolveEffectiveMcpServers(input: {
  cliOverrides?: RuntimeConfigPatch;
  envConfig: RuntimeConfigPatch;
  projectConfig: RuntimeConfigPatch;
  userConfig: RuntimeConfigPatch;
}): {
  servers: Record<string, McpServerConfig>;
  sources: Record<string, McpServerConfigSource>;
} {
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, McpServerConfigSource> = {};
  const apply = (source: McpServerConfigSource, patch: RuntimeConfigPatch | undefined) => {
    for (const [name, server] of Object.entries(patch?.mcp?.servers ?? {})) {
      servers[name] = server;
      sources[name] = source;
    }
  };

  apply("system", DefaultRuntimeConfig);
  // MCP server discovery has an extension-specific rule: user config shadows project config.
  // This does not change the global config precedence for model/permission/UI fields.
  apply("project", input.projectConfig);
  apply("user", input.userConfig);
  apply("env", input.envConfig);
  apply("cli", input.cliOverrides);
  return { servers, sources };
}

function logConfigDiagnostics(input: {
  env?: Record<string, string | undefined>;
  loggerFactory?: LoggerFactory;
  projectDiagnostics: LoadedConfig["diagnostics"];
  userDiagnostics: LoadedConfig["diagnostics"];
}): void {
  const diagnostics = [
    ...input.userDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "user" })),
    ...input.projectDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "project" })),
  ];
  if (diagnostics.length === 0) return;

  const loggerFactory = input.loggerFactory ?? createNodeLoggerFactory({ env: input.env });
  const logger = loggerFactory.createLogger("zcode").child({
    module: "adapters.config",
  });

  for (const diagnostic of diagnostics) {
    logger.warn(resolveConfigDiagnosticLogMessage(diagnostic.code), {
      configPath: diagnostic.filePath,
      configScope: diagnostic.configScope,
      diagnosticCode: diagnostic.code,
      diagnosticMessage: diagnostic.message,
      diagnosticPath: diagnostic.path,
      event: resolveConfigDiagnosticLogEvent(diagnostic.code),
      severity: diagnostic.severity,
    });
  }
}

function resolveConfigDiagnosticLogMessage(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "MCP server config skipped";
  return "Config file failed to load";
}

function resolveConfigDiagnosticLogEvent(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "config.mcp_server.skipped";
  return "config.file.invalid";
}

function summarizeOptionalProjectConfig(files: ProjectConfigFile[]): OptionalPathLoadedConfig {
  if (files.length === 0) {
    return { config: {}, diagnostics: [], path: undefined, loaded: false };
  }

  const path = files[files.length - 1]?.path;
  const config = mergeConfigs(
    ...files.map((file) => createPrioritizedConfig(file.config, ConfigScope.Project)),
  );

  return {
    config,
    diagnostics: files.flatMap((file) => file.diagnostics),
    path,
    loaded: true,
  };
}
