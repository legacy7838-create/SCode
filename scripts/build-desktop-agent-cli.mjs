import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { runCommand } from "./spawn-command.mjs";

// adapters tsc will OOM (exit 134) on memory-constrained machines, raising the heap limit for the entire build link.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--max-old-space-size=8192`;
import {
  stageBuiltinProviderConfig,
  resolveBuiltinProviderBuildEnvironment,
} from "./builtin-provider-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useTurboBuild = process.env.ZCODE_DESKTOP_AGENT_BUILD_MODE === "turbo";
const useBootstrapWithRemoteBuild = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";
const pnpmRunEnv = {
  ...process.env,
  ZCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot }),
  // The verify-deps-before-run of pnpm 11 will be in the apps/zcode-cli sub-workspace
  // Trigger pnpm install before executing each run; the sub-workspace depends on the root repository @zcode/shared when running.
  // Autoinstall cannot resolve the root workspace package, causing dev:desktop:test and E2E onPrepare to fail.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
// The desktop Agent is built with two paths: normal pnpm and bootstrap:with-remote, which run directly to tsc.
// In the past, the two paths maintained the dependency order separately. When adding the workspace dependency, only the bootstrap dependency was updated.
// The dist of this dependency does not yet exist in clean CI, and bootstrap will fail because it cannot resolve the type entry.
// The two paths are uniformly derived from this ordered list to avoid drifting again when workspace dependencies are added later.
const cliWorkspaceBuilds = [
  { packageName: "@zcode/shared-types", packageDir: "shared-types" },
  { packageName: "@zcode/contracts", packageDir: "contracts" },
  // The tsc build of dynamic-workflow depends on gitignored's libs.generated.ts.
  // The bare-tsc path (runBootstrapWithRemoteBuild) will not execute the package build script.
  // So you need to run the generation script first; it must be ranked before @zcode/core, core depends on dynamic-workflow.
  {
    packageName: "@zcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  // The type entry of dynamic-workflow-runtime is dist/index.d.ts, which must be built before bootstrap.
  { packageName: "@zcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@zcode/core", packageDir: "core" },
  { packageName: "@zcode/adapters", packageDir: "adapters" },
  { packageName: "@zcode/i18n", packageDir: "i18n" },
  { packageName: "@zcode/telemetry", packageDir: "telemetry" },
  { packageName: "@zcode/bootstrap", packageDir: "bootstrap" },
];
// The official plugin manifest can be filesystem seeded when server.js is missing until session
// An error is reported only after connecting to MCP, resulting in a semi-started state of "Helper ready but CUA tool does not exist". All required for normal Dev
// The standalone MCP runtime must be centrally registered and the real entry file verified after construction before allowing the Agent bundle to start.
const requiredDevPluginRuntimeBuilds = [
  {
    // node_repl host: Browser Use and Computer Use are shared, and the product belongs to an independent package.
    packageName: "@zcode/node-repl-host",
    artifactPath: "node-repl-host/dist/mcp/server.js",
  },
  {
    // The only remaining runtime of browser-use is browser-client; the host is no longer carried by it.
    packageName: "@zcode/browser-use-plugin",
    artifactPath: "browser-use-plugin/scripts/browser-client.mjs",
  },
];
const defaultBuildFilters = [
  ...cliWorkspaceBuilds.map(({ packageName }) => packageName),
  ...requiredDevPluginRuntimeBuilds.map(({ packageName }) => packageName),
];

async function verifyRequiredDevPluginRuntimeArtifacts() {
  for (const runtime of requiredDevPluginRuntimeBuilds) {
    const artifactPath = resolve(repoRoot, "apps/zcode-cli/packages", runtime.artifactPath);
    try {
      await access(artifactPath);
    } catch (error) {
      throw new Error(
        `[build-desktop-agent-cli] ${runtime.packageName} build succeeded without required MCP runtime: ${artifactPath}`,
        { cause: error },
      );
    }
  }
}

/**
 * Temporarily store the newly built agent bundle into bundled-agents.
 *
 * Must do: dev is not packaged when the agent binary is provided by desktopRuntimeEnv.ts
 * resolveBundledZCodeAgentBinaryPath() resolves, the candidates are only bundled-agents/, none
 * cli/dist/. Only relying on the temporary storage of the packaging chain will make dev keep running the share left by the last packaging - the actual test is stale
 * For 3 days, any changes on the agent CLI side will not take effect silently in the dev, disguising "the changes are not incorporated" as "the code has no effect".
 * The implementation shares stage-agent-bundle.mjs with the packaging chain, so both sides can no longer drift separately.
 *
 * dev only runs the host platform, so platformKey takes process directly; the cross-platform target of the packaging chain is resolved by itself.
 */
function stageDevAgentBundle() {
  stageAgentBundle({
    repoRoot,
    platformKey: `${process.platform}-${process.arch}`,
  });
}

async function runBootstrapWithRemoteBuild() {
  if (existsSync(resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"))) {
    await stageBuiltinProviderConfig({
      root: repoRoot,
      env: pnpmRunEnv,
      directory: resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/provider"),
    });
    console.log("[build-desktop-agent-cli] reuse existing zcode-cli desktop agent bundle");
    return;
  }

  for (const { packageDir, prepareScript } of cliWorkspaceBuilds) {
    // bootstrap:with-remote will build the agent bundle in the remote assets stage.
    // When executing tsc package by package through pnpm, it will go through the shim/env node layer. In a low-memory local environment, it is easy to get stuck for a long time.
    // Only the bootstrap-specific environment variables take effect here, and the current Node is directly reused to start the TypeScript CLI.
    // bare tsc bypasses the package build script, so the package with prepareScript (dynamic-workflow)
    // You must first manually run the generation script to complete the gitignored libs.generated.ts, otherwise tsc will report an error due to missing files.
    if (prepareScript) {
      runCommand(process.execPath, [prepareScript], {
        cwd: `apps/zcode-cli/packages/${packageDir}`,
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }
    runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: `apps/zcode-cli/packages/${packageDir}`,
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  runCommand(process.execPath, ["scripts/build.mjs", "--desktop-agent"], {
    cwd: "apps/zcode-cli/packages/cli",
    env: pnpmRunEnv,
    stdio: "inherit",
  });
}

if (useBootstrapWithRemoteBuild) {
  await runBootstrapWithRemoteBuild();
  stageDevAgentBundle();
  process.exit(0);
}

if (!useTurboBuild) {
  // There is no warehouse-level turbo root in the Linux container demo, `turbo --cwd apps/zcode-cli`
  // Will treat apps/zcode-cli as the root directory and reject inputs in turbo.json that point to ../../packages/shared.
  // At the same time, the agent sub-workspace does not contain root packages/shared, but the agent package depends on @zcode/shared.
  // Therefore, the explicit pnpm package sequential build of the warehouse root workspace is used by default to avoid WDIO pre-builds getting stuck in sub-workspace resolution.
  for (const filter of defaultBuildFilters) {
    runCommand("pnpm", ["--filter", filter, "build"], {
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  await verifyRequiredDevPluginRuntimeArtifacts();
  runCommand("pnpm", ["--filter", "@zcode/cli", "build:desktop-agent"], {
    env: pnpmRunEnv,
    stdio: "inherit",
  });
  stageDevAgentBundle();
  process.exit(0);
}

runCommand(
  "pnpm",
  [
    "exec",
    "turbo",
    "--skip-infer",
    "--cwd",
    "apps/zcode-cli",
    "run",
    "build:desktop-agent",
    "--filter=@zcode/cli",
  ],
  {
    env: pnpmRunEnv,
    stdio: "inherit",
  },
);
stageDevAgentBundle();
