import { rm } from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpawnRuntimeOptions } from "../../../scripts/spawn-command.mjs";

export function resolveDesktopBuildCwd() {
  // The entry paths in the tsup/vite configuration are declared relative to the root directory of the desktop package.
  // Previously, the default cwd was located in the scripts subdirectory. Windows CI would parse src/main/index.ts into scripts/src/... and directly report that the entry cannot be found.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveDesktopProductionCleanPaths(cwd) {
  return [
    resolve(cwd, "out/main"),
    resolve(cwd, "out/host"),
    resolve(cwd, "out/preload"),
    resolve(cwd, "out/renderer"),
    resolve(cwd, "out/.main-build-ready"),
    resolve(cwd, "out/.host-build-ready"),
    resolve(cwd, "out/.preload-build-ready"),
  ];
}

export async function cleanDesktopProductionOutput({ cwd }) {
  if (process.env.ZCODE_E2E_KEEP_BUILD_CACHE === "1") {
    console.log("[build] ZCODE_E2E_KEEP_BUILD_CACHE=1, skipping clean");
    return;
  }
  // If the development state/old production state is out before the production build, tsup will not actively delete expired chunks.
  // These old files will continue to be imported into app.asar by electron-builder's out/**/*, re-exposing uncompressed JS and sourcemap endnotes.
  await Promise.all(
    resolveDesktopProductionCleanPaths(cwd).map((targetPath) =>
      rm(targetPath, { force: true, recursive: true }),
    ),
  );
}

export function createDesktopProductionBuildPlan({ cwd, baseEnv = process.env }) {
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
  };

  return [
    {
      label: "desktop production bundles",
      parallel: [
        {
          command: "pnpm",
          args: ["exec", "tsup"],
          cwd,
          env,
        },
        {
          command: "pnpm",
          args: ["exec", "vite", "build"],
          cwd,
          env,
        },
      ],
    },
  ];
}

function runCommandAsync(step) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: "inherit",
      ...resolveSpawnRuntimeOptions(step.command),
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      const reason = signal ? `signal ${signal}` : `code ${code}`;
      rejectRun(new Error(`${step.command} ${step.args.join(" ")} failed with ${reason}`));
    });
  });
}

export async function runDesktopProductionBuild({ cwd = resolveDesktopBuildCwd() } = {}) {
  await cleanDesktopProductionOutput({ cwd });
  for (const step of createDesktopProductionBuildPlan({ cwd })) {
    if (step.parallel) {
      // Previously, tsup and vite were run serially, but they were written in the main/preload/host and renderer directories respectively.
      // Here, platform-independent builds are executed in parallel, shortening the CI critical path, while keeping their respective cwd/env consistent for compatibility with macOS/Windows/Linux runner.
      await Promise.all(step.parallel.map(runCommandAsync));
      continue;
    }

    await runCommandAsync(step);
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await runDesktopProductionBuild();
}
