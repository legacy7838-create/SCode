#!/usr/bin/env node
/* eslint-disable max-lines */

import { access, cp, mkdir } from "node:fs/promises";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveRemoteNativeSearchPrebuiltPlan } from "./remote-native-search-tools-config.mjs";
import { prepareNativeSearchTools } from "./prepare-native-search-tools.mjs";
import { stageNodeNotices, stageThirdPartyNotices } from "./third-party-notices.mjs";
import {
  computeDeterministicSourceSha256 as computeComponentSourceSha256,
  packSourceAsDeterministicTarGzip as packComponentSourceAsArchive,
} from "./deterministic-tar-archive.mjs";
import { runCommand } from "./spawn-command.mjs";
import { resolveIntranetDepsBaseUrl } from "./intranetDefaults.mjs";

export { computeComponentSourceSha256, packComponentSourceAsArchive };

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
// Lives at the repository root now: `packages/desktop` no longer exists, and the generic
// `mock-cdn/` entry in .gitignore covers the directory wherever it sits.
const mockCdnDir = join(rootDir, "mock-cdn");
const version = require(join(rootDir, "package.json")).version;
const ZCODE_AGENT_RUNTIME = {
  glm: {
    version: readZCodeAgentRuntimeVersion(),
  },
};
const releaseDir = join(mockCdnDir, "releases", version);
const nodeVersion = "v22.16.0";
const componentSchemaVersion = 1;
const remotePlatforms = ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"];
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

/**
 * Node dist download source. The default is to use domestic mirroring, `ZCODE_NODE_DIST_MIRROR` can be overridden (with
 * CI variables of the same name in `.gitlab/ci/00-workflow.yml`, the same convention in `scripts/cua-helper-sea-base.mjs`).
 *
 * Originally hardcoded here `https://nodejs.org/dist`, and macOS
 * runner couldn't connect to it - 3 attempts all `UND_ERR_CONNECT_TIMEOUT` (10s). Even worse is the error copy of this document
 * People have been asked to "check the Node.js mirror address", but there was no such knob at the time.
 *
 * Why was it not exposed before: `mock-cdn` relied on the GIT_CLEAN_FLAGS exclusion to persist across jobs, while
 * `build:remote:assets` will use `rm -rf` every time to remove all release directories except its own $VERSION.
 * Different version directories therefore expel each other's persistent products, and whoever is expelled must return to the source to download.
 * Usually it is `[skip] already exists`, so this network path has not been really traveled for a long time.
 */
export const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";

export function nodeDistBase(env = process.env) {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";
// After the node_repl host is extracted into an independent package @zcode/node-repl-host, browser-use
// dist/mcp/server.js is no longer produced, and CUA assets have been returned to @zcode/zcode-cua-plugin. This is the **third** parallel list
// (The other two copies: the production packaging of packages/desktop/scripts/prepare-agent-node-bundle.mjs,
// dev build of scripts/build-desktop-agent-cli.mjs), only the dev part was changed at that time, so I successively
// Hangs twice with "missing runtime" on build:macos:arm64 and build:remote:assets.
// See bootstrap/official-plugin-definitions.ts for authoritative attributions.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // The remote prebuild must use the same screen recording document integrity contract as the desktop seed.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const remoteOfficialPluginPackages = [
  // 44b25ed46c "remove bundled plugins except browser use and cua" deleted the rest
  // The plug-in source code is built-in, but the list is missing. Bootstrap:with-remote is thrown in the first manifest of staging.
  // missing. Desktop seed here with packages/desktop/scripts/prepare-agent-node-bundle.mjs
  // The remote contract in the manifest and packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts remains consistent.
  {
    // The remote shared-host must deploy node_repl runtime, otherwise there will only be skill but no mcp__node_repl__js——
    // This runtime is now provided by @zcode/node-repl-host (see next entry), browser-use only takes its own
    // client scripts and skills/docs.
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },
  {
    // node_repl host: MCP runtime shared by Browser Use and Computer Use. The remote shared-host lacks it
    // Without mcp__node_repl__js, both bua/cua would be unable to connect.
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
];
// The skill package built into the CLI (not a plug-in): the bootstrap of the remote agent is in the same candidate directory as the official plug-in next to zcode.cjs
// Find packages/bundled-skills and read it in place; the same manifest as packages/desktop/scripts/prepare-agent-node-bundle.mjs.
const remoteBundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["skills"],
};
const remoteOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // The production remote is pre-built with an independent top-level whitelist. Missing agents will permanently cut off the sub-agents before uploading.
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
const remoteOfficialPluginRequiredPaths = [
  "packages/browser-use-plugin/.zcode-plugin/plugin.json",
  "packages/node-repl-host/.zcode-plugin/plugin.json",
];

function readZCodeAgentRuntimeVersion() {
  const runtimeSourcePath = join(rootDir, "packages/shared/src/zcode-agent-runtime.ts");
  const runtimeSource = readFileSync(runtimeSourcePath, "utf8");
  const match = runtimeSource.match(/version:\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new Error("Unable to parse ZCode Agent runtime version");
  }
  return match[1];
}

async function download(url, destinationPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  }
  if (!response.body) {
    throw new Error(`Download failed: empty response body (${url})`);
  }

  // The original implementation uses response.pipe(file) + finish to monitor. When the network is interrupted, it may neither resolve nor reject.
  // Finally triggering Node 24's unsettled top-level await. Change to pipeline to ensure that the exception path is observable and can fail to exit.
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destinationPath, { flags: "w" }),
  );
}

async function downloadWithRetry(url, destinationPath, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await download(url, destinationPath);
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.warn(`  [warn] download attempt ${attempt}/${maxAttempts} failed: ${url}`);
      console.warn(`  [warn] retry reason: ${String(error)}`);
    }
  }
}

async function extractArchiveMember(url, destinationDir, archiveMember) {
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-node-dist-"));
  const archivePath = join(tempDir, "node.tar.xz");

  try {
    await downloadWithRetry(url, archivePath);
    // Bugfix: Under Windows, if the absolute path contains a drive letter colon (C:\...), GNU tar (Git Bash) will treat "C:" as
    // The remote host reported "Cannot connect to C". Use cwd + relative archive name instead, avoiding the colon in the -f parameter.
    // Backslash paths will also be destroyed by MSYS tar parameter conversion (\3 is treated as escaped), -C targets will uniformly convert forward slashes,
    // No impact on bsdtar and Linux/macOS CI.
    runCommand(
      "tar",
      [
        "-xJf",
        "node.tar.xz",
        "--strip-components=2",
        "-C",
        destinationDir.replaceAll("\\", "/"),
        archiveMember,
      ],
      {
        cwd: tempDir,
      },
    );
  } finally {
    // Bugfix: The archive that has just been written under Windows may temporarily hold the handle to the antivirus/indexer or the xz subprocess that has not yet exited.
    // Immediate deletion of rmSync will cause EPERM, and the exception thrown in finally will cover up the real download/decompression error.
    // Delete with retry, only alert when failure occurs, and let the original error be thrown normally.
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`  [warn] Failed to clean up temporary directory (ignorable): ${tempDir}`);
      console.warn(`  [warn] ${String(error)}`);
    }
  }
}

function resolveDedicatedPackageRoot(packageName, fromDir) {
  const packageEntryPath = require.resolve(packageName, { paths: [fromDir] });
  let currentDir = dirname(packageEntryPath);

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = require(packageJsonPath);
      if (packageJson?.name === packageName) {
        return currentDir;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error(
    `Unable to resolve package root for ${packageName} from entry ${packageEntryPath}`,
  );
}

function resolveNodePtyPackageName(platformKey) {
  return `@lydell/node-pty-${platformKey}`;
}

function resolveNodePtyPackageVersion(platformKey) {
  const packageName = resolveNodePtyPackageName(platformKey);
  const packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
  const packageJson = require(join(packageRoot, "package.json"));
  if (typeof packageJson?.version !== "string" || !packageJson.version.trim()) {
    throw new Error(`Unable to resolve version for ${packageName}`);
  }
  return packageJson.version.trim();
}

async function prepareNodeBinaries() {
  for (const platformKey of remotePlatforms) {
    const nodeDir = join(releaseDir, "node", platformKey);
    const nodeBinaryPath = join(nodeDir, "node");
    await stageNodeNotices(nodeDir, nodeVersion, rootDir);

    if (existsSync(nodeBinaryPath)) {
      console.log(`  [skip] mock-cdn node/${platformKey} already exists`);
      continue;
    }

    mkdirSync(nodeDir, { recursive: true });
    const archiveName = `node-${nodeVersion}-${platformKey}.tar.xz`;
    const url = `${nodeDistBase()}/${nodeVersion}/${archiveName}`;

    console.log(`  [download] ${url}`);

    try {
      await extractArchiveMember(url, nodeDir, `node-${nodeVersion}-${platformKey}/bin/node`);
      chmodSync(nodeBinaryPath, 0o755);
      console.log(`  [ok] mock-cdn node/${platformKey}`);
    } catch (error) {
      console.error(`  [error] Download or decompression failed: ${url}`);
      console.error(
        `  [error] Please check CI runner's external network access, tar/xz dependency, or use ZCODE_NODE_DIST_MIRROR to overwrite the download source (currently ${nodeDistBase()})`,
      );
      throw error;
    }
  }
}

function buildServerBundle() {
  console.log("==> Building server bundle");

  try {
    if (isBootstrapWithRemote) {
      runBootstrapServerRemoteBuild();
      return;
    }

    // Direct spawnSync("pnpm.cmd") in Windows CI (Node 24) will throw EINVAL before starting the child process.
    // Here, cross-platform startup encapsulation is unified and .cmd is executed through shell/cmd.exe to avoid early interruption in the remote resource preparation phase.
    runCommand(pnpmCommand, ["run", "build:remote"], {
      cwd: join(rootDir, "packages/server"),
    });
  } catch (error) {
    console.error(
      "  [error] packages/server build:remote failed, please check the TypeScript / esbuild output in the CI log first",
    );
    throw error;
  }
}

function runBootstrapServerRemoteBuild() {
  // bootstrap:with-remote will install, remote assets, and workspace build locally in series.
  // The existing zcode-server.cjs cannot be reused here: the package version often remains unchanged during development, and the old bundle will replace the missing new RPC
  // The server is deployed to the SSH remote end. Only the low memory optimization of "start tsx directly with the current Node" is retained, and CI's build:remote is not changed.
  runCommand(
    process.execPath,
    [join(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: join(rootDir, "packages/server"),
      env: process.env,
    },
  );
}

function copyServerBundle() {
  const serverDir = join(releaseDir, "server");
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(
    join(rootDir, "packages/server/dist/remote/zcode-server.cjs"),
    join(serverDir, "zcode-server.cjs"),
  );
  console.log("  [ok] mock-cdn server/zcode-server.cjs");
}

function copyNodePtyPrebuilds() {
  console.log("==> Copying node-pty prebuilds from @lydell/node-pty");

  for (const platformKey of remotePlatforms) {
    const ptyDir = join(releaseDir, "node-pty", platformKey);
    const targetBinaryPath = join(ptyDir, "pty.node");
    const targetSpawnHelperPath = join(ptyDir, "spawn-helper");
    const requiresSpawnHelper = platformKey.startsWith("darwin-");

    if (
      existsSync(targetBinaryPath) &&
      (!requiresSpawnHelper || existsSync(targetSpawnHelperPath))
    ) {
      console.log(`  [skip] mock-cdn node-pty/${platformKey} already exists`);
      continue;
    }

    mkdirSync(ptyDir, { recursive: true });

    const packageName = resolveNodePtyPackageName(platformKey);
    let packageRoot;
    try {
      packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
    } catch {
      console.log(`  [warn] ${packageName} not found, run: pnpm install`);
      continue;
    }

    const sourcePrebuildDir = join(packageRoot, "prebuilds", platformKey);
    const sourceBinaryPath = join(sourcePrebuildDir, "pty.node");
    if (!existsSync(sourceBinaryPath)) {
      console.log(`  [warn] binary not found at ${sourceBinaryPath}`);
      continue;
    }

    // Darwin platform node-pty also relies on spawn-helper in addition to pty.node.
    // Previously, mock-cdn only copied pty.node. After remote deployment, posix_spawn ENOENT will be reported in the terminal.create stage.
    // Here, spawn-helper is copied into the remote asset directory to avoid missing key binaries when the remote terminal starts.
    copyFileSync(sourceBinaryPath, targetBinaryPath);
    if (requiresSpawnHelper) {
      const sourceSpawnHelperPath = join(sourcePrebuildDir, "spawn-helper");
      if (!existsSync(sourceSpawnHelperPath)) {
        console.log(`  [warn] spawn-helper not found at ${sourceSpawnHelperPath}`);
        continue;
      }
      copyFileSync(sourceSpawnHelperPath, targetSpawnHelperPath);
      chmodSync(targetSpawnHelperPath, 0o755);
    }
    console.log(`  [ok] mock-cdn node-pty/${platformKey} (copied from ${packageName})`);
  }
}

function buildRemoteOfficialPluginRuntimes() {
  for (const plugin of remoteOfficialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`==> Building remote official plugin runtime: ${plugin.packageName}`);
    if (isBootstrapWithRemote) {
      buildRemoteOfficialPluginRuntimeForBootstrap(plugin);
      assertRemoteOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      pnpmCommand,
      ["--dir", join(rootDir, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: rootDir,
        env: process.env,
      },
    );
    assertRemoteOfficialPluginRuntime(plugin);
  }
}

function buildRemoteOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(join(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(`  [skip] reuse existing remote official plugin runtime: ${plugin.packageName}`);
    return;
  }

  // bootstrap:with-remote will serially prepare remote resources and workspace builds.
  // The official plug-in runtime is only needed for stage resources. Here, the current Node is used to perform equivalent construction to avoid nesting pnpm/tsc shims.
  // The MCP server and browser-client of browser-use must come from the same build; only the old server.js is used to determine whether they can be reused.
  // This will cause remote resources to be mixed with stale or missing clients, so the plug-in will be rebuilt unconditionally in bootstrap mode.
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertRemoteOfficialPluginRuntime(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare-prebuilds] missing remote official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageRemoteOfficialPlugins(glmDir) {
  for (const plugin of remoteOfficialPluginPackages) {
    const sourceRoot = join(rootDir, plugin.relativePath);
    const manifestPath = join(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `[prepare-prebuilds] missing remote official plugin manifest: ${manifestPath}`,
      );
    }

    const targetRoot = join(glmDir, ...plugin.stagedPath.split("/"));
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of remoteOfficialPluginTopLevelPaths) {
      const sourcePath = join(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, join(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of remoteOfficialPluginRequiredPaths) {
      if (!relativePath.startsWith(`${plugin.stagedPath}/`)) continue;
      const stagedAssetPath = join(glmDir, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare-prebuilds] missing staged remote official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`  [ok] mock-cdn glm official plugin ${plugin.stagedPath}`);
  }
}

async function stageRemoteBundledSkillPack(glmDir) {
  const sourceRoot = join(rootDir, remoteBundledSkillPack.relativePath);
  const targetRoot = join(glmDir, ...remoteBundledSkillPack.stagedPath.split("/"));
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of remoteBundledSkillPack.topLevelPaths) {
    const sourcePath = join(sourceRoot, entryName);
    await cp(sourcePath, join(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of remoteBundledSkillPack.requiredPaths) {
    const stagedAssetPath = join(targetRoot, ...relativePath.split("/"));
    await access(stagedAssetPath);
  }
  console.log(`  [ok] mock-cdn glm bundled skill pack ${remoteBundledSkillPack.stagedPath}`);
}

// The remote agent now runs the compiled zcode.cjs (rather than the platform-independent native binary):
// There is already an independent node (running zcode-server.cjs) during remote deployment. The agent can reuse it to execute zcode.cjs.
// No more having to prepare a node-embedded SEA binary for each platform. zcode.cjs is the same across platforms. Each platform just puts its own
// glm/<platform> component directory, keeping the existing manifest component structure unchanged.
async function stageRemoteAgentBundles() {
  console.log("==> Building zcode-cli bundle for remote agents");
  // Reuse the same desktop build script (turbo build:desktop-agent --filter=@zcode/cli), and the cache hit is almost instantaneous.
  runCommand(process.execPath, [join(rootDir, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: rootDir,
    env: process.env,
  });
  // The browser-use runtime's tsc depends on @zcode/core/dist. Remote assets must also be built first
  // agent CLI dependency to avoid TS2307 being masked by development machine cache during CI clean checkout.
  buildRemoteOfficialPluginRuntimes();
  const cliBundlePath = join(rootDir, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[prepare-prebuilds] expected cli bundle missing: ${cliBundlePath}`);
  }

  for (const platformKey of remotePlatforms) {
    const glmDir = join(releaseDir, "glm", platformKey);
    // Clean rebuild: The glm component now only contains zcode.cjs, clearing out the native binary/old meta left over from history.
    // To avoid being imported into components, use tar to expand remote resources.
    rmSync(glmDir, { recursive: true, force: true });
    mkdirSync(glmDir, { recursive: true });
    copyFileSync(cliBundlePath, join(glmDir, "zcode.cjs"));
    stageRemoteOfficialPlugins(glmDir);
    await stageRemoteBundledSkillPack(glmDir);
    console.log(`  [ok] mock-cdn glm/${platformKey}/zcode.cjs`);
  }
}

function canResolveIntranetDepsBaseUrl() {
  try {
    resolveIntranetDepsBaseUrl();
    return true;
  } catch {
    return false;
  }
}

export async function prepareRemoteNativeSearchTools({
  platforms = remotePlatforms,
  outputDir = join(releaseDir, "tools"),
} = {}) {
  console.log("==> Preparing local native search binaries for remote platforms");
  for (const platformKey of platforms) {
    const [targetOs, targetArch] = platformKey.split("-");
    if (!targetOs || !targetArch) {
      throw new Error(`Invalid remote platform key: ${platformKey}`);
    }

    await prepareNativeSearchTools({
      prebuiltPlan: resolveRemoteNativeSearchPrebuiltPlan({
        platform: targetOs,
        arch: targetArch,
        outputDir: join(outputDir, platformKey),
      }),
    });
  }
}

function joinPosix(...segments) {
  return segments.join("/").replace(/\/+/g, "/");
}

function normalizeSemanticPrefix(rawPrefix, fallback = "v1") {
  const prefix = String(rawPrefix ?? "").trim();
  if (!prefix) {
    return fallback;
  }

  const normalized = prefix.replace(/\+/g, "-");
  if (!normalized) {
    return fallback;
  }
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

function computeFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function buildComponentVersion(semanticPrefix) {
  return normalizeSemanticPrefix(semanticPrefix);
}

export function buildContentAddressedComponentVersion(semanticPrefix, sha256) {
  const normalizedSha = String(sha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedSha)) {
    throw new Error(`Invalid component sha256: ${sha256}`);
  }
  return `${buildComponentVersion(semanticPrefix)}+${normalizedSha.slice(0, 12)}`;
}

export function buildComponentArtifactRelativePath(platformKey, componentId, componentVersion) {
  return joinPosix("components", platformKey, componentId, `${componentVersion}.tar.gz`);
}

function resolveComponentSemanticVersion(componentVersion) {
  const version = String(componentVersion ?? "").trim();
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return version;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/.test(suffix) ? version.slice(0, plusIndex) : version;
}

// glm hosts the zcode-cli app-server protocol schema. Even if the runtime version has not changed,
// zcode.cjs may also change with the app code; reusing old glm across releases will cause the remote agent to reject new protocol fields.
const nonReusableReleaseAssetIds = new Set(["server-bundle", "glm"]);

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function compareVersionSegments(left, right) {
  const leftParts = String(left).split(/[.-]/);
  const rightParts = String(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      continue;
    }

    const compared = leftPart.localeCompare(rightPart, undefined, {
      numeric: true,
    });
    if (compared !== 0) {
      return compared;
    }
  }

  return 0;
}

function findReusableReleaseDirs({ mockCdnDir, currentVersion }) {
  const releasesDir = join(mockCdnDir, "releases");
  if (!existsSync(releasesDir)) {
    return [];
  }

  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentVersion)
    .map((entry) => entry.name)
    .filter((candidate) => compareVersionSegments(candidate, currentVersion) < 0)
    .sort((left, right) => compareVersionSegments(right, left))
    .map((candidate) => join(releasesDir, candidate));
}

function normalizeManifestComponents(manifest) {
  if (!manifest || !Array.isArray(manifest.components)) {
    return new Map();
  }

  return new Map(
    manifest.components
      .filter((component) => typeof component?.id === "string")
      .map((component) => [component.id, component]),
  );
}

export function restoreReusableReleaseAssets({
  mockCdnDir,
  currentVersion,
  releaseDir,
  componentDefinitionsByPlatform,
}) {
  const previousReleaseDirs = findReusableReleaseDirs({
    mockCdnDir,
    currentVersion,
  });
  if (previousReleaseDirs.length === 0) {
    return;
  }

  for (const [platformKey, componentDefinitions] of componentDefinitionsByPlatform.entries()) {
    for (const componentDefinition of componentDefinitions) {
      if (nonReusableReleaseAssetIds.has(componentDefinition.id)) {
        continue;
      }

      for (const previousReleaseDir of previousReleaseDirs) {
        const previousManifest = readJsonFile(
          join(previousReleaseDir, `manifest-${platformKey}.json`),
        );
        const previousComponents = normalizeManifestComponents(previousManifest);
        const previousComponent = previousComponents.get(componentDefinition.id);
        if (
          resolveComponentSemanticVersion(previousComponent?.version) !==
          resolveComponentSemanticVersion(componentDefinition.version)
        ) {
          continue;
        }

        const sourcePath = join(previousReleaseDir, ...componentDefinition.mount.split("/"));
        const targetPath = join(releaseDir, ...componentDefinition.mount.split("/"));
        if (!existsSync(sourcePath)) {
          continue;
        }

        const requiredPaths = componentDefinition.requiredPaths ?? [];
        const hasTargetRequiredPaths =
          existsSync(targetPath) &&
          requiredPaths.every((relativePath) =>
            existsSync(join(targetPath, ...relativePath.split("/"))),
          );
        if (hasTargetRequiredPaths) {
          continue;
        }

        const hasRequiredPaths = requiredPaths.every((relativePath) =>
          existsSync(join(sourcePath, ...relativePath.split("/"))),
        );
        if (!hasRequiredPaths) {
          continue;
        }

        // App version changes will generate a new releases/<version> directory, and mock-cdn cache hits cannot rely on this path.
        // Here, the historical release is only copied when the version of the component itself is consistent and the key files are complete to avoid repeated downloads of stable runtime.
        mkdirSync(dirname(targetPath), { recursive: true });
        if (existsSync(targetPath)) {
          // The last bootstrap abort may have left a fragmented target directory with only .part files.
          // If the target directory exists but the key files are incomplete, reuse cannot be skipped. Clear them first and then use the complete resources of historical releases to repair them.
          rmSync(targetPath, { force: true, recursive: true });
        }
        cpSync(sourcePath, targetPath, { recursive: true });
        console.log(
          `  [reuse] ${componentDefinition.id} ${platformKey} from ${basename(previousReleaseDir)}`,
        );
        break;
      }
    }
  }
}

function buildReusableComponentDefinitionsByPlatform() {
  return new Map(
    remotePlatforms.map((platformKey) => [
      platformKey,
      buildRemoteComponentDefinitions(platformKey).map((component) => ({
        id: component.id,
        version: buildComponentVersion(component.semanticPrefix),
        mount: component.mount,
        requiredPaths: buildReusableComponentRequiredPaths(component.id, platformKey),
      })),
    ]),
  );
}

function buildReusableComponentRequiredPaths(componentId, platformKey) {
  switch (componentId) {
    case "node-runtime":
      return ["node"];
    case "node-pty":
      return platformKey.startsWith("darwin-") ? ["pty.node", "spawn-helper"] : ["pty.node"];
    case "glm":
      // GLM is now the compiled product zcode.cjs (the same copy across platforms), which is executed remotely using the deployed node.
      // When reusing, you must also confirm that the official plug-in seed resource is complete, otherwise the old release will continue to produce remote resource packages with 0 builtin plugin.
      return ["zcode.cjs", ...remoteOfficialPluginRequiredPaths];
    case "bfs":
      return ["bfs"];
    case "ripgrep":
      return [platformKey.startsWith("win32-") ? "rg.exe" : "rg"];
    case "ugrep":
      return ["ugrep"];
    default:
      return [];
  }
}

export function buildRemoteComponentDefinitions(platformKey) {
  const baseComponents = [
    {
      id: "server-bundle",
      semanticPrefix: version,
      mount: "server",
      sourcePath: join(releaseDir, "server"),
    },
    {
      id: "node-runtime",
      semanticPrefix: nodeVersion,
      mount: joinPosix("node", platformKey),
      sourcePath: join(releaseDir, "node", platformKey),
    },
    {
      id: "node-pty",
      // The node-pty component was previously fixed to v1. After the platform package is upgraded, the client will still hit the old cache.
      // The version of the actual copied source package is used here to allow the component cache to automatically expire when @lydell/node-pty-<platform> is upgraded.
      semanticPrefix: resolveNodePtyPackageVersion(platformKey),
      mount: joinPosix("node-pty", platformKey),
      sourcePath: join(releaseDir, "node-pty", platformKey),
    },
    {
      id: "glm",
      // The GLM native binary was previously fixed to v1, and the upgrade of the binary version will not trigger component cache failure.
      // ZCODE_AGENT_RUNTIME.glm.version is reused here to keep the manifest version consistent with the runtime description.
      semanticPrefix: ZCODE_AGENT_RUNTIME.glm.version,
      mount: joinPosix("glm", platformKey),
      sourcePath: join(releaseDir, "glm", platformKey),
    },
  ];

  const [platform, arch] = platformKey.split("-");
  const nativeSearchPlan = resolveRemoteNativeSearchPrebuiltPlan({
    platform,
    arch,
    outputDir: join(releaseDir, "tools", platformKey),
  });

  return [
    ...baseComponents,
    ...nativeSearchPlan.artifacts
      .toSorted((left, right) => left.toolId.localeCompare(right.toolId))
      .map((artifact) => ({
        id: artifact.toolId,
        semanticPrefix: artifact.release,
        mount: joinPosix("tools", platformKey, artifact.toolId),
        sourcePath: dirname(artifact.binaryPath),
      })),
  ];
}

function tryReuseRemoteComponentArtifact({
  mockCdnDir,
  component,
  previousComponent,
  sourceSha256,
}) {
  if (!previousComponent) {
    return null;
  }

  if (previousComponent.id !== component.id || previousComponent.mount !== component.mount) {
    return null;
  }

  if (
    resolveComponentSemanticVersion(previousComponent.version) !==
    buildComponentVersion(component.semanticPrefix)
  ) {
    return null;
  }

  if (previousComponent.sourceSha256 !== sourceSha256) {
    return null;
  }

  if (
    typeof previousComponent.artifactPath !== "string" ||
    typeof previousComponent.sha256 !== "string" ||
    !isSha256(previousComponent.sha256)
  ) {
    return null;
  }

  const artifactPath = join(mockCdnDir, ...previousComponent.artifactPath.split("/"));
  if (!existsSync(artifactPath)) {
    return null;
  }

  if (computeFileSha256(artifactPath) !== previousComponent.sha256) {
    return null;
  }

  return previousComponent;
}

export function prepareRemoteComponentArtifact({
  mockCdnDir,
  platformKey,
  component,
  previousComponents = new Map(),
}) {
  if (!existsSync(component.sourcePath)) {
    throw new Error(
      `Missing component source for ${component.id} (${platformKey}): ${component.sourcePath}`,
    );
  }

  const sourceSha256 = computeComponentSourceSha256(component.sourcePath);
  const previousComponent = previousComponents.get(component.id);
  const reusedComponent = tryReuseRemoteComponentArtifact({
    mockCdnDir,
    component,
    previousComponent,
    sourceSha256,
  });
  if (reusedComponent) {
    // When the remote mock-cdn component source content has not changed, tar.gz cannot be retyped every time.
    // Here, the source directory content fingerprint is used to hit the existing manifest and artifact to avoid bootstrap:with-remote repeatedly compressing large components.
    console.log(`  [skip] component ${component.id} ${platformKey} unchanged`);
    return reusedComponent;
  }

  const semanticComponentVersion = buildComponentVersion(component.semanticPrefix);
  const stagingArtifactRelativePath = joinPosix(
    "components",
    platformKey,
    component.id,
    `${semanticComponentVersion}.tmp-${process.pid}-${Date.now()}.tar.gz`,
  );
  const stagingArtifactPath = join(mockCdnDir, ...stagingArtifactRelativePath.split("/"));
  mkdirSync(dirname(stagingArtifactPath), { recursive: true });

  // Continuing to reuse the old tar when re-running the same version locally will cause the manifest sha256 to point to stale content.
  // Here, a temporary package is created first and then the content hash is written into the final file name to prevent the CDN cache from continuing to hit old objects with the same name.
  packComponentSourceAsArchive(component.sourcePath, stagingArtifactPath);
  const artifactSha256 = computeFileSha256(stagingArtifactPath);
  const componentVersion = buildContentAddressedComponentVersion(
    component.semanticPrefix,
    artifactSha256,
  );
  const artifactRelativePath = buildComponentArtifactRelativePath(
    platformKey,
    component.id,
    componentVersion,
  );
  const artifactPath = join(mockCdnDir, ...artifactRelativePath.split("/"));
  if (artifactPath !== stagingArtifactPath) {
    rmSync(artifactPath, { force: true });
    mkdirSync(dirname(artifactPath), { recursive: true });
    renameSync(stagingArtifactPath, artifactPath);
  }
  console.log(`  [component] ${component.id} ${platformKey} -> ${artifactRelativePath}`);

  return {
    id: component.id,
    version: componentVersion,
    sha256: artifactSha256,
    sourceSha256,
    artifactPath: artifactRelativePath,
    mount: component.mount,
  };
}

function prepareRemoteComponentArtifacts() {
  console.log("==> Packaging component artifacts and manifests");

  const componentRootDir = join(mockCdnDir, "components");
  mkdirSync(componentRootDir, { recursive: true });

  for (const platformKey of remotePlatforms) {
    const componentManifestEntries = [];
    const componentDefinitions = buildRemoteComponentDefinitions(platformKey);
    const previousComponents = normalizeManifestComponents(
      readJsonFile(join(releaseDir, `manifest-${platformKey}.json`)),
    );

    for (const component of componentDefinitions) {
      if (!existsSync(component.sourcePath)) {
        if (!canResolveIntranetDepsBaseUrl()) {
          console.warn(
            `  [skip] component ${component.id} (${platformKey}): source missing and intranet deps source is not configured`,
          );
          continue;
        }
      }
      componentManifestEntries.push(
        prepareRemoteComponentArtifact({
          mockCdnDir,
          platformKey,
          component,
          previousComponents,
        }),
      );
    }

    const manifestPath = join(releaseDir, `manifest-${platformKey}.json`);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: componentSchemaVersion,
          appVersion: version,
          platformArch: platformKey,
          components: componentManifestEntries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`  [ok] mock-cdn releases/${version}/manifest-${platformKey}.json`);
  }
}

async function main() {
  console.log(`==> Preparing mock CDN release in ${releaseDir}`);

  mkdirSync(releaseDir, { recursive: true });
  restoreReusableReleaseAssets({
    mockCdnDir,
    currentVersion: version,
    releaseDir,
    componentDefinitionsByPlatform: buildReusableComponentDefinitionsByPlatform(),
  });

  await prepareNodeBinaries();
  buildServerBundle();
  copyServerBundle();
  copyNodePtyPrebuilds();
  await stageRemoteAgentBundles();
  await prepareRemoteNativeSearchTools();
  // Fix: server, pty, and agent can all be downloaded independently, and their respective declarations need to be completed before component hash calculation.
  await stageThirdPartyNotices(join(releaseDir, "server"), rootDir);
  for (const platformKey of remotePlatforms) {
    await stageThirdPartyNotices(join(releaseDir, "node-pty", platformKey), rootDir);
    await stageThirdPartyNotices(join(releaseDir, "glm", platformKey), rootDir);
  }
  prepareRemoteComponentArtifacts();

  console.log(`==> Done! Mock CDN release ready at ${releaseDir}`);
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  await main();
}
