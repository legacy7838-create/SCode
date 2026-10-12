import { readFileSync } from "node:fs";
import { build, type Plugin } from "esbuild";
import { validateRemoteServerBundle } from "./buildRemoteValidation.js";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { stageThirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const { version } = JSON.parse(readFileSync("../../package.json", "utf-8"));
const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

/**
 * Keep .node native addon files (the Rust `zcode_pty.node` / `zcode_db.node`) external so
 * esbuild never tries to inline a platform binary. The terminal adapter loads `zcode_pty.node`
 * by absolute path via ZCODE_PTY_NATIVE, which matches the `~/.zcode/server/zcode-pty` deploy
 * layout on the remote — there is no JS node-pty path.
 *
 * CJS 格式而非 ESM：native addon 的绝对路径 require 与运行时目录解析在 CJS 下最稳妥，
 * 可直接原生支持，不需要任何 polyfill。
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
  // CJS 环境没有 import.meta.url，通过 banner 注入等价变量，
  // 再用 define 全局替换，这样源码无需关心最终打包格式。
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
// 修复：remote 单文件 bundle 内联第三方代码，dist/remote 也必须附完整声明。
await stageThirdPartyNotices("dist/remote");

console.log("Built dist/remote/zcode-server.cjs");
