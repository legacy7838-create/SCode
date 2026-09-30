import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveZCodeEndpointOrigin, pickProductEndpointEnv } from "@zcode/shared/zcodeEndpoint";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";

const buildMetadata = getBuildMetadata();
const desktopRequire = createRequire(import.meta.url);

interface IstanbulInstrumenter {
  instrumentSync(sourceCode: string, filename: string): string;
  lastFileCoverage(): unknown;
  lastSourceMap(): object | null;
}

interface IstanbulLibInstrument {
  createInstrumenter(options: {
    autoWrap: boolean;
    compact: boolean;
    coverageGlobalScope: string;
    coverageGlobalScopeFunc: boolean;
    esModules: boolean;
    parserPlugins: string[];
    preserveComments: boolean;
    produceSourceMap: boolean;
  }): IstanbulInstrumenter;
}

const { createInstrumenter } = desktopRequire("istanbul-lib-instrument") as IstanbulLibInstrument;

function resolveInstalledPackageRoot(packageName: string): string {
  return dirname(desktopRequire.resolve(`${packageName}/package.json`));
}

export const desktopRendererDependencyAliases = {
  // pnpm hoisted/package-local layout changes with installation configuration; hardcoded node_modules subpath
  // This will cause Rolldown to rely on optimization to parse entries such as react/jsx-runtime to non-existent locations.
  // Parse the real installation root directory through Node, which not only retains a single React runtime, but is also compatible with different node-linkers.
  react: resolveInstalledPackageRoot("react"),
  "react-dom": resolveInstalledPackageRoot("react-dom"),
  "lucide-react": resolveInstalledPackageRoot("lucide-react"),
} as const;

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

function createE2EUIRendererCoveragePlugin(repoRoot: string): Plugin {
  const sourceRoots = [
    resolve(repoRoot, "packages/ui/src"),
    resolve(repoRoot, "packages/desktop/src/renderer"),
  ].map(normalizePathForVite);
  const instrumenter = createInstrumenter({
    autoWrap: true,
    compact: false,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    parserPlugins: ["typescript", "jsx"],
    preserveComments: true,
    produceSourceMap: true,
  });
  const baselineCoverage: Record<string, unknown> = {};
  const baselinePath = resolve(
    repoRoot,
    "packages/desktop/out/renderer/e2e-coverage-baseline.json",
  );

  return {
    name: "zcode:e2e-ui-source-coverage",
    enforce: "pre",
    transform(sourceCode, id, options) {
      if (options?.ssr || id.startsWith("\0")) {
        return null;
      }
      const filename = stripViteRequestQuery(id);
      const absoluteFilename = isAbsolute(filename) ? filename : resolve(repoRoot, filename);
      const normalizedFilename = normalizePathForVite(absoluteFilename);
      if (!shouldInstrumentE2EUISource(normalizedFilename, sourceRoots)) {
        return null;
      }

      // post-transform instrumentation relies on the merged sourcemap of Vite/React/esbuild,
      // The generated JS coverage points will be back-projected onto TS source code lines such as import and interface.
      // Here, the original TS/TSX AST is instrumented first and then handed over to Vite for compilation to ensure that the coverage map only contains real runtime code.
      const code = instrumenter.instrumentSync(sourceCode, normalizedFilename);
      baselineCoverage[normalizedFilename] = JSON.parse(
        JSON.stringify(instrumenter.lastFileCoverage()),
      );
      return {
        code,
        map: instrumenter.lastSourceMap(),
      };
    },
    closeBundle() {
      // Just reading the page __coverage__ will make the never-loaded lazy chunks disappear, and the denominator is shrunk.
      // coverage build leaves the zero-hit map of the complete renderer graph to the suite reporter for merging.
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(baselineCoverage, null, 2)}\n`, "utf-8");
    },
  };
}

function shouldInstrumentE2EUISource(filename: string, sourceRoots: string[]) {
  return (
    isCoverageSourceFile(filename) &&
    !filename.includes("/node_modules/") &&
    !isDeclarationFile(filename) &&
    !isTestSourceFile(filename) &&
    sourceRoots.some((sourceRoot) => isInsidePath(filename, sourceRoot))
  );
}

function isCoverageSourceFile(filename: string) {
  return [".cts", ".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(filename));
}

function isDeclarationFile(filename: string) {
  return /\.d\.[cm]?ts$/u.test(filename);
}

function isTestSourceFile(filename: string) {
  return /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filename);
}

function isInsidePath(filename: string, directory: string) {
  return filename === directory || filename.startsWith(`${directory}/`);
}

function normalizePathForVite(path: string) {
  return path.replaceAll("\\", "/");
}

function stripViteRequestQuery(id: string) {
  return id.split("?")[0] ?? id;
}

export default defineConfig(({ mode }) => {
  // `.env*` only provide link constants; the current production environment is injected with ZCODE_ENV by the startup script or CI.
  const env = { ...loadEnv(mode, "../..", ""), ...process.env };
  const repoRoot = resolve(__dirname, "../..");
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  // The identity of the installation package is separate from the backend environment; the renderer uses it to decide whether to display the update entry.
  const zcodeProductFlavor = resolveDesktopProductFlavor({
    ...process.env,
    ...env,
    ZCODE_ENV: zcodeEnv,
  });
  const e2eCoverageEnabled =
    env.ZCODE_E2E_COVERAGE === "1" || process.env.ZCODE_E2E_COVERAGE === "1";
  const e2eStoreBridgeEnabled =
    env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" || process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1";
  const zcodeEndpointOrigin = resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin: env.ZCODE_BASE_URL ?? env.ZCODE_ENDPOINT_ORIGIN,
  });
  const codingPlanWebviewOrigin =
    env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? process.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? "";
  const plugins = [
    ...(e2eCoverageEnabled ? [createE2EUIRendererCoveragePlugin(repoRoot)] : []),
    pdfJsCMapsPlugin(),
    react(),
    tailwindcss(),
  ];

  return {
    root: "src/renderer",
    plugins,
    resolve: {
      alias: {
        // Fix @ alias resolution failure in UI component library.
        // Cause of the problem: Desktop will directly package the source code of packages/ui, but the current Vite configuration does not know that @ should point to packages/ui/src.
        // As a result, all internal imports in components such as spinner and alert will fail during construction.
        // Completing the alias here on the consumer side is more stable than importing components one by one, and can also be consistent with the web side.
        "@": resolve(__dirname, "../ui/src"),
        ...desktopRendererDependencyAliases,
        // Recharts reads the Path export of d3-path through d3-shape; hoisted node_modules
        // There may be d3-shape/node_modules/d3-path@1.x left in it. Vite pre-build will hit the old package first and report Missing export.
        // Here, d3-path is fixed to the root 3.x entry to ensure that desktop dependency optimization and runtime resolution are consistent.
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
      dedupe: ["react", "react-dom", "lucide-react"],
    },
    server: { port: 5174, strictPort: true },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
      __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
      __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(mode !== "production"),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // Compatible with old renderer reading names; new codes uniformly read VITE_ZCODE_BASE_URL.
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN": JSON.stringify(codingPlanWebviewOrigin),
      "import.meta.env.VITE_REWARDS_WEBVIEW_ORIGIN": JSON.stringify(
        env.VITE_REWARDS_WEBVIEW_ORIGIN ?? process.env.VITE_REWARDS_WEBVIEW_ORIGIN ?? "",
      ),
      // The E2E store bridge can only be opened by the WDIO special variable to avoid mistaking the ZCODE_ENV=test product environment for the test running state.
      "import.meta.env.VITE_ZCODE_E2E_STORE_BRIDGE": JSON.stringify(
        e2eStoreBridgeEnabled ? "1" : "",
      ),
    },
    // Electron uses the file:// protocol to load pages. The resource path must be a relative path, otherwise ERR_FILE_NOT_FOUND will occur.
    base: "./",
    worker: {
      rollupOptions: {
        // The worker entry of @pierre/diffs relies on importing and then registering the message listener.
        // Its missing package sideEffects declaration will cause the production worker sub-build to be shaken to 0B;
        // Only turn off tree shaking built by workers to avoid affecting the main package.
        treeshake: false,
      },
    },
    build: {
      outDir: "../../out/renderer",
      emptyOutDir: true,
      // If the production package directly exposes the sourceMappingURL, the attacker can restore the business source code on the client side.
      // Use hidden sourcemap in production: the local/release process retains .map and does not expose the mapping entry in the product.
      sourcemap: mode === "production" ? "hidden" : true,
      rollupOptions: {
        // Multiple entrances: main window + process monitoring + CUA permission drag-and-drop floating window
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          "resource-manager": resolve(__dirname, "src/renderer/resource-manager.html"),
          "cua-permission-panel": resolve(__dirname, "src/renderer/cua-permission-panel.html"),
        },
      },
    },
  };
});
