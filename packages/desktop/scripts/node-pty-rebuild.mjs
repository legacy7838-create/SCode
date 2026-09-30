import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, normalize, posix as posixPath, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function normalizePathForComparison(filePath) {
  return normalize(filePath).split(sep).join("/");
}

export function getNodePtyPrebuildPath({ platform, arch, nodePtyRoot }) {
  const normalizedRoot = normalizePathForComparison(nodePtyRoot);
  return posixPath.join(normalizedRoot, "prebuilds", `${platform}-${arch}`, "pty.node");
}

export function decideNodePtyRebuild({ platform, arch, nodePtyRoot, existingPaths }) {
  const prebuildPath = getNodePtyPrebuildPath({ platform, arch, nodePtyRoot });

  if (platform !== "win32") {
    return {
      shouldRebuild: true,
      prebuildPath,
      reason: "non-windows-platform",
    };
  }

  if (existingPaths.has(prebuildPath)) {
    return {
      shouldRebuild: false,
      prebuildPath,
      reason: "windows-prebuild-available",
    };
  }

  return {
    shouldRebuild: true,
    prebuildPath,
    reason: "windows-prebuild-missing",
  };
}

export function resolveNodePtyRoot(cwd = process.cwd()) {
  const nodePtyPackageJsonPath = require.resolve("node-pty/package.json", { paths: [cwd] });
  return dirname(nodePtyPackageJsonPath);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveNodePtyRebuildDecision({
  platform = process.platform,
  arch = process.arch,
  cwd = process.cwd(),
} = {}) {
  const nodePtyRoot = resolveNodePtyRoot(cwd);
  const prebuildPath = getNodePtyPrebuildPath({ platform, arch, nodePtyRoot });
  const existingPaths = new Set((await pathExists(prebuildPath)) ? [prebuildPath] : []);

  return decideNodePtyRebuild({
    platform,
    arch,
    nodePtyRoot,
    existingPaths,
  });
}

function runElectronRebuild() {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "electron-rebuild.cmd" : "electron-rebuild";
    const child = spawn(command, ["-o", "node-pty"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `electron-rebuild failed with code ${code ?? "null"} and signal ${signal ?? "null"}`,
        ),
      );
    });
  });
}

export async function main() {
  const decision = await resolveNodePtyRebuildDecision();

  if (!decision.shouldRebuild) {
    // electron-rebuild will force node-gyp build-from-source on Windows.
    // node-pty 1.1 already comes with Electron's reusable N-API precompiled product. Continuing local compilation will only tie CI to the Specter library of VS.
    // This causes the installation phase to fail directly, so rebuild is skipped when precompilation is hit here.
    console.log(`[node-pty] skip electron-rebuild (${decision.reason}): ${decision.prebuildPath}`);
    return;
  }

  console.log(`[node-pty] run electron-rebuild (${decision.reason}): ${decision.prebuildPath}`);
  await runElectronRebuild();
}

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] && currentFilePath === process.argv[1]) {
  await main();
}
