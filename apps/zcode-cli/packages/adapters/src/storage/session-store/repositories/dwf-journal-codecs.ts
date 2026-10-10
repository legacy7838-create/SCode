/**
 * DWF journal 读面的**投影类型**（宿主侧看到的那一行长什么样）。
 *
 * Rust 切换（cutover）前，本文件同时承载 `dwf_*` 行 ↔ 记录的编解码（encode/decode）。现在
 * 这些映射全部在 `packages/desktop/zcode-db/src/session_journal*.rs` 里逐字实现并由 parity
 * harness 对齐，JS 侧只剩「addon 返回的 JSON 是什么形状」这一层类型，因此本文件只保留投影
 * 类型；文件名不变，是为了让 `@zcode/adapters/storage` 的既有导出路径不必跟着改。
 *
 * 记录类型只以 `import type` 从 @zcode/dynamic-workflow 引入：端口住在领域包里，adapter 运行
 * 时不得对领域包产生任何依赖。
 */

import type { NodeRecord, RunRecord } from "@zcode/dynamic-workflow";

/** journal 侧的行时间戳。`RunRecord` 刻意不带时间（引擎不关心），但读面要报 created/updated。 */
export interface DwfRunTimestamps {
  timeCreated: number;
  timeUpdated: number;
}

/**
 * 枚举查询的一行：run 元数据 + 时间戳，**不含** failure / result。
 * 详情行是它的超集，所以 list 与 get 两条读面可以共用同一套标签与归属推导。
 */
export type DwfRunListItem = Omit<RunRecord, "failure" | "result"> & DwfRunTimestamps;

/** 详情查询的一行：完整 `RunRecord`（含 failure / result）+ 时间戳。 */
export type DwfRunDetailRow = RunRecord & DwfRunTimestamps;

/**
 * 会话枚举查询的一行：{@link DwfRunListItem} + `failure`，**仍然不含 result**。
 *
 * 为什么不直接用 {@link DwfRunListItem}：会话枚举面（`listRunsForSession` → `/dwf list`）
 * 要报 failureCode/failureMessage，且 `resumable` 的谓词就是「failed 且 code 为
 * Interrupted」——省掉 failure 会让每个被打断的 run 都被算成不可恢复，那是一个静默的错误
 * 答案，而不是少一列展示。
 *
 * 为什么仍然不取 result：那一列是真正无界的（脚本的顶层返回值），而列表面从不展示产物。
 */
export type DwfRunSessionListItem = DwfRunListItem & Pick<RunRecord, "failure">;

/**
 * 工作区读面的一行：world-read / world-run 的
 * `NodeRecord`（**不含 `result`**——正文另有按 (siteId, ordinal) 的读面）+ journal 时间戳 +
 * `result_json` 的字节数（清单上的「多大」，不用把正文解出来就能报）。
 */
export interface DwfWorldNodeRow extends Omit<NodeRecord, "result">, DwfRunTimestamps {
  /** `result` 序列化后的 UTF-8 字节数；行还没结算或结算失败时缺席。 */
  resultBytes?: number;
  /**
   * 正文是 JSON 数组时的元素数（`glob` 的文件数、`grep` 的命中数、`git.changedFiles` 的路径数）。
   * 由 SQLite 的 JSON 函数在查询里算出，正文本身不出库。
   */
  resultCount?: number;
  /** `world.run` 结算后正文上的 `exitCode`；其它 op 与未结算行缺席。 */
  exitCode?: number;
  /** `world.run` 结算后 `stdout` / `stderr` 的 UTF-8 字节数。 */
  stdoutBytes?: number;
  stderrBytes?: number;
}
