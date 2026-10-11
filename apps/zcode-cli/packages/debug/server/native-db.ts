// 观测面板的 Rust addon 只读入口。
//
// 为什么这个包自己加载 `.node`，而不是 import `@zcode/adapters/storage`：debug 服务是一个
// 独立的本地诊断工具（依赖里没有任何 @zcode 包），走 adapters 就得先把整条 adapters 构建图
// （dist 产物 + 全部运行依赖）拖进这个只读面板，而它真正需要的只有一个查询。路径解析契约与
// CLI/桌面侧完全一致（ZCODE_DB_NATIVE 优先，其次仓库内暂存的 cargo 产物），产物本身由
// `packages/desktop/scripts/prepare-zcode-db-native.mjs --check` 负责验证可加载。
//
// 不再有 Node 内建 SQLite：切换后 JS 侧不持有数据库句柄，原始行由 addon 的只读投影返回。

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 观测面板用到的唯一 op：session / message / part 的原始行窗口（与切换前的三条 SELECT 同形）。 */
interface DebugDbAddon {
  debugObservationJson(
    dbPath: string,
    sessionsLimit: number,
    messagesLimit: number,
    partsLimit: number,
  ): string;
}

/** addon 的原始行投影：列名即键，TEXT/INTEGER 原样，缺值为 null。 */
export interface RawRow {
  [column: string]: string | number | null;
}

export interface DebugObservationRows {
  messages: RawRow[];
  parts: RawRow[];
  sessions: RawRow[];
}

/**
 * 当前模块目录的稳健解析（与 adapters/session-store/native-addon.ts 同一修复）。
 *
 * Bug 原因：打包态 CLI 是 CJS bundle，`import.meta` 不存在（被打包器替换成空对象），
 * `import.meta.url` 为 undefined，导致 `createRequire(undefined)` 抛 ERR_INVALID_ARG_VALUE。
 * dev（ESM/tsx）下无法复现，所以只在打包产物里暴露。
 */
function moduleDir(): string {
  const metaUrl = (import.meta as unknown as { url?: string }).url;
  if (typeof metaUrl === "string" && metaUrl.startsWith("file:")) {
    return dirname(fileURLToPath(metaUrl));
  }
  if (typeof __dirname === "string" && __dirname.length > 0) {
    return __dirname;
  }
  return process.cwd();
}

function resolveNativePath(): string {
  const fromEnv = process.env.ZCODE_DB_NATIVE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`ZCODE_DB_NATIVE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  // .../apps/zcode-cli/packages/debug/server → 仓库根，再进桌面侧的暂存产物。
  const here = moduleDir();
  const candidate = join(here, "../../../../../packages/desktop/zcode-db/zcode_db.node");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-db native addon not found at ${candidate}. Build it with: ` +
        `node packages/desktop/scripts/prepare-zcode-db-native.mjs (or set ZCODE_DB_NATIVE).`,
    );
  }
  return candidate;
}

let cached: DebugDbAddon | null = null;

function loadAddon(): DebugDbAddon {
  if (!cached) {
    cached = createRequire(join(moduleDir(), "native-db.cjs"))(resolveNativePath()) as DebugDbAddon;
  }
  return cached;
}

/** 读取一次观测快照；三条窗口的 SQL、排序与上限都留在 addon 里（单一事实源）。 */
export function readObservationRows(
  dbPath: string,
  limits: { sessions: number; messages: number; parts: number },
): DebugObservationRows {
  const json = loadAddon().debugObservationJson(
    dbPath,
    limits.sessions,
    limits.messages,
    limits.parts,
  ) as string;
  return JSON.parse(json) as DebugObservationRows;
}
