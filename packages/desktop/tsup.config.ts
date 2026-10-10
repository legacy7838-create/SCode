import { pickProductEndpointEnv } from "@zcode/shared/zcodeEndpoint";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
// tsup 会先打包配置文件；动态加载构建工具，避免其 import.meta.dirname 被重定位到 desktop。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);

const buildMetadata = getBuildMetadata();

// 手动加载 .env 文件，tsup 不像 Vite 会自动读取 .env.*；这些文件只提供链接常量。
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
  // 真实环境变量优先级最高
  if (process.env.ZCODE_ENV) vars.ZCODE_ENV = process.env.ZCODE_ENV;
  if (process.env.ZCODE_BASE_URL) vars.ZCODE_BASE_URL = process.env.ZCODE_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id 由 host runtime 读取；这里保留覆盖入口，方便开发构建时观察统一 env 来源。
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
// 安装包身份与后端环境分轴：ZCODE_PREVIEW_IDENTITY=1 让生产后端的构建仍以 ZCode Preview 身份打包运行。
const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });
console.log(`[tsup] ZCODE_ENV=${zcodeEnv} ZCODE_PRODUCT_FLAVOR=${zcodeProductFlavor}`);

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZCODE_E2E_COVERAGE === "1";
  return {
    // 发布包的 main/host/preload 之前没有随 NODE_ENV=production 压缩，
    // 产物保留大量源码注释与格式化换行，增加逆向和内部实现暴露风险。
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // 生产包不随包发布 sourcemap，继续生成 sourceMappingURL 会暴露无效映射路径。
    // E2E coverage build 只会进入隔离 app cache，需要保留 map 才能把 V8 bundle range
    // 还原到 TypeScript 源码；正常发布构建仍保持无 sourcemap。
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // 生产压缩时 esbuild 默认可能保留 license/legal 注释，
  // 发布包不应在 main/host/preload 里留下源码注释或 sourcemap 入口注释。
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
    // 客户端只有一个 CDN 配置，与发布端 OSS 目标列表分离。
    __ZCODE_CDN_BASE_URL__: JSON.stringify(env.ZCODE_CDN_BASE_URL?.trim() || ""),
  };
}

const desktopNodeRuntimeExternals = [
  "node-pty",
  "ssh2",
  "undici",
  // 独立 Host sidecar 用 ws 起 loopback RPC server；保留为运行时外部依赖，不内联进 ESM 产物。
  "ws",
  "@larksuiteoapi/node-sdk",
  "yaml",
  // node-forge 内部用动态 require("crypto")，内联进 ESM main/host bundle 后 Electron 会报
  // Dynamic require of "crypto" is not supported。和 undici 同样保留为运行时外部依赖。
  "node-forge",
  // ZIP 解包器内部依赖 CommonJS require("fs")，不能内联到 ESM main/host 产物。
  "yauzl",
  // Rust DB addon（zcode_db.node）等原生 N-API 模块保持外部：运行时按绝对路径动态 require，
  // 绝不能内联进 ESM host/scheduler 产物（esbuild 无 .node loader，且会固化平台专属二进制）。
  "*.node",
];

function createDevReadyMarkerHook(target: "main" | "host" | "preload"): string {
  // CLI 级 --onSuccess 在多 config watch 模式下会被每个子构建分别触发。
  // 之前 preload 先成功时就提前写入 ready 标记，Electron 仍会在 main/host 未完成时启动。
  // 这里改成每个 config 自己在成功后写独立 marker，让 dev 启动脚本能精确等待全部构建完成。
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      "host/standalone": "src/host/standaloneHost.ts",
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // host 与 main 共用同一套 services 图，继续内联 undici 会在 Electron ESM runtime 里触发同样的 dynamic require 崩溃。
    // 这里同样保留为外部依赖，避免 desktop 开发态和打包态 host 进程启动失败。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
    ],
    define: createSharedDefines(),
    // 与 main 保持一致的 chunk 隔离策略，避免 host/main 产物相互覆盖。
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
    // 与 host 同构：常驻 cron scheduler 进程复用 @zcode/services（tasks-index + cron），
    // 同样保留 undici 等为外部依赖，避免 Electron ESM runtime 的 dynamic require 崩溃。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
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
