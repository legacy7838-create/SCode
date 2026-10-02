#!/usr/bin/env node
/**
 * Renderer-graph gate for spec invariant 9 (docs/specs/rust-native-ports.md).
 *
 * 背景（bug fix 说明）：renderer/browser bundle 不能加载 `.node`。renderer 会为了拿 runtime
 * value 而 import `@zcode/shared/zcode-protocol-v4`、`@zcode/rpc`、`@zcode/client`、
 * `@zcode/services` 这几个 barrel，因此这些 barrel 后面只要有一个文件静态 import
 * `@zcode/rust`，Vite 就会把 `node:fs` / `node:module` / `node:path` / `node:url`
 * externalize 掉，renderer 在 `loader.ts` 求值时直接抛
 * `Module "node:fs" has been externalized for browser compatibility`。
 *
 * 这是一条**构建期模块图**规则，不是运行期兜底：这里不允许出现
 * `try { native } catch { js }`，也不允许用 alias 把 native 藏起来。所以只做静态断言。
 *
 * 用法：node packages/shared/scripts/check-native-graph.mjs
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * renderer 为了拿 runtime value 会 import 这些 barrel，所以 barrel 后面任何位置的
 * `@zcode/rust` 静态 import 都属于 renderer 可达。`packages/services` 只校验那些 renderer
 * 真实用到的目录（zcode-agent / git 等 host 专属目录不在其中）。
 */
const rendererReachableRoots = [
  "packages/shared/src/zcode-protocol-v4",
  "packages/shared/src",
  "packages/rpc/src",
  "packages/client/src",
  "packages/ui/src",
  "packages/web/src",
  // The Tauri renderer is a browser entry of the same UI; it was missing from this list,
  // so a native import added directly under `apps/zcode-tauri/src` would not have been seen.
  "apps/zcode-tauri/src",
].map((p) => join(repoRoot, p));

/** 静态 import 与 export-from 都会被 Vite 打进 renderer bundle。 */
const NATIVE_IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["']@zcode\/rust(?:\/[^"']*)?["']/g;

/**
 * Sanctioned Node-only directories, each reachable exclusively through a Node-only subpath.
 *
 * A directory is listed here **only** because nothing renderer-reachable imports its subpath, and
 * `assertNotRendererReachable` re-checks that claim on every run rather than trusting this comment.
 * Any *new* native import in rpc/shared/ui/web still fails this gate.
 */
const SANCTIONED_NATIVE_DIRS = ["packages/rpc/src/native/", "packages/shared/src/node/"];

/**
 * Subpaths that renderer code must never import, mapped to the module path that must be free of
 * them.
 *
 * This is the check that makes sanctioning safe. The directory list above says "these files may hold
 * native imports"; this says "and nothing the renderer reaches may pull them in". Without it, a
 * sanctioned directory becomes a hole: one stray import from `packages/ui` would put a `.node` back
 * into the renderer bundle, and the first gate would no longer see it.
 */
const NODE_ONLY_SUBPATHS = [
  { subpath: "@zcode/shared/node", module: "packages/shared/src/node.ts" },
  { subpath: "@zcode/rpc/native", module: "packages/rpc/src/native.ts" },
  // The Node-only counterpart of the renderer-safe `@zcode/services` barrel: it is where
  // `isValidCronExpr` moved when it stopped being exported from the root index
  // (rust-native-cron.md §2.5/8). Legal for the host, never for the renderer.
  { subpath: "@zcode/services/node", module: "packages/services/src/node.ts" },
];

/** Every `@zcode/<pkg>/<subpath>` reference in a source file. */
const SUBPATH_RE = /@zcode\/[a-z-]+\/[a-z][a-z0-9-]*/g;

function assertNotRendererReachable(rootDir, violations) {
  for (const { subpath, module } of NODE_ONLY_SUBPATHS) {
    for (const file of walk(rootDir)) {
      if (file.endsWith(module)) continue; // the Node-only barrel itself is fine
      let source;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const match of code.match(SUBPATH_RE) ?? []) {
        if (match === subpath) {
          violations.push({
            file: relative(repoRoot, file).split("\\").join("/"),
            text: `${match} — ${subpath} is Node-only and must not be reachable from the renderer`,
          });
        }
      }
    }
  }
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) yield full;
  }
}

const violations = [];
for (const root of rendererReachableRoots) {
  for (const file of walk(root)) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (SANCTIONED_NATIVE_DIRS.some((dir) => rel.startsWith(dir))) continue;
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(NATIVE_IMPORT_RE)) {
      violations.push({
        file: rel,
        text: match[0].replace(/\s+/g, " ").trim(),
      });
    }
  }
}

// The reverse check runs before reporting, so a violation of either rule surfaces together.
for (const root of rendererReachableRoots) {
  assertNotRendererReachable(root, violations);
}

// ---------------------------------------------------------------------------
// Transitive reachability from the renderer entries
// ---------------------------------------------------------------------------

/**
 * The roots above assert "no file *here* imports `@zcode/rust`". That cannot express the rule
 * that actually broke: a native-backed value re-exported from a barrel the renderer imports
 * *by value*. `packages/services/src/index.ts` re-exporting `automationCronValidation.ts`
 * (→ `@zcode/rust/cron` → `loader.ts` → `node:fs`) put the native loader in the browser
 * bundle while every root stayed clean — a reverse-graph trace of the Tauri renderer build
 * found 386 chains, every one of them through that single line.
 * See docs/specs/rust-native-cron.md §2.5/8 and invariant 9.
 *
 * So the real entries are walked here, every *value* import is followed across workspace
 * packages until the closure closes, and reaching `packages/rust/src/**` is the violation.
 * `import type` / `export type` are erased before the bundle, so they are dropped first:
 * following them would flag modules that are never shipped to the renderer.
 */
const RENDERER_ENTRIES = ["apps/zcode-tauri/src/main.tsx", "packages/web/src/main.tsx"];
const UI_ALIAS_DIR = "packages/ui/src";
const NATIVE_WRAPPER_PREFIX = "packages/rust/src/";
const NON_TS_FILE = /\.(css|json|svg|png|jpe?g|gif|webp|wasm|html|md|txt|mjs|cjs)$/;

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every value-import specifier; type-only import/export statements are erased by the TS transform. */
function valueImportSpecifiers(code) {
  const withoutTypeOnly = stripComments(code)
    .replace(/\bimport\s+type\b[\s\S]*?from\s*["'][^"']+["']/g, "")
    .replace(/\bexport\s+type\b[\s\S]*?from\s*["'][^"']+["']/g, "");
  const specs = new Set();
  for (const pattern of [
    /\bimport\s*\(\s*["']([^"']+)["']/g, // dynamic import("…")
    /\bfrom\s*["']([^"']+)["']/g, // import … from "…" / export … from "…"
    /\bimport\s*["']([^"']+)["']/g, // bare side-effect import "…"
  ]) {
    for (const match of withoutTypeOnly.matchAll(pattern)) specs.add(match[1]);
  }
  return [...specs];
}

/** Maps `./x.js` → `x.ts`, `./x` → `x.ts|x/index.ts`. Returns null for non-TypeScript targets. */
function resolveTypeScriptFile(base) {
  if (NON_TS_FILE.test(base)) return null;
  let candidates;
  if (base.endsWith(".js")) candidates = [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`];
  else if (base.endsWith(".jsx"))
    candidates = [`${base.slice(0, -4)}.ts`, `${base.slice(0, -4)}.tsx`];
  else if (base.endsWith(".ts") || base.endsWith(".tsx")) candidates = [base];
  else candidates = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const packageInfoCache = new Map();
/** Nearest `package.json` above a file, cached — used for `imports` (`#src/*`) resolution. */
function packageInfoFor(file) {
  let dir = dirname(file);
  for (;;) {
    if (packageInfoCache.has(dir)) return packageInfoCache.get(dir);
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      let info = null;
      try {
        info = { dir, json: JSON.parse(readFileSync(manifest, "utf8")) };
      } catch {
        info = null;
      }
      packageInfoCache.set(dir, info);
      return info;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      packageInfoCache.set(dir, null);
      return null;
    }
    dir = parent;
  }
}

/**
 * Workspace package name → directory. pnpm links workspace deps into each *dependent's*
 * `node_modules`, so there is no root `node_modules/@zcode` to resolve through — the map is
 * read from the workspace manifests instead.
 */
function collectWorkspacePackages() {
  const map = new Map();
  const visit = (dir, depth) => {
    if (!existsSync(dir)) return;
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof json.name === "string" && json.name.startsWith("@zcode/"))
          map.set(json.name, dir);
      } catch {
        // An unparseable manifest makes the walk incomplete, never wrong: it resolves to null.
      }
    }
    if (depth === 0) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      try {
        if (statSync(join(dir, entry)).isDirectory()) visit(join(dir, entry), depth - 1);
      } catch {
        // Unreadable entry: skip it.
      }
    }
  };
  visit(join(repoRoot, "packages"), 2); // packages/<pkg>
  visit(join(repoRoot, "apps"), 3); // apps/<pkg> and apps/<pkg>/packages/<pkg>
  return map;
}

const workspacePackages = collectWorkspacePackages();

/** Resolves `@zcode/<pkg>` and `@zcode/<pkg>/<sub>` through that package's `exports` map. */
function resolveZcodeSpecifier(spec) {
  const slash = spec.indexOf("/", 7);
  const name = slash === -1 ? spec : spec.slice(0, slash);
  const rest = slash === -1 ? "" : spec.slice(slash + 1);
  let pkgDir = workspacePackages.get(name);
  if (!pkgDir) {
    try {
      pkgDir = realpathSync(join(repoRoot, "node_modules", name));
    } catch {
      return null;
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const map = manifest.exports;
  let target = !rest ? (map?.["."] ?? manifest.module ?? manifest.main) : map?.[`./${rest}`];
  if (target === undefined && map?.["./*"]) target = String(map["./*"]).replace("*", rest);
  if (target && typeof target === "object") target = target.import ?? target.default;
  if (typeof target !== "string") target = rest ? join("src", rest) : join("src", "index.ts");
  return resolveTypeScriptFile(join(pkgDir, target));
}

function resolveSpecifier(spec, importerFile) {
  if (spec.startsWith(".")) return resolveTypeScriptFile(join(dirname(importerFile), spec));
  // Both vite configs map `@` to `packages/ui/src` (tauri vite.config.ts, web vite.config.ts).
  if (spec.startsWith("@/"))
    return resolveTypeScriptFile(join(repoRoot, UI_ALIAS_DIR, spec.slice(2)));
  if (spec.startsWith("#")) {
    const info = packageInfoFor(importerFile);
    const map = info?.json?.imports;
    if (!map) return null;
    for (const [key, target] of Object.entries(map)) {
      const value = typeof target === "string" ? target : target?.default;
      if (typeof value !== "string") continue;
      if (key.includes("*")) {
        const prefix = key.slice(0, key.indexOf("*"));
        if (spec.startsWith(prefix)) {
          return resolveTypeScriptFile(
            join(info.dir, value.replace("*", spec.slice(prefix.length))),
          );
        }
      } else if (key === spec) {
        return resolveTypeScriptFile(join(info.dir, value));
      }
    }
    return null;
  }
  if (spec.startsWith("@zcode/")) return resolveZcodeSpecifier(spec);
  return null; // external: react, @tauri-apps, node builtins, css, …
}

function posixRelative(path) {
  return relative(repoRoot, path).split("\\").join("/");
}

function rendererReachabilityViolations() {
  const found = [];
  const visited = new Set();
  const parentOf = new Map(); // child → { from, spec }
  const queue = RENDERER_ENTRIES.map((entry) => join(repoRoot, entry));
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const rel = posixRelative(file);
    if (rel.startsWith(NATIVE_WRAPPER_PREFIX)) {
      // Report the path the renderer actually takes to reach the native wrappers.
      const segments = [];
      let cursor = file;
      for (;;) {
        const edge = parentOf.get(cursor);
        if (!edge) {
          // The entry itself: only as its own segment, never duplicated as the left side of
          // the first edge.
          if (segments.length === 0) segments.unshift(posixRelative(cursor));
          break;
        }
        segments.unshift(
          `${posixRelative(edge.from)} --[${edge.spec}]--> ${posixRelative(cursor)}`,
        );
        cursor = edge.from;
      }
      found.push({ file: rel, text: `renderer-reachable native wrapper: ${segments.join(" ")}` });
      continue; // do not descend into the native package
    }
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of valueImportSpecifiers(source)) {
      const resolved = resolveSpecifier(spec, file);
      if (!resolved || visited.has(resolved) || parentOf.has(resolved)) continue;
      parentOf.set(resolved, { from: file, spec });
      queue.push(resolved);
    }
  }
  return { found, walked: visited.size };
}

const reachability = rendererReachabilityViolations();
for (const violation of reachability.found) violations.push(violation);

if (violations.length > 0) {
  process.stdout.write(
    "@zcode/rust must not be imported from renderer-reachable modules (the renderer imports the shared/rpc/client barrels for runtime values):\n",
  );
  for (const v of violations) process.stdout.write(`  ${v.file}: ${v.text}\n`);
  process.stdout.write(
    "\nThe sandboxed renderer cannot load a .node binary; Vite externalizes node:fs.\n" +
      "A sanctioned Node-only directory (packages/rpc/src/native, packages/shared/src/node,\n" +
      "packages/services/src/node) is only safe while nothing renderer-reachable imports it or\n" +
      "reaches it through a barrel — both are checked here.\n" +
      "See docs/specs/rust-native-ports.md invariant 9.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "native-graph OK: no @zcode/rust imports in renderer-reachable modules, and no native wrapper " +
    `reachable from the renderer entries (${reachability.walked} modules walked)\n`,
);
