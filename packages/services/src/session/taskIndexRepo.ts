/* eslint-disable max-lines -- task 索引仓库集中维护 tasks 表与分组/排序/闲时/cron 归属；存储已
   全部下沉 Rust `zcode-db` addon，本文件只做 db 路径注入 + addon JSON 编解码 + 少量类型胶水。 */
/* task index 存储仓库：tasks-index.sqlite 的 `tasks` 表（ZCodeTaskMeta 持久投影）与任务分组
   （task_groups / task_group_members / task_group_view_node_orders / task_group_workspace_bootstraps）。
   所有 SQL、状态机、原子认领、分组排序、搜索片段、grouped 视图组装与一次性启动自愈都在 Rust addon
   内实现，并逐条做过 TS-vs-Rust parity 校验；本文件不再有 JS SQLite 驱动，无 JS 回退。 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  resolveWorkspaceKey,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { loadDb } from "#src/session/zcodeDb.js";

/** updateTaskState 的状态补丁（字段语义与 addon `parse_state_patch` 一一对应）。 */
interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ZCodeTaskMeta["status"];
  lastError?: ZCodeTaskMeta["lastError"];
  target?: ZCodeTaskMeta["target"];
  updatedAt?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const meta = (json: string | null): ZCodeTaskMeta | null =>
  json ? (JSON.parse(json) as ZCodeTaskMeta) : null;
const metas = (json: string): ZCodeTaskMeta[] => JSON.parse(json) as ZCodeTaskMeta[];
const group = (json: string): ZCodeTaskGroup => JSON.parse(json) as ZCodeTaskGroup;

function wsKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

/** 同步写入的 SyncParams 投影；`incomingTargetPresent` = meta 是否自带 `target` 键（addon 侧口径）。 */
function syncParamsJson(
  params: { pinned?: boolean; archived?: boolean; deleted?: boolean; titleOverridden?: boolean },
  m: ZCodeTaskMeta,
): string {
  return JSON.stringify({
    pinned: params.pinned,
    archived: params.archived,
    deleted: params.deleted,
    titleOverridden: params.titleOverridden,
    incomingTargetPresent: Object.prototype.hasOwnProperty.call(m, "target"),
  });
}

export class TaskIndexRepo {
  private initializePromise: Promise<void> | null = null;
  private readyPath: string | null = null;
  // db 路径不能依赖进程级全局：vitest threads 并发跑测试会互相覆盖，存在写进真实库的窗口。
  // 改为构造期固定 dbPath，测试注入临时库，生产不传则回退 getTasksIndexDatabasePath。
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

  // addon 每调用自开自闭连接（busy_timeout + FK/WAL 已内建），无常驻连接可关；仅重置初始化标记。
  // 同进程写序列化不再需要：每个 addon op 是同步原子调用（含多步 op 的 BEGIN IMMEDIATE），JS 单线程
  // 下两个调用不会交错执行，旧 writeChains 的 per-key FIFO 已由 addon 内部事务取代。
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

  // ---- 读取 ----

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return meta(loadDb().getTaskMetaJson(this.path(), wsKey(params), params.taskId));
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const workspaceKey = params.workspacePath
      ? wsKey({ workspacePath: params.workspacePath, workspaceIdentity: params.workspaceIdentity })
      : null;
    return metas(
      loadDb().listTaskMetasFilteredJson(
        this.path(),
        JSON.stringify({
          workspaceKey,
          includeDeleted: params.includeDeleted ?? false,
          provider: params.provider ?? null,
          pinned: typeof params.pinned === "boolean" ? params.pinned : null,
          archived: typeof params.archived === "boolean" ? params.archived : null,
        }),
      ),
    );
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    return JSON.parse(loadDb().queryTaskListJson(this.path(), JSON.stringify(params))) as ZCodeTaskListResult;
  }

  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    return JSON.parse(
      loadDb().listDeletedTaskIdsJson(this.path(), wsKey(params), params.provider ?? null),
    ) as string[];
  }

  async listSessionsByAutomation(automationId: string): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    return metas(loadDb().listSessionsByAutomationJson(this.path(), automationId));
  }

  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    await this.ensureReady();
    return loadDb().hasGroupedWorkspaceBootstrapRunJson(this.path());
  }

  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }): Promise<ZCodeGroupedTaskViewStructure> {
    await this.ensureReady();
    return JSON.parse(
      loadDb().groupingQueryViewStructureJson(this.path(), JSON.stringify(params.workspaceScopes)),
    ) as ZCodeGroupedTaskViewStructure;
  }

  async queryGroupedTaskView(
    params: ZCodeGroupedTaskViewQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    return JSON.parse(
      loadDb().groupingQueryViewJson(
        this.path(),
        JSON.stringify(params.workspaceScopes ?? []),
        params.includeAllWorkspaces === true,
        params.provider ?? null,
        Date.now(),
      ),
    ) as ZCodeGroupedTaskView;
  }

  // ---- 写入：同步 / 状态 / 生命周期 ----

  async syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    const workspaceKey = wsKey(params.meta);
    return JSON.parse(
      loadDb().syncTaskMetaJson(
        this.path(),
        workspaceKey,
        JSON.stringify(params.meta),
        syncParamsJson(params, params.meta),
        params.searchableText ?? null,
        Date.now(),
      ),
    ) as ZCodeTaskMeta;
  }

  async syncTaskMetaAtGroupedTop(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    const workspaceKey = wsKey(params.meta);
    return JSON.parse(
      loadDb().syncTaskMetaAtGroupedTopJson(
        this.path(),
        workspaceKey,
        JSON.stringify(params.meta),
        syncParamsJson(params, params.meta),
        params.searchableText ?? null,
        Date.now(),
      ),
    ) as { meta: ZCodeTaskMeta; initializedGroupedOrder: boolean };
  }

  async seedTaskMetaIfMissing(metaArg: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return JSON.parse(
      loadDb().seedTaskMetaIfMissingJson(this.path(), wsKey(metaArg), JSON.stringify(metaArg)),
    ) as ZCodeTaskMeta;
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return JSON.parse(
      loadDb().clearTaskUnreadJson(this.path(), wsKey(params), params.taskId, params.expectedUnreadAt),
    ) as { meta: ZCodeTaskMeta; cleared: boolean };
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    const json = loadDb().updateTaskStateJson(
      this.path(),
      wsKey(params),
      params.taskId,
      JSON.stringify(params.patch),
    );
    // addon 在行缺失/已删除时返回 null；TS 在此 throw（写路径的最终边界）。
    if (!json) throw new Error(`task index 中不存在 task: ${params.taskId}`);
    return JSON.parse(json) as ZCodeTaskMeta;
  }

  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: Pick<TaskIndexStatePatch, "title" | "status" | "lastError" | "target" | "updatedAt">;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return meta(
      loadDb().applyAgentPatchJson(this.path(), wsKey(params), params.taskId, JSON.stringify(params.patch)),
    );
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return meta(loadDb().deleteArchivedTaskJson(this.path(), wsKey(params), params.taskId));
  }

  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * DAY_MS;
    return metas(loadDb().archiveStaleTasksJson(this.path(), wsKey(params), cutoff, params.provider ?? null));
  }

  // ---- 写入：任务分组 ----

  async createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    return group(
      loadDb().groupingCreateTaskGroupJson(this.path(), params?.title ?? null, params?.color ?? null, Date.now()),
    );
  }

  async renameTaskGroup(params: { groupId: string; title: string }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    return group(loadDb().groupingRenameTaskGroupJson(this.path(), params.groupId, params.title, Date.now()));
  }

  async updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    return group(
      loadDb().groupingUpdateTaskGroupColorJson(this.path(), params.groupId, params.color, Date.now()),
    );
  }

  async deleteTaskGroup(params: { groupId: string }): Promise<void> {
    await this.ensureReady();
    loadDb().groupingDeleteTaskGroupJson(this.path(), params.groupId);
  }

  async initializeGroupedTaskAtTop(params: ZCodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    return loadDb().groupingInitializeAtTopJson(this.path(), JSON.stringify(params), Date.now());
  }

  /** 落库排序后回读 grouped 视图（addon 内 apply 写 + 组装视图，与 TS 同口径）。 */
  async applyGroupedTaskViewOrder(
    params: ZCodeGroupedTaskViewOrderInput & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const db = loadDb();
    db.groupingApplyViewOrderJson(this.path(), JSON.stringify(params), Date.now());
    return JSON.parse(
      db.groupingQueryViewJson(
        this.path(),
        JSON.stringify(params.workspaceScopes ?? []),
        false,
        params.provider ?? null,
        Date.now(),
      ),
    ) as ZCodeGroupedTaskView;
  }
}
