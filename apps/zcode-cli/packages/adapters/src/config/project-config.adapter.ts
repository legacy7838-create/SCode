import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@zcode/contracts";
import { loadFileConfig, type LoadedConfig } from "./file-config.adapter.js";

const CURRENT_DIRECTORY = ".";

export interface ProjectConfigFile {
  baseDir: string;
  config: RuntimeConfigPatch;
  diagnostics: LoadedConfig["diagnostics"];
  loaded: boolean;
  path: string;
}

export interface ProjectConfigDiscovery {
  files: ProjectConfigFile[];
  diagnostics: LoadedConfig["diagnostics"];
  loaded: boolean;
  paths: string[];
  mcpServerNames: string[];
}

export function loadProjectConfigs(
  workingDirectory?: string,
  explicitProjectConfigPath?: string,
): ProjectConfigDiscovery {
  const resolvedWorkingDirectory = resolve(workingDirectory ?? process.cwd());
  const files = discoverProjectConfigPaths({
    workingDirectory: resolvedWorkingDirectory,
    ...(explicitProjectConfigPath ? { explicitProjectConfigPath } : {}),
  }).map((path) => loadProjectConfigFile(path));

  return summarizeProjectConfigs(files);
}

export function loadProjectConfigFile(path: string): ProjectConfigFile {
  const result = loadFileConfig(path);
  const baseDir = getProjectConfigBaseDir(result.path);

  return {
    baseDir,
    config: result.loaded ? normalizeProjectConfig(result.config, baseDir) : {},
    diagnostics: result.diagnostics,
    loaded: result.loaded,
    path: result.path,
  };
}

export function summarizeProjectConfigs(files: ProjectConfigFile[]): ProjectConfigDiscovery {
  const loadedFiles = files.filter((file) => file.loaded);
  const mcpServerNames = new Set<string>();

  for (const file of loadedFiles) {
    for (const name of Object.keys(file.config.mcp?.servers ?? {})) {
      mcpServerNames.add(name);
    }
  }

  return {
    diagnostics: files.flatMap((file) => file.diagnostics),
    files: loadedFiles,
    loaded: loadedFiles.length > 0,
    paths: loadedFiles.map((file) => file.path),
    mcpServerNames: [...mcpServerNames],
  };
}

/**
 * 项目配置路径发现。原实现复用 shared `workspace-hook-discovery`（Hooks 产品化移除后该
 * 模块已删除），语义在此原样保留，避免装载范围漂移：
 * - 从 cwd 向上走，遇到含 `.git`（目录或文件，兼容 worktree/submodule）的目录即视为
 *   仓库顶层，目录列表反转为 root→cwd 顺序（越靠 cwd 优先级越高）。
 * - 每个目录依次探测 `zcode.json` 与 `.zcode/config.json`，只保留存在的路径。
 * - explicit projectConfigPath 追加在末尾；按解析后的绝对路径去重、保留首次出现者，
 *   使同一文件不会因 auto-discovery 与 explicit 双重进入而覆盖优先级或重复合并。
 */
function discoverProjectConfigPaths(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): string[] {
  const candidates = buildProjectConfigCandidatePaths(getProjectConfigDirectories(input.workingDirectory))
    .filter((path) => existsSync(path))
    .map((path) => resolve(path));

  if (input.explicitProjectConfigPath) {
    const explicitPath = resolve(input.explicitProjectConfigPath);
    if (existsSync(explicitPath)) candidates.push(explicitPath);
  }

  return [...new Set(candidates)];
}

function buildProjectConfigCandidatePaths(directories: readonly string[]): string[] {
  return directories.flatMap((directory) => [
    join(directory, "zcode.json"),
    join(directory, ".zcode", "config.json"),
  ]);
}

function getProjectConfigDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (hasWorktreeMarker(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

function hasWorktreeMarker(directory: string): boolean {
  const marker = join(directory, ".git");
  try {
    if (!existsSync(marker)) return false;
    const stats = statSync(marker);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

function getProjectConfigBaseDir(path: string): string {
  const configDirectory = dirname(path);
  return basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory;
}

function normalizeProjectConfig(config: RuntimeConfigPatch, baseDir: string): RuntimeConfigPatch {
  const normalized: RuntimeConfigPatch = { ...config };

  if (!normalized.mcp?.servers) return normalized;

  return {
    ...normalized,
    mcp: {
      ...normalized.mcp,
      servers: Object.fromEntries(
        Object.entries(normalized.mcp.servers).map(([name, server]) => [
          name,
          normalizeProjectMcpServer(server, baseDir),
        ]),
      ),
    },
  };
}

function normalizeProjectMcpServer(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;

  const cwd = server.cwd ?? CURRENT_DIRECTORY;
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}
