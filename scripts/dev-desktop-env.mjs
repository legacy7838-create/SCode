import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { quoteArgsForWindowsShell } from "./spawn-command.mjs";

const requestedEnv = process.argv[2]?.trim().toLowerCase();
const agentBytecode = process.argv.slice(3).includes("--agent-bytecode");
if (requestedEnv !== "test" && requestedEnv !== "production") {
  console.error("Usage: node scripts/dev-desktop-env.mjs <test|production> [--agent-bytecode]");
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    // On Windows, shell:true only joins arguments with spaces; when the repo path contains spaces (e.g. E:\Z Code\...),
    // the script path of node <script> gets truncated by cmd to E:\Z and reports Cannot find module, so quote args first.
    const spawnArgs = process.platform === "win32" ? quoteArgsForWindowsShell(args) : args;
    const child = spawn(command, spawnArgs, {
      cwd: repoRoot,
      env: withPinnedNodePath(
        {
          ...process.env,
          ZCODE_ENV: requestedEnv,
          ZCODE_DESKTOP_AGENT_BYTECODE: agentBytecode ? "1" : "0",
        },
        process.execPath,
      ),
      stdio: "inherit",
      // Windows .cmd/.bat executables (pnpm.cmd, npm.cmd, etc.) require shell: true
      shell: process.platform === "win32",
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

try {
  // The public dev scripts delegate here instead of invoking the package's
  // `dev` lifecycle directly, so pnpm will not run `pre-dev` automatically.
  // Preserve its runtime-asset preparation and stale `out` cleanup explicitly
  // before rebuilding bundles or starting Electron.
  await run(pnpmCommand, ["--filter", "@zcode/desktop", "pre-dev"]);
  // On Windows, use "node" (resolved via PATHEXT) to avoid "C:\Program Files\..." space issues
  await run(process.platform === "win32" ? "node" : process.execPath, [
    resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs"),
  ]);
  if (agentBytecode) {
    await run(process.platform === "win32" ? "node" : process.execPath, [
      resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs"),
    ]);
  }
  await run(pnpmCommand, ["--filter", "@zcode/desktop", "dev:runtime"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
