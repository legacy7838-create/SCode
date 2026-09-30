#!/usr/bin/env node

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const gitCommand = "git";
const withRemoteAssets = process.argv.includes("--with-remote");

function prependPathEntries(pathValue, entries) {
  const currentEntries = pathValue ? pathValue.split(delimiter) : [];
  return [...entries, ...currentEntries].join(delimiter);
}

function resolvePinnedNodeBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const miseConfigPath = resolve(rootDir, "mise.toml");
  if (!existsSync(miseConfigPath)) {
    return undefined;
  }

  const miseConfig = readFileSync(miseConfigPath, "utf8");
  const match = miseConfig.match(/^\s*node\s*=\s*"([^"]+)"/m);
  const version = match?.[1]?.trim();
  if (!version) {
    return undefined;
  }

  const nvmNodeBin = join(homedir(), ".nvm", "versions", "node", `v${version}`, "bin");
  return existsSync(nvmNodeBin) ? nvmNodeBin : undefined;
}

function resolveUserPnpmBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const pnpmBin = join(homedir(), "Library", "pnpm");
  return existsSync(join(pnpmBin, "pnpm")) ? pnpmBin : undefined;
}

function resolvePnpmCommand() {
  if (!withRemoteAssets) {
    return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  }

  const userPnpmBin = resolveUserPnpmBin();
  if (userPnpmBin) {
    return join(userPnpmBin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  }

  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveBootstrapWithRemoteEnv(baseEnv = process.env) {
  if (!withRemoteAssets) {
    return {};
  }

  const pathEntries = [resolvePinnedNodeBin(), resolveUserPnpmBin()].filter(Boolean);

  return {
    // bootstrap:with-remote is the entry point for manual remote resource initialization, in non-TTY environments such as automation
    // pnpm install may ask for confirmation to clean node_modules. Only disables confirmation on this entry, does not change CI/production build commands.
    HUSKY: "0",
    PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
    npm_config_confirm_modules_purge: "false",
    // Remote assets and bootstrap build will trigger a large number of workspace builds in the same round.
    // Here, the peak reduction is limited to the bootstrap:with-remote child process, and the global semantics of build/build:bootstrap are not modified.
    PNPM_CONFIG_WORKSPACE_CONCURRENCY: "1",
    ZCODE_BOOTSTRAP_WITH_REMOTE: "1",
    ...(pathEntries.length > 0
      ? {
          PATH: prependPathEntries(baseEnv.PATH, pathEntries),
        }
      : {}),
  };
}

const bootstrapWithRemoteEnv = resolveBootstrapWithRemoteEnv();
const pnpmCommand = resolvePnpmCommand();

function runGit(args) {
  runCommand(gitCommand, args, {
    cwd: rootDir,
    env: process.env,
  });
}

function runPnpm(args, options = {}) {
  runCommand(pnpmCommand, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
      ...options.env,
    },
  });
}

function runBootstrapServerBuild() {
  const serverDir = resolve(rootDir, "packages/server");

  // The final build of bootstrap:with-remote used to reuse build:bootstrap, resulting in @zcode/server build
  // Inside, pnpm run build:remote is nested again; in a local low-memory environment, the tsx/esbuild child process is easily stuck or stopped.
  // At the same time, you cannot skip the build just because the dist file exists: the version often remains unchanged during development, and the old entry-http or remote bundle
  // Will let the local/remote continue to run the old protocol. Only low-memory optimizations that directly execute equivalent entries remain here, CI and production build scripts remain intact.
  runCommand(process.execPath, [resolve(rootDir, "node_modules/tsup/dist/cli-default.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
}

function runBootstrapDesktopBuild() {
  const desktopDir = resolve(rootDir, "packages/desktop");
  // The goal of bootstrap:with-remote is to complete remote resource and local runtime initialization.
  // Continuing to trigger the desktop app bundle will enter the tsup/vite path in the production build script and be SIGKILL in the local low-memory environment.
  // Here only the build meta is retained in the bootstrap runner, and the production/CI build:no-runtime-assets still maintains the original semantics.
  runCommand(process.execPath, ["scripts/build-metadata.mjs"], {
    cwd: desktopDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  console.log("[bootstrap:with-remote] skip desktop app bundle build; runtime assets are prepared");
}

function runBootstrapWithRemoteBuild() {
  for (const filter of ["@zcode/rpc", "@zcode/web", "@zcode/formal-proof"]) {
    // pnpm -r will launch multiple Vite/esbuild/tsups concurrently during the final build phase of bootstrap:with-remote.
    // Remote assets have already accounted for a round of memory peaks. Here, the serial package is built explicitly without changing the build:bootstrap/CI command.
    runPnpm(["--filter", filter, "build"]);
  }
  runBootstrapServerBuild();
  runBootstrapDesktopBuild();
}

runGit(["submodule", "update", "--init", "--recursive", "apps/zcode-cli"]);

runPnpm(withRemoteAssets ? ["install", "--config.confirmModulesPurge=false"] : ["install"]);

runPnpm(["prepare:desktop-runtime"], {
  env: withRemoteAssets
    ? {}
    : {
        // Local bootstrap used to prepare remote mock-cdn by default.
        // Cross-platform components are repackaged every time, causing normal initialization to be slow.
        // By default, only the local runtime on the desktop is prepared; use bootstrap:with-remote when remote resources are needed.
        ZCODE_SKIP_REMOTE_ASSETS: "1",
      },
});

if (withRemoteAssets) {
  runBootstrapWithRemoteBuild();
} else {
  runPnpm(["run", "build:bootstrap"]);
}
