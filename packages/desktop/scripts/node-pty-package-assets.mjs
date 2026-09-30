import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export function restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }) {
  if (targetPlatform.os !== "linux") {
    console.log(`[beforePack] node-pty prebuild restore skipped for ${targetPlatform.key}`);
    return;
  }

  const platformKey = targetPlatform.key;
  const sourcePackageName = `@lydell/node-pty-${platformKey}`;
  let sourceBinaryPath;

  try {
    sourceBinaryPath = resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Missing ${sourcePackageName}, cannot package node-pty for ${platformKey}: ${message}`,
    );
  }

  const nodePtyPackageRoot = dirname(
    require.resolve("node-pty/package.json", { paths: [desktopPackageRoot] }),
  );
  const targetPrebuildDir = resolve(nodePtyPackageRoot, "prebuilds", platformKey);
  const targetBinaryPath = resolve(targetPrebuildDir, "pty.node");

  // The node-pty body in the Linux package will only check its own prebuilds/linux-*/pty.node.
  // However, the Linux precompiled files actually come from the @lydell/node-pty-linux-* platform package; if this platform package is excluded,
  // However, node-pty does not have linux prebuild in its own directory, so pty.node will be missing from the final installation package and the terminal will fail to start.
  // Here, the dependent assets are restored in the beforePack stage, and the subsequent asarUnpack processes the native addon according to the standard link.
  mkdirSync(targetPrebuildDir, { recursive: true });
  cpSync(sourceBinaryPath, targetBinaryPath);

  if (!existsSync(targetBinaryPath))
    throw new Error(`Node-pty precompiled product recovery failed: ${targetBinaryPath}`);

  console.log(`[beforePack] node-pty prebuild restored: ${targetBinaryPath}`);
}

export function resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey }) {
  const sourcePackageEntry = require.resolve(sourcePackageName);
  let currentDir = dirname(sourcePackageEntry);

  while (currentDir !== dirname(currentDir)) {
    const candidatePath = resolve(currentDir, "prebuilds", platformKey, "pty.node");
    if (existsSync(candidatePath)) return candidatePath;

    currentDir = dirname(currentDir);
  }

  // @lydell/node-pty-linux-* only exposes lib/index.js through package exports,
  // package.json can no longer be parsed. Here we search for prebuilds from the public entrance upwards, compatible with exports restrictions.
  throw new Error(
    `Missing node-pty prebuilt product: ${sourcePackageName}/prebuilds/${platformKey}/pty.node`,
  );
}

export function resolvePackagedNodePtyPrebuildPath({ resourcesDir, platformKey }) {
  return resolve(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    platformKey,
    "pty.node",
  );
}
