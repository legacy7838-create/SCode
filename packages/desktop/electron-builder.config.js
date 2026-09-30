/* eslint-disable max-lines -- Electron Builder config keeps related packaging hooks together so build order stays explicit. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runCommand, runCommandAndReadStdout } from "../../scripts/spawn-command.mjs";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { noticesFileName, stageElectronNotices } from "../../scripts/third-party-notices.mjs";
import { resolveNativeSearchReleasePlan } from "../../scripts/native-search-tools-config.mjs";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { collectRuntimeModuleClosureEntries } from "./scripts/runtime-dependency-closure.mjs";
import {
  resolvePackagedNodePtyPrebuildPath,
  restoreTargetNodePtyPrebuild,
} from "./scripts/node-pty-package-assets.mjs";
import { cleanupPackagedSourcemaps } from "./scripts/packaged-sourcemap-cleanup.mjs";
import { getTargetPlatform } from "./scripts/target-platform.mjs";
import {
  resolveDesktopArtifactSuffix,
  resolveDesktopProductIdentity,
} from "./scripts/desktop-product-identity.mjs";
import { verifyStagedKoffi } from "./scripts/koffi-package-assets.mjs";
const ELECTRON_BUILDER_ARCH = {
  1: "x64",
  3: "arm64",
};
function resolveElectronBuilderWindowsTarget({
  electronPlatformName,
  arch,
  configuredTargetPlatform,
}) {
  if (electronPlatformName !== "win32") {
    throw new Error(
      `[electron-builder.config] context platform is not win32: ${String(electronPlatformName)}`,
    );
  }
  const actualArch = ELECTRON_BUILDER_ARCH[arch];
  if (!actualArch) {
    throw new Error(
      `[electron-builder.config] unsupported electron-builder Windows architecture: ${String(arch)}`,
    );
  }
  const actualTarget = {
    os: "win32",
    arch: actualArch,
    key: `win32-${actualArch}`,
  };
  if (
    configuredTargetPlatform?.os !== actualTarget.os ||
    configuredTargetPlatform?.arch !== actualTarget.arch ||
    configuredTargetPlatform?.key !== actualTarget.key
  ) {
    throw new Error(
      `[electron-builder.config] configured target ${String(configuredTargetPlatform?.key)} does not match electron-builder target ${actualTarget.key}`,
    );
  }
  return actualTarget;
}
import {
  findDesktopNativePackageViolations,
  createDesktopNativePackagePrunePatterns,
  parseAsarListWithPackState,
} from "./scripts/desktop-native-package-policy.mjs";
import { replaceAppAsarFromStaging } from "./scripts/app-asar-repack.mjs";
import {
  patchNsisInstallSectionFile,
  restoreNsisInstallSectionFileSync,
} from "./scripts/patch-nsis-install-section.mjs";

const buildMetadata = getBuildMetadata();
const targetPlatform = getTargetPlatform();
const builtinProviderConfig = await loadBuiltinProviderConfig();
const desktopProductIdentity = resolveDesktopProductIdentity({
  ...process.env,
  ZCODE_ENV: builtinProviderConfig.environment,
});
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: targetPlatform.os,
  arch: targetPlatform.arch,
});
const rawMacSigningIdentity = process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME;
const macSigningIdentity =
  rawMacSigningIdentity?.replace(/^Developer ID Application:\s*/, "") ?? null;
const shouldEnableMacSigning =
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" && Boolean(macSigningIdentity);
const workspaceRoot = resolve(import.meta.dirname, "../..");
const desktopPackageRoot = import.meta.dirname;
const runtimeModuleLookupRoots = [
  desktopPackageRoot,
  workspaceRoot,
  resolve(desktopPackageRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
// `pnpm exec asar` relies on `.bin/asar`, but when @electron/asar is only a transitive
// dependency of electron-builder, Linux CI (pnpm hoisted) often cannot resolve the binary,
// causing `asar list` to exit 1 before running. Explicitly depend on @electron/asar and
// execute its CLI directly with Node to avoid cross-platform shim resolution issues.
const requireFromConfig = createRequire(import.meta.url);
let nsisInstallSectionPatched = false;
let nsisInstallSectionOriginalSource = null;
let nsisInstallSectionPath = null;
const desktopElectronVersion = requireFromConfig("./package.json").devDependencies.electron;
const asarCliPath = resolve(
  dirname(requireFromConfig.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const REQUIRED_ASAR_RUNTIME_MODULES = [
  "module-details-from-path",
  "@opentelemetry/api-logs",
  // Bugfix: the telemetry OTLP exporter loads sdk-metrics during startup. In pnpm dev mode
  // it resolves from the workspace root, but electron-builder does not reliably copy this
  // hoisted dependency, causing the installed app to crash on launch. Inject sdk-metrics as
  // a closure root to recursively pull in its OpenTelemetry runtime dependencies.
  "@opentelemetry/sdk-metrics",
  // OTLP proto exporter chain closure root: recursively pull in otlp-transformer/protobufjs
  // and their sub-dependencies, otherwise when the hoisted layout misses protobufjs the
  // installed app crashes on launch with Cannot find module 'protobufjs/minimal'.
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "pngjs",
  // @zcode/services proxy connectivity probe dynamically requires("undici") for ProxyAgent.
  // tsup bundles services code into the main/host output but does not inline this runtime
  // require target; electron-builder may also miss the hoisted undici, causing the mac
  // installer to crash on launch with Cannot find module "undici". Inject undici into
  // app.asar like other fallback dependencies to prevent main process crashes in the
  // installed app.
  "undici",
  // node-forge has only been listed in bundle.mjs's verification checklist, relying on
  // electron-builder to include it in app.asar. This is the same class of risk as yauzl
  // missing pend — modules required by verification must have a clear owner. node-forge
  // has no sub-dependencies; afterPack scanning skips it when already present, leaving
  // existing packaging results unchanged.
  "node-forge",
  // Since 2.7.0, services added a feedback log compression path introducing yazl; 2.6.0
  // does not have this startup dependency. Under the pnpm hoisted layout yazl may land in
  // app.asar but its sub-dependency buffer-crc32 is not reliably included. Inject yazl as
  // a closure root here so recursive dependency collection pulls in all ZIP packaging
  // chain dependencies.
  "yazl",
  // After yauzl became a direct production dependency of desktop/services, pnpm list --prod
  // dedupes the top-level yauzl node into an empty node without sub-dependencies.
  // electron-builder's pnpm collector uses the first registered empty node and skips the
  // later one with a complete sub-tree, so app.asar contains yauzl but not its runtime
  // dependency pend, only surfacing "missing runtime dependency pend" during bundle
  // verification. Inject yauzl as a closure root here, consistent with bundle.mjs's
  // verification checklist, so recursive dependency collection pulls pend into the output.
  "yauzl",
  // Bugfix: after the Feishu SDK was externalized from desktop main/host, the installed
  // app runtime must resolve it from app.asar. Explicitly inject the scoped package here
  // to avoid the dev mode working but the production package crashing on launch with
  // Cannot find module.
  "@larksuiteoapi/node-sdk",
  // In production, ssh2 is packed into app.asar but its dependency chain is occasionally
  // missed by electron-builder. Online errors like Cannot find module 'asn1'
  // (Require stack: ssh2 keyParser) have occurred. Inject ssh2's key dependency chain here
  // to prevent remote SSH connections from failing outright due to missing packages in
  // the installed app.
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // electron-updater → builder-util-runtime → debug runtime require("ms"). Under the pnpm
  // hoisted layout electron-builder occasionally misses this leaf dependency; 3.4.0
  // (ci/cua-v0.3.17) already triggered online crashes with Cannot find module 'ms'
  // (Require stack: debug/src/common.js), breaking the auto-update chain. ms is a leaf
  // package; explicitly injecting it lets debug resolve reliably inside app.asar.
  "ms",
];
// pacman dependencies must use package names from the Arch official repositories.
// electron-builder's legacy default set includes removed packages like
// libappindicator-gtk3/http-parser and lacks runtime libraries Electron actually needs;
// explicitly maintain a minimal runtime closure to avoid pacman -U dependency resolution
// failures or missing libraries surfacing only at startup.
const PACMAN_RUNTIME_DEPENDENCIES = [
  "gtk3",
  "nss",
  "libxss",
  "libxtst",
  "libnotify",
  "alsa-lib",
  "mesa",
  "xdg-utils",
];

const WINDOWS_INSTALL_MANIFEST_NAME = ".zcode-install-manifest";

async function writeWindowsInstallManifest(context) {
  if (context.electronPlatformName !== "win32") return;

  const root = context.appOutDir;
  const files = [];
  const visit = async (directory, relativeDirectory = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relativePath.replaceAll("/", "\\"));
      }
    }
  };

  await visit(root);
  files.sort();
  await writeFile(join(root, WINDOWS_INSTALL_MANIFEST_NAME), `${files.join("\r\n")}\r\n`, "utf8");
}

function resolveElectronDownloadMirror(env = process.env) {
  const existingMirror =
    env.ZCODE_ELECTRON_RUNTIME_MIRROR ||
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

const commandStdoutMaxBuffer = 64 * 1024 * 1024;
// The artifact suffix only marks the backend environment (_TEST); identity is distinguished
// by productName — the production backend Preview package has no suffix.
const desktopArtifactEnvSuffix = resolveDesktopArtifactSuffix(process.env);

// Preview is an internal signing test package. When CI explicitly enables macOS signing
// without an identity, it must fail before generating an unsigned package, so that
// "artifact exists" is not mistaken for having completed the same signing chain as the
// production build.
if (
  desktopProductIdentity.flavor === "preview" &&
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" &&
  !macSigningIdentity
) {
  throw new Error(
    "ZCode Preview macOS packaging requires APPLE_SIGNING_IDENTITY or CSC_NAME when ZCODE_ENABLE_MAC_SIGN=1",
  );
}

const PACKAGING_PRUNE_PATTERNS = [
  "!**/*.map",
  "!**/*.pdb",
  "!**/__tests__/**",
  "!**/test/**",
  "!**/tests/**",
  "!**/example/**",
  "!**/examples/**",
  "!**/README*",
  "!**/CHANGELOG*",
  "!**/CONTRIBUTING*",
  "!**/CODE_OF_CONDUCT*",
  "!**/SECURITY*",
];

function buildDesktopArtifactName(platformName, extension = "${ext}") {
  // Test environment artifacts must have distinct filenames from production installers
  // to avoid mixing them during upload, download, or manual acceptance testing.
  return `\${productName}-\${version}-${platformName}-\${arch}${desktopArtifactEnvSuffix}.${extension}`;
}

function runAsarCommand(args) {
  runCommand(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
  });
}

function runAsarCommandAndReadStdout(args) {
  return runCommandAndReadStdout(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
    // The current desktop app.asar is large; `asar list` output may exceed the default
    // buffer and trigger ENOBUFS. Explicitly increase the buffer here to avoid the
    // "check whether injection is needed" step itself failing the packaging flow.
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
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

function resolveAppAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources", "app.asar");
  }

  return resolve(context.appOutDir, "resources", "app.asar");
}

function resolvePackagedResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources");
  }

  return resolve(context.appOutDir, "resources");
}

function normalizeAsarEntry(entry) {
  return entry.trim().replaceAll("\\", "/");
}

function resolveMissingRuntimeModules(appAsarPath) {
  const asarEntries = runAsarCommandAndReadStdout(["list", appAsarPath])
    .split("\n")
    .map(normalizeAsarEntry)
    .filter(Boolean);
  const asarEntrySet = new Set(asarEntries);

  const runtimeModules = collectRuntimeModuleClosureEntries(
    REQUIRED_ASAR_RUNTIME_MODULES,
    runtimeModuleLookupRoots,
  );
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // Under different platforms/installation layouts, some runtime dependencies may be
      // pruned or not present in this packaging workspace. Previously this threw during
      // the copy phase, interrupting the entire platform build; now it logs a warning and
      // skips the module, letting afterPack only handle dependencies actually resolvable in
      // the current environment, avoiding full CI failure from a single missing optional
      // dependency.
      console.warn(
        `[afterPack] runtime module not found, skip injection: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });
  return resolvableRuntimeModules.filter((entry) => {
    const { moduleName } = entry;
    const moduleRoot = `/node_modules/${moduleName}`;
    if (asarEntrySet.has(moduleRoot)) {
      return false;
    }
    for (const entry of asarEntrySet) {
      if (entry.startsWith(`${moduleRoot}/`)) {
        return false;
      }
    }
    return true;
  });
}

async function injectHoistedRuntimeModulesIntoAsar(context) {
  const appAsarPath = resolveAppAsarPath(context);
  if (!existsSync(appAsarPath)) {
    throw new Error(`The packaged product is missing app.asar: ${appAsarPath}`);
  }

  const missingRuntimeModules = runTimedSync("afterPack:scan-missing-runtime-modules", () =>
    resolveMissingRuntimeModules(appAsarPath),
  );
  if (missingRuntimeModules.length === 0) {
    // Previously afterPack fully extracted/repacked app.asar every time, even when runtime
    // dependencies were already complete. This added ten to tens of seconds to every build.
    // Now scan for missing modules first and only run the rewrite flow when packages are
    // actually missing.
    console.log("[afterPack] runtime modules already complete, skip app.asar rewrite");
    return;
  }
  console.log(`[afterPack] missing runtime modules count=${missingRuntimeModules.length}`);

  // CI may point TMPDIR to a project-local .tmp directory that GitLab get_sources/clean
  // could delete before the script starts. The app.asar rewrite in afterPack also relies
  // on mkdtempSync and must create the parent directory itself, so the subsequent signing
  // stage does not see the .app disappear.
  mkdirSync(tmpdir(), { recursive: true });
  const stagingDir = mkdtempSync(resolve(tmpdir(), "zcode-app-asar-"));
  try {
    runTimedSync("afterPack:asar-extract", () =>
      runAsarCommand(["extract", appAsarPath, stagingDir]),
    );

    const stagingNodeModulesDir = resolve(stagingDir, "node_modules");
    mkdirSync(stagingNodeModulesDir, { recursive: true });

    runTimedSync("afterPack:copy-runtime-modules", () => {
      for (const runtimeModule of missingRuntimeModules) {
        const { moduleName, sourceModulePath } = runtimeModule;
        const targetModulePath = resolve(stagingNodeModulesDir, moduleName);

        if (!sourceModulePath) {
          throw new Error(
            `Runtime dependency not found: ${moduleName}, searched: ${runtimeModuleLookupRoots
              .map((lookupRoot) => resolve(lookupRoot, "node_modules", moduleName))
              .join(", ")}`,
          );
        }

        // Under the pnpm hoisted layout, electron-builder may pack the main package into
        // app.asar but miss runtime dependencies it resolves from the root node_modules.
        // Previously require-in-the-middle missed module-details-from-path; this time
        // @fiahfy/icns missed pngjs — both triggered Cannot find module in the installed
        // app and crashed the main process on startup. Recursively complete the dependency
        // closure via package.json here, instead of patching one missing package at a time
        // and discovering the next sub-dependency after release. Relying solely on
        // package.json explicit dependencies, local node_modules mirroring, or files
        // include has not reliably placed these into asar, so during afterPack directly
        // rewrite app.asar to inject these runtime packages first, then hand off to signing
        // and packaging.
        mkdirSync(dirname(targetModulePath), { recursive: true });
        rmSync(targetModulePath, { force: true, recursive: true });
        cpSync(sourceModulePath, targetModulePath, { recursive: true });
      }
    });

    await runTimedAsync("afterPack:asar-pack", () =>
      replaceAppAsarFromStaging({
        sourceDir: stagingDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
    );
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

async function stripPackagedSourcemapReferences(context) {
  // electron-builder's files rules can exclude .map files but cannot strip sourceMappingURL
  // comments at the end of JS/CSS; afterPack runtime dependency injection may also reintroduce
  // third-party sourceMappingURL entries. Clean both app.asar and unpacked/extraResources
  // here to ensure the final release package does not expose sourcemap path entries.
  await cleanupPackagedSourcemaps({
    appAsarPath: resolveAppAsarPath(context),
    resourcesDir: resolvePackagedResourcesDir(context),
    runAsarCommand,
    runTimedSync,
    runTimedAsync,
    replaceAppAsarFromStaging: ({ sourceDir, appAsarPath }) =>
      replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
  });
}

function assertPackagedNativeResourcePolicy(context) {
  const appAsarPath = resolveAppAsarPath(context);
  const entries = parseAsarListWithPackState(
    runAsarCommandAndReadStdout(["list", "--is-pack", appAsarPath]),
  );
  const violations = findDesktopNativePackageViolations(entries, targetPlatform.key);
  if (violations.length > 0) {
    // supportedArchitectures allows the workspace to prepare multi-platform dependencies,
    // but the installer can only carry target-platform resources. Previously other-platform
    // native binaries for Canvas and node-pty were written into asar/unpacked together,
    // bloating the package by hundreds of MiB.
    throw new Error(
      `Desktop native resource boundary validation failed:\n- ${violations.join("\n- ")}`,
    );
  }
}

function assertPackagedNodePtyPrebuild(context) {
  const targetBinaryPath = resolvePackagedNodePtyPrebuildPath({
    resourcesDir: resolvePackagedResourcesDir(context),
    platformKey: targetPlatform.key,
  });
  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty prebuilt artifact missing: ${targetBinaryPath}`);
}

/** @type {import("electron-builder").Configuration} */
export default {
  appId: desktopProductIdentity.appId,
  // Linux deb packaging (fpm) validates homepage, author.email, and maintainer in package
  // metadata. In CI, missing fields cause the artifact stage to fail directly. Set them
  // here in the build config to avoid relying on external injection.
  extraMetadata: {
    version: buildMetadata.appVersion,
    zcodeProductFlavor: desktopProductIdentity.flavor,
    homepage: "https://zcode.z.ai",
    author: {
      name: "ZCode",
      email: "dev@zcode.z.ai",
    },
  },
  // The macOS signing phase codesigns each language pack under Electron Framework
  // individually. The default full language set produces many locale.pak signing calls,
  // significantly extending packaging time. Keep only the languages the current product
  // needs here to reduce signed file count and shorten total CI time.
  electronLanguages: ["en-US", "zh-CN"],
  // Under pnpm workspace + semver ranges (e.g. ^41.0.3), electron-builder sometimes
  // cannot reliably derive the Electron version from the dependency tree, causing the
  // bundle to fail outright. Explicitly pin the Electron version used by the desktop
  // app to avoid unreliable guesses during packaging.
  electronVersion: "41.0.3",
  electronDownload: {
    // ELECTRON_MIRROR is a global environment variable for @electron/get that overrides
    // mirrorOptions passed by generic artifacts like dmg-builder, causing builder helper
    // packages to be incorrectly placed under the Electron runtime mirror directory. Use
    // electron-builder's dedicated config here to only affect Electron runtime zip
    // downloads.
    mirror: resolveElectronDownloadMirror(),
  },
  productName: desktopProductIdentity.productName,
  directories: {
    // macOS arm64/x64 CI may share the same checkout for parallel packaging. The output
    // root can be isolated per architecture to avoid one job deleting another job's .app
    // (being signed) when cleaning dist.
    output: desktopDistDir,
    buildResources: "build",
  },
  files: [
    "out/**/*",
    "package.json",
    // app.asar includes the desktop runtime node_modules; dependency-provided .map /
    // README files would enter the installer as-is. Prune them uniformly at the main package
    // level here — only removing non-runtime files, keeping LICENSE.
    ...PACKAGING_PRUNE_PATTERNS,
    ...createDesktopNativePackagePrunePatterns(targetPlatform.key),
    "!node_modules/@zcode/**",
    "!node_modules/react/**",
    "!node_modules/react-dom/**",
  ],
  asarUnpack: [
    // node-pty's target prebuild also contains auxiliary executables like spawn-helper /
    // winpty-agent.exe, so the entire target directory must be unpacked; other platform
    // directories are already pruned by files rules.
    `node_modules/node-pty/prebuilds/${targetPlatform.key}/**`,
  ],
  beforePack: async (context) => {
    runTimedSync("beforePack:restoreTargetNodePtyPrebuild", () =>
      restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }),
    );
    if (context.electronPlatformName !== "win32" || nsisInstallSectionPatched) {
      return;
    }

    nsisInstallSectionPath = resolve(
      dirname(requireFromConfig.resolve("app-builder-lib/package.json")),
      "templates",
      "nsis",
      "installSection.nsh",
    );
    const patchResult = await runTimedAsync("beforePack:patchNsisInstallSection", () =>
      patchNsisInstallSectionFile(nsisInstallSectionPath),
    );
    nsisInstallSectionPatched = true;
    nsisInstallSectionOriginalSource = patchResult.originalSource;
    if (patchResult.changed) {
      // electron-builder compiles NSIS later within the same process; restore the upstream
      // template in node_modules after the entire build process exits, to avoid leaving
      // one-off packaging customizations permanently in the dev dependency.
      process.once("exit", () => {
        restoreNsisInstallSectionFileSync({
          filePath: nsisInstallSectionPath,
          originalSource: nsisInstallSectionOriginalSource,
        });
      });
    }
  },
  afterExtract: async (context) => {
    // Fix: the macOS rename phase deletes the archive top-level license; must preserve the
    // target-platform original in afterExtract.
    const framework = context.packager.info.framework;
    const resources =
      context.electronPlatformName === "darwin"
        ? resolve(context.appOutDir, framework.distMacOsAppName, "Contents", "Resources")
        : resolve(context.appOutDir, "resources");
    await stageElectronNotices(context.appOutDir, resources, framework.version);
  },
  afterPack: async (context) => {
    const actualWindowsTarget =
      context.electronPlatformName === "win32"
        ? resolveElectronBuilderWindowsTarget({
            electronPlatformName: context.electronPlatformName,
            arch: context.arch,
            configuredTargetPlatform: targetPlatform,
          })
        : null;
    await runTimedAsync("afterPack:injectHoistedRuntimeModulesIntoAsar", () =>
      injectHoistedRuntimeModulesIntoAsar(context),
    );
    await runTimedAsync("afterPack:stripPackagedSourcemapReferences", () =>
      stripPackagedSourcemapReferences(context),
    );
    runTimedSync("afterPack:assertPackagedNativeResourcePolicy", () =>
      assertPackagedNativeResourcePolicy(context),
    );
    runTimedSync("afterPack:assertPackagedNodePtyPrebuild", () =>
      assertPackagedNodePtyPrebuild(context),
    );
    if (actualWindowsTarget) {
      await runTimedAsync("afterPack:writeWindowsInstallManifest", () =>
        writeWindowsInstallManifest(context),
      );
    }
  },
  extraResources: [
    { from: resolve(workspaceRoot, noticesFileName), to: noticesFileName },
    ...(targetPlatform.os === "darwin"
      ? [
          {
            // CUA permission panel snap data source (CGWindowListCopyWindowInfo, requires no
            // TCC permissions). The main process resolves via process.resourcesPath; when
            // missing, the watcher fail-opens and the panel still works but without snapping,
            // so no existence assertion is made here.
            from: "resources/macos-window-bounds/zcode-window-bounds",
            to: "macos-window-bounds/zcode-window-bounds",
          },
        ]
      : []),
    {
      // Production packages cannot rely on the repository directory for built-in fallback
      // configs like community and feedback. Explicitly place under resources/config,
      // consistent with the main process's process.resourcesPath resolution.
      from: resolve(workspaceRoot, "config/default.json"),
      to: "config/default.json",
    },
    {
      // Provider Registry's ZCode Built-in Config is the only built-in source of static
      // Provider/Model facts. Ship it explicitly with the package to prevent production Host
      // from falling back to the old Catalog/Preset hardcode.
      from: builtinProviderConfig.sourcePath,
      to: "config/provider/zcode-builtin.json",
    },
    {
      // App icon: placed in the resources directory after packaging; the main process loads
      // it via process.resourcesPath
      from: "build/icon.png",
      to: "icon.png",
    },
    ...(targetPlatform.os === "linux"
      ? [
          {
            // AppImage user-level hicolor icon installation uses the real 512x512 resource to
            // avoid mismatch between the declared directory size and the PNG IHDR.
            from: "build/icons/512x512.png",
            to: "icon_512x512.png",
          },
        ]
      : []),
    {
      // Windows dedicated icon: both dev and packaged modes use the same taskbar/window
      // icon resource set.
      from: "build/icon_windows.png",
      to: "icon_windows.png",
    },
    ...(targetPlatform.os === "win32"
      ? [
          {
            // Windows tray icon: Tray can only reliably read the dedicated resource under
            // resources in packaged mode. Do not reuse the window PNG here to avoid blurry
            // scaled images in the notification area at high DPI.
            from: "build/icon.ico",
            to: "tray_icon.ico",
          },
        ]
      : []),
    {
      // Agent runtime assets, packaged into resources/glm.
      // The desktop bundles the agent JS bundle (glm/zcode.cjs, generated by
      // prepare:agent-bundle); the Host process runs `zcode.cjs app-server --stdio` using the
      // app's bundled Electron Node runtime (ELECTRON_RUN_AS_NODE). A standalone Node
      // binary is no longer bundled. Remote SSH/WSL still uses the native binary (without
      // Electron).
      from: `bundled-agents/${targetPlatform.key}/glm`,
      to: "glm",
      filter: ["**/*", "!**/*.map"],
    },
    {
      // The agent shell previously relied entirely on the host system PATH, often failing to
      // find the user's own rg on GUI startup. Package ripgrep as a desktop built-in runtime
      // tool under resources/tools; later host/server appends this directory to PATH. The
      // user's version takes priority; the bundled rg serves as fallback when missing.
      from: `bundled-tools/${targetPlatform.key}/ripgrep`,
      to: "tools/ripgrep",
      filter: ["**/*"],
    },
    ...nativeSearchReleasePlan.extraResourceToolIds.map((toolId) => ({
      from: `bundled-tools/${targetPlatform.key}/${toolId}`,
      to: `tools/${toolId}`,
      filter: ["**/*"],
    })),
  ],
  // postinstall first reuses node-pty's bundled Windows prebuilt artifacts, then runs
  // electron-rebuild on other platforms as needed. During packaging, uniformly reuse the
  // native files prepared at install time to avoid electron-builder triggering another
  // uncontrolled local compilation.
  npmRebuild: false,
  // OAuth deep link protocol registration (macOS packaging requires CFBundleURLTypes
  // declared in Info.plist)
  protocols: [
    {
      // The protocol handler display name previously used the lowercase scheme, so the
      // protocol description in the packaged artifact did not reflect the product name. The
      // display name now follows the installer identity; the scheme remains zcode, so the
      // last registered app becomes the default handler among the two.
      name: desktopProductIdentity.productName,
      schemes: ["zcode"],
    },
  ],
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    artifactName: buildDesktopArtifactName("mac"),
    extendInfo: {
      NSAppleEventsUsageDescription: `${desktopProductIdentity.productName} needs Apple Events access to coordinate local automation workflows with user-approved desktop apps.`,
    },
    // The pre-sign script uses native codesign, which requires the full
    // "Developer ID Application: ..." identity string; but electron-builder's mac.identity
    // rejects names with this prefix in 26.x. Normalize the prefix only on the
    // electron-builder side here to avoid local pre-signing conflicting with the final .app
    // signing. Previously z-code only had local unsigned packaging config; even when CI
    // injected certificate variables, electron-builder would not automatically switch to
    // the hardened runtime / entitlement release parameters. Consolidate this behind an
    // environment switch here to keep local dev unconstrained by signing config while
    // enabling it on demand for CI releases.
    identity: shouldEnableMacSigning ? macSigningIdentity : null,
    // macOS artifacts use a two-stage pipeline: "build-phase signing + separate notarization
    // phase". If electron-builder's built-in notarize is not explicitly disabled here, it
    // reads Apple credentials during the build phase and attempts notarization directly,
    // forcing APPLE_APP_SPECIFIC_PASSWORD and failing before the DMG is produced.
    notarize: false,
    hardenedRuntime: shouldEnableMacSigning,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // Runtime executables are already signed in a separate pre-sign phase before packaging.
    // If electron-builder continues to deep-scan these directories when signing the main
    // app, it significantly extends macOS codesign time. Match absolute paths by "any
    // prefix + Contents/Resources" here to avoid ^Contents/... failing to match in CI.
    // On match, skip redundant signing/traversal of pre-signed directories while keeping
    // main app and framework signing. The CUA Helper has already completed Developer ID
    // signing and notarization staple in a separate job; electron-builder re-signing the
    // nested Helper would change the CDHash and invalidate the staple in the final user
    // package.
    signIgnore: [
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]glm([/\\\\]|$)",
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]tools([/\\\\]|$)",
    ],
  },
  win: {
    target: ["nsis"],
    artifactName: buildDesktopArtifactName("win"),
  },
  linux: {
    target: ["AppImage", "deb", "rpm", "pacman"],
    artifactName: buildDesktopArtifactName("linux"),
    // The desktop package name is a scoped package (@zcode/desktop); electron-builder
    // defaults the Linux executable/Icon to @zcodedesktop. Some desktop environments cannot
    // match the hicolor icon by this icon name and fall back to the system gear. Fix it to
    // a stable lowercase name here so Icon=zcode stays consistent with
    // /usr/share/icons/hicolor/*/apps/zcode.png.
    executableName: desktopProductIdentity.linuxExecutableName,
    category: "Development",
    maintainer: "ZCode <dev@zcode.z.ai>",
  },
  deb: {
    // Production and Preview must be two separate dpkg packages; only changing the
    // executable name would still let the installer treat the other version as an upgrade
    // replacement.
    packageName: desktopProductIdentity.linuxPackageName,
  },
  pacman: {
    // Maintain the same flavor isolation as deb/rpm to avoid Preview/Production being
    // overwritten as the same package by pacman.
    packageName: desktopProductIdentity.linuxPackageName,
    // Explicitly list Arch official repository-resolvable Electron runtime dependencies,
    // replacing electron-builder's outdated default set to avoid install-phase failures from
    // removed package names.
    depends: PACMAN_RUNTIME_DEPENDENCIES,
    // Electron Builder names the pacman target .pacman by default; the standard extension
    // for Arch native packages is .pkg.tar.zst.
    artifactName: buildDesktopArtifactName("linux", "pkg.tar.zst"),
  },
  rpm: {
    // Same constraint as deb: Production and Preview must be two separate rpm packages,
    // otherwise dnf treats the other flavor as an upgrade replacement. rpm targets RHEL 8+
    // (glibc 2.28) distribution; the overall glibc floor is raised to 2.28 by node-pty
    // prebuild and bfs/ugrep, while the Electron 41 main binary only references up to 2.25,
    // never higher. fpm-produced rpm requires rpmbuild and xz on the build machine.
    packageName: desktopProductIdentity.linuxPackageName,
    // electron-builder's default rpm Requires (gtk3/nss/libXtst etc.) does not include the
    // mesa-libgbm and alsa-lib that Electron ELF actually DT_NEEDEDs; a rockylinux:8
    // minimal container was verified to fail at startup with libgbm.so.1 missing after
    // installation. Use fpm to append -d here (accumulating after the default Requires);
    // do not use depends — depends replaces the entire default Requires set.
    fpm: ["-d", "mesa-libgbm", "-d", "alsa-lib"],
  },
  dmg: {
    // The current installer's bundled runtime resources (especially agent node_modules)
    // exceed the default DMG size estimate. When relying on auto-sizing, the generated DMG
    // volume was only about 1.9Gi, and copying .app would run out of space, losing the
    // Electron Framework main binary and causing DYLD Library missing on startup after
    // installation. Explicitly increase DMG capacity to avoid copy truncation causing
    // "Framework directory exists but core files missing".
    size: "3200m",
    // Use a custom installer background image.
    background: "build/dmg_background.png",
    // The installer volume icon uniformly uses dedicated installer artwork to avoid
    // reusing the app icon and reducing installer recognizability.
    icon: "build/icon_installer.icns",
    contents: [
      // Experimental adjustment: explicitly specify icon coordinates for hidden resource
      // files to move them toward the corner area.
      { x: 640, y: 56, type: "file", path: ".background.tiff" },
      { x: 640, y: 56, type: "file", path: ".VolumeIcon.icns" },
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // The Windows installer flow uses a dedicated installer icon, decoupled from the app
    // runtime icon.
    installerIcon: "build/icon_installer.ico",
    uninstallerIcon: "build/icon_installer.ico",
    installerHeaderIcon: "build/icon_installer.ico",
  },
  detectUpdateChannel: false,
  publish: {
    provider: "generic",
    // The current OSS/CDN returns 206 for multi-range requests, but Content-Type remains
    // application/x-msdownload, so electron-updater falls back to full-package download due
    // to missing multipart/byteranges. With multiple range disabled, differential updates
    // still work — just fetching diff blocks sequentially by single range — avoiding Windows
    // users regressing from ~15MB to 300MB+ full packages during updates.
    useMultipleRangeRequest: false,
    // The new client runtime uses the server-side manifest provider; only the generic
    // publish placeholder required by electron-builder is kept here, to avoid the packaged
    // artifact continuing to carry the configurable old stable feed.
    url: "http://localhost:8081",
  },
};
