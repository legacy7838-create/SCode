import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
// The tsup configuration itself will be packaged, and the build tool must retain the original file location and cannot be relocated after inlining.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { stageThirdPartyNotices } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/third-party-notices.mjs")).href
);

// tsup config may be loaded from different cwd, and the warehouse root package.json is parsed based on the configuration file's own directory.
const rootPackageJsonPath = resolve(import.meta.dirname, "../../package.json");
const { version } = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8"));

const { environment: zcodeEnv, content: zcodeBuiltinProviderConfigJson } =
  await loadBuiltinProviderConfig();

export const SERVER_HTTP_DEFINES = {
  __ZCODE_VERSION__: JSON.stringify(version),
  __ZCODE_ENV__: JSON.stringify(zcodeEnv),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

function createSharedDefines() {
  return SERVER_HTTP_DEFINES;
}

export const SERVER_HTTP_EXTERNAL_DEPENDENCIES = [
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "proxy-from-env",
  "follow-redirects",
  // Node-forge uses dynamic require("crypto") internally. After inlining into the server ESM bundle, Node will report
  // Dynamic require of "crypto" is not supported; this maintains the same external strategy as the desktop main/host build.
  "node-forge",
  "yaml",
  // The feedback log compression link of services is introduced into the CJS package yazl and is inlined into the ESM bundle.
  // When the require("fs") dynamic require is hit during runtime, entry-http crashes upon startup; external dependencies are retained and left to Node for native loading.
  "yazl",
  // The cloud content ZIP unpacking link is introduced in yauzl, and its CommonJS require("fs") is in ESM
  // The bundle crashes when loading; the same as desktop, it is externally loaded and handed over to Node for native loading.
  "yauzl",
];

export default defineConfig({
  onSuccess: async () => {
    await stageThirdPartyNotices(resolve(import.meta.dirname, "dist"));
  },
  entry: { "entry-http": "src/entry-http.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // The exports of the workspace package point to the .ts source code, which cannot be loaded directly when node is running and needs to be bundled in.
  noExternal: [
    "@zcode/shared",
    "@zcode/rpc",
    "@zcode/services",
    "@zcode/services/node",
    "@zcode/client",
  ],
  // ssh2/node-pty contains .node native addon, which cannot be processed by esbuild.
  // After CJS dependencies such as undici / axios are inlined into the ESM bundle, the runtime will go to
  // For dynamic require such as require("assert") / require("util") / require("url"), Node's ESM wrapper will directly report Dynamic require not supported.
  // The HTTP server scenario is retained as an external dependency and handed over to Node for native loading; the remote single file bundle is still inlined by build-remote.ts.
  external: SERVER_HTTP_EXTERNAL_DEPENDENCIES,
  define: createSharedDefines(),
  // esbuild does not recognize es2025 in tsconfig.json, use special tsconfig.build.json to eliminate the warning
  tsconfig: "tsconfig.build.json",
});
