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
const RUNTIME_EXTERNALS = [
  "node-pty",
  "ssh2",
  "undici",
  "ws",
  "@larksuiteoapi/node-sdk",
  "yaml",
  "node-forge",
  "yauzl",
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

function main() {
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
