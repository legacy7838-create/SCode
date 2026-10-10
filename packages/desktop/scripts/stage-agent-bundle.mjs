// Agent bundle 的暂存动作：把 apps/zcode-cli/packages/cli/dist/zcode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledZCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

// node:sqlite 彻底移除后，app-server 子进程只能靠随包携带的 Rust addon 打开 session DB
// （见 packages/services/src/session/zcodeDb.ts）。addon 由 cargo 构建后暂存在
// packages/desktop/zcode-db/zcode_db.node；这里把它复制进 glm 目录（与 zcode.cjs 同级），
// 让 electron-builder/Tauri 的 glm→resources/glm 拷贝逻辑一并打进安装包，同时满足
// src-tauri/tauri.conf.json 的 bundle.resources glob（`bundled-agents/*/glm/zcode_db.node`
// 在 dev 与 build 都会被 build.rs 校验）。缺失即硬失败——没有 addon 的包/会话在首启直接崩，
// 必须比运行时更早地在构建期报错。dev 与打包共用这一份落点解析，避免两边漂移。
export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
    dbAddonSource: resolve(repoRoot, "packages", "desktop", "zcode-db", "zcode_db.node"),
    stagedDbNodePath: resolve(glmDir, "zcode_db.node"),
  };
}

/** 把 cargo 构建出的 Rust DB addon 暂存进 glm 目录。addon 源缺失时硬失败并给出构建命令。 */
export function stageZcodeDbNative({ repoRoot, platformKey, log = console.log }) {
  const { dbAddonSource, glmDir, stagedDbNodePath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(dbAddonSource)) {
    throw new Error(
      `[stage:zcode-db-native] zcode-db addon 源缺失：${dbAddonSource}。` +
        " 先运行 pnpm prepare:zcode-db-native（cargo 构建 Rust addon）",
    );
  }
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(dbAddonSource, stagedDbNodePath);
  log(`[stage:zcode-db-native] staged ${stagedDbNodePath}`);
  return stagedDbNodePath;
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath, stagedDbNodePath } =
    resolveAgentBundlePaths({
      repoRoot,
      platformKey,
    });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  // glm 目录刚被清空重建，Rust DB addon 必须在同一份暂存实现里一并放回，
  // 否则 dev 链（build-desktop-agent-cli.mjs）清完目录就不再补 addon，
  // 而 Tauri build.rs 的 bundle.resources glob 会因缺文件在 dev 直接失败。
  stageZcodeDbNative({ repoRoot, platformKey, log });
  return { stagedBundlePath, stagedMetaPath, stagedDbNodePath: stagedDbNodePath };
}
