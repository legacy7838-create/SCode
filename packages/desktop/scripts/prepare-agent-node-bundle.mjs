#!/usr/bin/env node

// Desktop packaged agent runtime assets: put the agent's JS bundle (zcode.cjs) into bundled-agents/<platform>/glm,
// Executed by the Electron Node runtime (ELECTRON_RUN_AS_NODE) built into the app, replacing the independent Node binary previously built into the package.
//
// Why do this:
// - Electron 41 has built-in Node 24.x, which is consistent with the target runtime of zcode-cli;
// - The size of a single platform is reduced from ~180MB to ~16MB, and the same JS is universal across platforms;
// - The app-server command path will not load @zcode/tui, so TUI is naturally not packaged here.
//
// Native addons: the agent DOES load napi binaries through @zcode/rust's loadNative() — zcode-git,
// zcode-events, zcode-markdown, zcode-image, zcode-codec, zcode-diff and zcode-event-coalescer as of
// docs/specs/rust-native-packaging.md §1.4. They are NOT bundled here (esbuild never inlines a .node);
// prepare:rust-native stages them into bundled-agents/<platform>/native, a SIBLING of glm/ rather than a
// child, because zcode.cjs is the file inside glm/ and the loader probes join(dirname(bundle), "..", "native").
// The set is decided by zcode-packaging, which fails the build rather than shipping a partial payload.
//
// The remote end (SSH/WSL) does not have Electron and still uses the native binary of prepare:remote-assets, which does not affect each other.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { access, cp, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const adaptersRoot = resolve(repoRoot, "apps/zcode-cli/packages/adapters");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 will trigger install before the apps/zcode-cli sub-workspace executes run;
  // The child workspace cannot resolve the @zcode/shared of the root workspace, and therefore the web app packaging will be stuck in the plug-in runtime build.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";

// Platform directory naming: darwin/win32/linux + x64/arm64,
// Supports ZCODE_TARGET_OS / ZCODE_TARGET_ARCH overrides (injected by CI when cross-packing).
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// The placement point of zcode.cjs / .node-bundle-meta.json is parsed by stage-agent-bundle.mjs itself (same source).
// node_repl host draws independent packages
// After @zcode/node-repl-host, browser-use no longer produces dist/mcp/server.js, CUA assets
// (docs/computer-use.md, scripts/computer-use-client.mjs) Also owned by @zcode/zcode-cua-plugin.
// This list was not modified at that time. During the packaging preparation stage, I still went to browser-use to get those three files, and directly failed with missing runtime.
// The dev link uses the requiredDevPluginRuntimeBuilds of scripts/build-desktop-agent-cli.mjs (that copy is correct).
// The two parallel manifests are maintained independently, so dev cannot detect them - see bootstrap/official-plugin-definitions.ts for authoritative attribution.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json has exposed recording lookup, and the desktop installation package cannot reuse the runtime that lacks the body.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const officialPluginPackages = [
  {
    // browser-use only carries its own client script and skill/docs; node_repl MCP runtime returns
    // @zcode/node-repl-host (see constant comments above).
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },

  {
    // node_repl host: MCP runtime shared by Browser Use and Computer Use. This round draws an independent package.
    // It does not have a listing (it does not enter the plug-in market display), but the first seed of the production package must obtain its dist runtime.
    // Otherwise, bua/cua will not be able to connect to node_repl when opened.
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
];
// The skill package built into the CLI (not a plug-in): bootstrap's resolveBundledSkillRoots is in the same candidate directory as the official plug-in.
// Find packages/bundled-skills next to zcode.cjs and read it in place. If you omit the stage, the /workflow of the desktop package will expand into
// "Load the dynamic-workflows skill first" and the skill file does not exist, so it must be packaged with the Agent.
const bundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["skills"],
};
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron production resource replication has an independent whitelist. Missing agents will permanently lack sub-agents when first starting the filesystem seed.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // Reuse the warehouse root script (turbo build:desktop-agent --filter=@zcode/cli), and the cache hit is almost instantaneous.
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime(plugin);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote will build remote assets and desktop agent bundles continuously.
  // When entering the plug-in build through pnpm/filter, the tsc shim is easily SIGKILLed in the local low-memory environment;
  // Here, the equivalent of tsc + build-mcp is directly executed using the current Node under the bootstrap switch without changing the plug-in's own build script.
  // browser-use's server and browser-client are in the same release pair; the old server.js must be rebuilt even if it exists,
  // Otherwise, the old server will be staged into the desktop installation package together with the current client (or missing client).
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageBundle() {
  // The implementation has been extracted to stage-agent-bundle.mjs: dev chain (scripts/build-desktop-agent-cli.mjs)
  // The same copy must be used, otherwise dev will continue to run the stale agent left by the previous packaging.
  stageAgentBundle({ repoRoot, platformKey });
}

function stageOfficialPlugins() {
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

async function stageBundledSkillPack() {
  const sourceRoot = resolve(repoRoot, bundledSkillPack.relativePath);
  const targetRoot = resolve(glmDir, bundledSkillPack.stagedPath);
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of bundledSkillPack.topLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    await cp(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of bundledSkillPack.requiredPaths) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    await access(stagedAssetPath);
  }
  console.log(`[prepare:agent-bundle] staged bundled skill pack ${bundledSkillPack.stagedPath}`);
}

// When the Electron production package only contains resources/glm/zcode.cjs, the app-server process
// There is no official plug-in directory near __dirname, seed cannot find the source at startup, and the user side will not automatically get the built-in plug-in.
// Here, the official plug-in is placed in glm/packages/*-plugin according to bootstrap's rootCandidates expectation.
// Let Electron Node reuse the same set of filesystem seed logic when running zcode.cjs.
// The declaration of browser-use runtime generates dependency @zcode/core/dist. CI clean detection does not contain this product,
// The CLI dependencies must be built first, and then the official plug-in; the remaining dist on the development machine used to mask this order issue.
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
stageOfficialPlugins();
await stageBundledSkillPack();
