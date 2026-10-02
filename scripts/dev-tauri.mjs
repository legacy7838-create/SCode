#!/usr/bin/env node
/**
 * `pnpm dev:tauri` launcher.
 *
 * This is a thin supervisor, not a rendering fallback. It does exactly two
 * things that `tauri dev` alone cannot:
 *
 *   1. boot `@zcode/server` on :3030 unless something is already listening, so
 *      `dev:tauri` stays a single command (the renderer mounts the real
 *      `@zcode/ui` `<Root>`, which needs the business-service channel over `/ws`
 *      exactly like the Web client), and
 *   2. run the Tauri/Vite tree in its own process group so one Ctrl-C tears the
 *      whole thing down instead of orphaning Vite on :5199.
 *
 * The WebKitGTK/NVIDIA `Error 71` startup abort is handled **inside the app**,
 * in `apps/zcode-tauri/src-tauri/src/rendering.rs`, which sets
 * `__NV_DISABLE_EXPLICIT_SYNC=1` before the first EGL display is initialized.
 * There is deliberately no tier ladder here: no probe, no remembered marker, no
 * retry with a different renderer. An environment problem is fixed where the
 * environment is read, not papered over by relaunching in JavaScript.
 *
 * Escape hatches (native, read by `rendering::apply_webkit_graphics_env`):
 *   ZCODE_WEBKIT_SOFTWARE=1  force CPU rendering from the start
 *   ZCODE_WEBKIT_HARDWARE=1  skip the NVIDIA workaround, test the stock path
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The port the business-service server (`@zcode/server`) listens on; Vite proxies `/ws` + `/api` here. */
const SERVER_PORT = Number(process.env.PORT) || 3030;

const args = process.argv.slice(2);

/** Resolves true when something is already listening on the server port. */
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
 * The Tauri renderer mounts the real `@zcode/ui` `<Root>`, which needs the
 * business-service channel over WebSocket — exactly like the Web client. That
 * channel is served by `@zcode/server`. Boot it here (unless one is already
 * running or the caller opted out with `ZCODE_TAURI_NO_SERVER=1`) so `dev:tauri`
 * stays a single command. The child joins the same process-group teardown as
 * the Tauri/Vite tree below.
 */
async function startServerIfNeeded() {
  if (process.env.ZCODE_TAURI_NO_SERVER === "1") return null;
  if (await isPortOpen(SERVER_PORT)) {
    console.log(`[dev-tauri] @zcode/server already listening on :${SERVER_PORT}, reusing it.`);
    return null;
  }
  console.log(`[dev-tauri] starting @zcode/server on :${SERVER_PORT}…`);
  // The server loads compiled Rust napi binaries (git/diff/…). In a workspace
  // checkout they live in packages/rust after `pnpm --filter @zcode/rust
  // build:native`; point the loader there so the bundled server finds them.
  // The loader still emits its own actionable error if a binary is missing.
  const nativeDir = join(REPO_ROOT, "packages", "rust");
  const serverEnv = { ...process.env, PORT: String(SERVER_PORT) };
  if (!serverEnv.ZCODE_NATIVE_DIR && existsSync(nativeDir)) {
    serverEnv.ZCODE_NATIVE_DIR = nativeDir;
  }
  const child = spawn("pnpm", ["--filter", "@zcode/server", "dev"], {
    stdio: ["inherit", "inherit", "inherit"],
    env: serverEnv,
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "exit"]) process.on(signal, stop);
  return { child, stop };
}

/**
 * Run `tauri dev` in its own process group. `detached` is what lets the signal
 * handlers tear down Vite (`build.beforeDevCommand`) together with the app; a
 * surviving Vite would make the next run fail on `--strictPort`.
 */
function launchTauri() {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["--filter", "@zcode/tauri", "tauri", "dev", ...args], {
      stdio: "inherit",
      env: process.env,
      detached: true,
    });

    const stopGroup = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Group already gone; nothing to tear down.
      }
    };

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        stopGroup();
        child.kill(signal);
      });
    }

    child.on("error", (error) => {
      console.error(`[dev-tauri] failed to launch: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const server = await startServerIfNeeded();
const code = await launchTauri();
server?.stop();
process.exit(code);
