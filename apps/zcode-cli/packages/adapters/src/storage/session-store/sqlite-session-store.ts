import { randomUUID } from "node:crypto";
import type {
  AppUsageQueryInput,
  AppUsageQueryResult,
  ClaimLegacySessionWorkspaceInput,
  CollaborationMode,
  CreateScriptWorkflowActivityInput,
  CreateScriptWorkflowRunInput,
  CreateSessionInput,
  CreateSessionTaskLinkInput,
  FileDiff,
  ForkChildSessionMetadata,
  ForkCommitBundle,
  GoalStatus,
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  ListSessionsInput,
  LocalSettingStorePort,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  ModelUsageRecord,
  PartId,
  PermissionRuleset,
  ProjectId,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  ScriptWorkflowStorePort,
  SessionEntryInfo,
  SessionEntryType,
  SessionGoal,
  SessionId,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionInfo,
  SessionRevert,
  SessionStorePort,
  SessionTaskLinkRecord,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  TodoItem,
  ToolUsageRecord,
  TurnUsageRecord,
  UpdateScriptWorkflowActivityInput,
  UpdateScriptWorkflowRunInput,
  UpdateSessionInput,
  UpsertScriptWorkflowDefinitionInput,
  UsageStorePort,
} from "@zcode/contracts";
// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { classifyDatabaseStartupError } from "@zcode/shared";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  DEFAULT_STARTUP_MIGRATION_WAIT_MS,
  type AsyncSqliteMigrationOptions,
  type SqliteMigrationProgress,
  type SqliteSessionStoreOptions,
} from "./options.js";
import { createDwfJournalStore } from "./repositories/dwf-journal.js";
import { ensureParentDir, getDefaultSessionDbPath } from "./paths.js";
import { loadSessionAddon, type DbAddon } from "./native-addon.js";

/** 存储层锁等待到期的错误文案（`migrations.rs:acquire_exec`），用于还原 TS 的 lock_timeout 语义。 */
const LOCK_WAIT_EXPIRED = "lock wait expired";
/** addon 把「本表没有这一行」统一编码成 JSON `null`。 */
const NULL_JSON = "null";
/** `openStartup` 用的延后引导记号：未迁移的实例只能活在这条工厂路径里。 */
const deferredStartup = Symbol("deferredSqliteStartup");

/** 迁移账本事实（`SessionMigrationFacts` 的 camelCase 投影），来自 `bootstrapSessionStoreJson`。 */
interface SessionMigrationFacts {
  kind: "none" | "initialize" | "upgrade";
  executedCount: number;
  committedCount: number;
  lastAppliedMigrationId: string | null;
}

/**
 * 把 addon 抛出的错误收敛成 `SqliteSessionMigrationError`。
 *
 * 切换前 `migration-runner.ts` 自己按 sqlite errcode 分类；现在迁移整批在 Rust 里完成，
 * 只带回一条消息文本，因此这里识别锁等待到期（`lock_timeout`）并把其余交给
 * `classifyDatabaseStartupError`，保持 CLI/TUI 依赖的错误名与 kind 不变。
 */
function toStartupError(error: unknown, dbPath: string): SqliteSessionMigrationError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(LOCK_WAIT_EXPIRED)) {
    return new SqliteSessionMigrationError(
      `Timed out waiting for SQLite migration lock at ${dbPath}`,
      { cause: error, dbPath, kind: "lock_timeout" },
    );
  }
  return new SqliteSessionMigrationError(
    `SQLite migration initialization failed for ${dbPath}`,
    { cause: error, dbPath, kind: classifyDatabaseStartupError(error) },
  );
}

/** goal 行主键：与切换前 `session-target.ts:createStorageTargetId` 逐字同形（前缀 + base36 时刻 + uuid）。 */
function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

/** input_history 主键：与切换前 `repositories/input-history.ts:createStorageInputHistoryId` 同形。 */
function createInputHistoryId(): string {
  return `input_${Date.now().toString(36)}_${randomUUID()}` as InputHistoryEntry["id"];
}

export class SqliteSessionStore
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  private readonly dbPath: string;
  private readonly addon: DbAddon;
  private dwfJournalStore?: JournalStorePort;

  constructor(options: SqliteSessionStoreOptions = {}, startupToken?: symbol) {
    this.dbPath = options.dbPath ?? getDefaultSessionDbPath();
    const startupLockTimeoutMs =
      options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS;
    // 打开 + WAL + 迁移账本在一次调用里完成：多个本地/远程 Agent 共享同一个 session DB，
    // 首条 PRAGMA 之前就要带上锁预算，否则并发启动直接抛 database is locked。
    try {
      ensureParentDir(this.dbPath);
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: this.dbPath });
      this.addon = loadSessionAddon();
    } catch (error) {
      throw new SqliteSessionMigrationError(
        `Failed to open SQLite session database at ${this.dbPath}`,
        { cause: error, dbPath: this.dbPath, kind: "open_failed" },
      );
    }
    if (startupToken !== deferredStartup) this.bootstrap(startupLockTimeoutMs);
  }

  /**
   * 异步启动工厂：与切换前一样，未迁移的实例只可能活在这条工厂内部，调用方拿到的永远是
   * 迁移已 COMMIT 的 store。迁移本身是一次同步 addon 调用，进度帧因此收敛为
   * checking → ready/failed（逐条迁移的中间帧在 Rust 的单个事务里不再可观测）。
   */
  static async openStartup(
    options: SqliteSessionStoreOptions = {},
    migrationOptions: AsyncSqliteMigrationOptions = {},
  ): Promise<SqliteSessionStore> {
    const startedAt = Date.now();
    const report = async (progress: SqliteMigrationProgress): Promise<void> => {
      try {
        await migrationOptions.onProgress?.(progress);
      } catch {
        /* 通知传输失败不能覆盖原数据库异常。 */
      }
    };
    await report({ phase: "checking", elapsedMs: Date.now() - startedAt });
    const store = new SqliteSessionStore(options, deferredStartup);
    try {
      const facts = store.bootstrap(
        migrationOptions.lockWaitTimeoutMs ?? DEFAULT_STARTUP_MIGRATION_WAIT_MS,
      );
      await report({
        phase: "ready",
        elapsedMs: Date.now() - startedAt,
        migration: facts as unknown as SqliteMigrationProgress["migration"],
      });
      return store;
    } catch (error) {
      await report({
        phase: "failed",
        elapsedMs: Date.now() - startedAt,
        errorCode: error instanceof SqliteSessionMigrationError ? error.kind : "sql_failed",
      });
      throw error;
    }
  }

  /** 一次迁移引导：失败时把 addon 的错误收敛成启动错误（构造路径与工厂路径共用）。 */
  private bootstrap(deadlineMs: number): SessionMigrationFacts {
    try {
      const factsJson = this.addon.bootstrapSessionStoreJson(this.dbPath, deadlineMs, Date.now());
      return JSON.parse(factsJson) as SessionMigrationFacts;
    } catch (error) {
      throw toStartupError(error, this.dbPath);
    }
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  /** addon 无状态（逐次调用开连接），没有需要关闭的常驻句柄。 */
  close(): void {
    // 故意留空：保留 `close()` 这条调用边界（宿主在退出时统一收口），但不再有连接可关。
  }

  /** JSON 文本 → 声明返回类型；`"null"`（无行）映射为 `null`，与切换前的 repo 语义一致。 */
  private parse<T>(json: string): T {
    return JSON.parse(json) as T;
  }

  private parseOrNull<T>(json: string): T | null {
    return json === NULL_JSON ? null : (JSON.parse(json) as T);
  }

  private throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }

  // ── session 行 ──

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return this.parse(this.addon.createSessionJson(this.dbPath, JSON.stringify(input), Date.now()));
  }

  /**
   * fork child + 父侧 `v4/command_fact` 幂等事实。切换前是 JS 里的 `begin immediate` 组合；
   * 现在整条 bundle 在 Rust 的一个事务里完成（守卫、幂等短路、创建 child、写事实），
   * JS 不再重新实现任何子步骤。
   */
  async createForkedSessionWithMetadata(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return this.parse(
      this.addon.createForkedSessionWithMetadataJson(
        this.dbPath,
        JSON.stringify(input),
        JSON.stringify(metadata),
        Date.now(),
      ),
    );
  }

  async commitForkBundle(bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return this.parse(this.addon.commitForkBundleJson(this.dbPath, JSON.stringify(bundle), Date.now()));
  }

  async commitSharedContextImportBundle(
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return this.parse(
      this.addon.commitSharedContextImportBundleJson(this.dbPath, JSON.stringify(bundle), Date.now()),
    );
  }

  async transitionSharedContextImport(input: SharedContextImportTransition): Promise<boolean> {
    this.throwBeforeWrite();
    return this.parse(
      this.addon.transitionSharedContextImportJson(this.dbPath, JSON.stringify(input), Date.now()),
    );
  }

  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return this.parse(this.addon.updateSessionJson(this.dbPath, JSON.stringify(input), Date.now()));
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return this.parseOrNull(this.addon.getSessionJson(this.dbPath, sessionID));
  }

  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    return this.parse(this.addon.listSessionsJson(this.dbPath, JSON.stringify(input)));
  }

  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    return this.parse(this.addon.claimLegacySessionWorkspaceJson(this.dbPath, JSON.stringify(input)));
  }

  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return this.parse(
      this.addon.repairLegacyRemoteSessionWorkspaceJson(this.dbPath, JSON.stringify(input)),
    );
  }

  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    return this.parse(this.addon.repairRemoteSessionPathsJson(this.dbPath, JSON.stringify(input)));
  }

  // ── message / part ──

  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    this.addon.saveMessageJson(
      this.dbPath,
      JSON.stringify(input),
      copyFrom ? JSON.stringify(copyFrom) : null,
      Date.now(),
    );
  }

  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    this.addon.removeMessageJson(this.dbPath, input.sessionID, input.messageID);
  }

  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    this.addon.savePartJson(
      this.dbPath,
      JSON.stringify(input),
      copyFrom ? JSON.stringify(copyFrom) : null,
      Date.now(),
    );
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    this.addon.removePartJson(this.dbPath, input.sessionID, input.messageID, input.partID);
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    return this.parseOrNull(
      this.addon.messageWithPartsJson(this.dbPath, input.sessionID, input.messageID),
    );
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return this.parse(this.addon.messagesJson(this.dbPath, input.sessionID));
  }

  // ── session_entry ──

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    this.addon.saveSessionEntryJson(this.dbPath, JSON.stringify(input));
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]> {
    return this.parse(
      this.addon.sessionEntriesJson(this.dbPath, input.sessionID, input.type ?? null),
    );
  }

  // ── session_input 账本──

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    this.addon.saveSessionInputJson(
      this.dbPath,
      input.id,
      input.sessionID,
      input.kind,
      input.delivery,
      JSON.stringify(input.payload),
      Date.now(),
    );
  }

  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    // AbortSignal 不能跨 JSON 边界，所以取消检查留在 JS；其余（读队列项、改 intent、
    // 写 execution + receipt）在 Rust 的一个事务里完成。
    input.signal?.throwIfAborted();
    this.addon.commitPermissionFullAccessJson(
      this.dbPath,
      JSON.stringify({
        sessionID: input.sessionID,
        queueItemIds: input.queueItemIds,
        execution: input.execution,
        receipt: input.receipt,
      }),
      Date.now(),
    );
  }

  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    this.addon.updateSessionInputsJson(
      this.dbPath,
      input.sessionID,
      JSON.stringify(input.updates),
      Date.now(),
    );
  }

  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    this.addon.promoteSessionInputJson(
      this.dbPath,
      input.id,
      input.sessionID,
      JSON.stringify(input.message),
      JSON.stringify(input.parts),
      Date.now(),
    );
  }

  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    this.addon.markSessionInputPromotedJson(
      this.dbPath,
      input.id,
      input.sessionID,
      input.promotedMessageID,
      Date.now(),
    );
  }

  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    this.addon.settleSessionInputJson(
      this.dbPath,
      input.id,
      input.sessionID,
      input.status,
      input.reason ?? null,
      Date.now(),
    );
  }

  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    return this.parse(this.addon.listSessionInputsJson(this.dbPath, input.sessionID, input.status ?? null));
  }

  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    return this.parseOrNull(this.addon.getSessionInputByIdJson(this.dbPath, id));
  }

  // ── todo / goal（session_target）──

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return this.parse(this.addon.readTodosJson(this.dbPath, input.sessionID));
  }

  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.throwBeforeWrite();
    this.addon.updateTodosJson(this.dbPath, input.sessionID, JSON.stringify(input.todos), Date.now());
  }

  async readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return this.parseOrNull(this.addon.readTargetJson(this.dbPath, input.sessionID));
  }

  async setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal> {
    const now = Date.now();
    // id 由调用方注入：addon 从不读时钟、也从不生成主键，才能保持与切换前逐字相同的写入形状。
    return this.parse(
      this.addon.setSessionTargetJson(
        this.dbPath,
        input.sessionID,
        createStorageTargetId(),
        input.objective,
        input.status ?? "active",
        input.tokenBudget ?? null,
        now,
      ),
    );
  }

  async cloneTargetForFork(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal> {
    this.throwBeforeWrite();
    return this.parse(
      this.addon.cloneSessionTargetForForkJson(
        this.dbPath,
        JSON.stringify(input.source),
        input.sessionID,
        input.status ?? input.source.status,
        Date.now(),
      ),
    );
  }

  async createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null> {
    // 插入被忽略（已有别的 target 行）时 addon 回 `"null"`，与切换前的 `null` 同义。
    return this.parseOrNull(
      this.addon.createSessionTargetJson(
        this.dbPath,
        input.sessionID,
        createStorageTargetId(),
        input.objective,
        input.tokenBudget ?? null,
        Date.now(),
      ),
    );
  }

  async updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null> {
    return this.parseOrNull(
      this.addon.updateSessionTargetStatusJson(this.dbPath, input.sessionID, input.status, Date.now()),
    );
  }

  async startTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null> {
    return this.parseOrNull(
      this.addon.startSessionTargetRunJson(
        this.dbPath,
        input.sessionID,
        input.targetID,
        input.inputID,
        input.startedAtMs,
      ),
    );
  }

  async heartbeatTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null> {
    return this.parseOrNull(
      this.addon.heartbeatSessionTargetRunJson(
        this.dbPath,
        input.sessionID,
        input.targetID,
        input.inputID,
        input.seenAtMs,
      ),
    );
  }

  async finishTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null> {
    return this.parseOrNull(
      this.addon.finishSessionTargetRunJson(
        this.dbPath,
        input.sessionID,
        input.targetID,
        input.inputID,
        input.endedAtMs,
        input.status ?? null,
        input.tokensUsedDelta ?? null,
      ),
    );
  }

  async recoverInterruptedTargetRun(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return this.parseOrNull(
      this.addon.recoverInterruptedSessionTargetRunJson(this.dbPath, input.sessionID),
    );
  }

  async accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null> {
    return this.parseOrNull(
      this.addon.accountSessionTargetUsageJson(
        this.dbPath,
        input.sessionID,
        input.targetID,
        input.tokensUsedDelta ?? null,
        input.timeUsedSecondsDelta ?? null,
        Date.now(),
      ),
    );
  }

  async updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null> {
    return this.parseOrNull(
      this.addon.updateTargetSummaryTitleJson(
        this.dbPath,
        input.sessionID,
        input.targetID,
        input.summaryTitle,
        Date.now(),
      ),
    );
  }

  async clearTarget(input: { sessionID: SessionId }): Promise<boolean> {
    return this.parse(this.addon.clearSessionTargetJson(this.dbPath, input.sessionID, Date.now()));
  }

  // ── usage 账本──

  async recordModelUsage(input: ModelUsageRecord): Promise<void> {
    this.addon.recordModelUsageJson(this.dbPath, JSON.stringify(input), Date.now());
  }

  async upsertTurnUsage(input: TurnUsageRecord): Promise<void> {
    this.addon.upsertTurnUsageJson(this.dbPath, JSON.stringify(input), Date.now());
  }

  async upsertToolUsage(input: ToolUsageRecord): Promise<void> {
    this.addon.upsertToolUsageJson(this.dbPath, JSON.stringify(input), Date.now());
  }

  async pruneUsage(input?: { beforeTime?: number }): Promise<void> {
    this.addon.pruneUsageJson(this.dbPath, input?.beforeTime ?? null, Date.now());
  }

  async queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult> {
    return this.parse(
      this.addon.queryAppUsageJson(this.dbPath, input.since, input.until, input.tzOffsetMs),
    );
  }

  async queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult> {
    return this.parse(this.addon.queryTaskUsageJson(this.dbPath, input.sessionID));
  }

  // ── 输入历史──

  async recordInputHistory(input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  }): Promise<InputHistoryEntry | null> {
    // 空文本与「和上一条完全相同」由存储层判定并回 `"null"`，与切换前的提前返回一致。
    // `now` 就是切换前的 `input.time?.created ?? Date.now()`：addon 用同一条时间写 time_created。
    return this.parseOrNull(
      this.addon.recordInputHistoryJson(
        this.dbPath,
        JSON.stringify(input),
        createInputHistoryId(),
        input.time?.created ?? Date.now(),
      ),
    );
  }

  async recallPreviousInputHistory(input: {
    projectID: ProjectId;
    skip?: number;
  }): Promise<InputHistoryEntry | null> {
    return this.parseOrNull(
      this.addon.recallPreviousInputHistoryJson(this.dbPath, input.projectID, input.skip ?? 0),
    );
  }

  // ── 本地设置（权限）──

  async getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null> {
    return this.parseOrNull(this.addon.getProjectPermissionJson(this.dbPath, projectID));
  }

  async saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset> {
    return this.parse(
      this.addon.saveProjectPermissionJson(
        this.dbPath,
        input.projectID,
        JSON.stringify(input.permission),
        Date.now(),
      ),
    );
  }

  getProjectPermissionMode(projectID: ProjectId): CollaborationMode | null {
    return JSON.parse(this.addon.getProjectPermissionModeJson(this.dbPath, projectID)) as
      | CollaborationMode
      | null;
  }

  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode {
    // addon 不回读，直接回写入的 mode，与切换前 `return input.mode` 同形。
    return JSON.parse(
      this.addon.saveProjectPermissionModeJson(this.dbPath, input.projectID, input.mode, Date.now()),
    ) as CollaborationMode;
  }

  // ── revert / summary ──

  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    this.addon.setRevertJson(this.dbPath, JSON.stringify(input), Date.now());
  }

  async clearRevert(sessionID: SessionId): Promise<void> {
    this.addon.clearRevertJson(this.dbPath, sessionID, Date.now());
  }

  // ── script workflow ──

  async upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord> {
    return this.parse(
      this.addon.upsertScriptWorkflowDefinitionJson(this.dbPath, JSON.stringify(input), Date.now()),
    );
  }

  async createScriptWorkflowRun(
    input: CreateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return this.parse(
      this.addon.createScriptWorkflowRunJson(this.dbPath, JSON.stringify(input), Date.now()),
    );
  }

  async updateScriptWorkflowRun(
    input: UpdateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return this.parse(
      this.addon.updateScriptWorkflowRunJson(this.dbPath, JSON.stringify(input), Date.now()),
    );
  }

  async getScriptWorkflowRun(runId: string): Promise<ScriptWorkflowRunRecord | null> {
    return this.parseOrNull(this.addon.getScriptWorkflowRunJson(this.dbPath, runId));
  }

  async listScriptWorkflowRuns(input?: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  }): Promise<ScriptWorkflowRunRecord[]> {
    return this.parse(this.addon.listScriptWorkflowRunsJson(this.dbPath, JSON.stringify(input ?? {})));
  }

  async createScriptWorkflowActivity(
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return this.parse(
      this.addon.createScriptWorkflowActivityJson(this.dbPath, JSON.stringify(input), Date.now()),
    );
  }

  async updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return this.parse(
      this.addon.updateScriptWorkflowActivityJson(this.dbPath, JSON.stringify(input), Date.now()),
    );
  }

  async findCachedScriptWorkflowActivity(input: {
    callPath: string;
    inputHash: string;
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord | null> {
    return this.parseOrNull(
      this.addon.findCachedScriptWorkflowActivityJson(this.dbPath, JSON.stringify(input)),
    );
  }

  async listScriptWorkflowActivities(input: {
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord[]> {
    return this.parse(this.addon.listScriptWorkflowActivitiesJson(this.dbPath, input.runId));
  }

  async appendScriptWorkflowEvent(input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  }): Promise<ScriptWorkflowEventRecord> {
    return this.parse(
      this.addon.appendScriptWorkflowEventJson(this.dbPath, JSON.stringify(input), Date.now()),
    );
  }

  async listScriptWorkflowEvents(input: {
    limit?: number;
    runId: string;
  }): Promise<ScriptWorkflowEventRecord[]> {
    return this.parse(
      this.addon.listScriptWorkflowEventsJson(this.dbPath, input.runId, input.limit ?? null),
    );
  }

  async createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<SessionTaskLinkRecord> {
    return this.parse(this.addon.createSessionTaskLinkJson(this.dbPath, JSON.stringify(input), Date.now()));
  }

  /**
   * dynamic-workflow 执行引擎的 durable journal（dwf_* 表）。端口是同步的，所以这里返回
   * 端口对象本身而不是逐方法转发——引擎持有它、按自己的节奏读写。
   */
  workflowJournalStore(): JournalStorePort {
    this.dwfJournalStore ??= createDwfJournalStore(this.dbPath, this.addon);
    return this.dwfJournalStore;
  }
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export { getDefaultSessionDbPath };
