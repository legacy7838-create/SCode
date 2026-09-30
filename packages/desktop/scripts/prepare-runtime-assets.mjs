#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// The Windows Chrome import portal is not enabled, and the default build continues to compile the helper, which will increase CI time and release signing time.
// Explicit switches are retained, and the existing native implementation and supply chain verification can still be reused when the entry is restored later.
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// CUA permission floating window's adsorption data source. macOS only; when swiftc is missing, the script internally downgrades to skip (floating window fail-open
// to the bottom of the screen, still available), so hanging on darwin unconditionally doesn't make the build brittle.
const shouldPrepareMacosWindowBounds = target.os === "darwin";

// The native desktop package has a built-in agent's JS bundle (prepare:agent-bundle), which is executed by the app's Electron Node runtime during runtime.
// prepare:rust-native stages the .node binaries the bundle loads through loadNative(). The destination is
// a sibling of glm/ (not a child): zcode.cjs is the file inside glm/, and loader.ts probes
// join(dirname(zcode.cjs), "..", "native"). Ownership and the fail-loud contract live in
// docs/specs/rust-native-packaging.md; this script only decides ordering.
// The remote cross-platform native binary is still provided by prepare:remote-assets above.
// The native-search archive is distributed with the warehouse. The preparation step only performs local unpacking and verification, and does not require any download source configuration.
const localRuntimeScripts = [
  "prepare:agent-bundle",
  "prepare:rust-native",
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

const shouldSkipRemoteAssets = process.env.ZCODE_SKIP_REMOTE_ASSETS === "1";

if (!shouldSkipRemoteAssets) {
  runTimedPnpmScript("prepare:remote-assets");
} else {
  // The desktop installation package of the Windows build job does not rely on the mock-cdn remote asset.
  // Previously, prepare:remote-assets was executed unconditionally here, which would serially download/package cross-platform resources in the same job.
  // As a result, the CI time is lengthened in vain and approaches the upper limit of 1 hour. Add explicit switch to only prepare remote assets when needed.
  console.log("[prepare:runtime-assets] skip prepare:remote-assets (ZCODE_SKIP_REMOTE_ASSETS=1)");
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
