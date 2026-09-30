#!/usr/bin/env node
/**
 * Remote verification orchestration: deploy the staged distribution package to the server with sshd
 * In the Linux environment, verify the daemon life cycle and HTTP/WS ingress contract from the local machine through the `ssh -L` tunnel.
 *
 * Usage:
 *   node scripts/verify-remote-ssh.mjs [--target linux-x64|linux-arm64] [--keep]
 *
 * Prerequisite: `pnpm --filter @zcode/server-cli stage --target <target>` has been run.
 * `--keep` keeps the environment for manual debugging (the script will print the connection method).
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { resolveVerificationTarget } from "./verify-remote-ssh-target.mjs";

const HOST_CAPABILITY_HEADER = "x-zcode-rpc-host-capability";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const target = resolveVerificationTarget(readArg("--target"));
const releaseArchive = join(packageRoot, "dist-release", `zcode-server-${target}.tar.gz`);

const log = (...args) => console.log("[verify-remote-ssh]", ...args);
const cleanups = [];

function readArg(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function run(command, args, { input, allowFailure = false, quiet = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      } else {
        if (!quiet) console.error(stderr || stdout);
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
      }
    });
  });
}

async function findFreePort() {
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function retry(description, attempts, delayMs, action) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error(`${description} failed after ${attempts} attempts: ${lastError}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  await run("ls", [releaseArchive], { quiet: true }).catch(() => {
    throw new Error(
      `Release archive missing: ${releaseArchive}; run pnpm --filter @zcode/server-cli stage --target ${target}`,
    );
  });

  // A one-time ssh key, the container only trusts the public key generated for this run.
  const workDir = await mkdtemp(join(tmpdir(), "zcode-server-verify-"));
  cleanups.push(() => rm(workDir, { force: true, recursive: true }));
  const keyPath = join(workDir, "id_ed25519");
  await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);

  const sshBaseArgs = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-i",
    keyPath,
    "-p",
    "22",
  ];
  const sshTargetHost = "root@127.0.0.1";
  const ssh = (remoteCommand) => run("ssh", [...sshBaseArgs, sshTargetHost, remoteCommand]);

  await retry("ssh connectivity", 30, 1000, () => ssh("true"));
  log(`sshd ready on 127.0.0.1:22`);

  log("scp release archive and extract");
  await run("scp", [
    ...sshBaseArgs.map((arg) => (arg === "-p" ? "-P" : arg)),
    releaseArchive,
    `${sshTargetHost}:/root/`,
  ]);
  await ssh(
    `mkdir -p /root/zcode-server && tar -xzf /root/zcode-server-${target}.tar.gz -C /root/zcode-server --strip-components=1`,
  );

  log("start daemon on remote");
  const { stdout: daemonOutput } = await ssh("/root/zcode-server/bin/zcode serve --daemon --json");
  const daemonStatus = JSON.parse(daemonOutput.trim().split("\n").pop());
  assert(daemonStatus.state === "ready", `daemon ready, got: ${daemonOutput}`);
  assert(
    daemonStatus.host === "127.0.0.1",
    `daemon binds loopback only, got: ${daemonStatus.host}`,
  );
  const remotePort = daemonStatus.port;
  log(`remote core ready at 127.0.0.1:${remotePort} (pid ${daemonStatus.pid})`);

  // Core only listens to the remote loopback address; the ssh -L tunnel is the only way to reach it.
  const localPort = await findFreePort();
  log(`open tunnel 127.0.0.1:${localPort} -> remote 127.0.0.1:${remotePort}`);
  const tunnel = spawn(
    "ssh",
    [...sshBaseArgs, "-N", "-L", `${localPort}:127.0.0.1:${remotePort}`, sshTargetHost],
    { stdio: "ignore" },
  );
  cleanups.push(() => {
    if (!keep) tunnel.kill("SIGTERM");
  });
  const baseUrl = `http://127.0.0.1:${localPort}`;

  const serverInfo = await retry("server-info via tunnel", 20, 500, async () => {
    const response = await fetch(`${baseUrl}/api/server-info`);
    assert(response.ok, `server-info status ${response.status}`);
    return await response.json();
  });
  assert(
    serverInfo.capabilities?.websocketRpc === true,
    "server-info reports websocketRpc capability",
  );
  log(`server-info ok: serverId=${serverInfo.serverId} version=${serverInfo.version}`);

  log("verify web replayable /ws upgrade");
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws`);
    const timer = setTimeout(() => rejectPromise(new Error("/ws upgrade timed out")), 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });

  log("verify /ws/host capability gate");
  // The capability middleware checks the request header before WS upgrade, and ordinary GET can verify the 401 boundary;
  // undici fetch disables and does not require manual setting of the upgrade header.
  const unauthorized = await fetch(`${baseUrl}/ws/host`);
  assert(
    unauthorized.status === 401,
    `/ws/host without ticket must be 401, got ${unauthorized.status}`,
  );
  const ticketResponse = await fetch(`${baseUrl}/api/rpc-host-capability`, { method: "POST" });
  const ticket = await ticketResponse.json();
  assert(
    typeof ticket.capability === "string" && ticket.capability.length > 0,
    "capability ticket issued",
  );
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws/host`, {
      headers: { [HOST_CAPABILITY_HEADER]: ticket.capability },
    });
    const timer = setTimeout(() => rejectPromise(new Error("/ws/host upgrade timed out")), 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
  const replayed = await fetch(`${baseUrl}/ws/host`, {
    headers: { [HOST_CAPABILITY_HEADER]: ticket.capability },
  });
  assert(replayed.status === 401, `replayed ticket must be 401, got ${replayed.status}`);
  log("ws contracts ok (replayable upgrade, host gate, one-time ticket)");

  // Linux's pty.node uses @lydell to complete the path (special processing during packaging), and must be verified to be loadable on the real target platform.
  log("verify node-pty spawns a real pty on remote");
  await ssh(
    "cd /root/zcode-server/runtime && ./node -e \"const pty=require('node-pty');const p=pty.spawn('/bin/echo',['pty-ok'],{cols:80,rows:24});let o='';p.onData(d=>o+=d);p.onExit(()=>{process.exit(o.includes('pty-ok')?0:1)})\"",
  );
  log("node-pty ok");

  log("verify remote lifecycle status/stop");
  const { stdout: statusOutput } = await ssh("/root/zcode-server/bin/zcode status --json");
  assert(
    JSON.parse(statusOutput.trim().split("\n").pop()).state === "ready",
    "remote status ready",
  );
  await ssh("/root/zcode-server/bin/zcode stop --json");
  const { stdout: stoppedOutput } = await ssh("/root/zcode-server/bin/zcode status --json");
  const stopped = JSON.parse(stoppedOutput.trim().split("\n").pop());
  assert(stopped.state === "stopped", `remote stopped, got ${stopped.state}`);
  log("lifecycle ok (ready -> stop -> stopped)");

  if (keep) {
    log(
      `kept for debugging: container=${containerName} ssh="ssh ${sshBaseArgs.join(" ")} ${sshTargetHost}" tunnel=127.0.0.1:${localPort}`,
    );
  }
  log("ALL CHECKS PASSED");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error("[verify-remote-ssh] FAILED:", error instanceof Error ? error.message : error);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Cleanup failures do not obscure the main process results.
    }
  }
}
process.exit(exitCode);
