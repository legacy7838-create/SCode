import { spawnSync } from "node:child_process";

const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export function resolveSpawnRuntimeOptions(command, platform = process.platform) {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return {
      // On Windows runner, bare `pnpm` / `npm` are actually provided through cmd shims.
      // Previously rewriting the command name to `pnpm.cmd` would cause some `pnpm exec` scenarios to fall back to the wrong package cwd,
      // ultimately resolving the tsup entry to scripts/src/... and reporting "Cannot find src/main/index.ts".
      // Here we keep the original command name and only require shell/cmd.exe to resolve the shim, avoiding changing pnpm's package context again.
      shell: true,
    };
  }

  return {};
}

// With shell:true, Node only joins args into the command line with spaces, no escaping (corresponding to DEP0190 warning).
// On Windows when the repo path contains spaces (e.g. E:\Z Code\...), the pnpm --dir path gets truncated by cmd
// at the space to E:\Z and reports ENOENT: lstat. Here we add double quotes to args containing spaces per cmd.exe rules;
// args without spaces are left as-is, not affecting existing space-free paths and CI behavior.
export function quoteArgsForWindowsShell(args) {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}

export function runCommand(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    stdio: "inherit",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result;
}

export function runCommandAndReadStdout(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    encoding: "utf8",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result.stdout;
}
