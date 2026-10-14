#!/usr/bin/env node
// dev:tauri 的前置步骤：在 `tauri dev` 触发 src-tauri 的 build.rs 之前，确保
// bundled-agents/<宿主平台>/glm/zcode_db.node 存在，并 stage 好 dev-host 运行期需要的全部原生边界。
//
// 为什么需要它：src-tauri/tauri.conf.json 的 bundle.resources glob
// (`bundled-agents/*/glm/zcode_db.node`) 在 dev 与 build 都会被 build.rs 校验，
// 匹配不到文件即 exit 101。dev 运行时的 DB addon 由 zcodeDb.ts 直接读
// packages/desktop/zcode-db/zcode_db.node，不需要 glm 副本；glm 副本只为满足该 glob
// 以及打包态随包携带。dev 链此前不 stage 它，所以干净工作树里 `pnpm dev:tauri` 必崩。
//
// 四条边界全部无 JS 兜底，因此这里缺一即建一，绝不降级：
//   - zcode-db（napi addon）
//   - zcode-pty（napi addon，dev-host 开终端用）
//   - zcode-scan（napi addon，@-mention 的工作区遍历）
//   - zcode-score-wasm（wasm 胶水 + payload，@-mention 的模糊评分）
//   - zcode-diff-wasm（wasm 胶水 + payload，行级 LCS / unified diff / 变更行统计）
// DB 始终是 Rust：addon 源缺失时用 cargo 构建（prepare-zcode-db-native.mjs），
// 不引入任何 JS sqlite 兜底。落点解析复用 stage-agent-bundle.mjs，与打包链同一份，不漂移。
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveAgentBundlePaths, stageZcodeDbNative } from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const platformKey = `${process.platform}-${process.arch}`;

const { dbAddonSource, stagedDbNodePath } = resolveAgentBundlePaths({ repoRoot, platformKey });
const ptyAddonSource = resolve(desktopRoot, "zcode-pty", "zcode_pty.node");
// 工作区文件搜索的两条原生边界（spec/native-boundary-*.md）在 dev 链同样必须就绪：
// scan 是 napi addon，score 是 wasm 胶水 + payload。两者都**没有 JS 兜底**，
// 缺一个就会在用户第一次按 `@` 时抛错，而不是降级。dev-host.mjs 也在启动时 fail-fast。
const scanAddonSource = resolve(desktopRoot, "zcode-scan", "zcode_scan.node");
const scoreGlueSource = resolve(desktopRoot, "zcode-score-wasm", "pkg", "nodejs", "zcode_score.js");
// diff 同理：Host 的 taskChangeSummary 与 renderer 的 toolDiffPreview 都走 wasm 内核，无 JS 兜底。
// Host 用 nodejs 胶水（packages/services/src/session/diffNative.ts），renderer 用 web 胶水
// （packages/ui/src/lib/diffWasm.ts + vite alias）。nodejs 胶水存在即代表两个 target 都已 stage。
const diffGlueSource = resolve(desktopRoot, "zcode-diff-wasm", "pkg", "nodejs", "zcode_diff.js");

// 快速路径：glm 里已有 addon 且不比构建产物旧，且 PTY / scan / score / diff 边界也都已就绪时，才直接跳过
//（含 cargo），不拖慢每次 dev 启动。PTY、scan、score、diff 也纳入判断：否则 DB 命中缓存时会跳过下面的
// cargo 构建，干净但 DB 已暂存的工作树里这些产物永远建不出来，dev-host / host-sidecar 随后必崩。
if (
  existsSync(stagedDbNodePath) &&
  existsSync(dbAddonSource) &&
  existsSync(ptyAddonSource) &&
  existsSync(scanAddonSource) &&
  existsSync(scoreGlueSource) &&
  existsSync(diffGlueSource) &&
  statSync(stagedDbNodePath).mtimeMs >= statSync(dbAddonSource).mtimeMs
) {
  console.log(`[dev:tauri:prepare] zcode_db.node 已就绪：${stagedDbNodePath}`);
  process.exit(0);
}

// DB = Rust：addon 源缺失时先用 cargo 构建，绝不 fallback 到 JS。
if (!existsSync(dbAddonSource)) {
  console.log("[dev:tauri:prepare] Rust DB addon 源缺失，运行 cargo 构建 ...");
  const result = spawnSync(
    process.execPath,
    [resolve(desktopRoot, "scripts", "prepare-zcode-db-native.mjs")],
    { cwd: desktopRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("[dev:tauri:prepare] cargo 构建 zcode-db 失败，无法继续 dev:tauri");
    process.exit(result.status ?? 1);
  }
}

stageZcodeDbNative({ repoRoot, platformKey });

// PTY = Rust: dev-host.mjs requires packages/desktop/zcode-pty/zcode_pty.node to open terminals.
// Build it with cargo when missing so a clean tree's `pnpm dev:tauri` works; never fall back to JS.
if (!existsSync(ptyAddonSource)) {
  console.log("[dev:tauri:prepare] Rust PTY addon 源缺失，运行 cargo 构建 ...");
  const result = spawnSync(
    process.execPath,
    [resolve(desktopRoot, "scripts", "prepare-zcode-pty-native.mjs")],
    { cwd: desktopRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("[dev:tauri:prepare] cargo 构建 zcode-pty 失败，无法继续 dev:tauri");
    process.exit(result.status ?? 1);
  }
}

// scan = Rust：@-mention 的工作区遍历走 napi addon，无 JS 兜底。缺失时用 cargo 构建。
if (!existsSync(scanAddonSource)) {
  console.log("[dev:tauri:prepare] Rust scan addon 源缺失，运行 cargo 构建 ...");
  const result = spawnSync(
    process.execPath,
    [resolve(desktopRoot, "scripts", "prepare-zcode-scan-native.mjs")],
    { cwd: desktopRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("[dev:tauri:prepare] cargo 构建 zcode-scan 失败，无法继续 dev:tauri");
    process.exit(result.status ?? 1);
  }
}

// score = WASM：@-mention 的模糊评分走 wasm 内核，无 JS 兜底。缺失时用 wasm-bindgen 构建。
if (!existsSync(scoreGlueSource)) {
  console.log("[dev:tauri:prepare] Rust score wasm 产物缺失，运行构建 ...");
  const result = spawnSync(
    process.execPath,
    [resolve(desktopRoot, "scripts", "prepare-zcode-score-wasm.mjs")],
    { cwd: desktopRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("[dev:tauri:prepare] 构建 zcode-score-wasm 失败，无法继续 dev:tauri");
    process.exit(result.status ?? 1);
  }
}

// diff = WASM：行级 LCS / unified diff / 变更行统计走 wasm 内核，无 JS 兜底。缺失时构建。
if (!existsSync(diffGlueSource)) {
  console.log("[dev:tauri:prepare] Rust diff wasm 产物缺失，运行构建 ...");
  const result = spawnSync(
    process.execPath,
    [resolve(desktopRoot, "scripts", "prepare-zcode-diff-wasm.mjs")],
    { cwd: desktopRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("[dev:tauri:prepare] 构建 zcode-diff-wasm 失败，无法继续 dev:tauri");
    process.exit(result.status ?? 1);
  }
}
