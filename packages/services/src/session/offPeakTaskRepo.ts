/* off-peak 任务仓库：off_peak_tasks 的状态机守卫写入与调度认领。
   存储层已全部下沉到 Rust `zcode-db` addon（见 `#src/session/zcodeDb.js`），本文件只做：
   路径解析 + 一次 bootstrap/repair + addon 调用的 JSON 编解码。不再依赖任何 JS SQLite 驱动，无 JS 回退。
   与 automation 共用 tasks-index.sqlite，但表/状态机/常量独立，禁止往 automations 表加字段。 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  resolveWorkspaceKey,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { loadDb } from "#src/session/zcodeDb.js";

/** 认领超时回收：claim_running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。
    与 Rust `offpeak_write` 的 `CLAIM_STALE_MS` 同值（语义相同，常量各留一份便于对照）。 */
export const OFF_PEAK_CLAIM_STALE_MS = 10 * 60_000;

/** INSERT 撞上 idx_off_peak_bound_active（并发双创建的失败方）。addon 抛出的 rusqlite UNIQUE 文本
    与原 JS 驱动的 UNIQUE 文本完全一致，故正则不变。 */
export function isOffPeakBoundSessionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: off_peak_tasks\.workspace_key, off_peak_tasks\.session_id/.test(
      error.message,
    )
  );
}

const task = (json: string | null): ZCodeOffPeakTask | null => (json ? (JSON.parse(json) as ZCodeOffPeakTask) : null);
const tasks = (json: string): ZCodeOffPeakTask[] => JSON.parse(json) as ZCodeOffPeakTask[];

/**
 * 闲时任务仓库（tasks-index.sqlite）。存储、状态机守卫、原子认领、启动回收、服务端快照写回等
 * 全部逻辑都在 Rust addon 内（与 TS 版逐条 parity 校验过）；本类只注入 db 路径与 `now` 时钟。
 */
export class OffPeakTaskRepo {
  private initializePromise: Promise<void> | null = null;
  private readyPath: string | null = null;
  // db 路径不能依赖进程级全局：vitest threads 并发跑测试会互相覆盖，存在写进真实库的窗口。
  // 改为构造期固定 dbPath，测试注入临时库路径，生产不传则回退默认。
  private readonly resolvedDbPath: string | null;

  constructor(dbPath?: string, private readonly startupBusyTimeoutMs = 5000) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.readyPath && this.readyPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.initializePromise = null;
        this.readyPath = null;
        throw error;
      });
    }
    await this.initializePromise;
  }

  // addon 每次调用自开自闭连接（busy_timeout + FK/WAL 已在 addon 内设置），没有需要显式关闭的
  // 常驻连接；close() 仅重置本实例的初始化标记，保留调用方原有的生命周期契约（无连接错误可抛）。
  close(_options?: { throwOnError?: boolean }): void {
    this.initializePromise = null;
    this.readyPath = null;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const db = loadDb();
    // 建表 + 迁移账本（幂等；已 ready 的库直接返回）。deadline 复用 busy_timeout 语义。
    db.bootstrapTasksIndex(path, this.startupBusyTimeoutMs);
    // 幂等自愈：awaiting_approval→running、off-peak 标记/分组回填、删除引用清理（Rust 内实现）。
    db.runStartupRepairsJson(path, Date.now());
    this.readyPath = path;
  }

  // ---- 管理 CRUD ----

  /** 创建即入队（status=queued）。取号在 service 层先行，取号结果经 options 一并写入。 */
  async create(
    params: ZCodeOffPeakTaskCreateParams,
    options?: {
      now?: number;
      offPeakTaskId?: string;
      serverTicketId?: string;
      queuePosition?: number;
      registeredAt?: number;
      schedulable?: boolean;
    },
  ): Promise<ZCodeOffPeakTask> {
    await this.ensureReady();
    const db = loadDb();
    const now = options?.now ?? Date.now();
    const created = db.offpeakCreateJson(
      this.resolveDbPath(),
      JSON.stringify({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? null,
        title: params.title,
        prompt: params.prompt,
        permissionMode: params.permissionMode,
        modelSelection: params.modelSelection,
        boundSessionId: params.boundSessionId ?? null,
      }),
      JSON.stringify({
        offPeakTaskId: options?.offPeakTaskId ?? null,
        serverTicketId: options?.serverTicketId ?? null,
        queuePosition: options?.queuePosition ?? null,
        registeredAt: options?.registeredAt ?? null,
        schedulable: options?.schedulable ? true : false,
      }),
      now,
    );
    return JSON.parse(created) as ZCodeOffPeakTask;
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    return tasks(loadDb().listOffPeakJson(this.resolveDbPath(), workspaceKey));
  }

  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(loadDb().getOffPeakJson(this.resolveDbPath(), offPeakTaskId));
  }

  /** Registry 变化使已保存 Selection 失效：保留模型/档位快照供修复，清 Selection、撤 schedulable。 */
  async invalidateModelSelection(
    offPeakTaskId: string,
    modelSelection: NonNullable<ZCodeOffPeakTask["modelSelection"]>,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(
      loadDb().offpeakInvalidateModelSelectionJson(
        this.resolveDbPath(),
        offPeakTaskId,
        JSON.stringify(modelSelection),
        options?.now ?? Date.now(),
      ),
    );
  }

  /** 卡片 Delete：任何状态均可删。 */
  async delete(offPeakTaskId: string): Promise<void> {
    await this.ensureReady();
    loadDb().offpeakDeleteJson(this.resolveDbPath(), offPeakTaskId);
  }

  /** 仅隐藏 History 行：任务必须已实际启动；重复调用幂等。 */
  async markHistoryDeleted(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(
      loadDb().offpeakMarkHistoryDeletedJson(
        this.resolveDbPath(),
        offPeakTaskId,
        options?.now ?? Date.now(),
      ),
    );
  }

  /** 创建上限的本地预判用（权威是服务端取号 429/3103）。 */
  async countNonTerminal(): Promise<number> {
    await this.ensureReady();
    return loadDb().offpeakCountNonTerminalJson(this.resolveDbPath());
  }

  /** 本会话是否已有未终态绑定任务（创建前预检）。 */
  async hasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean> {
    await this.ensureReady();
    return loadDb().offpeakHasActiveBoundTaskJson(this.resolveDbPath(), workspaceKey, sessionId);
  }

  /** 执行中计数：keep-awake powerSaveBlocker 判据。 */
  async countActive(): Promise<number> {
    await this.ensureReady();
    return loadDb().offpeakCountActiveJson(this.resolveDbPath());
  }

  /** 编辑窗口期字段：仅 queued/paused 可编辑；modelSelection 只能替换为另一份明确 Selection。 */
  async updateEditableFields(
    offPeakTaskId: string,
    params: {
      title?: string;
      prompt?: string;
      permissionMode?: string;
      modelSelection?: ZCodeOffPeakTask["modelSelection"] | null;
    },
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(
      loadDb().offpeakUpdateEditableFieldsJson(
        this.resolveDbPath(),
        offPeakTaskId,
        JSON.stringify(params),
        options?.now ?? Date.now(),
      ),
    );
  }

  /** 轮询/重新取号写回：仅覆盖显式传入的字段。 */
  async updateSchedulingSnapshot(
    offPeakTaskId: string,
    patch: {
      schedulable?: boolean;
      queuePosition?: number | null;
      nextPollAt?: number | null;
      serverTicketId?: string;
      registeredAt?: number;
      now?: number;
    },
  ): Promise<void> {
    await this.ensureReady();
    loadDb().offpeakUpdateSchedulingSnapshotJson(
      this.resolveDbPath(),
      offPeakTaskId,
      JSON.stringify({
        schedulable: patch.schedulable,
        queuePosition: patch.queuePosition,
        nextPollAt: patch.nextPollAt,
        serverTicketId: patch.serverTicketId,
        registeredAt: patch.registeredAt,
      }),
      patch.now ?? Date.now(),
    );
  }

  // ---- 调度状态机 ----

  /** single-flight 认领可派发任务 + 回收认领超时的僵尸认领。 */
  async claimDue(now: number): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    return tasks(loadDb().offpeakClaimDueJson(this.resolveDbPath(), now));
  }

  /** 派发成功（网关 admitted）：queued→running，回填首跑 session/ticket，释放认领。 */
  async markRunning(
    offPeakTaskId: string,
    options: {
      startedAt: number;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
    },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(
      loadDb().offpeakMarkRunningJson(
        this.resolveDbPath(),
        offPeakTaskId,
        options.startedAt,
        options.conversationId ?? null,
        options.sessionId ?? null,
        options.serverTicketId ?? null,
      ),
    );
  }

  /** 终态落库（completed/failed/cancelled）。终态不可逆出：已终态的行返回 null。 */
  async markTerminal(
    offPeakTaskId: string,
    options: {
      status: "completed" | "failed" | "cancelled";
      endedAt: number;
      failureReason?: string;
      filesChanged?: number;
      dispatchError?: string;
    },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(
      loadDb().offpeakMarkTerminalJson(
        this.resolveDbPath(),
        offPeakTaskId,
        options.status,
        options.endedAt,
        options.failureReason ?? null,
        options.filesChanged ?? null,
        options.dispatchError ?? null,
      ),
    );
  }

  /** 用户 Pause / Continue：queued ⇄ paused；在途认领不可 Pause，返回 null。 */
  async setPaused(
    offPeakTaskId: string,
    paused: boolean,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(
      loadDb().offpeakSetPausedJson(
        this.resolveDbPath(),
        offPeakTaskId,
        paused,
        options?.now ?? Date.now(),
      ),
    );
  }

  /** 释放认领（派发失败/关机退出）：复位 single-flight 锁；带 error 时累计一次尝试。 */
  async releaseClaim(
    offPeakTaskId: string,
    options?: { error?: string; now?: number },
  ): Promise<void> {
    await this.ensureReady();
    loadDb().offpeakReleaseClaimJson(
      this.resolveDbPath(),
      offPeakTaskId,
      options?.error ?? null,
      options?.now ?? Date.now(),
    );
  }

  /** 启动回收：残留 running 置回 queued + 清超时认领，返回回收数。 */
  async recoverInterrupted(now: number): Promise<number> {
    await this.ensureReady();
    return loadDb().offpeakRecoverInterruptedJson(this.resolveDbPath(), now);
  }

  /** 时间盒到期 / ready 废票的续跑回队：running→queued，保留 resume 线索。 */
  async requeueForContinuation(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return task(
      loadDb().offpeakRequeueForContinuationJson(
        this.resolveDbPath(),
        offPeakTaskId,
        options?.now ?? Date.now(),
      ),
    );
  }

  /** 全部非终态任务（offPeakTaskSync 轮询输入）。 */
  async listNonTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    return tasks(loadDb().offpeakListNonTerminalJson(this.resolveDbPath()));
  }

  /** settle 服务端 ack 后回填；仅终态行可核销（幂等）。 */
  async markSettled(offPeakTaskId: string, settledAt: number): Promise<void> {
    await this.ensureReady();
    loadDb().offpeakMarkSettledJson(this.resolveDbPath(), offPeakTaskId, settledAt);
  }

  /** 未核销的终态任务：poll 周期捎带补报 + host 启动扫描。 */
  async listUnsettledTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    return tasks(loadDb().offpeakListUnsettledTerminalJson(this.resolveDbPath()));
  }
}
