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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

if (violations.length > 0) {
  process.stdout.write(
    "@zcode/rust must not be imported from renderer-reachable modules (the renderer imports the shared/rpc/client barrels for runtime values):\n",
  );
  for (const v of violations) process.stdout.write(`  ${v.file}: ${v.text}\n`);
  process.stdout.write(
    "\nThe sandboxed renderer cannot load a .node binary; Vite externalizes node:fs.\n" +
      "A sanctioned Node-only directory (packages/rpc/src/native, packages/shared/src/node) is\n" +
      "only safe while nothing renderer-reachable imports its subpath — that is checked here.\n" +
      "See docs/specs/rust-native-ports.md invariant 9.\n",
  );
  process.exit(1);
}

process.stdout.write("native-graph OK: no @zcode/rust imports in renderer-reachable modules\n");
