// Agent bundle temporary storage action: put apps/zcode-cli/packages/cli/dist/zcode.cjs into
// bundled-agents/<platform>/glm, and write meta.
//
// dev and packaging must be implemented using the same temporary cache.
// It is not enough that only the packaging chain (prepare-agent-node-bundle.mjs) will be temporarily stored. The dev chain
// (scripts/build-desktop-agent-cli.mjs) will not; and the agent binary when dev is not packaged is
// resolveBundledZCodeAgentBinaryPath() resolution of desktopRuntimeEnv.ts, the candidates are only **
// bundled-agents/, no cli/dist/. So dev keeps running the share left in the last package——
// The actual measurement is 3 days old. Any changes on the agent CLI side will not take effect silently in dev. During troubleshooting, "changes have not taken effect" will be displayed.
// Misjudged as "the code does not work". Both sides share this share, and dev and packaging can no longer drift separately.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * Cleanly rebuild the glm directory and then copy it. The clearing is intentional: electron-builder copies the entire directory
 * bundled-agents/<platform>/glm → resources/glm, the remaining native binary from the last build in the local working tree
 * (zcode-agent / zcode-acp, etc.) and the old meta will be included in the installation package (the CI clean checkout will not have it, but the local one will).
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[stage:agent-bundle] agent bundle source product does not exist: ${cliBundlePath}`,
    );
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
