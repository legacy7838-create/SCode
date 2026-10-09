/**
 * Dev-only: run the standalone Tauri Host sidecar on a fixed loopback port so `pnpm dev:tauri`'s
 * renderer can connect to a real backend without the packaged externalBin (Phase 2/4). It waits for
 * `out/host/standalone.js` (produced by the `tsup` step) then execs it with the sidecar env, forwarding
 * signals and output. Production uses Rust to spawn the packaged host instead.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const standalone = join(desktopRoot, "out/host/standalone.js");
const port = process.env.ZCODE_WS_PORT ?? "5199";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBuild(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(standalone)) {
    if (Date.now() > deadline) {
      console.error(`[dev-host] timed out waiting for ${standalone} (run tsup first)`);
      process.exit(1);
    }
    await sleep(250);
  }
}

await waitForBuild();

const child = spawn(process.execPath, [standalone], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: { ...process.env, ZCODE_HOST_WS: "1", ZCODE_WS_PORT: port },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
