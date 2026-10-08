/*
 * Layer A4 — sidecar RUNTIME round-trip (spawn -> env handoff -> loopback WS -> clean kill).
 *
 * Promotes the `sidecar/echo.mts` PoC from COMPILE-ONLY to RUNTIME-VERIFIED. It proves, headlessly,
 * the four boundaries named in `SIDECAR-PACKAGING.md` §6/§7 that the Rust core is expected to drive:
 *
 *   1. A Node sidecar child can be spawned (here `tsx echo.mts`, standing in for the packaged
 *      `zcode-echo-<TRIPLE>` binary the Rust core launches via `tauri-plugin-shell`).
 *   2. The ephemeral loopback port is handed off via the `ZCODE_WS_PORT` env and the child binds it.
 *   3. A `ws` client round-trips a text frame against the running child (`echo:` prefix).
 *   4. The child is killed and fully exits — the orphan-prevention guarantee (§5) — with no leftover
 *      `echo.mts` node process.
 *
 * Style mirrors `_host.ts` / `a1-ws-rpc.test.ts`: node:test, ephemeral 127.0.0.1, bounded waits, hard
 * teardown. If the sidecar cannot be spawned in this environment the test FAILS with a clear message
 * (never skipped silently, never a faked assertion) so the Layer-A parity gate stays honest.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";

/** Wall-clock bound for the sidecar to boot and print its `ZCODE_WS_READY` line. */
const BOOT_BUDGET_MS = 5_000;
/** Wall-clock bound for the loopback WS to accept a connection once the child is ready. */
const CONNECT_BUDGET_MS = 3_000;
/** Poll interval while retrying the client connect. */
const CONNECT_RETRY_MS = 50;
/** How long to wait for a clean process exit after `kill()` before escalating to `SIGKILL`. */
const KILL_GRACE_MS = 2_000;

/** Resolve the `tsx` launcher and the `echo.mts` entry point as absolute paths.
 *
 * Paths are derived from this test file's own URL (not `process.cwd()`), so the fixture is robust to
 * being invoked from the repo root (`pnpm test:tauri:layer-a`) or any subdirectory.
 *
 * @returns Absolute paths for the `tsx` binary and the sidecar source, plus the resolved repo root.
 * @throws If `tsx` or `echo.mts` cannot be located.
 */
function resolveArtifacts(): { tsxBin: string; echoEntry: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const echoEntry = resolve(testDir, "../../sidecar/echo.mts");
  if (!existsSync(echoEntry)) {
    throw new Error(`Sidecar source not found at ${echoEntry}`);
  }

  // Walk up from the test directory looking for a hoisted `node_modules/.bin/tsx`.
  let dir = testDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) {
      return { tsxBin: candidate, echoEntry };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate a `node_modules/.bin/tsx` launcher while walking up from the test dir");
}

/** Ask the OS for an ephemeral loopback port, then release it immediately.
 *
 * Mirrors the Rust side's "bind `:0` and read the port" strategy (`SIDECAR-PACKAGING.md` §6 step 1).
 * There is a theoretical reuse race between closing this probe and the child binding the same port;
 * the bounded connect-retry below absorbs it, and the child's `ZCODE_WS_READY` line confirms the
 * actual bound port.
 *
 * @returns The free port number.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePromise(port));
    });
  });
}

/** Wait until the child prints `ZCODE_WS_READY <port> ...` on stdout, or the boot budget elapses.
 *
 * @param child Piped child process whose stdout is scanned.
 * @param expectedPort Port handed off via `ZCODE_WS_PORT`.
 * @returns The port the sidecar reports as bound.
 * @throws If the process exits early or the line never arrives within the budget.
 */
async function readReadyPort(child: ChildProcessWithoutNullStreams, expectedPort: number): Promise<number> {
  const deadline = Date.now() + BOOT_BUDGET_MS;
  let buffer = "";
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  while (Date.now() < deadline) {
    const { value, done } = await readStdoutChunk(child, CONNECT_RETRY_MS);
    if (done) break;
    buffer += value;
    const match = /ZCODE_WS_READY\s+(\d+)/.exec(buffer);
    if (match) {
      const bound = Number.parseInt(match[1] ?? "", 10);
      assert.equal(
        bound,
        expectedPort,
        "sidecar bound a different port than the ZCODE_WS_PORT env handed off (env handoff broken)",
      );
      return bound;
    }
    if (exited) break;
  }

  throw new Error(
    `Sidecar never printed ZCODE_WS_READY within ${BOOT_BUDGET_MS}ms. stdout so far:\n${buffer}\n` +
      `This usually means tsx could not launch the child in this environment.`,
  );
}

/** Read one bounded chunk from the child's stdout without hanging if the stream is idle.
 *
 * @param child Piped child process.
 * @param timeoutMs Max wait for a chunk before returning an empty slice.
 * @returns The decoded text (possibly empty) and whether the stream has ended.
 */
function readStdoutChunk(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ value: string; done: boolean }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: string, done: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.off("end", onEnd);
      resolvePromise({ value, done });
    };
    const onData = (chunk: Buffer): void => finish(chunk.toString("utf8"), false);
    const onEnd = (): void => finish("", true);
    const timer = setTimeout(() => finish("", false), timeoutMs);
    child.stdout.on("data", onData);
    child.stdout.once("end", onEnd);
  });
}

/** Open a WS connection to `ws://127.0.0.1:<port>`, tolerating a not-yet-listening child.
 *
 * @param port Loopback port the sidecar is bound to.
 * @returns The connected socket.
 * @throws If no connection succeeds within the connect budget.
 */
async function connectWithRetry(port: number): Promise<WebSocket> {
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await Promise.race([
        once(ws, "open").then(() => undefined),
        new Promise<never>((_, reject) => ws.once("error", reject)),
      ]);
      return ws;
    } catch (err) {
      lastError = err;
      ws.removeAllListeners();
      ws.terminate();
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
  throw new Error(
    `Could not connect to the sidecar WS on 127.0.0.1:${port} within ${CONNECT_BUDGET_MS}ms: ${String(lastError)}`,
  );
}

test("A4: sidecar spawn + env handoff + loopback WS round-trip + clean kill", async () => {
  const { tsxBin, echoEntry } = resolveArtifacts();
  const port = await getFreePort();

  // stdio piped so we can parse the ready line and observe stderr on failure. NOT detached, so the
  // child stays in our process group and `kill()` reaches it (orphan prevention, §5).
  const child = spawn(tsxBin, [echoEntry], {
    env: { ...process.env, ZCODE_WS_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let client: WebSocket | undefined;
  // Capture stderr for diagnostics; surfaced only when the test fails.
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  // Guarantee no orphan child regardless of where the body throws: kill and await exit in teardown.
  const teardown = async (): Promise<void> => {
    client?.removeAllListeners();
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        once(child, "exit").then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), KILL_GRACE_MS)),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  };

  try {
    const boundPort = await readReadyPort(child, port);

    client = await connectWithRetry(boundPort);
    const payload = `ping-${crypto.randomUUID()}`;
    client.send(payload);

    const [raw] = (await once(client, "message")) as [Buffer | ArrayBuffer | Buffer[]];
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    assert.equal(text, `echo:${payload}`, "sidecar must echo the frame prefixed with `echo:`");
  } catch (err) {
    throw new Error(
      `Sidecar runtime test failed in this environment: ${String(err)}\n--- child stderr ---\n${stderr}`,
      { cause: err },
    );
  } finally {
    await teardown();
  }

  // Orphan-kill guarantee: the child process has fully terminated.
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "sidecar child must be fully exited after teardown (no orphan process)",
  );
});
