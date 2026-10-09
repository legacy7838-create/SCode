import type { DatabaseMigrationFacts } from "@zcode/shared";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadDb } from "#src/session/zcodeDb.js";

type TasksStoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";
const LOCK_WAIT_MS = 60 * 60_000;

/**
 * 由 Host Worker 调用：确保 tasks-index.sqlite 建表 / 迁移 / 一次性启动自愈完成。
 *
 * 存储与迁移账本已全部下沉 Rust `zcode-db` addon：`bootstrapTasksIndex` 负责建表 + 冻结校验和的
 * 迁移账本（幂等，遇锁按 busy_timeout 等待），`runStartupRepairsJson` 负责 off-peak 标记/分组回填、
 * 删除引用清理、awaiting_approval 修复等一次性自愈（同样幂等）。本函数不再直接开 `node:sqlite`，
 * 迁移期专用的 prepared/migrated 标记也已随 addon 的幂等 bootstrap 一并省去。`migration` 进度事实
 * 保留为可选入参以兼容 Worker 回调（addon 的 bootstrap 为单步，不再逐迁移上报）。
 */
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
): Promise<void> {
  const report = (phase: TasksStoragePhase): void => onProgress(phase);
  report("checking");
  await mkdir(dirname(path), { recursive: true });
  report("migrating");
  try {
    // 建表 + 迁移账本；busy_timeout 传入以在并发窗口/多 Host 下等待而非立即 SQLITE_BUSY。
    loadDb().bootstrapTasksIndex(path, LOCK_WAIT_MS);
    report("maintaining");
    // 一次性启动自愈（幂等）：off-peak 标记/分组回填、删除引用清理、legacy 状态修复。
    loadDb().runStartupRepairsJson(path, Date.now());
  } catch (error) {
    // 失败事实随原异常交给 Worker，由其归类为 sql_failed / lock_timeout；不吞首因。
    report("checking");
    throw error;
  }
  report("ready");
}
