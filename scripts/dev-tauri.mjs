#!/usr/bin/env node
/**
 * `pnpm dev:tauri` launcher.
 *
 * This is a thin supervisor, not a rendering fallback. It does exactly three
 * things that `tauri dev` alone cannot:
 *
 *   1. build the Rust napi binaries (`packages/rust/*.node`) when this checkout
 *      has none, so a fresh `git clone && pnpm i && pnpm dev:tauri` boots —
 *      `pnpm i` does not compile them (root `prepare` is only `husky`) and
 *      `@zcode/server` loads them at startup; 中文：fresh clone 后 .node
 *      二进制不存在，启动器自动执行 build:native，三步流程开箱即用
 *      （docs/specs/tauri-windows-boot.md，issue #2 验收路径）;
 *   2. boot `@zcode/server` on :3030 unless something is already listening, so
 *      `dev:tauri` stays a single command (the renderer mounts the real
 *      `@zcode/ui` `<Root>`, which needs the business-service channel over `/ws`
 *      exactly like the Web client), and
 *   3. run the Tauri/Vite tree in its own process group so one Ctrl-C tears the
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
 *   ZCODE_TAURI_SKIP_NATIVE_BUILD=1  skip the automatic build:native step
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where `build:native` stages the compiled napi binaries (`zcode-*.node`). */
const NATIVE_DIR = join(REPO_ROOT, "packages", "rust");

/** The port the business-service server (`@zcode/server`) listens on; Vite proxies `/ws` + `/api` here. */
const SERVER_PORT = Number(process.env.PORT) || 3030;

/**
 * Spawn `pnpm` cross-platform. On Windows `pnpm` is a `pnpm.cmd` shim, which
 * Node's `spawn` cannot execute directly (it raises `ENOENT`). We run it through
 * `cmd.exe /c` explicitly rather than `shell: true`: the args stay an array
 * (no unescaped-concatenation DEP0190 warning or injection surface), and
 * cmd.exe resolves the shim. On POSIX `pnpm` is a real binary, so it spawns
 * directly.
 */
function spawnPnpm(args, options) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/c", "pnpm", ...args], options);
  }
  return spawn("pnpm", args, options);
}

/**
 * Log a child process's exit so a failure names the process that died instead
 * of surfacing as a bare non-zero exit code from the launcher.
 */
function logChildExit(label, code, signal) {
  if (code === 0 && !signal) return;
  console.error(
    `[dev-tauri] ${label} exited (code=${code}, signal=${signal ?? "none"}); ` +
      `check its output above for the error.`,
  );
}

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
 * Does this checkout already have compiled napi binaries?
 *
 * 中文：`@zcode/server` 启动时加载 packages/rust 下的 .node 二进制，
 * 但 `pnpm i` 不会构建它们 —— fresh clone 直接 `pnpm dev:tauri` 会在
 * server 阶段失败。启动器在缺失时自动补跑 build:native。
 */
function hasNativeBinaries() {
  try {
    return readdirSync(NATIVE_DIR).some((name) => /^zcode-.*\.node$/.test(name));
  } catch {
    return false;
  }
}

/** Run `pnpm --filter @zcode/rust build:native`, resolving with its exit code. */
function runBuildNative() {
  return new Promise((resolve) => {
    console.log(
      "[dev-tauri] native .node binaries missing — running " +
        "`pnpm --filter @zcode/rust build:native` (first run compiles for several minutes)…",
    );
    const child = spawnPnpm(["--filter", "@zcode/rust", "build:native"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (error) => {
      console.error(`[dev-tauri] build:native failed to launch: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (code !== 0) logChildExit("build:native", code, signal);
      resolve(code ?? (signal ? 1 : 0));
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
  const serverEnv = { ...process.env, PORT: String(SERVER_PORT) };
  if (!serverEnv.ZCODE_NATIVE_DIR && existsSync(NATIVE_DIR)) {
    serverEnv.ZCODE_NATIVE_DIR = NATIVE_DIR;
  }
  const child = spawnPnpm(["--filter", "@zcode/server", "dev"], {
    stdio: ["inherit", "inherit", "inherit"],
    env: serverEnv,
    detached: true,
  });
  child.on("exit", (code, signal) => logChildExit("@zcode/server", code, signal));
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
    const child = spawnPnpm(["--filter", "@zcode/tauri", "tauri", "dev", ...args], {
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
    child.on("exit", (code, signal) => {
      logChildExit("tauri dev", code, signal);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

// 中文：fresh clone 后 packages/rust 下没有 .node 二进制，而 `pnpm i` 不会
// 编译它们（root prepare 只有 husky）。若缺失则先自动执行 build:native，
// 使 `git clone → pnpm i → pnpm dev:tauri` 三步开箱即用（issue #2 验收路径）。
if (process.env.ZCODE_TAURI_SKIP_NATIVE_BUILD !== "1" && !hasNativeBinaries()) {
  const buildCode = await runBuildNative();
  if (buildCode !== 0) {
    console.error(
      "[dev-tauri] native build failed — @zcode/server cannot boot without " +
        "packages/rust/*.node. 通过 node scripts/build-native.mjs 驱动 cargo，无需 bash 环境。",
    );
    process.exit(buildCode);
  }
}

const server = await startServerIfNeeded();
const code = await launchTauri();
server?.stop();
process.exit(code);
