export {
  createSqliteSessionStore,
  getDefaultSessionDbPath,
  openStartupSqliteSessionStore,
  SqliteSessionStore,
} from "./session-store/sqlite-session-store.js";
// journal 读面类型住在 repositories/dwf-journal*.ts；运行面是 Rust addon 的 adapter，
// 因此这里只导出类型与工厂，不再导出任何 sqlite 句柄形状。
export { createDwfJournalStore } from "./session-store/repositories/dwf-journal.js";
// run 内省查询的类型住在 adapters 而不是 contracts：它们说的是 **journal 行**的词汇
// （dwf_run 的列 + 时间戳），不是跨边界的工具载荷；而 bootstrap 已经依赖 @zcode/adapters，
// 能力探测的窄接口因此可以直接复用这份签名，不必在宿主侧再抄一遍（抄一遍就会漂移）。
export type {
  DwfArtifactItem,
  DwfArtifactItemsQuery,
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./session-store/repositories/dwf-journal.js";
export type {
  DwfRunDetailRow,
  DwfRunListItem,
  DwfRunSessionListItem,
  DwfRunTimestamps,
  DwfWorldNodeRow,
} from "./session-store/repositories/dwf-journal-codecs.js";
export { SqliteSessionMigrationError } from "./session-store/errors.js";
export type {
  SqliteSessionMigrationErrorKind,
  SqliteSessionMigrationErrorOptions,
} from "./session-store/errors.js";
export type {
  AsyncSqliteMigrationOptions,
  SqliteMigrationPhase,
  SqliteMigrationProgress,
  SqliteSessionStoreOptions,
} from "./session-store/options.js";
export {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  DEFAULT_STARTUP_MIGRATION_WAIT_MS,
} from "./session-store/options.js";
// Rust addon 的加载入口（CLI 侧），宿主做能力探测/诊断时可能需要直接拿句柄。
export { loadSessionAddon, type DbAddon } from "./session-store/native-addon.js";
