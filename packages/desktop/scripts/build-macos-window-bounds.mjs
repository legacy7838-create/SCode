#!/usr/bin/env node
// Compile the macOS window bounds auxiliary program (the adsorption data source of the CUA permission floating window).
//
// Skip directly for non-darwin: This binary only serves the TCC authorized boot of macOS, and there is no corresponding process for other platforms.
// When swiftc is missing (Xcode CLT is not installed), it only warns and does not fail - adsorption enhances the look and feel, and the window floats when bounds cannot be obtained.
// It will still be available if it fails-open to the bottom of the screen. This should not cause the entire desktop build to hang.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-window-bounds", "main.swift");
const outputDir = join(packageRoot, "resources", "macos-window-bounds");
const outputPath = join(outputDir, "zcode-window-bounds");

if (process.platform !== "darwin") {
  console.log("[window-bounds] Skip: required for macOS only");
  process.exit(0);
}

if (!existsSync(sourcePath)) {
  console.error(`[window-bounds] Source file missing: ${sourcePath}`);
  process.exit(1);
}

function hasSwiftc() {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasSwiftc()) {
  console.warn(
    "[window-bounds] swiftc not found (requires Xcode Command Line Tools); skipping build.",
  );
  console.warn(
    "[window-bounds] The permission floating window is still available, but will not be attached to the system settings window.",
  );
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

try {
  // At the same time, arm64 and x86_64 universal binaries are produced to prevent the release package from being unable to execute on another architecture.
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "arm64-apple-macos11", sourcePath, "-o", `${outputPath}-arm64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "x86_64-apple-macos11", sourcePath, "-o", `${outputPath}-x86_64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "lipo",
    ["-create", `${outputPath}-arm64`, `${outputPath}-x86_64`, "-output", outputPath],
    { stdio: "inherit" },
  );
  execFileSync("rm", ["-f", `${outputPath}-arm64`, `${outputPath}-x86_64`]);
  console.log(`[window-bounds] Universal binary built: ${outputPath}`);
} catch (error) {
  console.warn(
    "[window-bounds] Build failed; permission floating window is still available but will not snap:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(0);
}
