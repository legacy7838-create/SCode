import { z } from "zod";

export const databaseStartupErrorCodeSchema = z.enum([
  "storage_full",
  "permission_denied",
  "io_error",
  "out_of_memory",
  "corrupt",
  "open_failed",
  "lock_timeout",
  "checksum_mismatch",
  "sql_failed",
  "startup_status_timeout",
  "transport_closed",
  "unsupported_runtime",
]);
export type DatabaseStartupErrorCode = z.infer<typeof databaseStartupErrorCodeSchema>;

/** The original structured cause is more accurate than the outer generic wrapper; inferring a full disk or an OOM from the error message is forbidden. */
export function classifyDatabaseStartupError(error: unknown): DatabaseStartupErrorCode {
  const seen = new Set<unknown>();
  let fallback: DatabaseStartupErrorCode = "sql_failed";
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 12) {
    seen.add(error);
    const value = error as { code?: unknown; errcode?: unknown; kind?: unknown; cause?: unknown };
    const primary = typeof value.errcode === "number" ? value.errcode & 0xff : undefined;
    if (primary === 13 || value.code === "ENOSPC" || value.code === "EDQUOT") return "storage_full";
    if (primary === 3 || primary === 8 || value.code === "EACCES" || value.code === "EPERM")
      return "permission_denied";
    if (primary === 10 || value.code === "EIO") return "io_error";
    if (primary === 7 || value.code === "ENOMEM" || value.code === "ERR_WORKER_OUT_OF_MEMORY")
      return "out_of_memory";
    if (primary === 11 || primary === 26) return "corrupt";
    if (primary === 14) fallback = "open_failed";
    if (primary === 5) fallback = "lock_timeout";
    const kind = databaseStartupErrorCodeSchema.safeParse(value.kind);
    if (kind.success && kind.data !== "sql_failed") fallback = kind.data;
    error = value.cause;
  }
  return fallback;
}

/** Only the error code and the frozen migration id cross the process boundary; no SQL, file contents or credentials are carried. */
export function databaseStartupErrorDetails(error: unknown): {
  sqliteCode?: number;
  systemCode?: string;
  migrationId?: string;
} {
  const result: { sqliteCode?: number; systemCode?: string; migrationId?: string } = {};
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 12) {
    seen.add(error);
    const current = error as {
      errcode?: unknown;
      code?: unknown;
      migrationId?: unknown;
      cause?: unknown;
    };
    if (typeof current.errcode === "number" && Number.isSafeInteger(current.errcode))
      result.sqliteCode = current.errcode;
    if (typeof current.code === "string" && /^[A-Z_0-9]{1,64}$/.test(current.code))
      result.systemCode = current.code;
    if (
      typeof current.migrationId === "string" &&
      /^[a-zA-Z_0-9-]{1,128}$/.test(current.migrationId)
    )
      result.migrationId = current.migrationId;
    error = current.cause;
  }
  return result;
}
export const databaseStartupErrorDetailsSchema = z.object({
  sqliteCode: z.number().int().optional(),
  systemCode: z.string().max(64).optional(),
  migrationId: z.string().max(128).optional(),
});

export const startupDiskSummarySchema = z
  .object({
    scopeId: z.string().max(128),
    observedAvailableDropPeakBytes: z.number().finite().nonnegative().nullable(),
    minAvailableBytes: z.number().finite().nonnegative().nullable(),
    quality: z.enum(["complete", "partial", "unknown"]),
    sampledAt: z.number().finite().nonnegative().nullable(),
  })
  .strict();
export type StartupDiskSummary = z.infer<typeof startupDiskSummarySchema>;
export const databaseStartupPhaseSchema = z.enum([
  "starting",
  "preparing_host_storage",
  "preparing_session_storage",
  "starting_services",
  "ready",
  "failed",
]);
export const databaseMigrationIdSchema = z.string().regex(/^[a-zA-Z_0-9-]{1,128}$/);

/** The kind of need is kept separate from what actually executed/committed; a precheck finding a need does not mean the current executor ran SQL. */
export const databaseMigrationFactsSchema = z
  .object({
    kind: z.enum(["none", "initialize", "upgrade"]),
    executedCount: z.number().int().nonnegative(),
    committedCount: z.number().int().nonnegative(),
    // Null means that the ledger in the lock is empty; missing means that the trusted starting point has not yet been obtained.
    lastAppliedMigrationId: databaseMigrationIdSchema.nullable().optional(),
  })
  .strict()
  .superRefine((facts, context) => {
    if (
      facts.committedCount > facts.executedCount ||
      (facts.kind === "none" && facts.executedCount !== 0)
    )
      context.addIssue({ code: "custom", message: "Invalid migration execution facts" });
  });
export type DatabaseMigrationFacts = z.infer<typeof databaseMigrationFactsSchema>;

export const databaseStartupStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    startupId: z.string().min(1).max(128),
    attemptId: z.string().min(1).max(128),
    sequence: z.number().int().nonnegative(),
    startedAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    phase: databaseStartupPhaseSchema,
    databasePhase: z
      .enum(["checking", "waiting_for_lock", "migrating", "committing", "maintaining", "ready"])
      .optional(),
    migration: databaseMigrationFactsSchema.optional(),
    currentMigration: databaseMigrationFactsSchema.optional(),
    migrationBaselines: z
      .array(
        z
          .object({
            databaseId: z.string().min(1).max(128),
            databaseKind: z.enum(["tasks-index", "session"]),
            lastAppliedMigrationId: databaseMigrationIdSchema.nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    finalDatabase: z.boolean().optional(),
    failedPhase: databaseStartupPhaseSchema.optional(),
    errorCode: databaseStartupErrorCodeSchema.optional(),
    ...databaseStartupErrorDetailsSchema.shape,
    disk: z.array(startupDiskSummarySchema).max(8),
  })
  .strict();
export type DatabaseStartupState = z.infer<typeof databaseStartupStateSchema>;
/** The local port and the startup snapshot must come from the same Host; this id does not carry workspace or task identity. */
export const databaseStartupPortPayloadSchema = z
  .object({
    databaseStartupId: z.string().min(1).max(128),
  })
  .strict();
export const databaseStartupControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("exit") }).strict(),
  z.object({ action: z.literal("retry"), attemptId: z.string().min(1).max(128) }).strict(),
]);
export type DatabaseStartupControl = z.infer<typeof databaseStartupControlSchema>;

/** Migration can be retried manually; when services are already partly assembled or the database is corrupt/unreachable, recover by exiting and reopening, to avoid repeated startup side effects. */
export function canRetryDatabaseStartup(
  state: Pick<DatabaseStartupState, "phase" | "failedPhase" | "errorCode">,
): boolean {
  return (
    state.phase === "failed" &&
    state.failedPhase !== "starting_services" &&
    ![
      "corrupt",
      "checksum_mismatch",
      "transport_closed",
      "startup_status_timeout",
      "unsupported_runtime",
    ].includes(state.errorCode ?? "sql_failed")
  );
}
