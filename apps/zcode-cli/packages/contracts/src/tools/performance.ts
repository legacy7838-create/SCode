import { z } from "zod";

export const ToolCommandStatusSchema = z.enum([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "backgrounded",
]);

export type ToolCommandStatus = z.infer<typeof ToolCommandStatusSchema>;

export const CommandExecutionTelemetrySchema = z
  .object({
    runMs: z.number().int().nonnegative().optional(),
    firstOutputMs: z.number().int().nonnegative().optional(),
    noOutputMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    category: z.string().max(64).optional(),
    /**
     * Only executable file names from the public Registry, or fixed low-cardinality buckets, are allowed; putting the raw command or arguments in is forbidden.
     */
    name: z.string().max(128).optional(),
    count: z.number().int().nonnegative().optional(),
    status: ToolCommandStatusSchema,
    /**
     * A local diagnostic field; the remote Trace Exporter must ignore it explicitly, so that it does not become a high-cardinality remote dimension.
     */
    hash: z
      .string()
      .regex(/^[a-f0-9]{16}$/u)
      .optional(),
  })
  .strict();

export type CommandExecutionTelemetry = z.infer<typeof CommandExecutionTelemetrySchema>;

export const FileSystemExecutionTelemetrySchema = z
  .object({
    readMs: z.number().int().nonnegative().optional(),
    writeMs: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    maxFileBytes: z.number().int().nonnegative().optional(),
    workspaceKind: z.enum(["local", "remote", "unknown"]).optional(),
  })
  .strict();

export type FileSystemExecutionTelemetry = z.infer<
  typeof FileSystemExecutionTelemetrySchema
>;

export const PatchExecutionTelemetrySchema = z
  .object({
    matchMs: z.number().int().nonnegative().optional(),
    hunkCount: z.number().int().nonnegative().optional(),
    matchAttempts: z.number().int().nonnegative().optional(),
  })
  .strict();

export type PatchExecutionTelemetry = z.infer<typeof PatchExecutionTelemetrySchema>;

export const ToolExecutionTelemetryDetailSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: CommandExecutionTelemetrySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("filesystem"),
      filesystem: FileSystemExecutionTelemetrySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("patch"),
      filesystem: FileSystemExecutionTelemetrySchema,
      patch: PatchExecutionTelemetrySchema,
    })
    .strict(),
]);

export type ToolExecutionTelemetryDetail = z.infer<
  typeof ToolExecutionTelemetryDetailSchema
>;

/**
 * A summary of the tool execution result, persisted to local storage together with the ToolCallResult event; command-specific fields may only
 * enter the discriminated detail, so that non-command tools do not fabricate inapplicable facts such as exitCode.
 */
export const ToolExecutionTelemetrySchema = z
  .object({
    totalMs: z.number().int().nonnegative().optional(),
    permissionWaitMs: z.number().int().nonnegative().optional(),
    detail: ToolExecutionTelemetryDetailSchema.optional(),
  })
  .strict();

export type ToolExecutionTelemetry = z.infer<typeof ToolExecutionTelemetrySchema>;
