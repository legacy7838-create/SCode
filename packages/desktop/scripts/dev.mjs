import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareDevElectronAppBundle } from "./devElectronAppBundle.mjs";

const root = resolve(import.meta.dirname, "..");
const mainBundle = resolve(root, "out/main/index.js");
const buildReadyMarkers = [
  { name: "main", path: resolve(root, "out/.main-build-ready") },
  { name: "host", path: resolve(root, "out/.host-build-ready") },
  { name: "preload", path: resolve(root, "out/.preload-build-ready") },
];
const waitLogIntervalMs = 3_000;
const require = createRequire(import.meta.url);

// Fail fast when the desktop manifest version drifts from the root release version:
// dev Electron reads packages/desktop/package.json via app.getVersion(), and
// electron-updater throws on anything that is not valid semver.
const desktopPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const rootPackage = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../../../package.json"), "utf8"),
);
if (!desktopPackage.version || desktopPackage.version !== rootPackage.version) {
  throw new Error(
    `Desktop package version "${desktopPackage.version ?? "<missing>"}" does not match root package version "${rootPackage.version}". Sync packages/desktop/package.json with the root package.json.`,
  );
}

function resolveLocalElectronBinary() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageRoot = resolve(electronPackageJsonPath, "..");

  // Before launching Windows, directly spawn("electron"), completely relying on PATH to find the local bin.
  // In the pnpm + PowerShell scenario, the child process often only gets the node executable but not the electron command.
  // As a result, the dev script is stuck at ENOENT and can only be bypassed by manually splitting it into three terminals.
  // Here, the Electron binary installed by the current project is explicitly parsed to avoid inconsistent PATH semantics across shells/cross-platforms.
  if (process.platform === "win32") {
    return resolve(electronPackageRoot, "dist", "electron.exe");
  }

  if (process.platform === "darwin") {
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }

  return resolve(electronPackageRoot, "dist", "electron");
}

function probeHttpUrl(url) {
  return new Promise((resolveProbe) => {
    const req = request(url, { method: "HEAD", timeout: 1_000 }, (res) => {
      res.resume();
      resolveProbe({ ok: true });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        reason: `${error.code ? `${error.code} ` : ""}${error.message}`,
      });
    });
    req.end();
  });
}

// Wait for both Vite dev server and main bundle to be ready
async function waitForReady() {
  // Desktop's tsup is actually three independent watch builds of main/host/preload.
  // If any previous build is successful, it may be released. Electron will start when other products are not stable and read the half-completed ESM/CJS files.
  // Now you have to wait for each of the three builds to write the ready mark, and then additionally confirm that the main bundle has been produced.
  let lastBuildWaitLogAt = 0;
  while (true) {
    const missingMarkers = buildReadyMarkers
      .filter((marker) => !existsSync(marker.path))
      .map((marker) => marker.name);
    const hasMainBundle = existsSync(mainBundle);
    if (missingMarkers.length === 0 && hasMainBundle) {
      break;
    }
    const now = Date.now();
    if (now - lastBuildWaitLogAt >= waitLogIntervalMs) {
      // When the dev startup is stuck in the waiting stage, the last line of the terminal often stops in the tsup watch log, and the developer cannot determine which condition is missing.
      // The wait status is printed regularly here, so that missing markers or main bundles can be located directly from the log.
      console.log(
        `[dev] Waiting for build artifacts... missingMarkers=${
          missingMarkers.join(",") || "none"
        } mainBundle=${hasMainBundle ? "ready" : "missing"}`,
      );
      lastBuildWaitLogAt = now;
    }
    await sleep(300);
  }

  // Wait for Vite dev server
  // Vite may only listen to one of localhost/::1 or 127.0.0.1 under different native DNS/IPv6 configurations.
  // Multiple loopback addresses are polled here to avoid inconsistency between the dev script and the actual listening address of Vite, causing Electron to never start.
  const viteUrls = ["http://localhost:5174", "http://127.0.0.1:5174", "http://[::1]:5174"];
  let lastViteWaitLogAt = 0;
  while (true) {
    const failures = [];
    for (const viteUrl of viteUrls) {
      const result = await probeHttpUrl(viteUrl);
      if (result.ok) {
        return viteUrl;
      }
      failures.push(`${viteUrl}: ${result.reason}`);
    }
    const now = Date.now();
    if (now - lastViteWaitLogAt >= waitLogIntervalMs) {
      console.log(`[dev] Waiting for Vite dev server... ${failures.join(" | ")}`);
      lastViteWaitLogAt = now;
    }
    await sleep(300);
  }
}

const rendererUrl = await waitForReady();
console.log("[dev] Starting Electron...");

const electronBinary = resolveLocalElectronBinary();
let electronCommand = existsSync(electronBinary) ? electronBinary : "electron";

if (process.platform === "darwin" && existsSync(electronBinary)) {
  // Raw Electron launched from the macOS command line does not have CFBundleURLTypes, and LaunchServices will
  // zcode:// is given to an Electron default shell with no project entry. Supplement the local boot copy with products
  // Info.plist, the online Share page does not need to be aware of Dev and can still deliver links to running Dev instances.
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackage = JSON.parse(await readFile(electronPackageJsonPath, "utf8"));
  const electronAppPath = resolve(electronBinary, "../../..");
  const devBundle = await prepareDevElectronAppBundle({
    electronAppPath,
    runtimeRoot: resolve(root, "../../.zcode-runtime/desktop-dev"),
    electronVersion: electronPackage.version,
    arch: process.arch,
  });
  electronCommand = devBundle.executablePath;
  console.log(`[dev] Prepared macOS ZCode Dev bundle: ${devBundle.appPath}`);
}

const electron = spawn(electronCommand, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  windowsHide: true,
  detached: process.platform !== "win32",
});

let electronClosed = false;
let shuttingDown = false;
let forceKillTimer;
let hardExitTimer;

function signalElectronTree(signal) {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    electron.kill(signal);
    return;
  }

  try {
    process.kill(-electron.pid, signal);
  } catch {
    electron.kill(signal);
  }
}

function forceKillElectronTree() {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  signalElectronTree("SIGKILL");
}

function shutdownFromSignal(signal) {
  if (shuttingDown) {
    forceKillElectronTree();
    return;
  }

  shuttingDown = true;
  console.log(`[dev] Received ${signal}, stopping Electron...`);
  // Concurrently will only end the packaging process of node scripts/dev.mjs after receiving Ctrl+C.
  // Electron will not respond reliably to SIGINT/SIGTERM on macOS, and was previously orphaned to ppid=1 to continue occupying ports and logs.
  // Here, Electron is put into an independent process group and recycled uniformly by the dev script. After timeout, the entire development process tree is forced to be cleared.
  signalElectronTree("SIGTERM");
  forceKillTimer = setTimeout(forceKillElectronTree, 1_500);
  hardExitTimer = setTimeout(() => process.exit(0), 5_000);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdownFromSignal(signal));
}

electron.on("error", (error) => {
  console.error("[dev] Failed to start Electron:", error);
  process.exit(1);
});

electron.on("close", (code, signal) => {
  electronClosed = true;
  clearTimeout(forceKillTimer);
  clearTimeout(hardExitTimer);
  if (shuttingDown) {
    process.exit(0);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
