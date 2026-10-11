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
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const outDir = join(desktopRoot, "src-tauri", "resources", "host");
const hostBundleDir = join(desktopRoot, "out", "host");
const dbAddonSource = join(desktopRoot, "zcode-db", "zcode_db.node");
const isWindows = getTargetPlatform().os === "win32";

// tsup keeps these external in the host ESM bundle (tsup.config.ts desktopNodeRuntimeExternals);
// they must be present at runtime. *.node is the DB addon (handled separately as zcode_db.node).
//
// This list must stay a SUPERSET of the bare third-party imports actually present in the built
// host bundle. tsup additionally externalizes anything declared in @zcode/desktop's `dependencies`,
// which is why `yazl` belongs here even though it is NOT in `desktopNodeRuntimeExternals`:
// @zcode/services/src/feedback/feedbackLogArchive.ts imports it for the log-export zip, so the
// bundle keeps a runtime `import "yazl"` that must resolve from the staged node_modules.
// Missing it shipped a broken AppImage whose Host died on boot with ERR_MODULE_NOT_FOUND.
// `checkRuntimeExternalsCoverBundle` below fails CI if this list ever drifts from the bundle again.
const RUNTIME_EXTERNALS = [
  "node-pty",
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
 * @param {{ bundleDir: string }} options
 * @returns {string[]} The bare specifiers found in the bundle that are not vendored.
 */
function findUnvendoredBundleImports(bundleDir) {
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
  for (const file of readdirSync(bundleDir)) {
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
  for (const f of readdirSync(hostBundleDir)) {
    if (f.endsWith(".js") || f.endsWith(".mjs"))
      copyFileSync(join(hostBundleDir, f), join(outDir, f));
  }

  // 3. The Rust DB addon — the ONLY database engine. Loaded by the host via ZCODE_DB_NATIVE.
  copyFileSync(dbAddonSource, join(outDir, "zcode_db.node"));

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
      `(node=${existsSync(nodeDest)}, addon=${existsSync(join(outDir, "zcode_db.node"))}, vendored pkgs=${vendored})`,
  );
}

main();
