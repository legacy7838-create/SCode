/* eslint-disable max-lines -- automation 仓库集中维护调度状态机与运行历史；存储已下沉 Rust addon，
   本文件只做 db 路径注入 + addon JSON 编解码 + 少量类型校验胶水。 */
/* automation 存储仓库：automations（定义 + 调度状态）与 automation_runs（运行历史 + runId 幂等台账）。
   与 task index 同库 tasks-index.sqlite。所有 SQL/状态机/原子认领逻辑都在 Rust `zcode-db` addon 内
   （逐条 TS-vs-Rust parity 校验过），本文件不再有 JS SQLite 驱动，无 JS 回退。cron 表达式解析 /
   next_run_at 计算由调用方（scheduler / 管理层）算好后传入，仓库不感知 cron 语义。 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  resolveWorkspaceKey,
  zcodeAutomationBotDeliveryTargetSchema,
  modelSelectionSchema,
  zcodeTaskModeSchema,
  type ZCodeAutomation,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeAutomationCreateParams,
  type ModelSelection,
  type ZCodeAutomationLifecycleStatus,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunDispatchStatus,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { loadDb } from "#src/session/zcodeDb.js";

/** 派发失败退避常量（scheduler 计算 retry 用；与 Rust `automation_write` 同值）。 */
export const DISPATCH_RETRY_BASE_MS = 30_000;
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000;
export const DISPATCH_MAX_ATTEMPTS = 5;
/** 认领超时回收：running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。 */
export const CLAIM_STALE_MS = 10 * 60_000;

/** 创建总数超过产品上限；错误码会跨 RPC 保留在 message 中供 UI 识别。 */
export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most ${AUTOMATION_CREATE_LIMIT} automations may be retained. Delete an existing automation before creating another.`,
    );
    this.name = "AutomationCreateLimitError";
  }
}

interface ClaimedManualAutomationRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

function readSerializedModelSelection(value: string | null | undefined): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function assertValidAutomationMode(mode: unknown): void {
  if (mode === undefined || mode === null) return;
  if (!zcodeTaskModeSchema.safeParse(mode).success) {
    // 读取兼容历史脏数据不代表允许继续写脏数据；Repo 是绕过 RPC 时的最终持久化边界。
    throw new Error(`Invalid automation mode: ${String(mode)}`);
  }
}

/** 退避重试时间：now + min(BASE * 2^(attempts-1), CAP)。 */
export function computeRetryAt(now: number, attempts: number): number {
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
  return now + backoff;
}

const automation = (json: string | null): ZCodeAutomation | null =>
  json ? (JSON.parse(json) as ZCodeAutomation) : null;

/**
 * automation 存储仓库。所有持久化 + 状态机 + 原子认领都在 Rust addon 内完成；本类只注入 db 路径
 * 与 `now` 时钟，并把 addon 的 JSON 投影还原成 `ZCode*` 类型。
 */
export class AutomationRepo {
  private initializePromise: Promise<void> | null = null;
  private readyPath: string | null = null;
  // db 路径不能从进程级全局解析：vitest threads 池并发跑测试文件时全局值互相覆盖，会写进真实库。
  // 构造期固定 dbPath，测试注入临时库，生产不传则回退 getTasksIndexDatabasePath。
  private readonly resolvedDbPath: string | null;

  constructor(dbPath?: string, private readonly startupBusyTimeoutMs = 5000) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private path(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.path();
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

  // addon 每调用自开自闭连接（busy_timeout + FK/WAL 已内建）；close() 仅重置本实例初始化标记。
  close(_options?: { throwOnError?: boolean }): void {
    this.initializePromise = null;
    this.readyPath = null;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const db = loadDb();
    db.bootstrapTasksIndex(path, this.startupBusyTimeoutMs);
    db.runStartupRepairsJson(path, Date.now());
    this.readyPath = path;
  }

  // ---- 管理 CRUD ----

  async create(
    params: ZCodeAutomationCreateParams,
    options: { nextRunAt: number | null; lifecycleStatus?: ZCodeAutomationLifecycleStatus },
  ): Promise<ZCodeAutomation> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const now = Date.now();
    try {
      const created = loadDb().automationCreateJson(
        this.path(),
        JSON.stringify(params),
        JSON.stringify(options),
        now,
      );
      return JSON.parse(created) as ZCodeAutomation;
    } catch (error) {
      // addon 的建上限守卫抛的是通用 Error；映射回类型化错误，保留调用方按类/catch 的契约。
      if (error instanceof Error && error.message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE)) {
        throw new AutomationCreateLimitError();
      }
      throw error;
    }
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    return JSON.parse(loadDb().listAutomationsJson(this.path(), workspaceKey)) as ZCodeAutomation[];
  }

  /** 首次派发专用读取：区分「跟随工作区（未配置）」与「损坏（必须报错）」，不能静默降级。 */
  async getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined> {
    await this.ensureReady();
    const { exists, column } = JSON.parse(
      loadDb().automationGetModelSelectionColumnJson(this.path(), automationId, workspaceKey),
    ) as { exists: boolean; column: string | null };
    if (!exists) throw new Error("Automation 不存在或不属于当前工作区");
    const selection = readSerializedModelSelection(column);
    if (selection) return selection;
    // 迁移已把旧默认写为 JSON null。SQL NULL 是缺配置，不能借旧列决定执行默认值。
    if (column === "null") return undefined;
    throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
  }

  /** 仅供后台派发读取 Bot 回推目标；该内部来源信息不进入 automation 展示模型。 */
  async getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined> {
    await this.ensureReady();
    const raw = loadDb().automationGetBotDeliveryTargetJson(this.path(), automationId, workspaceKey ?? null);
    if (!raw) return undefined;
    try {
      const parsed = zcodeAutomationBotDeliveryTargetSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // 脏 JSON 不能拖垮任务列表或 scheduler；无效来源按未配置处理。
      return undefined;
    }
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    return loadDb().automationHasTaskBindingJson(
      this.path(),
      resolveWorkspaceKey(scope),
      scope.targetTaskId,
    );
  }

  async get(automationId: string, workspaceKey?: string): Promise<ZCodeAutomation | null> {
    await this.ensureReady();
    return automation(loadDb().getAutomationJson(this.path(), automationId, workspaceKey ?? null));
  }

  /** maxRuns 的生命周期口径只统计定时派发；manual run 仅属于 Card 累计展示。 */
  async getScheduledRunCount(automationId: string, workspaceKey?: string): Promise<number | null> {
    await this.ensureReady();
    return loadDb().automationScheduledRunCountJson(this.path(), automationId, workspaceKey ?? null);
  }

  /** 编辑定义字段。调用方按需传入重算后的 nextRunAt / 新的 lifecycleStatus；addon 内做全字段合并。 */
  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    options?: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomationLifecycleStatus;
      resetRetry?: boolean;
    },
    workspaceKey?: string,
  ): Promise<ZCodeAutomation | null> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    return automation(
      loadDb().updateAutomationJson(
        this.path(),
        automationId,
        JSON.stringify(params),
        JSON.stringify(options ?? {}),
        workspaceKey ?? null,
        Date.now(),
      ),
    );
  }

  async delete(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    return loadDb().deleteAutomationJson(this.path(), automationId, workspaceKey ?? null);
  }

  /** 暂停 / 恢复。paused ↔ active，保留 next_run_at / run_count。 */
  async setEnabled(automationId: string, enabled: boolean, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    loadDb().automationSetEnabledJson(this.path(), automationId, enabled, workspaceKey ?? null, Date.now());
  }

  /** 终态任务手动重跑：回 active、清计数与重试态，nextRunAt 由调用方重算传入。 */
  async restart(
    automationId: string,
    options: { nextRunAt: number | null },
    workspaceKey?: string,
  ): Promise<void> {
    await this.ensureReady();
    loadDb().automationRestartJson(this.path(), automationId, options.nextRunAt, workspaceKey ?? null, Date.now());
  }

  /**
   * 立即运行：写入由当前 host 直接持有的 manual run，占用 automation single-flight 锁。
   * 返回 { automation(running=1), run }，已 running 的行返回 null。
   */
  async runNow(
    automationId: string,
    options: { now: number },
    workspaceKey?: string,
  ): Promise<ClaimedManualAutomationRun | null> {
    await this.ensureReady();
    const json = loadDb().automationRunNowJson(this.path(), automationId, workspaceKey ?? null, options.now);
    return json ? (JSON.parse(json) as ClaimedManualAutomationRun) : null;
  }

  // ---- 调度状态机 ----

  /** single-flight 认领到期项（含僵尸回收 + 过期终态化）。 */
  async claimDue(now: number): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    return JSON.parse(loadDb().automationClaimDueJson(this.path(), now)) as ZCodeAutomation[];
  }

  /** 认领 UI「立即运行」产生的 manual run。 */
  async claimManualRuns(now: number): Promise<ClaimedManualAutomationRun[]> {
    await this.ensureReady();
    return JSON.parse(loadDb().automationClaimManualRunsJson(this.path(), now)) as ClaimedManualAutomationRun[];
  }

  /** 派发成功结算：计数 +1、清重试、复位 running；循环回 active，有限次达 max 转 completed。 */
  async markDispatched(
    automationId: string,
    options: { dispatchedAt: number; nextRunAt: number | null },
  ): Promise<void> {
    await this.ensureReady();
    loadDb().automationMarkDispatchedJson(this.path(), automationId, options.dispatchedAt, options.nextRunAt);
  }

  /** 派发失败：transient 累加 attempts + 退避 retry_at；permanent 直接 failed 终态。 */
  async markDispatchFailed(
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    await this.ensureReady();
    loadDb().automationMarkDispatchFailedJson(
      this.path(),
      automationId,
      options.failedAt,
      options.error,
      options.kind,
      options.nextRunAt ?? null,
    );
  }

  /** 关机/退出时释放认领：清 running、保留 next_run_at，不记失败不推进。 */
  async releaseClaim(automationId: string): Promise<void> {
    await this.ensureReady();
    loadDb().automationReleaseClaimJson(this.path(), automationId, Date.now());
  }

  /** manual run 结束后只释放 single-flight 锁，不改 automation 调度状态。 */
  async releaseManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    loadDb().automationReleaseManualClaimJson(this.path(), automationId, workspaceKey, Date.now());
  }

  /** host 仍持有在途 manual run 时续租，避免被 scheduler 当僵尸回收。 */
  async touchManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    loadDb().automationTouchManualClaimJson(this.path(), automationId, workspaceKey, Date.now());
  }

  /** 错过触发窗口：记 skipped run + 前推 next_run_at（finalize=纯一次性终态收口）。 */
  async skipAndReschedule(params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }): Promise<void> {
    await this.ensureReady();
    loadDb().automationSkipAndRescheduleJson(this.path(), JSON.stringify(params), Date.now());
  }

  // ---- 运行历史 automation_runs ----

  /** 确保 run 历史存在（host outcome 回写兜底），不增加 attempts。 */
  async ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void> {
    await this.ensureReady();
    loadDb().automationEnsureRunClaimedJson(this.path(), JSON.stringify(params), Date.now());
  }

  /** 认领时 upsert 一行 run（run_id 冲突即命中本轮 retry，attempts+1）。 */
  async upsertRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    modelSelection?: ModelSelection;
  }): Promise<void> {
    await this.ensureReady();
    loadDb().automationUpsertRunClaimedJson(
      this.path(),
      JSON.stringify(params),
      params.modelSelection ? JSON.stringify(params.modelSelection) : null,
      Date.now(),
    );
  }

  /** Select 首次形成 Submission 时原子固定 run Selection；之后只读回原值。 */
  async fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.ensureReady();
    const json = loadDb().automationFixRunModelSelectionJson(this.path(), runId, JSON.stringify(selection), Date.now());
    return JSON.parse(json) as ModelSelection;
  }

  /** 派发结果回写 run（dispatched 回填 session_id / failed_to_dispatch 记 error）。 */
  async markRunDispatch(params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.ensureReady();
    loadDb().automationMarkRunDispatchJson(
      this.path(),
      params.runId,
      params.dispatchStatus,
      params.sessionId ?? null,
      params.error ?? null,
      Date.now(),
    );
  }

  /** manual run 首次派发成功结算：原子更新 run 台账 + 累计 run_count（dispatch_status 幂等边界）。 */
  async markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean> {
    await this.ensureReady();
    return loadDb().automationMarkManualRunDispatchedJson(
      this.path(),
      params.runId,
      params.sessionId ?? null,
      params.dispatchedAt,
    );
  }

  /** session runtime 回写运行结果（running / succeeded / failed / stopped）。 */
  async markRunOutcome(runId: string, outcome: ZCodeAutomationRunOutcome, error?: string): Promise<void> {
    await this.ensureReady();
    loadDb().automationMarkRunOutcomeJson(this.path(), runId, outcome, error ?? null, Date.now());
  }

  /** 错过触发窗口：落一条 skipped run，不计 run_count。 */
  async recordSkippedRun(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    reason: string;
  }): Promise<void> {
    await this.ensureReady();
    loadDb().automationRecordSkippedRunJson(this.path(), JSON.stringify(params), params.reason, Date.now());
  }

  async listRuns(automationId: string, workspaceKey?: string): Promise<ZCodeAutomationRun[]> {
    await this.ensureReady();
    return JSON.parse(
      loadDb().automationListRunsJson(this.path(), automationId, workspaceKey ?? null),
    ) as ZCodeAutomationRun[];
  }

  async getRun(runId: string): Promise<ZCodeAutomationRun | null> {
    await this.ensureReady();
    const json = loadDb().automationGetRunJson(this.path(), runId);
    return json ? (JSON.parse(json) as ZCodeAutomationRun) : null;
  }

  async deleteRun(runId: string, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    loadDb().automationDeleteRunJson(this.path(), runId, workspaceKey ?? null);
  }

  /** 保留策略：删除超过 maxAgeMs 的历史 run（防无限增长）。 */
  async pruneRuns(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    return loadDb().automationPruneRunsJson(this.path(), maxAgeMs, Date.now());
  }
}
