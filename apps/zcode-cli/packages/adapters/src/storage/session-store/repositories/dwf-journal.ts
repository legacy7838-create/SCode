/**
 * `JournalStorePort` + 宿主内省读面的 Rust addon 实现（`dwf_*` 表）。
 *
 * 端口是同步的、仓储式的；每个方法是一次 `#[napi]` 调用（addon 无状态，逐次开连接），SQL 与
 * 行↔记录编解码全部在 `packages/desktop/zcode-db/src/session_journal*.rs`，JS 只做 JSON 收发。
 * `now` 由调用方注入（`Date.now()`），addon 从不读时钟——与切换前的 TS 语义逐字一致。
 *
 * 与 @zcode/dynamic-workflow 的依赖方向不变：只 `import type`。端口属于领域包，本文件是它的一个
 * adapter；运行时不得从领域包取任何值（`implements` 在编译期被抹除）。
 *
 * 事务性不在端口面上：需要与 session 写入同原子的场景由 driver 组合；addon 侧的复合写
 * （fork bundle 等）自带 `BEGIN IMMEDIATE`。
 */

import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  ListEventsOptions,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import type { DbAddon } from "../native-addon.js";
import type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
import type {
  DwfRunDetailRow,
  DwfRunListItem,
  DwfRunSessionListItem,
  DwfWorldNodeRow,
} from "./dwf-journal-codecs.js";
import type {
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

export type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
export type {
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

/** addon 的 `"null"`（无行）与端口的 `undefined` 之间的唯一转换点。 */
function parseOrNull(json: string): unknown {
  return json === "null" ? undefined : (JSON.parse(json) as unknown);
}

class NativeDwfJournalStore implements JournalStorePort, DwfRunIntrospectionQueries {
  constructor(
    private readonly dbPath: string,
    private readonly addon: DbAddon,
  ) {}

  createRun(record: RunRecord): void {
    this.addon.dwfCreateRunJson(this.dbPath, JSON.stringify(record), Date.now());
  }

  getRun(runId: string): RunRecord | undefined {
    return parseOrNull(this.addon.dwfGetRunJson(this.dbPath, runId)) as RunRecord | undefined;
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    // 结算袋缺省时传空串：addon 侧 `""` 与 `"null"` 都表示「无结算袋」，与 TS 的 undefined 同义。
    this.addon.dwfUpdateRunStatusJson(
      this.dbPath,
      runId,
      status,
      settlement === undefined ? "" : JSON.stringify(settlement),
      Date.now(),
    );
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    this.addon.dwfUpdateRunUsageJson(this.dbPath, runId, spentTokens, Date.now());
  }

  updateRunCaps(runId: string, caps: Caps): void {
    this.addon.dwfUpdateRunCapsJson(this.dbPath, runId, JSON.stringify(caps), Date.now());
  }

  /**
   * 某个父会话名下所有**非终态**的 run。刻意不在 `JournalStorePort` 上：引擎从不按父会话找
   * run，这条查询只服务于宿主侧的孤儿收敛（一个进程被杀掉的 run 会永远停在 `running`）。
   * 终态判定权威留在 service 侧；存储层只做索引友好的预筛。
   */
  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    return JSON.parse(
      this.addon.dwfListNonTerminalRunsJson(this.dbPath, parentSessionId),
    ) as RunRecord[];
  }

  listRuns(query: DwfListRunsQuery): DwfRunListItem[] {
    return JSON.parse(this.addon.dwfListRunsJson(this.dbPath, JSON.stringify(query))) as DwfRunListItem[];
  }

  getRunRow(runId: string): DwfRunDetailRow | undefined {
    return parseOrNull(this.addon.dwfGetRunRowJson(this.dbPath, runId)) as DwfRunDetailRow | undefined;
  }

  countNodesByStatus(runId: string): DwfNodeStatusCounts {
    return JSON.parse(this.addon.dwfCountNodesByStatusJson(this.dbPath, runId)) as DwfNodeStatusCounts;
  }

  listRecentLogEvents(runId: string, limit: number): StoredEvent[] {
    return JSON.parse(
      this.addon.dwfListRecentLogEventsJson(this.dbPath, runId, limit),
    ) as StoredEvent[];
  }

  listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
    return JSON.parse(this.addon.dwfListRunLifeSpansJson(this.dbPath, runId)) as DwfRunLifeSpan[];
  }

  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[] {
    return JSON.parse(
      this.addon.dwfListRunsByParentSessionJson(this.dbPath, parentSessionId, limit),
    ) as DwfRunSessionListItem[];
  }

  putActor(record: ActorRecord): void {
    this.addon.dwfPutActorJson(this.dbPath, JSON.stringify(record), Date.now());
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    return parseOrNull(
      this.addon.dwfGetActorJson(this.dbPath, runId, siteId, ordinal),
    ) as ActorRecord | undefined;
  }

  listActors(runId: string): ActorRecord[] {
    return JSON.parse(this.addon.dwfListActorsJson(this.dbPath, runId)) as ActorRecord[];
  }

  putNode(record: NodeRecord): void {
    this.addon.dwfPutNodeJson(this.dbPath, JSON.stringify(record), Date.now());
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    return parseOrNull(
      this.addon.dwfGetNodeJson(this.dbPath, runId, siteId, ordinal),
    ) as NodeRecord | undefined;
  }

  listNodes(runId: string): NodeRecord[] {
    return JSON.parse(this.addon.dwfListNodesJson(this.dbPath, runId)) as NodeRecord[];
  }

  listArtifactRows(runId: string): NodeRecord[] {
    return JSON.parse(this.addon.dwfListArtifactRowsJson(this.dbPath, runId)) as NodeRecord[];
  }

  listWorldNodes(runId: string): DwfWorldNodeRow[] {
    return JSON.parse(this.addon.dwfListWorldNodesJson(this.dbPath, runId)) as DwfWorldNodeRow[];
  }

  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): DwfArtifactItem[] {
    return JSON.parse(
      this.addon.dwfListArtifactItemsJson(this.dbPath, runId, artifactId, JSON.stringify(query)),
    ) as DwfArtifactItem[];
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // 写入时刻由 JS 注入并原样回传：addon 不读时钟，所以 `timeCreated` 必须来自这里，
    // 否则「刚写的事件没有时刻、读回来才有」的两面不一致会重新出现。
    return JSON.parse(
      this.addon.dwfAppendEventJson(this.dbPath, runId, JSON.stringify(event), Date.now()),
    ) as StoredEvent;
  }

  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[] {
    // cursor / limit 直接作为查询袋下推到存储层：分页存在的理由就是不把整条 journal 读进内存。
    return JSON.parse(
      this.addon.dwfListEventsJson(this.dbPath, runId, opts === undefined ? "" : JSON.stringify(opts)),
    ) as StoredEvent[];
  }
}

/**
 * 在既有 session 库上开一个 dwf journal 视图；表由 session bootstrap 建立（migration 0019）。
 * 句柄不再是一个 sqlite 连接，而是「库路径 + 已加载的 addon」。
 */
export function createDwfJournalStore(dbPath: string, addon: DbAddon): JournalStorePort {
  return new NativeDwfJournalStore(dbPath, addon);
}
