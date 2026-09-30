#!/usr/bin/env node
/**
 * `pnpm dev:tauri` launcher.
 *
 * Why this exists: `tauri dev` is a faithful one-liner, but on machines whose
 * GBM/EGL stack cannot allocate a compositing buffer for the webview,
 * WebKitGTK does not degrade gracefully. It aborts the GDK display a few
 * hundred milliseconds after `setup()` returns, and `tauri dev` exits 1 with
 * only this on stderr:
 *
 *   Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
 *
 * That looks like an application crash but is an environment problem — the
 * renderer never got a buffer. Forcing WebKit's software path makes the same
 * binary run indefinitely.
 *
 * So: run normally, and only if the app dies at startup with a known GPU/GTK
 * signature, relaunch once with software rendering and say so loudly. The
 * verdict is then remembered (a marker file in the Cargo target dir), so the
 * crash is a one-time cost — every later run on this machine starts straight in
 * software mode. Machines with a working GPU never pay the retry, never get
 * software rendering, and never write the marker.
 *
 * Escape hatches:
 *   ZCODE_WEBKIT_SOFTWARE=1  force software rendering from the start
 *   ZCODE_WEBKIT_HARDWARE=1  never fall back / ignore the marker, fail loudly
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Remembers which rendering tier actually works on this machine, so the probe
 * is paid once instead of on every run. Lives in the gitignored Cargo target
 * dir so it never leaves the machine.
 */
const RENDER_MARKER = join(
  REPO_ROOT,
  "apps",
  "zcode-tauri",
  "src-tauri",
  "target",
  ".zcode-render-tier",
);

/** The port the business-service server (`@zcode/server`) listens on; Vite proxies `/ws` + `/api` here. */
const SERVER_PORT = Number(process.env.PORT) || 3030;

/**
 * Rendering strategies, tried in order from "most hardware" to "least".
 *
 * The renderer is WebKitGTK (Tauri's Linux engine), not Chromium, so its GPU
 * path is a different stack with different failure modes. Each tier disables
 * exactly one known-bad layer, so a machine keeps as much GPU acceleration as
 * it can and only degrades one step at a time.
 *
 * Order follows Tauri's own Linux-graphics troubleshooting ladder
 * (https://v2.tauri.app/develop/debug/linux-graphics/, upstream tauri#9394),
 * which says "try these in order; the earlier ones keep hardware acceleration".
 *
 *  - `native`     — stock Wayland/EGL. Best on a healthy GBM stack (AMD/Intel).
 *  - `nv-sync`    — `__NV_DISABLE_EXPLICIT_SYNC=1`. The real fix on NVIDIA:
 *                  WebKitGTK's DMABUF path trips NVIDIA's explicit-sync path and
 *                  aborts the GDK display with "Error 71". This disables that
 *                  one sync mode and is documented as fixing the crash *without a
 *                  performance cost*, i.e. it KEEPS GPU acceleration. Verified
 *                  here: the process maps libEGL_nvidia/libGLX_nvidia/
 *                  libnvidia-glcore with no software rasteriser, zero Error 71.
 *  - `no-dmabuf`  — stay on Wayland but drop WebKit's DMA-BUF renderer, keeping
 *                  hardware GL. Costs the faster path, so it comes after nv-sync.
 *  - `software`   — last resort; CPU rendering. Correct, but slow.
 */
const RENDER_TIERS = [
  { name: "native", env: {} },
  { name: "nv-sync", env: { __NV_DISABLE_EXPLICIT_SYNC: "1" } },
  { name: "no-dmabuf", env: { __NV_DISABLE_EXPLICIT_SYNC: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1" } },
  {
    name: "software",
    env: {
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      LIBGL_ALWAYS_SOFTWARE: "1",
    },
  },
];

/** Tier used when the caller forces software rendering outright. */
const SOFTWARE_TIER = RENDER_TIERS[RENDER_TIERS.length - 1];
/** Tier used when the caller forces the stock native path. */
const NATIVE_TIER = RENDER_TIERS[0];

/** Failures that mean "this rendering path is broken here", not "the app is broken". */
const GPU_CRASH = [
  /Protocol error dispatching to Wayland/i,
  /Error 71/,
  /Failed to create GBM buffer/i,
  /Failed to create EGL/i,
  /libEGL\.so|libGL\.so/,
  /dlopen\(\):/,
];

/**
 * A crash this soon after launch means the window never came up. A failure
 * after the user has actually been using the app is not ours to reinterpret.
 */
const STARTUP_WINDOW_MS = 30_000;

const CAPTURE_LIMIT = 64 * 1024;

const args = process.argv.slice(2);
const forceHardware = process.env.ZCODE_WEBKIT_HARDWARE === "1";
const forceSoftware =
  process.env.ZCODE_WEBKIT_SOFTWARE === "1" || args.includes("--software");

/**
 * The tier this machine is known to need, or null when nothing is recorded yet.
 *
 * Learned from real launches rather than guessed from `/dev/dri`: a missing
 * `card0` node does NOT mean a broken GPU (Mesa skips missing nodes and NVIDIA's
 * GBM backend is installed fine), so no such heuristic is used here.
 */
function readRememberedTier() {
  if (forceHardware) return null;
  try {
    const raw = readFileSync(RENDER_MARKER, "utf-8").trim();
    return RENDER_TIERS.find((tier) => tier.name === raw) ?? null;
  } catch {
    return null;
  }
}

/** Remember which tier worked so later runs start there instead of re-probing. */
function rememberTier(tier) {
  const name = typeof tier === "string" ? tier : tier?.name;
  if (!name) return;
  try {
    mkdirSync(dirname(RENDER_MARKER), { recursive: true });
    writeFileSync(RENDER_MARKER, `${name}\n`);
  } catch {
    // Best-effort cache; a failure just means the next run re-probes.
  }
}

/** Order to probe: the remembered tier first, then everything more degraded. */
function buildTierPlan() {
  if (forceSoftware) return [SOFTWARE_TIER];
  if (forceHardware) return [NATIVE_TIER];
  const remembered = readRememberedTier();
  const startIndex = remembered ? RENDER_TIERS.indexOf(remembered) : 0;
  return RENDER_TIERS.slice(startIndex);
}

function looksLikeGpuCrash(text) {
  return GPU_CRASH.some((pattern) => pattern.test(text));
}

function launch(env, { allowFallback, tier, onSurvived }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let captured = "";
    let finished = false;
    let survivedTimer = null;

    // Detached so the whole process group can be torn down together: `tauri dev`
    // spawns Vite as a child, and an orphaned dev server holding :5199 would
    // make the relaunch fail on `--strictPort`.
    const child = spawn(
      "pnpm",
      ["--filter", "@zcode/tauri", "tauri", "dev", ...args.filter((a) => a !== "--software")],
      { stdio: ["inherit", "inherit", "pipe"], env, detached: true },
    );

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      if (captured.length < CAPTURE_LIMIT) captured += text;
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
        if (!finished) child.kill(signal);
      });
    }

    // A tier that is still running once the startup window has passed has
    // demonstrably produced a window, so it works on this machine. Record it
    // now rather than at exit: the app is normally killed with Ctrl-C, which
    // exits non-zero, and waiting for a clean exit would mean re-probing the
    // broken tiers on every single run.
    survivedTimer = setTimeout(() => {
      if (!finished) onSurvived?.(tier);
    }, STARTUP_WINDOW_MS);
    survivedTimer.unref?.();

    child.on("exit", (code, signal) => {
      finished = true;
      if (survivedTimer) clearTimeout(survivedTimer);
      const lifetime = Date.now() - startedAt;
      if (code === 0) onSurvived?.(tier);
      const startupGpuCrash =
        allowFallback &&
        !forceHardware &&
        code !== 0 &&
        lifetime < STARTUP_WINDOW_MS &&
        looksLikeGpuCrash(captured);

      resolve({ code, signal, startupGpuCrash, tier });
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      console.error(`[dev-tauri] failed to launch: ${error.message}`);
      resolve({ code: 1, signal: null, startupGpuCrash: false, tier });
    });
  });
}

function explain(tier, nextTier) {
  const keepGpu = nextTier && nextTier.name !== "software";
  console.error(
    [
      "",
      `[dev-tauri] The "${tier.name}" rendering path aborted on this machine.`,
      "[dev-tauri] That is a GPU/GTK stack problem, not an app crash: the webview",
      "[dev-tauri] never got a buffer, so GDK tore down the display.",
      keepGpu
        ? `[dev-tauri] Retrying with "${nextTier.name}" — still GPU-accelerated where possible.`
        : "[dev-tauri] Retrying with software rendering — fully functional, but CPU-bound.",
      `[dev-tauri] The working tier is remembered; re-probe with ZCODE_WEBKIT_HARDWARE=1.`,
      "",
    ].join("\n"),
  );
}

if (forceHardware) {
  console.log("[dev-tauri] ZCODE_WEBKIT_HARDWARE=1 — stock native rendering, no fallback.");
}

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
 * running or the caller opted out with ZCODE_TAURI_NO_SERVER=1) so `dev:tauri`
 * stays a single command. The child joins the same process group teardown as
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

const server = await startServerIfNeeded();

const plan = buildTierPlan();
if (plan[0] !== NATIVE_TIER) {
  console.log(
    `[dev-tauri] Using the "${plan[0].name}" rendering tier (remembered for this machine). ` +
      `Re-probe all tiers with ZCODE_WEBKIT_HARDWARE=1.`,
  );
}

// Walk the tiers from most to least degraded. A tier that aborts inside the
// startup window is recorded as unusable on this machine; the first tier that
// survives is remembered and becomes the starting point next run.
let last = { code: 0, signal: null, startupGpuCrash: false };
for (let index = 0; index < plan.length; index += 1) {
  const tier = plan[index];
  const isLast = index === plan.length - 1;
  last = await launch({ ...process.env, ...tier.env }, {
    allowFallback: !isLast,
    tier,
    onSurvived: rememberTier,
  });

  if (last.startupGpuCrash) {
    explain(tier, plan[index + 1]);
    continue;
  }
  break;
}

server?.stop();
process.exit(last.code ?? 0);
