/**
 * 宿主侧 **run 内省读面**的类型（`DwfRunIntrospectionQueries` 一族）。
 *
 * SQL 与它的论证现在一起住在 `packages/desktop/zcode-db/src/session_journal_read.rs`；本文件
 * 只留签名。文件名与导出路径不变，是因为 `dwf-journal.ts` 与 `@zcode/adapters/storage` 的既有
 * 导出面都挂在这里，改名只会制造无意义的跨包改动。
 *
 * 引擎的 `JournalStorePort` 写面不在这里——这里没有任何写入者。
 */

import type { NodeRecord, RunStatus, StoredEvent } from "@zcode/dynamic-workflow";
import type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
import type {
  DwfRunDetailRow,
  DwfRunListItem,
  DwfWorldNodeRow,
} from "./dwf-journal-codecs.js";

/** {@link DwfRunIntrospectionQueries.listRuns} 的查询袋。 */
export interface DwfListRunsQuery {
  /**
   * 项目键。字面等值匹配 `dwf_run.cwd`（写入侧原样落，读侧原样查）。
   *
   * **可选**：缺省即不加 cwd 谓词，跨所有项目枚举。全局工作流的运行历史横跨它被发起过的每个
   * 项目（`workflows/runs` 的 `scope: "global"` 变体）；项目档变体仍传 cwd，行为逐字不变。
   */
  cwd?: string;
  /**
   * 返回行数上限，**必填**。钳制策略属于调用方（工具面钳到 [1, 50]）；存储层不替它猜一个
   * 默认值——一条无界的枚举查询是这里唯一不该有的形状。
   *
   * 但**别在这里加自己的天花板**（如 `Math.min(50, limit)`）。调用方合法地传「钳制上限 + 1」：
   * run service 多取一条来判定 `truncated`（多取的那条不进页）。一个 50 的硬顶会把探测行悄悄
   * 吃掉，于是 `truncated` 在**恰好** limit = 50 时永久缺席——正是用户最需要知道"还有更多"的
   * 那个页大小，而且没有任何测试会在别的 limit 上发现它。
   */
  limit: number;
  /** 可选状态子集。缺省即不过滤；空数组即「不匹配任何状态」（回空页）。 */
  statuses?: readonly RunStatus[];
  /**
   * 可选的 run 名字（`dwf_run.name` 字面等值）。GUI 中枢按「工作流名 = run 名」归属运行历史，
   * 过滤下推到存储层而不是取一页再筛——否则一个高频工作流会把别的工作流挤出页外，卡片上的
   * 「上次运行」就是错的。
   */
  name?: string;
}

/** dwf_node 的三态计数（`NodeRecordStatus` 的全部取值，三个键恒在场）。 */
export interface DwfNodeStatusCounts {
  completed: number;
  failed: number;
  running: number;
}

/**
 * 一个 run 的**一世**（一次 `run-started` 到它最后一条事件）的起止，epoch 毫秒。
 *
 * 一世就是「引擎活着的一段」：崩溃或停止的那一世没有 `run-settled`，所以收尾只能由「这一世
 * 记下的最后一条事件」界定——那正是它最后一次动的时刻。两个时刻同源于 `dwf_event.time_created`
 * （事件日志里一切「多久以前」的唯一时钟），因此差值不会跨时钟。
 */
export interface DwfRunLifeSpan {
  startedAt: number;
  lastActivityAt: number;
}

/**
 * 宿主侧的 run 内省查询面（`ListWorkflowRuns` / `GetWorkflowRun` 两个只读工具的取数底座）。
 *
 * 刻意**不加宽**引擎的 `JournalStorePort`，与 `listNonTerminalRuns` 逐字同一条论证：引擎只按
 * runId 读写自己那一行，从不枚举 run、也不做聚合计数——把这些加进领域端口，等于要求每个
 * journal 实现（包括引擎自带的内存实现）为一件引擎不做的事负责。
 *
 * 消费方按能力探测（`typeof journal.listRuns === "function"`）决定工具可用性，所以这个接口是
 * 宿主与 adapter 之间**唯一**的签名来源：签名在两处各写一份就会漂移，而漂移的后果是工具静默
 * 降级成「本会话没有这个能力」。
 */
export interface DwfRunIntrospectionQueries {
  countNodesByStatus(runId: string): DwfNodeStatusCounts;
  getRunRow(runId: string): DwfRunDetailRow | undefined;
  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): DwfArtifactItem[];
  /**
   * 本 run 的**产物行**（`kind = 'artifact'`），按落库先后。一行 = 一个版本（同 id 再发布是新
   * 行、历史保留），所以调用方按 `artifactId` 分组、从每行的 `result` 取版本。排序是插入序而不是
   * `artifact_id, ordinal`：版本的先后就是落库的先后。失败的发布同样在结果里。
   */
  listArtifactRows(runId: string): NodeRecord[];
  listRecentLogEvents(runId: string, limit: number): StoredEvent[];
  /**
   * 按项目（cwd）枚举 run，最近更新的在前。行是窄投影（{@link DwfRunListItem}，不带 failure /
   * result）：列表面不展示产物，而产物可以很大。
   */
  listRuns(query: DwfListRunsQuery): DwfRunListItem[];
  /**
   * 本 run 每一世的活动区间，按时序（完成卡的「时间」格）。一条 run 可以
   * 有多世（每次 resume 一世），而每一世的墙钟只有事件日志知道。
   */
  listRunLifeSpans(runId: string): DwfRunLifeSpan[];
  /**
   * 本 run 的 world-read / world-run 行，按落库先后。**不取正文**：这条读面是清单
   * （op / args / 状态 / 时间），正文另有按 (siteId, ordinal) 的读面——一页 256 个节点把每个
   * 256 KB 的 stdout 一起解出来，等于把整条 journal 读进内存。
   */
  listWorldNodes(runId: string): DwfWorldNodeRow[];
}
