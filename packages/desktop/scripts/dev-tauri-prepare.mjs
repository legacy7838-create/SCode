#!/usr/bin/env node
// dev:tauri 的前置步骤：在 `tauri dev` 触发 src-tauri 的 build.rs 之前，确保
// bundled-agents/<宿主平台>/glm/zcode_db.node 存在。
//
// 为什么需要它：src-tauri/tauri.conf.json 的 bundle.resources glob
// (`bundled-agents/*/glm/zcode_db.node`) 在 dev 与 build 都会被 build.rs 校验，
// 匹配不到文件即 exit 101。dev 运行时的 DB addon 由 zcodeDb.ts 直接读
// packages/desktop/zcode-db/zcode_db.node，不需要 glm 副本；glm 副本只为满足该 glob
// 以及打包态随包携带。dev 链此前不 stage 它，所以干净工作树里 `pnpm dev:tauri` 必崩。
//
// DB 始终是 Rust：addon 源缺失时用 cargo 构建（prepare-zcode-db-native.mjs），
// 不引入任何 JS sqlite 兜底。落点解析复用 stage-agent-bundle.mjs，与打包链同一份，不漂移。
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  resolveAgentBundlePaths,
  stageZcodeDbNative,
} from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const platformKey = `${process.platform}-${process.arch}`;

const { dbAddonSource, stagedDbNodePath } = resolveAgentBundlePaths({ repoRoot, platformKey });

// 快速路径：glm 里已有 addon 且不比构建产物旧，直接跳过（含 cargo），不拖慢每次 dev 启动。
if (
  existsSync(stagedDbNodePath) &&
  existsSync(dbAddonSource) &&
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
