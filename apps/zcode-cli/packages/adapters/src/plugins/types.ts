import type {
  CustomCommandRoot,
  McpServerConfig,
  PluginManifest,
  PluginSource,
  SkillRoot,
} from "@zcode/contracts";

export interface PluginCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface PluginComponents {
  commandRoots: CustomCommandRoot[];
  mcpServers: Record<string, McpServerConfig>;
  skillCount: number;
  skillRoots: SkillRoot[];
}

export interface PluginAbortOptions {
  signal?: AbortSignal;
}
