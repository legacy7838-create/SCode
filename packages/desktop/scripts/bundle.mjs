#!/usr/bin/env node

/* eslint-disable max-lines */
// This script integrates packaging entry, retry strategy, timing and product verification logic. Disassembling files in the short term will affect CI stability.
// Keep the centralized implementation first, and then split the modules according to "parameter analysis/build execution/product verification".

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";
import {
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "./desktop-native-package-policy.mjs";
import {
  resolveSpawnRuntimeOptions,
  runCommand,
  runCommandAndReadStdout,
} from "../../../scripts/spawn-command.mjs";
import { resolveIntranetDepsBaseUrl } from "../../../scripts/intranetDefaults.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const requireFromBundle = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(requireFromBundle.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const runtimeModuleLookupRoots = [
  desktopRoot,
  workspaceRoot,
  resolve(desktopRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const pnpmCommand = "pnpm";
const DEFAULT_TARGET_OS = "mac";
const DEFAULT_TARGET_ARCH = "arm64";
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const desktopDistRoot = resolve(desktopRoot, desktopDistDir);
const desktopProductIdentity = resolveDesktopProductIdentity(process.env);

const osAliasMap = new Map([
  ["mac", "mac"],
  ["macos", "mac"],
  ["darwin", "mac"],
  ["osx", "mac"],
  ["win", "win"],
  ["windows", "win"],
  ["win32", "win"],
  ["linux", "linux"],
]);

const archAliasMap = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["x86_64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
]);

const osBuilderFlagMap = {
  mac: "--mac",
  win: "--win",
  linux: "--linux",
};

const archBuilderFlagMap = {
  x64: "--x64",
  arm64: "--arm64",
};

const artifactExtensionsByOs = {
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"],
};
const artifactArchHintsByArch = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
};
const commandStdoutMaxBuffer = 64 * 1024 * 1024;
const requiredRuntimeModules = [
  "module-details-from-path",
  "pngjs",
  // Bugfix: telemetry's OTLP exporter relies on sdk-metrics during the startup phase; development state hoist will cover up
  // electron-builder leaks. The final product must mechanically verify this closure and prohibit the flow of installation packages that can be generated but cannot be started.
  "@opentelemetry/sdk-metrics",
  // The same caliber as the injection closure: verify that the OTLP proto export chain (exporter → otlp-transformer → protobufjs) is completely included in the package.
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  // The @arms/rum-core runtime will continue require('@babel/runtime/helpers/*') from the CJS entry.
  // It hangs @babel/runtime on peerDependencies, which can usually be parsed in the pnpm workspace development state.
  // But if the production package does not bring the peer runtime into app.asar, the installed application will crash directly during the startup phase of the main process.
  // Here @babel/runtime is included in the bundle for mechanical verification to prevent bad packages from continuing to flow out.
  "@babel/runtime",
  // Proxy detection in services will require("undici") at runtime.
  // If only the pngjs/ssh2 dependency is checked here, the packaging link will miss the bad package that "the product can be generated but undici is missing when the main process starts".
  // Here, undici is included in the mechanical verification, so that the problem can be stopped in the bundle stage.
  "undici",
  // The app's self-signed CA is generated using node-forge, which internally dynamically requires("crypto") and is inlined into the ESM main bundle will crash.
  // Therefore, it is retained as an external dependency; the production package must explicitly verify that the package exists in app.asar to avoid missing the package and causing a crash at startup.
  "node-forge",
  // Aligned with tsup external, preserving the CommonJS runtime boundaries of the ZIP unpacker.
  "yauzl",
  // Bugfix: In order to avoid the crash of Electron ESM dynamic require, Feishu SDK will be retained as an external dependency.
  // Production packages must explicitly verify that the scoped package exists in app.asar.
  "@larksuiteoapi/node-sdk",
  // If the key dependency chain of ssh2 (asn1/bcrypt-pbkdf/tweetnacl) is missing,
  // When connecting to a remote workspace, MODULE_NOT_FOUND will be thrown directly in the keyParser stage.
  // Here, the ssh2 key dependency chain is included in mechanical verification to prevent bad packets from flowing out.
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
];
const electronBuilderRetryCount = 3;
const electronBuilderRetryDelayMs = 5_000;
const electronBuilderHeartbeatIntervalMs = 30_000;
export const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
export const NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
export const OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/";

function isMisconfiguredNpmMirrorElectronRuntimeMirror(mirror) {
  return mirror
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase()
    .includes("npmmirror.com/binaries/electron");
}

export function resolveElectronMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

export function createElectronRuntimeMirrorEnv(mirror) {
  return {
    ZCODE_ELECTRON_RUNTIME_MIRROR: mirror,
    // The Electron runtime environment variables of @electron/get are read globally.
    // If passed to the main process of electron-builder, the mirrorOptions of generic artifacts such as dmg-builder will be overridden.
    ELECTRON_MIRROR: "",
    NPM_CONFIG_ELECTRON_MIRROR: "",
    npm_config_electron_mirror: "",
    npm_package_config_electron_mirror: "",
  };
}

function resolveDefaultElectronBuilderBinariesMirror(env = process.env) {
  return env.ZCODE_DEPS_BASE_URL?.trim() || env.INTRANET_MACHINE_HOST?.trim()
    ? `${resolveIntranetDepsBaseUrl(env)}/electron-builder-binaries/`
    : NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
}

export function resolveElectronBuilderBinariesMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR ||
    env.npm_config_electron_builder_binaries_mirror ||
    env.npm_package_config_electron_builder_binaries_mirror ||
    env.ELECTRON_BUILDER_BINARIES_MIRROR;
  if (existingMirror?.trim()) {
    if (isMisconfiguredNpmMirrorElectronRuntimeMirror(existingMirror)) {
      // If the electron-builder binaries mirror is configured as an Electron runtime mirror,
      // The directory structures of the two types of resources are different. dmg-builder will be moved to the runtime directory, resulting in 404.
      return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
    }

    return existingMirror.trim();
  }

  return resolveDefaultElectronBuilderBinariesMirror(env);
}

export function createElectronBuilderBinariesMirrorEnv(mirror) {
  return {
    // The DOWNLOAD_OVERRIDE_URL priority of electron-builder is higher than that of mirror.
    // If CI misallocates it to the Electron runtime directory, it will completely bypass the mirror fallback and continue with 404.
    ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    npm_config_electron_builder_binaries_download_override_url: "",
    npm_config_electron_builder_binaries_mirror: mirror,
    npm_package_config_electron_builder_binaries_download_override_url: "",
    npm_package_config_electron_builder_binaries_mirror: mirror,
  };
}

export function shouldFallbackElectronBuilderBinariesMirror(output, mirror, env = process.env) {
  const normalizedOutput = output.toLowerCase();
  const normalizedMirror = mirror.trim().replace(/\/+$/, "");
  const normalizedDefaultMirror = resolveDefaultElectronBuilderBinariesMirror(env).replace(
    /\/+$/,
    "",
  );
  const isMissingBuilderBinary =
    normalizedOutput.includes("status code 404") || normalizedOutput.includes("response code 404");
  const isDefaultDepsMirrorMissing =
    normalizedMirror === normalizedDefaultMirror &&
    normalizedOutput.includes("electron-builder-binaries/");
  const isMisconfiguredNpmMirrorElectronRuntime =
    normalizedOutput.includes("npmmirror.com/binaries/electron/") &&
    !normalizedOutput.includes("electron-builder-binaries/");

  return (
    isMissingBuilderBinary &&
    (isDefaultDepsMirrorMissing || isMisconfiguredNpmMirrorElectronRuntime)
  );
}

export function resolveElectronBuilderBinariesFallbackMirror(output, mirror, env = process.env) {
  if (!shouldFallbackElectronBuilderBinariesMirror(output, mirror, env)) {
    return null;
  }

  // CI once misallocated ELECTRON_BUILDER_BINARIES_MIRROR to the Electron runtime image directory.
  // This directory lacks builder auxiliary packages such as dmg-builder/appimage/nsis. registry.npmmirror binary
  // The electron-builder-binaries path contains these files. Domestic sources are preferred to avoid macOS packaging cache misses.
  return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function artifactNameMatchesArch(fileName, archHint) {
  // The installation packages of some environments will append a suffix after the architecture (such as mac-arm64_TEST.dmg).
  // Volume auditing must accept "_" as the delimiter after the schema, otherwise the package will be generated but the audit phase will falsely report that the product cannot be found.
  return new RegExp(`-${escapeRegExp(archHint.toLowerCase())}(?:[._-])`, "i").test(fileName);
}

function printHelp() {
  console.log(`Desktop packaging script

Usage:
  pnpm bundle:desktop
  pnpm bundle:desktop -- --os mac --arch x64
  pnpm bundle:desktop -- linux arm64

Parameters:
  --os, -o <mac|win|linux> target operating system, default mac
  --arch, -a <x64|arm64> Target CPU architecture, default arm64
  --skip-prepare skip prepare:runtime-assets
  --skip-build skip pnpm build
  --dry-run only prints the final command and does not perform packaging
  -h, --help View help

Environment variables:
  ZCODE_TARGET_OS is equivalent to --os
  ZCODE_TARGET_ARCH is equivalent to --arch
`);
}

function normalizeOs(rawOs) {
  const normalizedOs = osAliasMap.get(rawOs.toLowerCase());
  if (!normalizedOs) {
    throw new Error(`Unsupported target operating system: ${rawOs}`);
  }
  return normalizedOs;
}

function normalizeArch(rawArch) {
  const normalizedArch = archAliasMap.get(rawArch.toLowerCase());
  if (!normalizedArch) {
    throw new Error(`Unsupported target CPU architecture: ${rawArch}`);
  }
  return normalizedArch;
}

function parseArgs(argv) {
  const options = {
    os: process.env.ZCODE_TARGET_OS ?? null,
    arch: process.env.ZCODE_TARGET_ARCH ?? null,
    skipPrepare: process.env.ZCODE_SKIP_PREPARE === "1",
    skipBuild: process.env.ZCODE_SKIP_BUILD === "1",
    dryRun: false,
    positionals: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--skip-prepare") {
      options.skipPrepare = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "-o" || arg === "--os") {
      options.os = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--os=")) {
      options.os = arg.slice("--os=".length);
      continue;
    }

    if (arg === "-a" || arg === "--arch") {
      options.arch = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--arch=")) {
      options.arch = arg.slice("--arch=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unsupported parameters: ${arg}`);
    }

    options.positionals.push(arg);
  }

  const positionalOs = options.positionals[0];
  const positionalArch = options.positionals[1];

  if (options.positionals.length > 2) {
    throw new Error(`Too many parameters: ${options.positionals.join(" ")}`);
  }

  const resolvedOs = normalizeOs(options.os ?? positionalOs ?? DEFAULT_TARGET_OS);
  const resolvedArch = normalizeArch(options.arch ?? positionalArch ?? DEFAULT_TARGET_ARCH);

  return {
    os: resolvedOs,
    arch: resolvedArch,
    skipPrepare: options.skipPrepare,
    skipBuild: options.skipBuild,
    dryRun: options.dryRun,
  };
}

function run(command, args, envPatch = {}) {
  console.log(`[bundle] > ${command} ${args.join(" ")}`);

  runCommand(command, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ...envPatch,
    },
  });
}

function findBuiltArtifact(os, arch) {
  const distRoot = desktopDistRoot;
  const extensions = artifactExtensionsByOs[os] ?? [];
  const candidates = [];

  const archHints = artifactArchHintsByArch[arch] ?? [arch];

  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = join(distRoot, entry.name);
    const lowerName = entry.name.toLowerCase();
    const matchesExtension = extensions.some((extension) =>
      lowerName.endsWith(extension.toLowerCase()),
    );
    const matchesArch = archHints.some((archHint) => artifactNameMatchesArch(lowerName, archHint));

    if (!matchesExtension || !matchesArch) {
      continue;
    }

    candidates.push({
      path: fullPath,
      mtimeMs: statSync(fullPath).mtimeMs,
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      `The packaged product file of ${os}/${arch} was not found and the volume audit could not be performed.`,
    );
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].path;
}
function runAndReadStdout(command, args) {
  return runCommandAndReadStdout(command, args, {
    cwd: desktopRoot,
    env: process.env,
    // `asar list app.asar` will output a large number of file paths in the current desktop package.
    // The default 1MiB stdout buffer of Node.js spawnSync is not enough, so it will directly ENOBUFS.
    // Explicitly amplify the buffer to avoid "verification logic's own failure to read the output" from falsely reporting normal packaging as a failure.
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function runTimedSync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

async function runTimedAsync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return await fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

function shouldRetryElectronBuilderFailure(output) {
  const normalizedOutput = output.toLowerCase();
  const transientSignals = [
    "github.com/electron-userland/electron-builder-binaries/releases/download",
    "electron-builder-binaries/",
    "nsis-resources-",
    'get "https://',
    " eof",
    "read: connection reset by peer",
    "connection reset by peer",
    "connectex",
    "timed out",
    "timeout",
    "socket hang up",
    "unexpected end of file",
    "err_electron_builder_cannot_execute",
  ];

  return transientSignals.some((signal) => normalizedOutput.includes(signal));
}

async function runElectronBuilderWithRetry(args, envPatch) {
  const retryEnvPatch = { ...envPatch };
  let didFallbackElectronBuilderMirror = false;

  for (let attempt = 1; attempt <= electronBuilderRetryCount; attempt += 1) {
    console.log(
      `[bundle] > ${pnpmCommand} ${args.join(" ")} ${attempt > 1 ? `(retry ${attempt}/${electronBuilderRetryCount})` : ""}`.trim(),
    );

    const mergedEnv = {
      ...process.env,
      ...retryEnvPatch,
    };
    const result = await new Promise((resolvePromise) => {
      const child = spawn(pnpmCommand, args, {
        cwd: desktopRoot,
        env: mergedEnv,
        stdio: ["inherit", "pipe", "pipe"],
        // spawn-command no longer exports resolveSpawnCommand, and we do not want to rewrite pnpm into *.cmd here.
        // Directly reuse the same set of runtime options, allowing Windows to still parse the shim through the shell to avoid CI dry-run/real packaging crashing during the module loading stage.
        ...resolveSpawnRuntimeOptions(pnpmCommand),
      });

      let outputBuffer = "";
      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      const heartbeatTimer = setInterval(() => {
        const now = Date.now();
        // There will be no stdout/stderr in the macOS codesign stage for a long time, and the CI will look like "stuck".
        // Periodic heartbeat logs are used to confirm that the process is still running, and give the total time taken and the length of silence.
        console.log(
          `[bundle][heartbeat] electron-builder running elapsed_ms=${now - startedAt} idle_ms=${now - lastOutputAt}`,
        );
      }, electronBuilderHeartbeatIntervalMs);
      const appendOutput = (chunk, writeFn) => {
        const text = chunk.toString();
        outputBuffer += text;
        lastOutputAt = Date.now();
        writeFn(text);
      };

      child.stdout?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stdout.write(text)),
      );
      child.stderr?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stderr.write(text)),
      );

      child.on("error", (error) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status: null,
          error,
          combinedOutput: `${outputBuffer}\n${error.message}`,
        });
      });

      child.on("close", (status) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status,
          error: null,
          combinedOutput: outputBuffer,
        });
      });
    });

    if (!result.error && result.status === 0) {
      return;
    }

    const failureOutput = [
      result.combinedOutput,
      result.error?.message,
      typeof result.status === "number"
        ? `${pnpmCommand} ${args.join(" ")} failed with code ${result.status}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const currentElectronBuilderMirror = retryEnvPatch.ELECTRON_BUILDER_BINARIES_MIRROR ?? "";
    const fallbackElectronBuilderMirror = resolveElectronBuilderBinariesFallbackMirror(
      failureOutput,
      currentElectronBuilderMirror,
      process.env,
    );
    if (
      attempt < electronBuilderRetryCount &&
      !didFallbackElectronBuilderMirror &&
      fallbackElectronBuilderMirror
    ) {
      // Self-built mirror sources may miss synchronization of new architecture resources.
      // Or CI misallocates the builder mirror to the Electron runtime mirror directory. 404 is not a build code error,
      // Here, only the known missing files/mismatched mirrors are switched to registry.npmmirror. Other explicit mirrors still maintain user configuration.
      Object.assign(
        retryEnvPatch,
        createElectronBuilderBinariesMirrorEnv(fallbackElectronBuilderMirror),
      );
      didFallbackElectronBuilderMirror = true;
      console.warn(
        `[bundle] The electron-builder binary image is missing files, switch to registry.npmmirror and try again (${attempt}/${electronBuilderRetryCount})`,
      );
      await sleep(electronBuilderRetryDelayMs);
      continue;
    }

    const shouldRetry =
      attempt < electronBuilderRetryCount && shouldRetryElectronBuilderFailure(failureOutput);
    if (!shouldRetry) {
      if (result.error) {
        throw result.error;
      }

      throw new Error(
        `${pnpmCommand} ${args.join(" ")} failed with code ${result.status ?? "unknown"}`,
      );
    }

    // The Windows packager is occasionally interrupted by the GitHub connection when downloading NSIS resources. The electron-builder will report such transient network errors.
    // Unifiedly folded into ERR_ELECTRON_BUILDER_CANNOT_EXECUTE, causing the pipeline to misjudge recoverable jitter as configuration failure.
    // Here, only a limited number of retries are made for download signals, which not only improves the stability of the first round of cache misses, but also avoids swallowing real build errors indefinitely.
    console.warn(
      `[bundle] electron-builder failed to download resources, try again after ${electronBuilderRetryDelayMs}ms (${attempt}/${electronBuilderRetryCount})`,
    );
    await sleep(electronBuilderRetryDelayMs);
  }
}

function resolveAppAsarPath(os, arch) {
  if (os === "mac") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "mac-arm64" : "mac",
      `${desktopProductIdentity.productName}.app`,
      "Contents",
      "Resources",
      "app.asar",
    );
  }

  if (os === "win") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
      "resources",
      "app.asar",
    );
  }

  if (os === "linux") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
      "resources",
      "app.asar",
    );
  }

  throw new Error(`Unsupported target operating system: ${os}`);
}

function verifyPackagedRuntimeDependencies(os, arch) {
  const appAsarPath = resolveAppAsarPath(os, arch);
  if (!existsSync(appAsarPath)) {
    throw new Error(`The packaged product is missing app.asar: ${appAsarPath}`);
  }

  // Under pnpm hoisted dependency layout, electron-builder may load the runtime code body into app.asar.
  // But it misses the sub-dependencies that it still needs to find in the root node_modules when actually parsing.
  // Module-details-from-path was missing here before, but this time @fiahfy/icns is missing pngjs.
  // The result is that the installation package can be generated, but the main process crashes because of Cannot find module after the user starts it.
  // Here, a mechanical check is done after the bundle to prevent bad packages from continuing to flow out.
  const asarEntriesWithPackState = parseAsarListWithPackState(
    // pnpm exec will mix workspace engine warning into stdout, and strict asar line parsing will misjudge failure.
    // Execute the locked version of the CLI directly so that stdout only contains asar pack state, without relying on relaxing the parser to swallow unknown output.
    runAndReadStdout(process.execPath, [asarCliPath, "list", "--is-pack", appAsarPath]),
  );
  const asarEntries = asarEntriesWithPackState.map((entry) => entry.path);

  const targetPlatformKey = `${os === "mac" ? "darwin" : os === "win" ? "win32" : os}-${arch}`;
  const nativePackageViolations = findDesktopNativePackageViolations(
    asarEntriesWithPackState,
    targetPlatformKey,
  );
  if (nativePackageViolations.length > 0) {
    // In addition to afterPack, do a mechanical verification of the final unpacked product to avoid subsequent hooks or builders
    // Re-introduce native to other platforms, or write the unpack file back to app.asar payload.
    throw new Error(
      `The packaged product contains out-of-bounds native resources:\n- ${nativePackageViolations.join("\n- ")}`,
    );
  }

  const runtimeModules = collectRuntimeModuleClosureEntries(
    requiredRuntimeModules,
    runtimeModuleLookupRoots,
  );
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // afterPack will inject dependencies according to the actual resolvable dependencies of the current platform; bundle verification must also maintain the same caliber.
      // Otherwise in some CI installation layouts you will get a false positive of "Injection phase skipped, but verification phase still hard failed".
      console.warn(
        `[bundle] runtime module not found in workspace, skip verify: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });

  for (const { moduleName } of resolvableRuntimeModules) {
    const moduleRoot = `/node_modules/${moduleName}`;
    // @electron/asar will generate a backslash path through path.join in the following directories on Windows.
    // Previously, exact matching was performed based on the POSIX path. As a result, the module was actually entered into app.asar, but the verification was still falsely reported as missing.
    // First normalize them to forward slashes to prevent the Windows packager from being accidentally damaged by this mechanical verification.
    const hasModule = asarEntries.some(
      (entry) => entry === moduleRoot || entry.startsWith(`${moduleRoot}/`),
    );

    if (!hasModule) {
      // The verification is also expanded based on dependency closures to ensure that if the afterPack injection logic omits sub-dependencies, it can directly fail in the bundle phase.
      throw new Error(
        `The packaged product is missing runtime dependency ${moduleName}: ${appAsarPath}`,
      );
    }
  }
}

async function main() {
  const { os, arch, skipPrepare, skipBuild, dryRun } = parseArgs(process.argv.slice(2));
  const buildArgs = [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.config.js",
    osBuilderFlagMap[os],
    archBuilderFlagMap[arch],
  ];

  console.log(`[bundle] target=${os}/${arch}`);
  console.log(`[bundle] skipPrepare=${skipPrepare} skipBuild=${skipBuild}`);

  const buildEnv = {
    ZCODE_TARGET_OS: os,
    ZCODE_TARGET_ARCH: arch,
    ...createElectronRuntimeMirrorEnv(resolveElectronMirror()),
    ...createElectronBuilderBinariesMirrorEnv(resolveElectronBuilderBinariesMirror()),
  };

  if (dryRun) {
    console.log(`[bundle] dry-run: ${pnpmCommand} ${buildArgs.join(" ")}`);
    process.exit(0);
  }

  if (!skipPrepare) {
    run(pnpmCommand, ["prepare:runtime-assets"], buildEnv);
  }

  if (!skipBuild) {
    run(pnpmCommand, ["build"], buildEnv);
  }

  await runTimedAsync("bundle:electron-builder", () =>
    runElectronBuilderWithRetry(buildArgs, buildEnv),
  );

  runTimedSync("bundle:verify-runtime-dependencies", () =>
    verifyPackagedRuntimeDependencies(os, arch),
  );

  const artifactPath = findBuiltArtifact(os, arch);
  runTimedSync("bundle:audit-bundle-size", () =>
    run(process.execPath, [
      resolve(desktopRoot, "scripts", "audit-bundle-size.mjs"),
      "--artifact-path",
      artifactPath,
    ]),
  );
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(`[bundle] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
