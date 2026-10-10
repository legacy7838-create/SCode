/**
 * 用户面**产物**的两条宿主读面的类型。
 *
 * ⚠ 这里的 artifact 是脚本**发布给用户看**的交付物（文件 / markdown / 预置看板），不是
 * `RunSettlement.artifact`（脚本的顶层返回值）。两义并存。
 *
 * 为什么住在 `JournalStorePort` **之外**：与 `listRuns` 逐字同一条论证——引擎只按
 * `listNodes` 走自己那条 ordinal 链，从不为「本 run 有哪些产物」「某个看板收到过哪些条目」
 * 负责。把它们加进领域端口，等于要求每个 journal 实现（含引擎自带的内存实现）实现一件引擎不
 * 做的事。消费方按能力探测（`typeof journal.listArtifactRows === "function"`）决定读面可用性，
 * 签名的单一事实源是 `DwfRunIntrospectionQueries`。
 *
 * Rust 切换前本文件还带着这两条查询的 SQL；SQL 现在住在
 * `packages/desktop/zcode-db/src/session_journal_read.rs`（`dwf_list_artifact_*`），这里只剩
 * 返回形状。
 */

/** {@link listArtifactItems} 的分页袋（游标 = journal sequence）。 */
export interface DwfArtifactItemsQuery {
  /**
   * 只返回 sequence **严格大于**该值的条目。游标是「已读到的最后一个 sequence」而不是偏移量，
   * 与 `listEvents` 逐字同一套语义——看板 hook 用的正是它已经在用的那个游标。
   */
  afterSequence?: number;
  /**
   * 单页条数上限，**必填**。存储层不替调用方猜默认值：一条无界的取数查询是这里唯一不该有的形状。
   *
   * 但**别在这里加自己的天花板**（如 `Math.min(500, limit)`）。调用方合法地传「钳制上限 + 1」
   * 来判定 `hasMore`（多取的那条不进页）——一个硬顶会把探测行悄悄吃掉，于是 `hasMore` 在
   * 恰好 limit = 上限时永久缺席。与 `DwfListRunsQuery.limit` 的截断探测行同一条论证。
   */
  limit: number;
}

/**
 * 一条喂给某个预置产物的 `report` 条目，**按 journal sequence 定位**。
 *
 * 为什么键是 sequence 而不是 (siteId, ordinal)：UI 的增量取数游标就是 journal 那一套
 * sequence（`afterSequence`，同运行事件查询的形状），而 dwf_node 上没有它。站点坐标仍然随行返回——
 * 揭示动画要一个跨重取稳定的 React key，而 sequence 与坐标都满足。
 */
export interface DwfArtifactItem {
  /** 被报告的 item 原值（任意 JSON；`REPORT_CAPS` 在写入侧已保证有界）。 */
  item: unknown;
  ordinal: number;
  sequence: number;
  siteId: string;
}
