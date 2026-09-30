// Packaged-native verification hook for electron-builder's afterPack.
//
// The .node payload decision belongs entirely to `zcode-packaging`
// (docs/specs/rust-native-packaging.md). This file contains no crate list, no platform
// suffix table, and no tolerance: it spawns `verify`, which re-hashes the staged tree
// against the plan recorded by `prepare:rust-native` and exits non-zero on a missing,
// wrong-sized, hash-mismatched, or unplanned binary.
//
// Note the deliberate contrast with `koffi-package-assets.mjs`, whose `verifyStagedKoffi`
// is imported at electron-builder.config.js:23 and never called — a dangling verification
// import. This hook is actually invoked, and its failure aborts the pack.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");

/** Plan written by `pnpm --filter @zcode/rust native:stage-desktop`. */
const PLAN_PATH = resolve(repoRoot, "packages/rust/target/desktop-agent-plan.json");

/**
 * Verifies the packaged agent's native payload against its plan.
 *
 * Fails the pack when the plan is absent: without it there is nothing to verify against,
 * and treating that as a pass is exactly how a package that throws on its first
 * `loadNative()` call gets shipped.
 */
export function assertPackagedRustNative() {
  const target = getTargetPlatform();
  if (!existsSync(PLAN_PATH)) {
    throw new Error(
      `[afterPack:rust-native] missing staging plan ${PLAN_PATH}. ` +
        "Run `pnpm --filter @zcode/desktop prepare:rust-native` before packaging; " +
        "the packaged agent loads .node binaries and will throw without them.",
    );
  }

  const result = spawnSync(
    "cargo",
    ["run", "--release", "-p", "zcode-packaging", "--", "verify", "--plan", PLAN_PATH],
    {
      cwd: resolve(repoRoot, "packages/rust"),
      stdio: "inherit",
      env: { ...process.env, ZCODE_PACKAGE_TARGET: `${target.os}-${target.arch}` },
    },
  );

  if (result.error) {
    throw new Error(
      `[afterPack:rust-native] could not run zcode-packaging verify: ${result.error.message}. ` +
        "A Rust toolchain is required in the packaging job (spec risk R6).",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `[afterPack:rust-native] native payload verification failed (exit ${result.status}). ` +
        "See the zcode-packaging output above for the specific binary.",
    );
  }
}
