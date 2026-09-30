import { join } from "node:path";

export const DEFAULT_GIT_DISCOVERY_TIMEOUT_MS = 3_000;
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 15_000;
// `git push` may be blocked by the repository's pre-push hook for a long time (such as executing `pnpm test`).
// Continuing to use the 15s timeout of ordinary Git commands will misjudge explicit push as failure, so the push timeout is relaxed separately.
export const DEFAULT_GIT_PUSH_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_GIT_DIFF_TIMEOUT_MS = 20_000;
export const DEFAULT_GIT_OUTPUT_BYTES = 512 * 1024;
// The pre-push hook may output the complete test log; continue to use the 512KB upper limit of ordinary Git commands.
// It will be truncated and terminated before the actual push is completed because there are too many logs. Here only the output quota is relaxed for push alone.
export const DEFAULT_GIT_PUSH_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_GIT_DIFF_BYTES = 1024 * 1024;

const WINDOWS_GIT_BINARY_CANDIDATES = [
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "cmd",
    "git.exe",
  ),
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "bin",
    "git.exe",
  ),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "cmd", "git.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "git.exe"),
];
const GIT_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

export function getGitBinaryCandidates(): string[] {
  const candidates = [process.env.ZCODE_GIT_BINARY?.trim(), "git"];
  if (process.platform === "win32") {
    candidates.push(...WINDOWS_GIT_BINARY_CANDIDATES);
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

export function getGitCommandEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
  };

  // The pre-push hook will inject local env such as GIT_DIR/GIT_WORK_TREE of the current warehouse into the child process.
  // If the Git service command is passed through as it is, the Git service command will be "transmitted" to the warehouse where the hook is located, and the temporary warehouse/remote warehouse operations will be contaminated.
  // Uniformly clear the local env first, and then superimpose the ZCode constraint variable to ensure that the command only relies on explicit cwd.
  for (const variableName of GIT_LOCAL_ENV_VARS) {
    delete env[variableName];
  }

  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    TERM: "dumb",
    LC_ALL: "C",
    LANG: "C",
  };
}

export function getGitNullDevicePath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizeWorkspaceInRepoPath(path: string): string {
  const normalized = normalizeGitPath(path)
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : ".";
}

export function isPathInWorkspaceScope(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): boolean {
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === ".") {
    return true;
  }

  return (
    normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`)
  );
}

export function toWorkspaceRelativeGitPath(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): string {
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === ".") {
    return normalizedPath;
  }

  if (normalizedPath === normalizedWorkspace) {
    return ".";
  }

  return normalizedPath.startsWith(`${normalizedWorkspace}/`)
    ? normalizedPath.slice(normalizedWorkspace.length + 1)
    : normalizedPath;
}
