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

/*
 * Regression guard for the stuck-startup bug.
 *
 * The Rust spawner (`spawn_host_discover_port`) used to `return` from its stdout reader thread as
 * soon as it parsed `ZCODE_WS_READY`, which drops the pipe's read end. The Host keeps logging to
 * stdout afterwards (provider / coding-plan probes etc.), so its next `console.log` threw an
 * unhandled `write EPIPE` on the socket and Node exited with code 1 — the renderer then never
 * settled startup and the window sat on the startup logo forever (observed in
 * ~/.zcode/v2/logs/host-sidecar.log as `Error: write EPIPE ... at write (.../chunk-*.js:34:5)`).
 *
 * The Rust fix is to keep draining stdout to EOF after reporting the port (mirroring the stderr
 * thread), so the read end is never dropped while the Host lives. This test pins the Host-side half
 * of that contract: once its stdout read end is closed, the Host DOES die with EPIPE — which is
 * exactly why the reader must never detach. If a future change makes the Host tolerate EPIPE, this
 * test fails and should be replaced by one that asserts survival instead.
 */
test("A8: Host dies with EPIPE if its stdout read end is dropped post-ready", async (t) => {
  if (!existsSync(STANDALONE)) {
    t.skip("run `tsup` (pnpm --filter @zcode/desktop build) first: missing out/host/standalone.js");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "zcode-host-drain-"));
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

  let exited = false;
  let exitInfo = "";
  let stderrText = "";
  child.on("exit", (code, sig) => {
    exited = true;
    exitInfo = `code=${code} sig=${sig}`;
  });
  child.stderr.on("data", (c: Buffer) => {
    stderrText += c.toString("utf8");
  });

  try {
    const port = await waitForReady(child);
    assert.ok(port > 0, `bad port ${port}`);
    // Emulate the pre-fix reader that stops consuming stdout once it has the port: destroying the
    // readable stream closes the pipe's read end, so the Host's next write is a real EPIPE.
    child.stdout!.removeAllListeners("data");
    child.stdout!.destroy();
    await new Promise((r) => setTimeout(r, 8000));
    assert.equal(exited, true, "Host reported ready but never wrote again; test inconclusive");
    assert.match(
      stderrText,
      /EPIPE/,
      `expected the Host to die from EPIPE after stdout was closed (${exitInfo})`,
    );
  } finally {
    child.kill("SIGKILL");
  }
});
