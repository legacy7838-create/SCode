#!/usr/bin/env node
// Package the Local Host as a self-contained Tauri sidecar so the PACKAGED app can boot its
// backend (the dev flow uses scripts/dev-host.mjs instead). Output layout under
// packages/desktop/src-tauri/resources/host/:
//   node(.exe)            bundled Node runtime (from the running process — CI builds each OS natively)
//   standalone.js + *.js  the built ESM host bundle (out/host/*)
//   zcode_db.node         the RUST DB addon (rusqlite). The DB stays 100% Rust: the host loads it
//                         via ZCODE_DB_NATIVE, never any JS sqlite.
//   package.json          {"type":"module"} so node treats the .js bundle as ESM.
//   node_modules/<pkgs>   the tsup runtime externals (node-pty, ssh2, undici, ws, yaml, node-forge,
//                         yauzl, @larksuiteoapi/node-sdk) + their transitive deps, so ESM import
//                         resolution finds them next to standalone.js.
//
// Run from anywhere; paths resolve relative to this script. Set ZCODE_TARGET_OS/ARCH to override.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const outDir = join(desktopRoot, "src-tauri", "resources", "host");
const hostBundleDir = join(desktopRoot, "out", "host");
const dbAddonSource = join(desktopRoot, "zcode-db", "zcode_db.node");
const ptyAddonSource = join(desktopRoot, "zcode-pty", "zcode_pty.node");
const isWindows = getTargetPlatform().os === "win32";

// tsup keeps these external in the host ESM bundle (tsup.config.ts desktopNodeRuntimeExternals);
// they must be present at runtime. *.node addons (zcode_db.node, zcode_pty.node) are handled
// separately and copied above, not vendored from node_modules.
//
// This list must stay a SUPERSET of the bare third-party imports actually present in the built
// host bundle. tsup additionally externalizes anything declared in @zcode/desktop's `dependencies`,
// which is why `yazl` belongs here even though it is NOT in `desktopNodeRuntimeExternals`:
// @zcode/services/src/feedback/feedbackLogArchive.ts imports it for the log-export zip, so the
// bundle keeps a runtime `import "yazl"` that must resolve from the staged node_modules.
// Missing it shipped a broken AppImage whose Host died on boot with ERR_MODULE_NOT_FOUND.
// `checkRuntimeExternalsCoverBundle` below fails CI if this list ever drifts from the bundle again.
const RUNTIME_EXTERNALS = [
  "ssh2",
  "undici",
  "ws",
  "@larksuiteoapi/node-sdk",
  "yaml",
  "node-forge",
  "yauzl",
  // ZIP writer used by feedbackLogArchive (the reader `yauzl` above is a separate package).
  "yazl",
];

// Candidate node_modules roots (pnpm hoists to the workspace root; some deps live per-package).
const MODULE_ROOTS = [join(desktopRoot, "node_modules"), join(repoRoot, "node_modules")];

function findPackageDir(name) {
  for (const root of MODULE_ROOTS) {
    const dir = join(root, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`[host-sidecar] runtime dependency not found in node_modules: ${name}`);
}

function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDirRecursive(s, d);
    else copyFileSync(s, d);
  }
}

// BFS the transitive closure of the runtime externals (deps + optionalDependencies), copying each
// into resources/host/node_modules so the packaged host resolves them by ordinary ESM lookup.
function vendorExternals() {
  const nmDest = join(outDir, "node_modules");
  const seen = new Set();
  const queue = [...RUNTIME_EXTERNALS];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = findPackageDir(name);
    const dest = join(nmDest, name);
    copyDirRecursive(src, dest);
    const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
    for (const dep of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]) {
      queue.push(dep);
    }
  }
  return seen.size;
}

/**
 * Fail when RUNTIME_EXTERNALS does not cover every bare third-party import in the built host
 * bundle.
 *
 * 原因：这类问题只能等到打包后的 AppImage 首次运行时才暴露（Host 启动即
 * ERR_MODULE_NOT_FOUND），CI 的 build 步骤不会发现，因为构建本身是成功的。构建后立刻比对一次
 * 导入集合与白名单，成本极低（纯文本扫描），却能把 “白名单与 bundle 漂移” 变成构建期失败。
 *
 * 只做单向包含检查（bundle ⊆ RUNTIME_EXTERNALS）：白名单里多列几个包是无害的（多拷贝一份而已），
 * 而漏列是致命的，因此只对漏列报错。
 *
 * 只扫可达图，是为了避开假阳性：`tsconfig.host.json` 和 tsup 共用 `outDir: out/host`，所以 tsc -b
 * 会把逐模块产物（standaloneHost.js / storagePreparationProcesses.js）写在这里；它们带
 * `@zcode/services` / `@zcode/shared` / `zod` 这些本来就会被内联的裸导入，扫全部文件就会每次
 * 报三个假错——而一个会错报的检查很快就会被人忽略。
 * 注意这只收窄**检查范围**；上面的拷贝仍是全量，宁多勿缺。
 *
 * @param {string} bundleDir Directory holding the tsup output.
 * @returns {string[]} Bare specifiers imported by the reachable bundle graph but not vendored.
 */
function findUnvendoredBundleImports(bundleDir) {
  const reachable = collectReachableBundleFiles(bundleDir, BUNDLE_ENTRIES);
  // Node 内建模块（含 node: 前缀与 subpath），不是需要拷贝的第三方包。
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const specifiers = new Set();
  // tsup 不完全压缩：同一个 bundle 里既有 `from"yazl"`（压缩过）也有
  // `import { ZipFile } from "yazl";`（带空格的 ESM 语句）。两种形态都必须覆盖，
  // 只匹配无空格形态会漏掉后者。
  //
  // 而 `from\s*["']` 同样会命中普通字符串字面量内部（实测有
  // `readString2(message, "from")` 与 `qrUrl.searchParams.set("from", "sdk")` 两类误报），
  // 因此真正负责过滤的是下面的形状校验。两者缺一不可。
  const importPattern =
    /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const file of reachable) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(join(bundleDir, file), "utf8");
    for (const match of source.matchAll(importPattern)) {
      const spec = match[1] ?? match[2] ?? match[3];
      // 只关心裸模块名：相对路径由 bundle 内部解析，`node:` 与内建模块由 Node 自己提供。
      if (!spec || spec.startsWith(".") || spec.startsWith("/") || builtins.has(spec)) continue;
      // 形状校验：真实的裸包名不可能含空白或括号。上一条正则捕获到的三处误报
      //（`) || readString2(message, `、`, currentBaseDir, `、`);\nvar CLAUDE…`）全部含这些字符，
      // 在此被丢弃。若去掉这一步，检查会因为错误的原因失败，久而久之就没人再信它。
      if (/[\s()[\]{};,]/.test(spec)) continue;
      // 取包名：@scope/name[/subpath] -> @scope/name, name[/subpath] -> name
      const parts = spec.split("/");
      const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      if (pkg && !builtins.has(pkg)) specifiers.add(pkg);
    }
  }
  const vendored = new Set(RUNTIME_EXTERNALS);
  return [...specifiers].filter((name) => !vendored.has(name)).sort();
}

/**
 * The bundle graph actually reachable from the shipped entry points.
 *
 * 为什么需要这个：`tsconfig.host.json` 的 `outDir` 和 tsup 的输出目录是同一个 `out/host`，所以
 * `pnpm typecheck`/`tsc -b` 会把**逐模块的 ESM 产物**（standaloneHost.js、storagePreparationProcesses.js 等）
 * 一起写到这里。它们不是 tsup bundle 的一部分、不会被任何入口引用，但含有 `@zcode/services`、
 * `@zcode/shared`、`zod` 这些裸导入（这些包本来就会被内联，不会 vendor）。
 * 之前的做法是把 `out/host` 下所有 .js 全部 copy 进 bundle，既臃肿又会让 `--check` 报出三个
 * 假阳性——而一个会错报的检查很快就会被人忽略，那正是我们想要避免的。
 *
 * 因此从真正的入口（standalone.js / index.js / tasksStorageWorker.js，最后一个由 `new Worker(路径)`
 * 加载）沿相对导入做 BFS，只把可达的 chunk 当作打包产物。
 *
 * @param {string} bundleDir Directory holding the tsup output.
 * @param {string[]} entries Entry file names that are loaded directly at runtime.
 * @returns {string[]} Basenames of every reachable bundle file.
 */
function collectReachableBundleFiles(bundleDir, entries) {
  const seen = new Set();
  const queue = entries.filter((name) => existsSync(join(bundleDir, name)));
  // 必须同时兼容三种形式（实测 tsup 产物里都有）：
  //   import { x } from "./chunk.js"      静态命名导入
  //   export * from "./chunk.js"          再导出
  //   await import("./chunk.js")          动态导入 —— 括号形式！
  // 之前只写了 `(?:from|import)\s*["']\./` ，漏掉 `import("...")`：那个 `(` 使整条不匹配，
  // 于是只有懒加载入口引用的 chunk 会被当成“不可达”而不再拷进 bundle ——CI 的 boot proof
  // 只启动 standalone.js，根本不会触发那条路径，所以会漏检。
  // 另外不要求引号前一定有空白（压缩后是 `from"./x"`），也不假设只有 `./`（兼容 `../`）。
  const relativeImport = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.[^"']+)["']/g;
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = readFileSync(join(bundleDir, name), "utf8");
    for (const match of source.matchAll(relativeImport)) {
      const dep = match[1];
      if (!dep) continue;
      const resolved = join(bundleDir, dep);
      // 只纳入 bundleDir 内部的文件：`../` 或跳出目录的引用不是 bundle 产物。
      // `seen` / `queue` 统一存 basename，避免下面 join 时重复拼接。
      if (dirname(resolved) !== bundleDir || !/\.m?js$/.test(resolved)) continue;
      if (existsSync(resolved)) queue.push(basename(resolved));
    }
  }
  return [...seen];
}

/** Entry points loaded directly by the Rust spawner or by `new Worker(...)` at runtime. */
const BUNDLE_ENTRIES = ["standalone.js", "index.js", "tasksStorageWorker.js"];

function main() {
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    if (!existsSync(hostBundleDir)) {
      throw new Error(
        `[host-sidecar] host bundle missing at ${hostBundleDir}. Run \`pnpm --filter @zcode/desktop build\` first.`,
      );
    }
    const missing = findUnvendoredBundleImports(hostBundleDir);
    if (missing.length > 0) {
      throw new Error(
        `[host-sidecar] host bundle imports packages that RUNTIME_EXTERNALS does not vendor: ` +
          `${missing.join(", ")}. Add each to RUNTIME_EXTERNALS in this script, or bundle it ` +
          `via noExternal in tsup.config.ts. Otherwise the packaged AppImage fails at RUNTIME ` +
          `with ERR_MODULE_NOT_FOUND (the build itself still succeeds, so CI would not catch it).`,
      );
    }
    console.log(`[host-sidecar] check OK: all bundle imports are vendored`);
    return;
  }

  if (!existsSync(hostBundleDir)) {
    throw new Error(
      `[host-sidecar] host bundle missing at ${hostBundleDir}. Run \`pnpm --filter @zcode/desktop build\` first.`,
    );
  }
  if (!existsSync(dbAddonSource)) {
    throw new Error(
      `[host-sidecar] Rust DB addon missing: ${dbAddonSource}. Run pnpm prepare:zcode-db-native first.`,
    );
  }
  if (!existsSync(ptyAddonSource)) {
    throw new Error(
      `[host-sidecar] Rust PTY addon missing: ${ptyAddonSource}. Run pnpm prepare:zcode-pty-native first.`,
    );
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. Bundled Node runtime (the running process's binary; CI builds each OS natively so this
  //    matches the target arch). Copied, not symlinked, so it survives the bundle copy.
  const nodeDest = join(outDir, isWindows ? "node.exe" : "node");
  copyFileSync(process.execPath, nodeDest);
  if (!isWindows) {
    // Preserve the exec bit; copyFileSync may not carry it across filesystems.
    const mode = statSync(nodeDest).mode;
    chmodSync(nodeDest, mode | 0o111);
  }

  // 2. ESM host bundle (standalone.js + index.js + tasksStorageWorker.js + chunk-*.js).
  // 拷贝全部 .js/.mjs（原行为）：只拷“可达集”看似能去掉 tsc 残留产物，但风险不可接受——
  // chunk 可以由动态 import、计算出的路径或其他入口引用，任何遗漏都会把“只在特定操作时
  // 报错”的缺陷发进产品（CI 的 boot proof 只启动 standalone.js，测不到那条路径）。
  // 多拷是死重量，少拷是运行时 ERR_MODULE_NOT_FOUND：两边不对等，所以这里宁可冗余。
  for (const f of readdirSync(hostBundleDir)) {
    if (f.endsWith(".js") || f.endsWith(".mjs"))
      copyFileSync(join(hostBundleDir, f), join(outDir, f));
  }

  // 3. The Rust DB addon — the ONLY database engine. Loaded by the host via ZCODE_DB_NATIVE.
  copyFileSync(dbAddonSource, join(outDir, "zcode_db.node"));

  // 3a. The Rust PTY addon — the ONLY terminal engine. Loaded by the host via ZCODE_PTY_NATIVE.
  //     There is no JS node-pty path: the host opens every terminal through this addon.
  copyFileSync(ptyAddonSource, join(outDir, "zcode_pty.node"));

  // 3b. The bundled Agent (zcode.cjs) the packaged Host runs for storage-prep + sessions.
  //     Resolved by the host via ZCODE_BUNDLED_AGENT_ENTRY (set by the Rust spawner).
  const agentSource = join(repoRoot, "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs");
  if (!existsSync(agentSource)) {
    throw new Error(
      `[host-sidecar] agent bundle missing: ${agentSource}. Build it first: node scripts/build-desktop-agent-cli.mjs`,
    );
  }
  mkdirSync(join(outDir, "agent"), { recursive: true });
  copyFileSync(agentSource, join(outDir, "agent", "zcode.cjs"));

  // 内置 Provider Release（`schemaVersion/revision/config{providerConfigRules,modelConfigRules}`）。
  // 打包态之前从未把它带进 bundle：Rust spawner 不设置 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_PATH`，
  // `ensureProviderConfigFile()` 就退到 `/tmp/zcode-host-dev/providers.json` 并写出 `{"providers":{}}`。
  // 那份手写内容不是合法的 Release envelope，`decodeZCodeBuiltinRelease` 每次都报
  // `Unrecognized key: "providers"` / `expected number, received undefined`，于是 Provider 启动状态
  // 永远不能 settled，`shouldBlockRootRender()` 恒为 true —— 表现就是 AppImage 一直卡在黑底 logo。
  // 这里把仓库里真正的那份带进去，Rust 侧再把路径传给 Host。
  const providerReleaseSource = join(repoRoot, "config", "provider", "zcode-builtin.json");
  if (!existsSync(providerReleaseSource)) {
    throw new Error(`[host-sidecar] builtin provider release missing: ${providerReleaseSource}`);
  }
  mkdirSync(join(outDir, "provider"), { recursive: true });
  copyFileSync(providerReleaseSource, join(outDir, "provider", "zcode-builtin.json"));

  // 4. Force ESM interpretation for the copied bundle (the repo's "type":"module" isn't inherited
  //    by the packaged resources tree).
  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    "utf8",
  );

  // 5. Vendored runtime externals + transitive deps.
  const vendored = vendorExternals();

  console.log(
    `[host-sidecar] staged ${isWindows ? "win32" : "unix"} host sidecar at ${outDir} ` +
      `(node=${existsSync(nodeDest)}, db=${existsSync(join(outDir, "zcode_db.node"))}, pty=${existsSync(join(outDir, "zcode_pty.node"))}, vendored pkgs=${vendored})`,
  );
}

main();
