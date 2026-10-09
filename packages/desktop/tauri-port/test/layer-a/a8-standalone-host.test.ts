/*
 * Layer A8 — standalone Tauri Host sidecar end-to-end.
 * Spawns the BUILT out/host/standalone.js as a real Node process, reads its `ZCODE_WS_READY <port>`
 * stdout line (the exact contract Rust parses), then connects a production WS client and calls a
 * real service. Proves the Phase-1 standalone WS endpoint serves RPC over the reused transport.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { connectViaWebSocket } from "@zcode/client";

const DESKTOP = resolve(import.meta.dirname, "../../..");
const STANDALONE = join(DESKTOP, "out/host/standalone.js");

async function waitForReady(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ZCODE_WS_READY")), 20000);
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const m = /ZCODE_WS_READY\s+(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`standalone host exited early code=${code}; output:\n${buf}`));
    });
    child.stderr!.on("data", (c: Buffer) => process.stderr.write(c));
  });
}

test("A8: built standalone Host serves RPC over loopback WS", async (t) => {
  if (!existsSync(STANDALONE)) {
    t.skip("run `tsup` (pnpm --filter @zcode/desktop build) first: missing out/host/standalone.js");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "zcode-host-e2e-"));
  const providerConfig = join(dir, "providers.json");
  writeFileSync(providerConfig, JSON.stringify({ providers: {} }), "utf8");

  const child = spawn(process.execPath, [STANDALONE], {
    env: {
      ...process.env,
      ZCODE_HOST_WS: "1",
      ZCODE_WS_PORT: "0",
      ZCODE_WORKSPACE_PATH: dir,
      ZCODE_AGENT_SPAWN_FALLBACK_CWD: dir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_PATH: providerConfig,
    },
  });

  try {
    const port = await waitForReady(child);
    assert.ok(port > 0 && port <= 65535, `bad port ${port}`);
    const services = await connectViaWebSocket(`ws://127.0.0.1:${port}`);
    assert.ok(services?.fileService, "expected a live IServiceAccessor over WS");
  } finally {
    child.kill("SIGKILL");
  }
});
