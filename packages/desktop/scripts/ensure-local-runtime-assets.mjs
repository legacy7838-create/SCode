#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  resolveNativeSearchBuildPlan,
  resolveNativeSearchReleasePlan,
} from "../../../scripts/native-search-tools-config.mjs";
import { verifyBuiltNativeSearchTools } from "../../../scripts/native-search-tools-verify.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const target = getTargetPlatform();
const bundledToolsRoot = join(desktopRoot, "bundled-tools", target.key);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
const nativeSearchBuildPlan = nativeSearchReleasePlan.enabled
  ? resolveNativeSearchBuildPlan({
      platform: target.os,
      arch: target.arch,
      outputDir: bundledToolsRoot,
    })
  : undefined;
// The Windows Chrome import portal is not enabled and the default dev startup should not treat optional helpers as local required resources.
// Continue to use the original on-demand build when explicitly opt-in to avoid deleting code required for future recovery.
const shouldRequireWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// The CUA permission floating window can be adsorbed by reading the system setting window bounds through zcode-window-bounds. The Swift product is
// .gitignore excludes (warehouse hygiene access control products are stored in the warehouse), the production chain prepare:runtime-assets will compile it on darwin,
// The dev chain must also ensure - the binary is missing after new checkout, changing worktree or clearing resources, watcher spawn
// Fail-open after ENOENT: The floating window is displayed as usual, but it no longer follows the system settings window, and no error is reported throughout the process. The problem can only be discovered by looking through the logs.
// When Xcode CLT is missing, the build script itself warns and then exits 0, and it remains not ready. At most, each dev runs an extra second-level script.
const shouldRequireMacosWindowBounds = target.os === "darwin";

function isNativeSearchReady() {
  if (!nativeSearchBuildPlan) return true;
  const requiredPaths = nativeSearchReleasePlan.runtimeToolIds.map(
    (toolId) => nativeSearchBuildPlan.binaries[toolId],
  );
  if (requiredPaths.some((binaryPath) => !binaryPath || !existsSync(binaryPath))) {
    return false;
  }

  try {
    verifyBuiltNativeSearchTools({
      bfsPath: nativeSearchBuildPlan.bfsPath,
      rgPath: nativeSearchBuildPlan.rgPath,
      ugrepPath: nativeSearchBuildPlan.ugrepPath,
      platform: nativeSearchBuildPlan.platform,
      arch: nativeSearchBuildPlan.arch,
    });
    return true;
  } catch (error) {
    // The native sidecar does not enter Git, and files with expired version, architecture or ABI may be left after branching.
    // Reuse the formal build verifier to determine readiness to avoid continuing to run the old product just because the path exists.
    console.warn(
      `[ensure-local-runtime-assets] embedded search validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Clear the generated artifacts when ABI or functional contract verification fails, ensuring that the next prepare is re-decompressed from the warehouse archive.
    for (const binaryPath of requiredPaths) {
      rmSync(binaryPath, { force: true });
    }
    return false;
  }
}

const REQUIRED_LOCAL_RUNTIME_ASSETS = [
  ...(nativeSearchReleasePlan.enabled
    ? [
        {
          label: "embedded search",
          script: "prepare:native-search",
          isReady: isNativeSearchReady,
        },
      ]
    : []),
  ...(shouldRequireWindowsBrowserImportHelper
    ? [
        {
          label: "Windows browser import helper",
          script: "prepare:browser-import-helper",
          isReady: () =>
            existsSync(join(bundledToolsRoot, "browser-import", "zcode-browser-import-helper.exe")),
        },
      ]
    : []),
  ...(shouldRequireMacosWindowBounds
    ? [
        {
          label: "macOS window bounds helper",
          script: "prepare:macos-window-bounds",
          isReady: () =>
            existsSync(
              join(desktopRoot, "resources", "macos-window-bounds", "zcode-window-bounds"),
            ),
        },
      ]
    : []),
];

const missingAssets = [];
for (const asset of REQUIRED_LOCAL_RUNTIME_ASSETS) {
  if (!(await asset.isReady())) {
    missingAssets.push(asset);
  }
}

if (missingAssets.length === 0) {
  console.log(`[ensure-local-runtime-assets] all local runtime assets are ready for ${target.key}`);
  process.exit(0);
}

// The development state needs to discover the missing local sidecar/helper before Electron starts, instead of reporting an error until it is actually used.
// Here, before Electron is started, only the embedded search sidecar and platform helper required by the current development path are self-checked.
// Agent bundle is built by subsequent build-desktop-agent-cli. The development state resolver uses workspace dist first.
// It is not within the scope of this self-test.
for (const asset of missingAssets) {
  console.log(
    `[ensure-local-runtime-assets] preparing ${asset.label} because local runtime asset is missing or incomplete`,
  );
  runCommand(pnpmCommand, [asset.script], {
    cwd: desktopRoot,
    env: process.env,
  });
}
