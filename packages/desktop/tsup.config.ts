import { pickProductEndpointEnv } from "@zcode/shared/zcodeEndpoint";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
// tsup will package the configuration file first; dynamically load the build tool to prevent its import.meta.dirname from being relocated to the desktop.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);

const buildMetadata = getBuildMetadata();

// Manually load .env files, tsup does not automatically read .env.* unlike Vite; these files only provide link constants.
function loadEnvFiles(): Record<string, string> {
  const vars: Record<string, string> = {};
  const files = ["../../.env", "../../.env.local"];
  if (process.env.NODE_ENV === "production") {
    files.push("../../.env.production");
  } else {
    files.push("../../.env.development", "../../.env.development.local");
  }
  for (const file of files) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  // Real environment variables have the highest priority
  if (process.env.ZCODE_ENV) vars.ZCODE_ENV = process.env.ZCODE_ENV;
  if (process.env.ZCODE_BASE_URL) vars.ZCODE_BASE_URL = process.env.ZCODE_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id is read by the host runtime; the coverage entry is reserved here to facilitate observation of the unified env source during development and build.
  if (process.env.ZAI_OAUTH_CLIENT_ID) vars.ZAI_OAUTH_CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID;
  if (process.env.ZAI_OAUTH_ORIGIN) vars.ZAI_OAUTH_ORIGIN = process.env.ZAI_OAUTH_ORIGIN;
  if (process.env.ZAI_BUSINESS_BASE_URL) {
    vars.ZAI_BUSINESS_BASE_URL = process.env.ZAI_BUSINESS_BASE_URL;
  }
  if (process.env.ZAI_BUSINESS_LOGIN_URL) {
    vars.ZAI_BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL;
  }
  if (process.env.VITE_ZAI_OAUTH_CLIENT_ID) {
    vars.VITE_ZAI_OAUTH_CLIENT_ID = process.env.VITE_ZAI_OAUTH_CLIENT_ID;
  }
  if (process.env.VITE_ZAI_OAUTH_ORIGIN) {
    vars.VITE_ZAI_OAUTH_ORIGIN = process.env.VITE_ZAI_OAUTH_ORIGIN;
  }
  return {
    ...vars,
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

const env = loadEnvFiles();
const { environment: zcodeEnv } = await loadBuiltinProviderConfig();
// Separate the installation package identity from the backend environment: ZCODE_PREVIEW_IDENTITY=1 allows the production backend build to still be packaged and run as ZCode Preview.
const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });
console.log(`[tsup] ZCODE_ENV=${zcodeEnv} ZCODE_PRODUCT_FLAVOR=${zcodeProductFlavor}`);

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZCODE_E2E_COVERAGE === "1";
  return {
    // The main/host/preload of the release package was not compressed with NODE_ENV=production before.
    // The product retains a large number of source code comments and formatted line breaks, increasing the risk of reverse engineering and internal implementation exposure.
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // The production package does not publish the sourcemap with the package, and continuing to generate sourceMappingURL will expose invalid mapping paths.
    // E2E coverage build will only enter the isolated app cache, and you need to retain the map to put the V8 bundle range
    // Revert to TypeScript source; normal release builds remain sourcemap-less.
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // When producing compression, esbuild may retain license/legal comments by default.
  // Release packages should not leave source code comments or sourcemap entry comments in main/host/preload.
  options.legalComments = "none";
}

const desktopTsupBundleSecurityOptions = resolveDesktopTsupBundleSecurityOptions();

function createSharedDefines() {
  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
    // Computer Use Helper build identity — read by helperInstaller to determine which Helper bundle to download.
    // When missing, the installer throws "Packaged ZCode is missing its embedded Computer Use Helper build identity".
    // When CI is built, it is injected through ZCODE_CUA_HELPER_BUILD_ID env; dev is an empty string to avoid downloading (the dev helper does not download).
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    // There is only one CDN configuration on the client side, separate from the OSS target list on the publisher side.
    __ZCODE_CDN_BASE_URL__: JSON.stringify(env.ZCODE_CDN_BASE_URL?.trim() || ""),
  };
}

const desktopNodeRuntimeExternals = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "@larksuiteoapi/node-sdk",
  "yaml",
  // Node-forge uses dynamic require("crypto") internally. After inlining into the ESM main/host bundle, Electron will report
  // Dynamic require of "crypto" is not supported. and undici are also reserved as runtime external dependencies.
  "node-forge",
  // The ZIP unpacker internally relies on CommonJS require("fs") and cannot be inlined into the ESM main/host product.
  "yauzl",
];

function createDevReadyMarkerHook(target: "main" | "host" | "preload"): string {
  // CLI-level --onSuccess will be triggered separately for each sub-build in multi-config watch mode.
  // Previously, when preload succeeded, the ready mark was written in advance, and Electron would still start before main/host was completed.
  // Here, each config is changed to write its own independent marker after success, so that the dev startup script can accurately wait for all builds to be completed.
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "main",
    entry: {
      "main/index": "src/main/index.ts",
      "main/browserWebmRecorder": "src/main/browserView/electronBrowserWebmRecorder.ts",
      "main/zcodeDataSizeWorker": "src/main/zcodeDataSizeWorker.ts",
      // Scanning of the "Storage" tab of the resource manager Worker: main holds the StorageService and traverses it in an independent thread for new Worker (new URL()) to parse.
      "main/storageScanWorker": "src/main/storageScanWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // If undici is directly inlined by the main ESM bundle, the runtime will fall into CommonJS require("assert") inside it.
    // When Electron loads the main product, it will report that Dynamic require of "assert" is not supported.
    // desktop keeps undici as an external dependency, and the remote single file bundle is inlined separately.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      // Provider Refactor's workspace package exports TypeScript source code; Electron production runtime does not
      // The TS loader must be inlined with the Desktop bundle and cannot leave a bare package reference pointing to src/index.ts.
      "@zcode/provider",
      "@zcode/provider-node",
      // services has been inlined into main, but its producer import was retained as a bare package reference;
      // electron-builder will exclude node_modules/@zcode, causing the installation package to start with ERR_MODULE_NOT_FOUND.
      // The producer's JS broker must be inlined along with the services, and the native addon still only exists in the independent Helper.
      "@zcode/zcode-cua",
      // The Rust native ports are only a JS wrapper around a compiled `.node` binary. The wrapper must stay inlined;
      // externalizing it would leave a bare `@zcode/rust/git` import pointing at the package's TypeScript sources.
      // The binary itself is resolved at runtime by `loadNative()` from the package directory.
      "@zcode/rust",
    ],
    // OTLP endpoints and authentication are only read at runtime; credentials from the build environment cannot be written into the public installation package.
    define: createSharedDefines(),
    // When main/host is watched at the same time and shares the out root directory, the default chunk naming will overwrite each other.
    // It is possible to make the import of main point to the chunk just rewritten by the host, triggering the occasional startup error of "missing named export".
    // Here, chunks are output according to target directories to ensure product isolation under concurrent builds.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "main/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("main"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "preload",
    entry: {
      "preload/embeddedBrowserJavaScriptDialog": "src/preload/embeddedBrowserJavaScriptDialog.ts",
      "preload/codingPlanWebview": "src/preload/codingPlanWebview.ts",
      "preload/browserVideoRecorder": "src/preload/browserVideoRecorder.ts",
      "preload/index": "src/preload/index.ts",
      "preload/resourceManager": "src/preload/resourceManager.ts",
      "preload/cuaPermissionPanel": "src/preload/cuaPermissionPanel.ts",
    },
    outDir: "out",
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    noExternal: ["@zcode/shared"],
    outExtension: () => ({ js: ".cjs" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    onSuccess: createDevReadyMarkerHook("preload"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // host and main share the same set of services graph, and continuing to inline undici will trigger the same dynamic require crash in the Electron ESM runtime.
    // This is also retained as an external dependency to avoid failure to start the desktop development state and packaged host process.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
      // Same as main: keep the native-port wrapper inlined so `loadNative()` can resolve the `.node` binary
      // through `@zcode/rust/package.json` instead of a bare TypeScript package import.
      "@zcode/rust",
    ],
    define: createSharedDefines(),
    // Maintain a consistent chunk isolation strategy with main to avoid host/main products from overwriting each other.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("host"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "scheduler",
    entry: { "scheduler/index": "src/scheduler/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // Isomorphic with host: resident cron scheduler process reuse @zcode/services (tasks-index + cron),
    // Also retain undici and others as external dependencies to avoid the dynamic require crash of Electron ESM runtime.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
      // Same as main: the resident scheduler reuses @zcode/services, which loads the Rust ports at startup.
      "@zcode/rust",
    ],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "scheduler/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("scheduler"),
    ...desktopTsupBundleSecurityOptions,
  },
]);
