export type ForkCommitFaultStage =
  | "afterChild"
  | "afterMessages"
  | "afterGoal"
  | "afterEntries"
  | "afterInput"
  | "afterCommandFact"
  | "beforeCommit";

export interface SqliteSessionStoreOptions {
  dbPath?: string;
  /** For transaction atomicity testing only; must not be set for production calls. */
  forkCommitFaultAt?: ForkCommitFaultStage;
  /** For startup lock wait boundary testing only; production calls use the default. */
  startupLockTimeoutMs?: number;
}

