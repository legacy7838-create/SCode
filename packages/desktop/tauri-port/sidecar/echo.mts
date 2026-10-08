// Trivial echo WebSocket sidecar for the Tauri sidecar-runtime PoC.
//
// Proves the spawn -> env-handoff -> loopback-WS boundary end to end WITHOUT dragging in the real
// Local Host's native externals (node-pty/ssh2/undici). It reuses the exact `ws` server pattern from
// `../poc/ws-rpc-roundtrip.ts` (bind 127.0.0.1, port from env) but keeps the wire protocol as raw
// frame echo: every received text frame is sent back prefixed with `echo:`.
//
// Packaging (see SIDECAR-PACKAGING.md §2/§3): esbuild bundles this file to a single CommonJS artifact
// with the `#!/usr/bin/env node` shebang banner; the result is copied to
// `src-tauri/binaries/zcode-echo-<rust-target-triple>` and `chmod 755`. At runtime the sidecar needs a
// `node` on PATH (fine for the headless PoC; production ships a bundled Node per §2).
//
// Build command (reproducible, from `packages/desktop`):
//   TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
//   ../../node_modules/.bin/esbuild tauri-port/sidecar/echo.mts \
//     --bundle --platform=node --format=cjs --target=node22 \
//     --banner:js='#!/usr/bin/env node' \
//     --external:bufferutil --external:utf-8-validate \
//     --outfile=src-tauri/binaries/zcode-echo-$TRIPLE
//   chmod 755 src-tauri/binaries/zcode-echo-$TRIPLE
import { WebSocketServer, type WebSocket } from "ws";

/** Parsed startup configuration read from the environment the Rust core injects. */
interface EchoConfig {
  /** TCP port to bind on 127.0.0.1. `0` lets the OS pick an ephemeral port. */
  port: number;
  /** Shared secret handed off from Rust; only echoed back in the ready line, never logged in full. */
  secret: string;
}

/**
 * Read the sidecar's startup config from the process environment.
 *
 * `ZCODE_WS_PORT` must parse as a base-10 integer in `[0, 65535]`; anything else is treated as `0`
 * (ephemeral) so the PoC never crashes on a malformed port.
 *
 * @returns The resolved port and secret.
 */
function readConfig(): EchoConfig {
  const rawPort = process.env.ZCODE_WS_PORT ?? "0";
  const parsed = Number.parseInt(rawPort, 10);
  const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0;
  return { port, secret: process.env.ZCODE_WS_SECRET ?? "" };
}

const config = readConfig();

// Bind loopback only, matching SIDECAR-TRANSPORT.md §4 (never expose beyond 127.0.0.1).
const wss = new WebSocketServer({ host: "127.0.0.1", port: config.port });

wss.on("listening", () => {
  const address = wss.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : config.port;
  // Ready handshake on stdout, parsed by the Rust core (SIDECAR-PACKAGING.md §6 option "print ready
  // port"). Only a boolean "secret present" flag is emitted — never the secret itself (AGENTS.md 日志边界).
  process.stdout.write(`ZCODE_WS_READY ${boundPort} has_secret=${config.secret.length > 0}\n`);
});

wss.on("connection", (socket: WebSocket) => {
  socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    if (socket.readyState === socket.OPEN) {
      socket.send(`echo:${text}`);
    }
  });
});

wss.on("error", (err: Error) => {
  process.stderr.write(`zcode-echo error: ${err.message}\n`);
});
