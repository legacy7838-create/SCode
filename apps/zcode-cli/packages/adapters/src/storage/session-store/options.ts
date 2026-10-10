import type { DatabaseMigrationFacts } from "@zcode/shared";

/**
 * 启动期 SQLite 迁移等待的默认预算（同步构造路径）。业务连接不能继承升级后的一小时等待，
 * 所以构造器与 `openStartup` 用的是两个不同的默认值。
 */
export const DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS = 5_000;

/** `openStartup` 未显式给 `lockWaitTimeoutMs` 时的等待预算（迁移可能排在别的窗口后面）。 */
export const DEFAULT_STARTUP_MIGRATION_WAIT_MS = 60 * 60_000;

export interface SqliteSessionStoreOptions {
  dbPath?: string;
  /** 仅供启动锁等待边界测试；生产调用使用默认值。 */
  startupLockTimeoutMs?: number;
}

/**
 * 启动进度阶段。Rust 切换后迁移整批发生在一次 addon 调用里（`BEGIN IMMEDIATE` 内），
 * 逐条迁移的中间帧不复存在：`migrating` / `committing` 只在语义仍然成立时出现，
 * `waiting_for_lock` 由存储层的锁重试反映为「一次调用直到 deadline」。
 */
export type SqliteMigrationPhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "committing"
  | "ready"
  | "failed";

export interface SqliteMigrationProgress {
  phase: SqliteMigrationPhase;
  migration?: DatabaseMigrationFacts;
  elapsedMs: number;
  migrationId?: string;
  completed?: number;
  total?: number;
  errorCode?: string;
  sqliteCode?: number;
  systemCode?: string;
}

export interface AsyncSqliteMigrationOptions {
  lockWaitTimeoutMs?: number;
  onProgress?: (progress: SqliteMigrationProgress) => Promise<void>;
}
