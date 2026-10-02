#!/usr/bin/env node
/**
 * CI supervisor: simulate `pnpm dev:tauri` on a clean runner.
 *
 * Spec: docs/specs/tauri-dev-simulate.md.
 *
 * This script does NOT reimplement the dev boot. It spawns the real
 * `pnpm dev:tauri` (scripts/dev-tauri.mjs) and supervises the three signals
 * that together mean "actually booted", not merely "compiled":
 *
 *   1. `@zcode/server` listening on :3030,
 *   2. Vite listening on :5199 (tauri.conf.json beforeDevCommand, strictPort),
 *   3. the app process alive (`zcode-tauri.exe` on Windows, `zcode-tauri` on
 *      POSIX) — evidence that cargo finished the debug build AND the webview
 *      host launched. A compile that dies at WebView2 init never gets here.
 *
 * Success requires all three green AND still green after STABILIZE_SECONDS,
 * with the supervisor child alive the entire time — a port opening early does
 * not mask a later child exit. On failure the last log lines are printed so
 * the workflow log names the failing stage (server / vite / cargo / app).
 *
 * Teardown always runs: taskkill /T on Windows (dev-tauri.mjs children are in
 * the same console tree), process-group SIGTERM then SIGKILL on POSIX.
 *
 * Env:
 *   BOOT_TIMEOUT_SECONDS  total boot budget (default 1800 — cold debug cargo
 *                         builds on a clean runner are slow)
 *   STABILIZE_SECONDS     health window after all signals green (default 45)
 *   CI_DEV_TAURI_LOG      transcript path (default dev-tauri-ci.log)
 *   ZCODE_TAURI_NO_SERVER=1  skip the :3030 requirement (matches
 *                         scripts/dev-tauri.mjs opting out of the server boot)
 *
 * Also runnable on a developer machine: `node scripts/ci-dev-tauri-simulate.mjs`
 * to reproduce a Windows boot failure locally.
 */
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import net from "node:net";

const SERVER_PORT = 3030;
const VITE_PORT = 5199;
const BOOT_TIMEOUT_SECONDS = Number(process.env.BOOT_TIMEOUT_SECONDS) || 1800;
const STABILIZE_SECONDS = Number(process.env.STABILIZE_SECONDS) || 45;
const LOG_FILE = process.env.CI_DEV_TAURI_LOG || "dev-tauri-ci.log";
const POLL_MS = 5000;
const REQUIRE_SERVER = process.env.ZCODE_TAURI_NO_SERVER !== "1";
const IS_WINDOWS = process.platform === "win32";
const APP_PROCESS = IS_WINDOWS ? "zcode-tauri.exe" : "zcode-tauri";

function log(message) {
  process.stdout.write(`[ci-dev-tauri-simulate] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn `pnpm dev:tauri` the same way scripts/dev-tauri.mjs spawns its own
 * children: `cmd.exe /c` on Windows (the pnpm.cmd shim is not directly
 * spawnable), direct spawn on POSIX — detached there so the teardown can kill
 * the whole process group.
 */
function spawnDevTauri() {
  if (IS_WINDOWS) {
    return spawn("cmd.exe", ["/c", "pnpm", "dev:tauri"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn("pnpm", ["dev:tauri"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

/** Resolves true when something is listening on the port. */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Resolves true when the compiled app process is running. Windows `tasklist
 * /FI` exits 0 even with no match (it prints an INFO line), so the answer is
 * read from stdout; POSIX `pgrep -x` uses its exit code.
 */
function isAppProcessAlive() {
  return new Promise((resolve) => {
    const file = IS_WINDOWS ? "tasklist" : "pgrep";
    const args = IS_WINDOWS ? ["/FI", `IMAGENAME eq ${APP_PROCESS}`, "/NH"] : ["-x", APP_PROCESS];
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("exit", (code) => {
      resolve(IS_WINDOWS ? stdout.includes(APP_PROCESS) : code === 0);
    });
    child.on("error", () => resolve(false));
  });
}

/** Prints the tail of the boot transcript so the failing stage is in the workflow log. */
function printLogTail(lines = 120) {
  try {
    const content = readFileSync(LOG_FILE, "utf8");
    const tail = content.split(/\r?\n/).slice(-lines);
    process.stdout.write(`\n===== last ${lines} lines of ${LOG_FILE} =====\n`);
    process.stdout.write(`${tail.join("\n")}\n`);
    process.stdout.write("===== end of log tail =====\n\n");
  } catch (error) {
    log(`could not read ${LOG_FILE}: ${error.message}`);
  }
}

const logStream = createWriteStream(LOG_FILE, { flags: "a" });
// A bad log path must degrade to a warning, not an unhandled WriteStream crash:
// stdout still carries the boot transcript even when the file cannot be written.
logStream.on("error", (error) => {
  log(`could not write ${LOG_FILE}: ${error.message}`);
});
const child = spawnDevTauri();
let childExit = null;

// Tee the boot transcript to the log file AND to this process's streams, so
// the Actions log shows the boot live and the artifact keeps the full record.
for (const [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", (chunk) => {
    logStream.write(chunk);
    target.write(chunk);
  });
}
child.on("error", (error) => {
  log(`failed to spawn pnpm dev:tauri: ${error.message}`);
  childExit = { code: null, signal: "spawn-error" };
});
child.on("exit", (code, signal) => {
  childExit = { code, signal };
});

/** Kill the whole dev tree: taskkill /T on Windows, process group on POSIX. */
function teardown() {
  if (!child.pid || childExit?.signal === "spawn-error") return;
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Group already gone.
        }
      }, 5000).unref();
    }
  } catch {
    // Already gone.
  }
}
process.on("exit", teardown);

const deadline = Date.now() + BOOT_TIMEOUT_SECONDS * 1000;
let greenSince = null;
let lastReport = 0;
let result = 1;

log(
  `spawning: pnpm dev:tauri (boot timeout ${BOOT_TIMEOUT_SECONDS}s, stabilize ${STABILIZE_SECONDS}s, server required: ${REQUIRE_SERVER})`,
);
log(`transcript: ${LOG_FILE}`);

while (true) {
  if (childExit) {
    log(
      `FAIL: supervisor child exited early (code=${childExit.code}, signal=${childExit.signal ?? "none"}) — the dev boot died; see the transcript below.`,
    );
    break;
  }
  const server = REQUIRE_SERVER ? await isPortOpen(SERVER_PORT) : true;
  const vite = await isPortOpen(VITE_PORT);
  const app = await isAppProcessAlive();
  const now = Date.now();
  if (now - lastReport >= 30000) {
    log(`signals: server:${SERVER_PORT}=${server} vite:${VITE_PORT}=${vite} app-process=${app}`);
    lastReport = now;
  }
  if (server && vite && app) {
    if (greenSince === null) greenSince = now;
    if (now - greenSince >= STABILIZE_SECONDS * 1000) {
      result = 0;
      log("boot stable — all signals green for the stabilize window; success.");
      break;
    }
  } else {
    greenSince = null;
  }
  if (now >= deadline) {
    log(
      `FAIL: boot signals not all green within ${BOOT_TIMEOUT_SECONDS}s (server=${server}, vite=${vite}, app-process=${app}).`,
    );
    break;
  }
  await sleep(POLL_MS);
}

teardown();
printLogTail();
logStream.end();
process.exit(result);
