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
const dbAddon = join(desktopRoot, "zcode-db/zcode_db.node");
const ptyAddon = join(desktopRoot, "zcode-pty/zcode_pty.node");
// @-mention 工作区文件搜索的两条原生边界（spec/native-boundary-*.md）。两者都无 JS 兜底：
// 缺 artifact 时 workspaceScanNative / workspaceScoreNative 会抛错，而抛错点在用户第一次按 `@`
// 之后，日志里只会看到一句孤立的异常，很难定位。这里与 DB/PTY 一样在启动期 fail-fast。
const scanAddon = join(desktopRoot, "zcode-scan/zcode_scan.node");
const scoreGlue = join(desktopRoot, "zcode-score-wasm/pkg/nodejs/zcode_score.js");
// Host 侧的行级 diff 统计（packages/services/src/session/diffNative.ts）同样无 JS 兜底。
const diffGlue = join(desktopRoot, "zcode-diff-wasm/pkg/nodejs/zcode_diff.js");
const port = process.env.ZCODE_WS_PORT ?? "5199";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The standalone host loads the Rust DB addon on its first data op; fail fast here with the exact
// build command instead of surfacing a missing-addon error deep in host startup.
if (!existsSync(dbAddon)) {
  console.error(
    `[dev-host] zcode-db addon missing: ${dbAddon}\n  run: pnpm prepare:zcode-db-native`,
  );
  process.exit(1);
}

// Same fail-fast for the Rust terminal (PTY) addon: the host opens terminals via ZCODE_PTY_NATIVE.
if (!existsSync(ptyAddon)) {
  console.error(
    `[dev-host] zcode-pty addon missing: ${ptyAddon}\n  run: pnpm prepare:zcode-pty-native`,
  );
  process.exit(1);
}

// Same fail-fast for the two workspace-file native boundaries the @-mention picker uses. They have
// no JS fallback, so a missing artifact would only surface as a thrown error the first time the user
// types `@` — far from the real cause. Check both here so a clean tree fails at boot.
if (!existsSync(scanAddon)) {
  console.error(
    `[dev-host] zcode-scan addon missing: ${scanAddon}\n  run: pnpm prepare:zcode-scan-native`,
  );
  process.exit(1);
}

if (!existsSync(scoreGlue)) {
  console.error(
    `[dev-host] zcode-score wasm glue missing: ${scoreGlue}\n  run: pnpm prepare:zcode-score-wasm`,
  );
  process.exit(1);
}

// Same fail-fast for the line-diff kernel the Host uses for per-turn / task change stats. It has no
// JS fallback, so a missing artifact would only surface as a thrown error the first time a summary
// is built. Check it here so a clean tree fails at boot.
if (!existsSync(diffGlue)) {
  console.error(
    `[dev-host] zcode-diff wasm glue missing: ${diffGlue}\n  run: pnpm prepare:zcode-diff-wasm`,
  );
  process.exit(1);
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
  env: {
    ...process.env,
    ZCODE_HOST_WS: "1",
    ZCODE_WS_PORT: port,
    ZCODE_PTY_NATIVE: ptyAddon,
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
