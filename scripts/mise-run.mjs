import { spawn } from "node:child_process";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";

const [requestedCommand, ...args] = process.argv.slice(2);
if (!requestedCommand) {
  console.error("Usage: node scripts/mise-run.mjs <command> [...args]");
  process.exit(1);
}

// On Windows, pnpm is a .cmd file; other platforms use the pnpm executable entry directly.
const command =
  process.platform === "win32" && requestedCommand === "pnpm" ? "pnpm.cmd" : requestedCommand;
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: withPinnedNodePath(process.env, process.execPath),
  // The Windows .cmd entry requires a shell to be spawned by Node.
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`[mise-run] failed to start ${requestedCommand}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
