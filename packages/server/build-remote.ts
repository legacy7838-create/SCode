import { readFileSync } from "node:fs";
import { build, type Plugin } from "esbuild";
import { validateRemoteServerBundle } from "./buildRemoteValidation.js";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { stageThirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const { version } = JSON.parse(readFileSync("../../package.json", "utf-8"));
const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

/**
 * Let esbuild bundle node-pty's JS code normally, but keep .node native
 * addon files as external requires. node-pty's loadNativeModule() searches
 * for `./build/Release/pty.node` relative to itself, which matches our
 * deploy layout on the remote.
 *
 * CJS format instead of ESM: node-pty uses __dirname extensively internally, and there is no such variable in ESM.
 * CJS output can be directly supported natively without any polyfill.
 */
const nativeAddonPlugin: Plugin = {
  name: "native-addon",
  setup(build) {
    // Mark all .node files as external — they can't be bundled
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const buildResult = await build({
  entryPoints: ["src/entry-stdio.ts"],
  bundle: true,
  outfile: "dist/remote/zcode-server.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  plugins: [nativeAddonPlugin],
  // There is no import.meta.url in the CJS environment. Equivalent variables are injected through banner.
  // Then use define to replace it globally, so that the source code does not need to care about the final packaging format.
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href; var __import_meta_dirname = __dirname;',
  },
  define: {
    "import.meta.url": "__import_meta_url",
    "import.meta.dirname": "__import_meta_dirname",
    __ZCODE_VERSION__: JSON.stringify(version),
    __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
  },
  metafile: true,
});

const remoteBundleSource = readFileSync("dist/remote/zcode-server.cjs", "utf-8");
const bundledInputs = Object.keys(buildResult.metafile.inputs);
validateRemoteServerBundle({ bundledInputs, source: remoteBundleSource });
// Fix: remote single-file bundle inlines third-party code, and dist/remote must also be accompanied by complete declarations.
await stageThirdPartyNotices("dist/remote");

console.log("Built dist/remote/zcode-server.cjs");
