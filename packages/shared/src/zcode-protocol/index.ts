import {
  databaseStartupErrorCodeSchema,
  databaseStartupErrorDetailsSchema,
  databaseMigrationFactsSchema,
} from "../database-startup.js";
/* oxlint-disable eslint(max-lines) -- The ZCode Protocol schemas need a single-file export, so that app and agent share one protocol contract. */
// ──Old protocol deletes boundaries──────────────────────
// ~257 exports remaining: old ZCode Protocol method contract, request/response/event schema,
// session/workspace state snapshot projection, etc. (the load-bearing type has been moved to zcode-protocol-legacy-types.ts).
// Dead words that have been deleted (vocabulary + schema + implementation on both sides): session/steer, session/rewind,
// session/rewindCascade,session/previewFileRewind,session/applyFileRewind,
// prompt/enhance full cluster (including promptEnhanceResult notification), plugins/marketplace/list;
// The session/fork client chain has been deleted (op+schema retention = v4 forkSessionAtMessage hook consumption).
// Consumer: services old stack (zcodeProtocolClient/zcodeAgent/zcodeAgentService/zcodeSession*),
// CLI bootstrap old protocol server (zcode-protocol/server-operations, plugins, session-mapper, etc.),
// UI old projection (read paths such as zcodeSessionProjection).
// When the above old protocol client/server group is deleted, this file will be deleted as a whole.
// Note: External zero-consumption schemas are mostly internal dependencies of surviving schema unions. They are processed together with the host file and should not be deleted separately.
import { bashOutputDisplaySchema } from "../bash-output-display.js";
// Backend details share a compact, read-only response schema that carries no command or timing metadata.
export * from "../background-bash-output.js";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { z } from "zod";
export * from "../process-diagnostic.js";
import { errorAttributionSchema } from "../zcode-protocol-v4/snapshot.js";
import { modelSelectionSchema } from "../model-selection.js";
import { completeModelPropertiesDataSchema } from "../model-config.js";
import { accountProviderUnavailableReasonSchema } from "../account-provider-state.js";
import { modelExecutionSchema } from "../model-execution.js";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
// browser-use single source of command/result contract: agent constructor, protocol check, and main executor share the same schema.
import { browserClientModeSchema, browserCommandSchema } from "../browser-use/commands.js";
import {
  browserBackendListResultSchema,
  browserSessionContextKindSchema,
} from "../browser-use/backend.js";
import { browserCommandResultSchema } from "../browser-use/result.js";
import { integratedTerminalShellSelectionSchema } from "../validationAppSettings.js";
import { zcodeTaskModeSchema } from "../zcode-task-mode-schema.js";
import { OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS } from "../official-mcp-auth.js";
import {
  zcodeDeliveryKindSchema,
  zcodeMessageVisibilitySchema,
  zcodeSyntheticUserMessageSourceSchema as legacyZcodeSyntheticUserMessageSourceSchema,
  zcodeWorkspaceRefSchema,
  zcodePermissionDecisionSchema,
  zcodePermissionResponseSchema,
  zcodePermissionUpdateSchema,
  zcodeSessionModeSchema,
  zcodeSessionStatusSchema,
  zcodeSessionKindSchema,
  zcodeSessionGoalSchema,
  zcodeSessionGoalVerificationSchema,
  zcodeSessionGoalVerificationTimelineSchema,
  zcodeInteractionRequestOriginSchema,
  zcodeToolStateSchema,
  zcodeSessionApiRetryStatusSchema,
  zcodeSessionContextUsageSchema,
  zcodeSessionInfoSchema,
  zcodeSessionRuntimeStateSchema,
  zcodeMessageWithPartsSchema,
  zcodeMessagePartSchema,
} from "../zcode-protocol-legacy-types.js";

export {
  hookExecutionProjectionSchema,
  hookInvocationRowSchema,
  type HookExecutionProjection,
  type HookInvocationRow,
} from "../zcode-protocol-v4/rows.js";

export const ZCODE_PROTOCOL_NAME = "ZCode Protocol" as const;
export const ZCODE_PROTOCOL_VERSION = 1 as const;
// V4 wire coexists with the legacy main protocol; rewriting the legacy version for V4 physical framing is prohibited.
export const ZCODE_PROTOCOL_V4_WIRE_VERSION = 3 as const;
export const zcodeRuntimeCapabilitiesSchema = z.object({
  independentPlanState: z.boolean().optional(),
});
export const zcodeProtocolErrorCodes = {
  sessionUnavailable: -32004,
} as const;

const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();
const protocolInstantSchema = z.union([timestampMsSchema, nonEmptyString, z.date()]);

// Tool result display is not constrained by the model text budget; Node REPL images must be at the Agent/App protocol boundary
// Strictly limit the length to prevent screenshots from expanding continuous or replayable messages into unbounded payloads.
export const zcodeNodeReplImageToolResultDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

// Similarly: CreateWorkflow's type check diagnosis is also a display channel, which must be bounded at the protocol boundary.
// Avoid extensive diagnostics that expand continuous/replayable messages into unbounded payloads.
// The causalityGraph is length-limited at the tool output bounds, mirroring the same set of upper bounds here (consistent with v4 rows).
// The vocabulary of graphs is intentionally small: step card + actor lane + a type of arrow (runs after, `back` only marks back edges) +
// Return object tag. The analyzer's kind / certainty / exact / region are not included in the payload.
// The name is only shaped at runtime (`` agent(`researcher${i + 1}`) ``). The shape is statically available: before the first hole.
// The literal (head) and the literal after the last hole (tail). At least one is present, both are trimmed and contain meaningful characters.
// Bug fix: These two fields fell into contracts and v4 images with 0a8b059f40, and v3 missed the change——.strict()
// The following workflow with interpolated names will cause the entire display verification to fail and the entire image to disappear, so it must be aligned with v4 field by field.
const zcodeWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// An edge = runs after; the step edge is the same shape as the stage edge, `back` only marks the loop back edge.
const zcodeWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const zcodeCreateWorkflowCausalityGraphDisplaySchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            kind: z.enum(["ask", "world-read"]),
            label: z.string().min(1).max(128),
            // Inline `agent()` receiver gives the static shape of the name when label falls into the string.
            labelPattern: zcodeWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // The site id expanded from, only appears on the copy of the may-set lane expansion (the associated key of the real-time overlay);
            // The added field is additive, and old payloads without it pass .strict() as usual.
            source: z.string().min(1).max(64).optional(),
            // The author uses `phase("…")` to mark the divided phases.
            // Advance and exit simultaneously with the phases / phaseEdges / exits of the diagram: all present or all absent.
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // Static shape when `name` is absent and the first parameter of agent() is a template string with holes; mutually exclusive with name.
            namePattern: zcodeWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // Participants and handoffs; Mirror v4.
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    handoffs: z
      .array(
        zcodeWorkflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // Stage vocabulary: The grouping structure imposed by the author, with the main screen as a node. with phaseEdges/exits/Step.phase
    // All or Nothing - The zero flag script is completely absent and the UI falls back to the step/lane view. The zero-member stage is also inside and outside.
    // `unphased` No name, the display name is localized by the UI.
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // Other stages that are still running when entering this stage (their strands have not yet been joined), stage table order, excluding itself,
            // Absent when empty. It's the node fact rather than the edge - control is not transferred from there, so phaseEdges are not entered.
            // The timeline folds adjacent stages into a bifurcated "belt" and the sidebar mini-track is drawn as a double line segment.
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(zcodeWorkflowEdgeSchema).max(128).optional(),
    // The stage in which the control flow can be completed normally (the "stage → return object" arrow in the stage view); the group can be an empty array.
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export const zcodeCreateWorkflowToolResultDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: zcodeCreateWorkflowCausalityGraphDisplaySchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

const zcodeToolResultObjectSchema = jsonObjectSchema.superRefine((result, context) => {
  const display = result.display;
  if (typeof display !== "object" || display === null || Array.isArray(display)) {
    return;
  }
  const kind = (display as Record<string, unknown>).kind;
  const schemaByKind: Record<string, z.ZodTypeAny> = {
    node_repl_images: zcodeNodeReplImageToolResultDisplaySchema,
    create_workflow: zcodeCreateWorkflowToolResultDisplaySchema,
    bash_output: bashOutputDisplaySchema,
  };
  const schema = typeof kind === "string" ? schemaByKind[kind] : undefined;
  if (!schema) return;
  const parsed = schema.safeParse(display);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ["display", ...issue.path] });
  }
});

export const zcodeProtocolRequestIdSchema = z.union([z.string(), z.number().int()]);
export type ZCodeProtocolRequestId = z.infer<typeof zcodeProtocolRequestIdSchema>;

export const zcodeProtocolTraceSchema = z
  .object({
    traceparent: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    parentId: nonEmptyString.optional(),
    spanId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeProtocolTrace = z.infer<typeof zcodeProtocolTraceSchema>;

export const zcodeProtocolRequestSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeProtocolRequest = z.infer<typeof zcodeProtocolRequestSchema>;

export const zcodeProtocolNotificationSchema = z
  .object({
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeProtocolNotification = z.infer<typeof zcodeProtocolNotificationSchema>;

export const zcodeProtocolResponseSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    result: z.unknown(),
  })
  .strict();
export type ZCodeProtocolResponse = z.infer<typeof zcodeProtocolResponseSchema>;

export const zcodeProtocolErrorSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    error: z
      .object({
        code: z.number().int(),
        message: nonEmptyString,
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodeProtocolError = z.infer<typeof zcodeProtocolErrorSchema>;

export const zcodeProtocolMessageSchema = z.union([
  zcodeProtocolRequestSchema,
  zcodeProtocolNotificationSchema,
  zcodeProtocolResponseSchema,
  zcodeProtocolErrorSchema,
]);
export type ZCodeProtocolMessage = z.infer<typeof zcodeProtocolMessageSchema>;

export const zcodeProtocolNotifications = {
  storageStartup: "startup/storageState",
  providerRuntimeHeadersCancelled: "interaction/providerRuntimeHeadersCancelled",
  mcpTelemetry: "process/mcpTelemetry",
  mcpResourceSamples: "process/mcpResourceSamples",
  toolExecResource: "process/toolExecResource",
  pluginOperationProgress: "plugins/operationProgress",
  processResourceSample: "process/resourceSample",
} as const;

/** The startup control plane is independent of the task stream; a database identity must never carry a path or credentials. */
export const zcodeStorageStartupStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    databaseId: z.string().min(1).max(128),
    databaseKind: z.enum(["session", "tasks-index"]),
    phase: z.enum(["checking", "waiting_for_lock", "migrating", "committing", "ready", "failed"]),
    // Contains the optional lastAppliedMigrationId within the lock, before version SQL; old notifications can still be parsed.
    migration: databaseMigrationFactsSchema.optional(),
    elapsedMs: z.number().nonnegative().finite(),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    errorCode: databaseStartupErrorCodeSchema.optional(),
    ...databaseStartupErrorDetailsSchema.shape,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.phase === "failed" && !state.errorCode)
      context.addIssue({ code: "custom", message: "failed requires errorCode" });
  });
export type ZCodeStorageStartupState = z.infer<typeof zcodeStorageStartupStateSchema>;

const zcodeMcpTelemetryPlatformSchema = z.enum([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
]);
const zcodeMcpTelemetryArchSchema = z.enum([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);
const zcodeMcpTelemetryBaseSchema = z
  .object({
    arch: zcodeMcpTelemetryArchSchema,
    occurredAt: z.number().int().nonnegative(),
    platform: zcodeMcpTelemetryPlatformSchema,
  })
  .strict();
const zcodeMcpProcessTelemetryBaseShape = {
  mcpId: z
    .string()
    .regex(
      /^(?:builtin:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+(?::(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+)*|(?:plugin|custom):[a-f0-9]{12})$/,
    ),
  mcpInstanceId: nonEmptyString,
  mcpIsolation: z.enum(["session", "workspace"]),
  mcpSource: z.enum(["builtin", "plugin", "custom"]),
} as const;

export const zcodeMcpTelemetryEventSchema = z.discriminatedUnion("kind", [
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_start"),
      ...zcodeMcpProcessTelemetryBaseShape,
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_crash"),
      ...zcodeMcpProcessTelemetryBaseShape,
      affectedSessionCount: z.number().int().nonnegative().max(10_000),
      exitCode: z.number().int().nullable(),
      signal: nonEmptyString.nullable(),
      uptimeMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("session_startup"),
      configuredCount: z.number().int().nonnegative().max(10_000),
      connectedCount: z.number().int().nonnegative().max(10_000),
      failedCount: z.number().int().nonnegative().max(10_000),
      processCount: z.number().int().nonnegative().max(10_000),
      sessionId: nonEmptyString,
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("memory"),
      ...zcodeMcpProcessTelemetryBaseShape,
      memoryKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
      memoryScope: z.enum(["process_tree", "direct_process"]),
      orphanSuspected: z.boolean(),
      ownerSessionCount: z.number().int().nonnegative().max(10_000),
      unownedSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
export type ZCodeMcpTelemetryEvent = z.infer<typeof zcodeMcpTelemetryEventSchema>;

/** MCP only probes once every five minutes; the interval is shared by the producer and the device-count expiry criterion. */
export const ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60_000;

export const zcodeMcpResourceSampleSchema = z
  .object({
    mcpId: zcodeMcpProcessTelemetryBaseShape.mcpId,
    instanceToken: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    sampledAt: z.number().int().nonnegative(),
    intervalMs: z.number().finite().positive(),
    processCount: z.number().int().positive().max(100_000),
    rssKbTotal: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rssKbMaxProcess: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cpuTimeMsDelta: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    uptimeMinutes: z.number().int().nonnegative(),
    platform: zcodeMcpTelemetryPlatformSchema,
    arch: zcodeMcpTelemetryArchSchema,
    logicalCpuCount: z.number().int().positive().max(4_096),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576),
  })
  .strict();
export type ZCodeMcpResourceSample = z.infer<typeof zcodeMcpResourceSampleSchema>;
// The notification input is bounded; main also executes the event quota according to the 32 MCP groups of each reporting window.
export const zcodeMcpResourceSamplesSchema = z.array(zcodeMcpResourceSampleSchema).max(1_024);

export const BASH_RESOURCE_SAMPLE_INTERVAL_MS = 15_000;
export const BASH_RESOURCE_MAX_SAMPLES = 20;

/** Bounded completion facts of a Bash subprocess; commands, paths and session identifiers are forbidden from the telemetry side channel. */
export const zcodeToolExecResourceSchema = z
  .object({
    // The same completion fact may be forwarded by multiple hosts; the random identifier is only used for main deduplication, and the missing fields of the old CLI are still compatible.
    completionToken: z.string().uuid().optional(),
    platform: zcodeMcpTelemetryPlatformSchema,
    toolName: z.literal("bash"),
    durationMs: z.number().finite().min(BASH_RESOURCE_SAMPLE_INTERVAL_MS),
    exitKind: z.enum(["completed", "timeout", "killed", "error"]),
    treeRssKbPeak: z.number().finite().nonnegative().optional(),
    treeCpuTimeMs: z.number().finite().nonnegative().optional(),
    sampleCount: z.number().int().nonnegative().max(BASH_RESOURCE_MAX_SAMPLES),
    cliRssKb: z.number().finite().nonnegative(),
    systemFreeMemoryKb: z.number().finite().nonnegative(),
  })
  .strict();
export type ZCodeToolExecResource = z.infer<typeof zcodeToolExecResourceSchema>;

export const zcodeProcessResourceSampleSchema = z
  .object({
    platform: z.enum([
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "netbsd",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
    ]),
    arch: z.enum([
      "arm",
      "arm64",
      "ia32",
      "loong64",
      "mips",
      "mipsel",
      "ppc",
      "ppc64",
      "riscv64",
      "s390",
      "s390x",
      "x64",
    ]),
    logicalCpuCount: z.number().int().positive().max(4_096),
    intervalMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1_000),
    cpuCores: z.number().finite().nonnegative().max(4_096),
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /**
     * The following four are newly added telemetry fields, all optional: samples from an old
     * CLI still validate, so the **protocol handshake version is deliberately not bumped**
     * (the handshake version is a compatibility switch, not a field version).
     */
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    uptimeMinutes: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 365 * 24 * 60)
      .optional(),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576).optional(),
    /**
     * An instance identifier randomly generated at CLI process startup, used only by the
     * app-side main to count "how many CLI processes are alive at the same time" and the
     * "largest single-process RSS". It never enters ARMS attributes and carries no pid.
     * The narrow character set is a mechanical guarantee of the privacy red line: content
     * such as paths or workspace identifiers can never pass validation.
     */
    instanceToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
  })
  .strict();
export type ZCodeProcessResourceSample = z.infer<typeof zcodeProcessResourceSampleSchema>;

export const zcodeProcessChildProcessesParamsSchema = z.object({}).strict();
export const zcodeProcessChildProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    serverName: nonEmptyString,
    mcpSource: z.enum(["builtin", "plugin", "custom"]),
    /** The plugin name of an official/third-party plugin (the `name` of `plugin:<name>:<key>`, or the plugin corresponding to an official host MCP); absent for custom */
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export const zcodeProcessChildProcessesResultSchema = z
  .object({
    processes: z.array(zcodeProcessChildProcessSchema).max(10_000),
  })
  .strict();
export type ZCodeProcessChildProcess = z.infer<typeof zcodeProcessChildProcessSchema>;
export type ZCodeProcessChildProcessesResult = z.infer<
  typeof zcodeProcessChildProcessesResultSchema
>;

export type ZCodeDeliveryKind = z.infer<typeof zcodeDeliveryKindSchema>;
// TurnStarted and persistent message must share the same source vocabulary; otherwise live event can pass and cold
// The message is rejected at the app/agent boundary, causing a bifurcation of continuous/replayable semantics.
const zcodeTurnInputSourceSchema = legacyZcodeSyntheticUserMessageSourceSchema;
export const zcodeSessionPersistenceSchema = z.enum(["immediate", "deferred"]);
export type ZCodeSessionPersistence = z.infer<typeof zcodeSessionPersistenceSchema>;
export type ZCodeWorkspaceRef = z.infer<typeof zcodeWorkspaceRefSchema>;
export const zcodePermissionOptionSchema = z
  .object({
    optionId: nonEmptyString,
    kind: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    response: zcodePermissionResponseSchema,
  })
  .strict();

const zcodeProtocolMcpEntrySchema = z
  .object({
    name: nonEmptyString,
    value: z.string(),
  })
  .strict();

const zcodeProtocolMcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: nonEmptyString,
      clientSecret: nonEmptyString,
      clientName: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: nonEmptyString.optional(),
      clientSecret: nonEmptyString.optional(),
      clientName: nonEmptyString.optional(),
      redirectPath: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

export const zcodeProtocolMcpServerSchema = z.union([
  z
    .object({
      name: nonEmptyString,
      command: nonEmptyString,
      args: z.array(z.string()),
      env: z.array(zcodeProtocolMcpEntrySchema),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      type: z.enum(["http", "sse"]),
      url: nonEmptyString,
      headers: z.array(zcodeProtocolMcpEntrySchema),
      oauth: zcodeProtocolMcpOAuthSchema.optional(),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ZCodeProtocolMcpServer = z.infer<typeof zcodeProtocolMcpServerSchema>;

export const zcodeMcpServerStatusKindSchema = z.enum([
  "connecting",
  "connected",
  "disabled",
  "disconnected",
  "failed",
  "untrusted",
]);
export const MCP_SERVER_FAILURE_KINDS = [
  "config_invalid",
  "runtime_unavailable",
  "process_start_failed",
  "network_unreachable",
  "connection_timeout",
  "protocol_negotiation_failed",
  "tool_list_failed",
  "unexpected_disconnect",
  "oauth_authorization_failed",
  "official_origin_untrusted",
  "not_authenticated",
  "coding_plan_required",
  "server_not_found",
  "server_unavailable",
  "rate_limited",
  "server_internal_error",
  "protocol_error",
  "status_unavailable",
  "connection_failed",
] as const;
export const mcpServerFailureKindSchema = z.enum(MCP_SERVER_FAILURE_KINDS);
export type McpServerFailureKind = z.infer<typeof mcpServerFailureKindSchema>;
export const zcodeMcpServerStatusSnapshotSchema = z
  .object({
    status: zcodeMcpServerStatusKindSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    toolCount: z.number().int().nonnegative(),
    updatedAt: nonEmptyString,
    error: z.string().optional(),
    failureKind: mcpServerFailureKindSchema.optional(),
    serverRequestId: nonEmptyString.optional(),
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    authorization: z
      .object({
        type: z.literal("oauth_authorization_code"),
        authorizationUrl: nonEmptyString,
        startedAt: nonEmptyString,
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeMcpServerStatusSnapshot = z.infer<typeof zcodeMcpServerStatusSnapshotSchema>;

export const zcodeMcpListModeSchema = z.enum(["connect", "status"]);
export type ZCodeMcpListMode = z.infer<typeof zcodeMcpListModeSchema>;

export const zcodeMcpListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    mode: zcodeMcpListModeSchema.default("connect"),
  })
  .strict();
export const zcodeMcpListResultSchema = z
  .object({
    statuses: z.record(z.string(), zcodeMcpServerStatusSnapshotSchema),
  })
  .strict();
export type ZCodeMcpListResult = z.infer<typeof zcodeMcpListResultSchema>;

export const zcodeSessionImportMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: timestampMsSchema.optional(),
  })
  .strict();
export type ZCodeSessionImportMessage = z.infer<typeof zcodeSessionImportMessageSchema>;

export const zcodeSessionImportHistorySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("claudeCode"),
      title: z.string().optional(),
      createdAt: timestampMsSchema.optional(),
      updatedAt: timestampMsSchema.optional(),
      messages: z.array(zcodeSessionImportMessageSchema).min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("sharedContext"),
      title: z.string().trim().min(1),
      createdAt: timestampMsSchema.optional(),
      markdown: z.string().min(1),
      provenance: z
        .object({
          shareId: z.string().trim().min(1),
          contextId: z.string().trim().min(1).optional(),
          shareUrl: z.string().url().optional(),
          status: z.enum(["pending", "reserved", "attached", "discarded"]).optional(),
          projectionSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          artifactSetSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          formatterVersion: z.literal(1),
          markdownSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          installedArtifacts: z.array(
            z
              .object({
                artifactId: z.string().trim().min(1),
                workspaceRelativePath: z.string().trim().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
]);
export type ZCodeSessionImportHistory = z.infer<typeof zcodeSessionImportHistorySchema>;

export const zcodeThoughtLevelOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
  })
  .strict();
export const zcodeModelReasoningOptionsSchema = z
  .object({
    levels: z.array(zcodeThoughtLevelOptionSchema),
    defaultLevel: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeModelReasoningOptions = z.infer<typeof zcodeModelReasoningOptionsSchema>;

export const zcodeModelFormatPropertiesSchema = completeModelPropertiesDataSchema.pick({
  inputFormat: true,
  outputFormat: true,
});
export type ZCodeModelFormatProperties = z.infer<typeof zcodeModelFormatPropertiesSchema>;

export const zcodeModelOptionSchema = z
  .object({
    ref: modelSelectionSchema,
    label: nonEmptyString,
    providerLabel: nonEmptyString.optional(),
    description: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: zcodeModelReasoningOptionsSchema.optional(),
    properties: zcodeModelFormatPropertiesSchema,
    disabledReason: z.string().optional(),
  })
  .strict();
export type ZCodeModelOption = z.infer<typeof zcodeModelOptionSchema>;

export const zcodeAccountAccessSchema = z.discriminatedUnion("planKind", [
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("start-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("individual-coding-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);
export type ZCodeAccountAccess = z.infer<typeof zcodeAccountAccessSchema>;

/** The fixed account access category for Active Model; the current offering and Team scope are resolved by the account service at request time. */
export const zcodeProviderAccountAccessSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: z.enum(["start-plan", "individual-coding-plan", "team-coding-plan", "off-peak"]),
    entitled: z.boolean(),
  })
  .strict();
export type ZCodeProviderAccountAccess = z.infer<typeof zcodeProviderAccountAccessSchema>;

export type ZCodeSessionMode = z.infer<typeof zcodeSessionModeSchema>;
export type ZCodeSessionKind = z.infer<typeof zcodeSessionKindSchema>;
export type ZCodeSessionGoal = z.infer<typeof zcodeSessionGoalSchema>;

export const zcodeSessionTodoItemSchema = z
  .object({
    content: nonEmptyString,
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
  })
  .strict();
export const zcodeSessionGoalStatsSchema = z
  .object({
    timeUsedSeconds: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    iterationCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeSessionGoalStats = z.infer<typeof zcodeSessionGoalStatsSchema>;
export type ZCodeSessionGoalVerification = z.infer<typeof zcodeSessionGoalVerificationSchema>;
export type ZCodeSessionGoalVerificationTimeline = z.infer<
  typeof zcodeSessionGoalVerificationTimelineSchema
>;

export const zcodeSessionTodoGroupSchema = z
  .object({
    id: nonEmptyString,
    source: z.enum(["goal_iteration", "session"]),
    goalIteration: z.number().int().positive().optional(),
    targetId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema),
  })
  .strict();
export type ZCodeSessionTodoGroup = z.infer<typeof zcodeSessionTodoGroupSchema>;

export const zcodeSessionSettingsStateSchema = z
  .object({
    model: z
      .object({
        // Unbound is a legal recovery state; you cannot forge models or block history reads to satisfy the protocol.
        current: modelSelectionSchema.optional(),
        available: z.array(zcodeModelOptionSchema),
        lastUsed: modelSelectionSchema.optional(),
      })
      .strict(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: nonEmptyString.optional(),
        defaultLevel: nonEmptyString.optional(),
        available: z.array(zcodeThoughtLevelOptionSchema),
      })
      .strict(),
    mode: z
      .object({
        current: zcodeSessionModeSchema,
      })
      .strict(),
    permission: z
      .object({
        mode: zcodeSessionModeSchema.optional(),
        rulesRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionSettingsState = z.infer<typeof zcodeSessionSettingsStateSchema>;
export const zcodePendingPermissionSchema = z
  .object({
    requestId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown().optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    requestedAt: timestampMsSchema,
  })
  .strict();
export type ZCodePendingPermission = z.infer<typeof zcodePendingPermissionSchema>;

export const zcodeActiveToolCallSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    status: z.enum(["pending", "running", "completed", "failed", "denied"]),
    startedAt: timestampMsSchema.optional(),
  })
  .strict();
export type ZCodeActiveToolCall = z.infer<typeof zcodeActiveToolCallSchema>;

export const zcodeSessionProjectionSchema = z
  .object({
    sessionId: nonEmptyString,
    status: zcodeSessionStatusSchema,
    mode: zcodeSessionModeSchema,
    turnCount: z.number().int().nonnegative(),
    totalTokenCount: z.number().int().nonnegative(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    currentTurnId: nonEmptyString.optional(),
    pendingPermissions: z.array(zcodePendingPermissionSchema),
    activeToolCalls: z.array(zcodeActiveToolCallSchema),
    backgroundJobs: z.array(jsonObjectSchema),
    target: zcodeSessionGoalSchema.nullable().optional(),
    lastError: z
      .object({
        type: nonEmptyString,
        code: nonEmptyString.optional(),
        message: nonEmptyString,
        detail: z.string().optional(),
        attribution: errorAttributionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionProjection = z.infer<typeof zcodeSessionProjectionSchema>;
export type ZCodeToolState = z.infer<typeof zcodeToolStateSchema>;
export const zcodeSlashCommandSchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    inputHint: z.string().optional(),
    source: z.enum(["builtin", "custom"]).optional(),
  })
  .strict();
export type ZCodeSessionApiRetryStatus = z.infer<typeof zcodeSessionApiRetryStatusSchema>;
export type ZCodeSessionContextUsage = z.infer<typeof zcodeSessionContextUsageSchema>;
export const zcodeModelStreamingKindSchema = z.enum([
  "start",
  "finish",
  "error",
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
]);
export const zcodeModelStreamingEventPayloadSchema = z
  .object({
    assistantMessageId: z.string().optional(),
    delta: z.string().optional(),
    done: z.boolean().optional(),
    input: z.unknown().optional(),
    kind: zcodeModelStreamingKindSchema,
    partId: z.string().optional(),
    providerExecuted: z.boolean().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
export const zcodeSessionStateSnapshotSchema = z
  .object({
    protocol: z
      .object({
        name: z.literal(ZCODE_PROTOCOL_NAME),
        version: z.literal(ZCODE_PROTOCOL_VERSION),
      })
      .strict(),
    session: zcodeSessionInfoSchema,
    settings: zcodeSessionSettingsStateSchema,
    projection: zcodeSessionProjectionSchema,
    runtime: zcodeSessionRuntimeStateSchema,
    messages: z.array(zcodeMessageWithPartsSchema),
    goalStats: zcodeSessionGoalStatsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema).optional(),
    todoGroups: z.array(zcodeSessionTodoGroupSchema).optional(),
    slashCommands: z.array(zcodeSlashCommandSchema).optional(),
  })
  .strict();
export type ZCodeSessionStateSnapshot = z.infer<typeof zcodeSessionStateSnapshotSchema>;

export const zcodeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    seq: z.number().int().nonnegative(),
    traceId: nonEmptyString.optional(),
    timestamp: timestampMsSchema,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
  })
  .strict();

const zcodeComputerUseOperationEventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    sequenceNumber: z.number().int().nonnegative(),
    sessionId: nonEmptyString,
    timestamp: timestampMsSchema,
  })
  .strict();

const zcodeComputerUseTurnStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-started"),
  turnId: nonEmptyString,
});
const zcodeComputerUseTurnCompletedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-completed"),
  turnId: nonEmptyString,
});
const zcodeComputerUseTurnFailedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-failed"),
  turnId: nonEmptyString,
});
const zcodeComputerUseToolScheduledEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-scheduled"),
  turnId: nonEmptyString,
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  // Whether this cell is using Computer Use. Only express Boolean facts, no longer carry action names - old
  // operationAction is obtained by extracting the action name from the model source code. Once the SDK surface changes, the overall mismatch will occur (see
  // usesComputerUse of bootstrap/src/zcode-protocol/computer-use-operation-event.ts).
  // Only hung on scheduled: ToolCallStartedPayload has no input, and the model source code cannot be obtained when starting.
  computerUse: z.literal(true).optional(),
});
const zcodeComputerUseToolStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-started"),
  turnId: nonEmptyString.optional(),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString.optional(),
});
const zcodeComputerUseSessionClosedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("session-closed"),
});

export const zcodeComputerUseOperationEventSchema = z.discriminatedUnion("kind", [
  zcodeComputerUseTurnStartedEventSchema,
  zcodeComputerUseTurnCompletedEventSchema,
  zcodeComputerUseTurnFailedEventSchema,
  zcodeComputerUseToolScheduledEventSchema,
  zcodeComputerUseToolStartedEventSchema,
  zcodeComputerUseSessionClosedEventSchema,
]);
export type ZCodeComputerUseOperationEvent = z.infer<typeof zcodeComputerUseOperationEventSchema>;

export const zcodeSessionEventTypeSchema = z.enum([
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
]);
export type ZCodeSessionEventType = z.infer<typeof zcodeSessionEventTypeSchema>;

export const zcodeProtocolErrorDetailSchema = z
  .object({
    type: nonEmptyString,
    message: nonEmptyString,
    stack: z.string().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
    underlyingErrorMessage: z.string().optional(),
    underlyingErrorDetail: z.string().optional(),
    attribution: errorAttributionSchema.optional(),
    retryable: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .strict();
export const zcodeSessionCreatedEventPayloadSchema = z
  .object({
    mode: zcodeSessionModeSchema,
    contextWindow: z.number().int().nonnegative(),
  })
  .strict();
export const zcodeSessionResumedEventPayloadSchema = z
  .object({
    directory: nonEmptyString,
    interruptedToolCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    partCount: z.number().int().nonnegative(),
    recoveredCompactTimelineCount: z.number().int().nonnegative().optional(),
    recoveredSteerInputCount: z.number().int().nonnegative().optional(),
    resumedTodoCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export const zcodeSessionTitleUpdatedEventPayloadSchema = z
  .object({
    messageID: nonEmptyString.optional(),
    previousTitle: z.string(),
    source: z.enum(["default", "first_input", "generated", "custom"]),
    title: z.string(),
  })
  .strict();
export const zcodeTurnStartedEventPayloadSchema = z
  .object({
    turnNumber: z.number().int().nonnegative(),
    input: z.string(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    inputSource: zcodeTurnInputSourceSchema.optional(),
    inputVisibility: zcodeMessageVisibilitySchema.optional(),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    targetId: nonEmptyString.optional(),
    messageId: nonEmptyString.optional(),
    foregroundExecutionId: nonEmptyString.optional(),
    intent: jsonObjectSchema.optional(),
    originMeta: jsonObjectSchema.optional(),
    // The runtime will transparently transmit the background wake-up source, and strict schema must be declared synchronously to avoid discarding the entire event.
    backgroundSource: z.enum(["bash", "subagent"]).optional(),
    attachments: z.array(jsonObjectSchema).optional(),
  })
  .strict();
const zcodeTurnSteerSourceSchema = z.enum(["plan_approval_feedback", "workflow_refine_feedback"]);
const zcodeTurnSteerCommandKindSchema = z.enum(["sendText", "sendGoalCommand", "compact"]);
const zcodeTurnSteerDeliverySchema = z.enum(["queue", "guide"]);

export const zcodeTurnSteerQueuedEventPayloadSchema = z
  .object({
    pendingInputId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    input: z.string(),
    inputPreview: z.string(),
    inputSize: z.number().int().nonnegative(),
    commandKind: zcodeTurnSteerCommandKindSchema.optional(),
    source: zcodeTurnSteerSourceSchema.optional(),
    toolDisallowlist: z.array(nonEmptyString).optional(),
    delivery: zcodeTurnSteerDeliverySchema.optional(),
    targetTurnId: nonEmptyString,
    queueLength: z.number().int().nonnegative(),
    intent: jsonObjectSchema.optional(),
  })
  .strict();
export const zcodeTurnSteerDrainedEventPayloadSchema = z
  .object({
    pendingInputIds: z.array(nonEmptyString),
    queryIds: z.array(nonEmptyString).optional(),
    targetTurnId: nonEmptyString,
    injectedMessageIds: z.array(nonEmptyString),
    drainedInputs: z
      .array(
        z
          .object({
            pendingInputId: nonEmptyString,
            messageId: nonEmptyString,
            text: z.string(),
            delivery: zcodeTurnSteerDeliverySchema.optional(),
            intent: jsonObjectSchema.optional(),
            toolDisallowlist: z.array(nonEmptyString).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const zcodeTurnCompletedEventPayloadSchema = z
  .object({
    response: z.string(),
    tokenCount: z.number().int().nonnegative(),
    usage: z.unknown().optional(),
    toolCallCount: z.number().int().nonnegative(),
    historyRoundCount: z.number().int().nonnegative().optional(),
    duration: z.number().nonnegative(),
    // runtime turn.completed will come with cacheStats, which was previously missing from the protocol schema.
    // Failure of strict verification will cause the desktop to lose the final event, which means that the message has been completed but the UI has not responded.
    cacheStats: z
      .object({
        totalMessages: z.number().int().nonnegative(),
        cachedMessages: z.number().int().nonnegative(),
        lastCacheHit: z.boolean(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    inputId: nonEmptyString.optional(),
    resultType: z.enum([
      "success",
      // "cancelled": User-initiated interruption is a normal end, reuse turn.completed to report to avoid being mapped to turn.failed.
      "cancelled",
      "error_max_turns",
      "error_max_budget",
      "error_during_execution",
      "error_max_tool_calls",
    ]),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
export const zcodeTurnFailedEventPayloadSchema = z
  .object({
    error: zcodeProtocolErrorDetailSchema,
    turnPhase: z.string(),
    inputId: nonEmptyString.optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
export const zcodeMessageUpsertedEventPayloadSchema = z
  .object({
    content: z.string(),
    attachments: z.array(z.unknown()).optional(),
    toolCalls: z.array(z.unknown()).optional(),
    type: z.string().optional(),
    compactBoundary: z.unknown().optional(),
  })
  .strict();
export const zcodeMessageRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
export const zcodeMessagePartDeltaEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    field: z.enum(["text", "reasoning", "input", "output"]).optional(),
    delta: z.string(),
  })
  .strict();
export const zcodeMessagePartUpsertedEventPayloadSchema = z
  .object({
    part: zcodeMessagePartSchema,
  })
  .strict();
export const zcodeMessagePartRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
const zcodeToolCallBasePayloadSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: z.string().optional(),
    parentToolCallId: nonEmptyString.optional(),
    source: z.enum(["subagent"]).optional(),
    agentId: nonEmptyString.optional(),
    agentType: nonEmptyString.optional(),
    // Subagent mirror will carry background attribution; strict schema missing fields will cause the entire session/event to be discarded.
    background: z.boolean().optional(),
    childSessionId: nonEmptyString.optional(),
    childToolCallId: nonEmptyString.optional(),
    description: z.string().optional(),
  })
  .strict();

export const zcodeToolUpdatedEventPayloadSchema = z.discriminatedUnion("kind", [
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("scheduled"),
      // Fix: CLI scheduled events already carry the corresponding message ID; missing declarations will cause strict verification to discard the entire event.
      assistantMessageId: nonEmptyString.optional(),
      toolName: nonEmptyString,
      input: z.unknown().optional(),
      inputByteLength: z.number().int().nonnegative().optional(),
      inputOmitted: z.boolean().optional(),
      inputRef: z.literal("model_stream").optional(),
      dependencies: z.array(nonEmptyString).optional(),
      parallelGroupIndex: z.number().int().nonnegative().optional(),
      canRunParallel: z.boolean().optional(),
      schedule: jsonObjectSchema.optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("started"),
      startedAt: protocolInstantSchema,
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("progress"),
      elapsedMs: z.number().nonnegative().optional(),
      pid: z.number().int().optional(),
      stdoutBytes: z.number().int().nonnegative().optional(),
      stderrBytes: z.number().int().nonnegative().optional(),
      outputBytes: z.number().int().nonnegative().optional(),
      outputPreview: executionOutputPreviewSchema.optional(),
      stdoutTail: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("result"),
      result: zcodeToolResultObjectSchema,
      duration: z.number().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("error"),
      error: zcodeProtocolErrorDetailSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      toolCallIds: z.array(nonEmptyString),
      successCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("raw"),
      payload: jsonObjectSchema,
    })
    .strict(),
]);
export const zcodePermissionRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    reason: z.string(),
    input: z.unknown(),
    suggestedPermissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
export const zcodePermissionResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    decision: zcodePermissionDecisionSchema.optional(),
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    inputSummary: z.unknown().optional(),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
export const zcodeUserInputRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    prompt: z.string(),
    inputType: z.enum(["text", "choice", "confirm"]).optional(),
    choices: z.array(z.string()).optional(),
  })
  .strict();
export const zcodeUserInputResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    value: z.unknown().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();
export const zcodeSessionClosedEventPayloadSchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict();

function zcodeSessionEventEnvelopeFor<T extends ZCodeSessionEventType>(
  type: T,
  payload: z.ZodTypeAny,
) {
  return zcodeEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: payload.optional(),
  });
}

export const zcodeSessionEventSchema = z.discriminatedUnion("type", [
  zcodeSessionEventEnvelopeFor("session.created", zcodeSessionCreatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.resumed", zcodeSessionResumedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.updated", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("session.titleUpdated", zcodeSessionTitleUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.closed", zcodeSessionClosedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.started", zcodeTurnStartedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerQueued", zcodeTurnSteerQueuedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerDrained", zcodeTurnSteerDrainedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.completed", zcodeTurnCompletedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.failed", zcodeTurnFailedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.upserted", zcodeMessageUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.removed", zcodeMessageRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.started", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.delta", zcodeMessagePartDeltaEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.upserted", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.removed", zcodeMessagePartRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("model.streaming", zcodeModelStreamingEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("tool.updated", zcodeToolUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.requested", zcodePermissionRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.resolved", zcodePermissionResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.requested", zcodeUserInputRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.resolved", zcodeUserInputResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("checkpoint.created", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("rewind.triggered", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("streamRecovery.updated", jsonObjectSchema),
]);
export type ZCodeSessionEvent = z.infer<typeof zcodeSessionEventSchema>;

export const zcodeSessionEventsResultSchema = z
  .object({
    events: z.array(zcodeSessionEventSchema),
  })
  .strict();
export const zcodeSessionMessagesResultSchema = z
  .object({
    messages: z.array(zcodeMessageWithPartsSchema),
  })
  .strict();
export const zcodeStateUpdatedNotificationSchema = z
  .object({
    type: z.literal("state.updated"),
    scope: z.enum(["server", "workspace", "session"]),
    workspace: zcodeWorkspaceRefSchema.optional(),
    sessionId: nonEmptyString.optional(),
    revision: z.number().int().nonnegative(),
    reason: z.string().optional(),
    patch: z.unknown(),
  })
  .strict();
export type ZCodeStateUpdatedNotification = z.infer<typeof zcodeStateUpdatedNotificationSchema>;

export const zcodeSessionSubscribeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema,
    afterSeq: z.number().int().nonnegative().optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export type ZCodeSessionSubscribeParams = z.infer<typeof zcodeSessionSubscribeParamsSchema>;

export const zcodeSessionSubscribeResultSchema = z
  .object({
    sessionId: nonEmptyString,
    eventSeq: z.number().int().nonnegative(),
    events: z.array(zcodeSessionEventSchema),
    snapshot: zcodeSessionStateSnapshotSchema.optional(),
  })
  .strict();
export const zcodeSessionListResultSchema = z
  .object({
    sessions: z.array(zcodeSessionInfoSchema),
  })
  .strict();

const zcodeSessionSubagentBaseSchema = z
  .object({
    childSessionId: nonEmptyString,
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    subagentType: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const zcodeSessionRunningSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["running", "waiting", "blocked"]),
});
export type ZCodeSessionRunningSubagent = z.infer<typeof zcodeSessionRunningSubagentSchema>;

export const zcodeSessionEndedSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["success", "failed", "cancelled", "lost"]),
});
export type ZCodeSessionEndedSubagent = z.infer<typeof zcodeSessionEndedSubagentSchema>;

export const zcodeSessionSubagentsResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    childSessionIds: z.array(nonEmptyString),
    running: z.array(zcodeSessionRunningSubagentSchema),
    ended: z
      .object({
        total: z.number().int().nonnegative(),
        items: z.array(zcodeSessionEndedSubagentSchema),
        nextCursor: nonEmptyString.optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodeSessionSubagentsResult = z.infer<typeof zcodeSessionSubagentsResultSchema>;
export const zcodeSessionCreateParamsSchema = z
  .object({
    sessionId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    mode: zcodeSessionModeSchema.optional(),
    model: modelSelectionSchema.optional(),
    persistence: zcodeSessionPersistenceSchema.optional(),
    thoughtLevel: nonEmptyString.optional(),
    titleGenerationEnabled: z.boolean().optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    importedHistory: zcodeSessionImportHistorySchema.optional(),
    // The host only determines whether to register the tool according to the local service assembly/remote/end configuration, and does not read grayscale;
    // The default is not issued = no registration; grayscale and package access are verified on the actually created Host handler.
    offPeakToolEnabled: z.boolean().optional(),
    // Dynamic workflow grayscale: same as offPeakToolEnabled
    // Mode - delivered after host decision, default is not delivered = does not register the workflow tool cluster (fail-closed).
    dynamicWorkflowEnabled: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionCreateParams = z.infer<typeof zcodeSessionCreateParamsSchema>;

export const zcodeSessionResumeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema.optional(),
    // When the old session does not have a runtime/model_selection entry, the migration hint is provided by the index metadata of the same task.
    thoughtLevel: nonEmptyString.optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // The tool surface constraints of create must be followed when rebuilding the runtime during cold recovery (otherwise allow/deny will be bypassed, especially CUA sessions).
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    // The same semantics as create; resume without it will cause cold recovery to lose the Off-Peak tool surface.
    offPeakToolEnabled: z.boolean().optional(),
    // The same semantics as create; not using resume will cause the cold recovery to lose the workflow tool cluster.
    dynamicWorkflowEnabled: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionResumeParams = z.infer<typeof zcodeSessionResumeParamsSchema>;

export const zcodeSessionListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema.optional(),
    // Explicit identity queries include hidden sessions; normal lists still only return the main task to avoid index repair activating the runtime.
    sessionIds: z.array(nonEmptyString).min(1).max(64).optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionListParams = z.infer<typeof zcodeSessionListParamsSchema>;

export const zcodeSessionSubagentsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    endedCursor: nonEmptyString.optional(),
    endedLimit: z.number().int().positive().max(100).default(20),
  })
  .strict();
export type ZCodeSessionSubagentsParams = z.infer<typeof zcodeSessionSubagentsParamsSchema>;

export const zcodeUsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export const zcodeUsageStatsResultSchema = appUsageSnapshotSchema;
export const zcodeTaskTokenUsageParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
export const zcodeTaskTokenUsageResultSchema = z
  .object({
    sessionId: nonEmptyString,
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type ZCodeTaskTokenUsageResult = z.infer<typeof zcodeTaskTokenUsageResultSchema>;

export const zcodeSessionReadParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
    messageLimit: z.number().int().positive().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionReadParams = z.infer<typeof zcodeSessionReadParamsSchema>;

export const zcodeSessionMessagesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterMessageId: nonEmptyString.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionMessagesParams = z.infer<typeof zcodeSessionMessagesParamsSchema>;

export const zcodeSessionEventsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionEventsParams = z.infer<typeof zcodeSessionEventsParamsSchema>;

export const zcodeSessionRuntimePreferencesScopeSchema = z.enum([
  "runtime-materialization",
  "user-execution",
]);
export type ZCodeSessionRuntimePreferencesScope = z.infer<
  typeof zcodeSessionRuntimePreferencesScopeSchema
>;

export const ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS = 15_000;

export const zcodeSessionRequestRuntimePreferencesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    scope: zcodeSessionRuntimePreferencesScopeSchema,
  })
  .strict();
export type ZCodeSessionRequestRuntimePreferencesParams = z.infer<
  typeof zcodeSessionRequestRuntimePreferencesParamsSchema
>;

export const DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY = "preflight-v1" as const;

// 3.12.2: legacy is only compatible with old protocols; runtime will always be normalized to the above shared default policy.
export const zcodeModelContextBudgetStrategySchema = z.enum(["legacy", "preflight-v1"]);
export type ZCodeModelContextBudgetStrategy = z.infer<typeof zcodeModelContextBudgetStrategySchema>;

export const zcodeSessionRuntimePreferencesResultSchema = z
  .object({
    nativeSearchEnhancementsEnabled: z.boolean(),
    askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
    integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
    // Compatible with older Hosts: Use the current default policy at protocol parsing boundaries when fields are missing.
    modelContextBudgetStrategy: zcodeModelContextBudgetStrategySchema.default(
      DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    ),
  })
  .strict();
export type ZCodeSessionRuntimePreferencesResult = z.infer<
  typeof zcodeSessionRuntimePreferencesResultSchema
>;

/**
 * The IAB visible state the App collects read-only before submitting a prompt. This field
 * is only used for provider-visible ambient context and never enters the user-visible
 * transcript; its content is bounded and must never carry page text or credentials.
 */
export const zcodeBrowserAmbientContextSchema = z
  .object({
    tabCount: z.number().int().positive().max(100),
    currentUrl: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
export type ZCodeBrowserAmbientContext = z.infer<typeof zcodeBrowserAmbientContextSchema>;

export const zcodeSessionSendParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    modelExecution: modelExecutionSchema.optional(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    content: z.string(),
    attachments: z.array(jsonObjectSchema).optional(),
    browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedProviderRevision: nonEmptyString.optional(),
    automationId: nonEmptyString.optional(),
    offPeakTaskId: nonEmptyString.optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.automationId && payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (payload.offPeakRunType && !payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
    if (payload.modelExecution && !payload.modelSelection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelExecution requires modelSelection",
        path: ["modelExecution"],
      });
    }
  });
export const zcodeSessionSendResultSchema = z
  .object({
    sessionId: nonEmptyString,
    accepted: z.literal(true),
    stateRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeSessionSendResult = z.infer<typeof zcodeSessionSendResultSchema>;

export const zcodeSessionHistoryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("turn"),
      turnIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      messageId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      checkpointId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("latestCheckpoint"),
    })
    .strict(),
]);
export type ZCodeSessionHistoryTarget = z.infer<typeof zcodeSessionHistoryTargetSchema>;

export const zcodeSessionForkParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    target: zcodeSessionHistoryTargetSchema.default({
      kind: "latestCheckpoint",
    }),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionForkParams = z.infer<typeof zcodeSessionForkParamsSchema>;

export const zcodeSessionForkResultSchema = z
  .object({
    forkedSessionId: nonEmptyString,
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: nonEmptyString.optional(),
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
  })
  .strict();
export type ZCodeSessionForkResult = z.infer<typeof zcodeSessionForkResultSchema>;

export const zcodeSessionCompactParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    instructions: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionCompactParams = z.infer<typeof zcodeSessionCompactParamsSchema>;

export const zcodeSessionCompactResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    compact: z
      .object({
        state: z.enum(["accepted", "already_running"]),
        inputId: nonEmptyString.optional(),
        operationId: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionCompactResult = z.infer<typeof zcodeSessionCompactResultSchema>;

export const zcodeSessionGoalActionSchema = z.enum([
  "show",
  "set",
  "replace",
  "pause",
  "resume",
  "clear",
]);
export type ZCodeSessionGoalAction = z.infer<typeof zcodeSessionGoalActionSchema>;

export const zcodeSessionGoalParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    action: zcodeSessionGoalActionSchema,
    objective: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionGoalParams = z.infer<typeof zcodeSessionGoalParamsSchema>;

export const zcodeSessionGoalResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    startedTurn: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionGoalResult = z.infer<typeof zcodeSessionGoalResultSchema>;

export const zcodeSessionStopParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
const zcodeBackgroundTaskInfoStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "lost",
]);

export const zcodeBackgroundTaskInfoSchema = z
  .object({
    taskId: nonEmptyString,
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    taskKind: z.enum(["bash", "subagent"]).optional(),
    blocked: z.boolean().optional(),
    blockedReason: z.string().optional(),
    cancellable: z.boolean().optional(),
    cancelRequestedAt: protocolInstantSchema.optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    pid: z.number().int().positive().optional(),
    startedAt: protocolInstantSchema.optional(),
    completedAt: protocolInstantSchema.optional(),
    outputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
    outputTail: z.string().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    stderrTail: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stdoutTail: z.string().optional(),
    terminalId: nonEmptyString.optional(),
  })
  .strict();
export const zcodeSessionCancelBackgroundTaskParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
  })
  .strict();
export type ZCodeSessionCancelBackgroundTaskParams = z.infer<
  typeof zcodeSessionCancelBackgroundTaskParamsSchema
>;

export const zcodeSessionCancelBackgroundTaskResultSchema = z
  .object({
    cancelled: z.boolean(),
    reason: z.string().optional(),
    snapshot: zcodeBackgroundTaskInfoSchema.optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    taskId: nonEmptyString,
  })
  .strict();
export type ZCodeSessionCancelBackgroundTaskResult = z.infer<
  typeof zcodeSessionCancelBackgroundTaskResultSchema
>;

export const zcodeSessionSetModelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    model: modelSelectionSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZCodeSessionSetModelParams = z.infer<typeof zcodeSessionSetModelParamsSchema>;

export const zcodeSessionSetThoughtLevelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    thoughtLevel: nonEmptyString.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZCodeSessionSetThoughtLevelParams = z.infer<
  typeof zcodeSessionSetThoughtLevelParamsSchema
>;

export const zcodeSessionSetModeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    mode: zcodeSessionModeSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionSetModeParams = z.infer<typeof zcodeSessionSetModeParamsSchema>;

export const zcodeSessionCloseParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    expectedPersistence: zcodeSessionPersistenceSchema.optional(),
  })
  .strict();
export type ZCodeSessionCloseParams = z.infer<typeof zcodeSessionCloseParamsSchema>;
export const zcodeSessionCloseResultSchema = z
  .object({
    closed: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionCloseResult = z.infer<typeof zcodeSessionCloseResultSchema>;
export const zcodeWorkspaceReadPresentationParamsSchema = z
  .object({ workspace: zcodeWorkspaceRefSchema })
  .strict();
export const zcodeWorkspacePresentationSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mode: zcodeSessionModeSchema,
    slashCommands: z.array(zcodeSlashCommandSchema),
  })
  .strict();
export type ZCodeWorkspacePresentation = z.infer<typeof zcodeWorkspacePresentationSchema>;
const workspaceHookSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const zcodeWorkspaceHookTrustGrantParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    bundleDigest: workspaceHookSha256DigestSchema,
    hookDeclarationDigest: workspaceHookSha256DigestSchema,
  })
  .strict();
export type ZCodeWorkspaceHookTrustGrantParams = z.infer<
  typeof zcodeWorkspaceHookTrustGrantParamsSchema
>;
export const zcodeWorkspaceHookTrustGrantReasonCodeSchema = z.enum([
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_config_unreadable",
]);
export type ZCodeWorkspaceHookTrustGrantReasonCode = z.infer<
  typeof zcodeWorkspaceHookTrustGrantReasonCodeSchema
>;
export const zcodeWorkspaceHookTrustGrantResultSchema = z
  .object({
    accepted: z.boolean(),
    reasonCode: zcodeWorkspaceHookTrustGrantReasonCodeSchema.optional(),
  })
  .strict();
export type ZCodeWorkspaceHookTrustGrantResult = z.infer<
  typeof zcodeWorkspaceHookTrustGrantResultSchema
>;
const zcodeWorkspaceModelToolCallSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    input: z.unknown(),
  })
  .strict();
const zcodeWorkspaceModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
      isError: z.boolean().optional(),
    })
    .strict(),
]);
const zcodeWorkspaceModelToolSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const zcodeWorkspaceGenerateTextParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
    prompt: nonEmptyString.optional(),
    messages: z.array(zcodeWorkspaceModelMessageSchema).min(1).optional(),
    tools: z.array(zcodeWorkspaceModelToolSchema).optional(),
    querySource: nonEmptyString,
    maxOutputTokens: z.number().int().positive().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict()
  .refine((value) => value.prompt !== undefined || value.messages !== undefined, {
    message: "either prompt or messages is required",
  });
export const zcodeWorkspaceGenerateTextResultSchema = z
  .object({
    text: z.string(),
    selection: modelSelectionSchema,
    toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    // Optional for compatibility with legacy app-servers that are still running; the new CLI always returns a structured end reason.
    finishReason: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheWriteTokens: z.number().nonnegative().optional(),
        reasoningTokens: z.number().nonnegative().optional(),
        serverToolUse: z
          .object({
            webSearchRequests: z.number().nonnegative().optional(),
            webFetchRequests: z.number().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeWorkspaceGenerateTextParams = z.infer<
  typeof zcodeWorkspaceGenerateTextParamsSchema
>;
export type ZCodeWorkspaceModelMessage = z.infer<typeof zcodeWorkspaceModelMessageSchema>;
export type ZCodeWorkspaceModelTool = z.infer<typeof zcodeWorkspaceModelToolSchema>;
export type ZCodeWorkspaceGenerateTextResult = z.infer<
  typeof zcodeWorkspaceGenerateTextResultSchema
>;
export const zcodeWorkspaceCancelGenerateTextParamsSchema = z
  .object({ operationId: nonEmptyString })
  .strict();
export const zcodeWorkspaceCancelGenerateTextResultSchema = z
  .object({ operationId: nonEmptyString, cancelled: z.boolean() })
  .strict();

export const zcodeProviderTestModelConnectivityParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
  })
  .strict();
export const zcodeProviderTestModelConnectivityResultSchema = z
  .object({ success: z.literal(true) })
  .strict();
export type ZCodeProviderTestModelConnectivityParams = z.infer<
  typeof zcodeProviderTestModelConnectivityParamsSchema
>;
export type ZCodeProviderTestModelConnectivityResult = z.infer<
  typeof zcodeProviderTestModelConnectivityResultSchema
>;

export const zcodeProviderUpdateAccountConfigParamsSchema = z
  .object({
    revision: nonEmptyString,
    basedOnZCodeBuiltinRevision: nonEmptyString,
    // Provider Config field verification is handled by @zcode/provider; the protocol layer only restricts transmittable envelopes.
    providers: z.record(z.string(), z.unknown()),
    // The account status and Overlay must be passed together, otherwise the Worker will lose execution access control for non-current packages.
    states: z.record(
      z.string(),
      z
        .object({
          availability: z.enum(["available", "pending", "unavailable", "unknown"]),
          entitled: z.boolean(),
          unavailableReason: accountProviderUnavailableReasonSchema.optional(),
          current: z.boolean().optional(),
          connectionKey: z.string().optional(),
          effectiveAt: z.number().finite().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const zcodeProviderUpdateAccountConfigResultSchema = z
  .object({
    // Receiving the account result does not mean that the package Built-in has arrived; the application version can only read the Registry snapshot.
    receivedRevision: nonEmptyString,
    providerCount: z.number().int().nonnegative(),
    status: z.enum(["received", "unchanged"]),
  })
  .strict();
export type ZCodeProviderUpdateAccountConfigResult = z.infer<
  typeof zcodeProviderUpdateAccountConfigResultSchema
>;
export const zcodeInteractionPreferencesSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
  })
  .strict();
export type ZCodeInteractionPreferences = z.infer<typeof zcodeInteractionPreferencesSchema>;

export const zcodeWorkspaceUpdateInteractionPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeInteractionPreferencesSchema,
  })
  .strict();
export type ZCodeWorkspaceUpdateInteractionPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesParamsSchema
>;

export const zcodeWorkspaceUpdateInteractionPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    snoozedInteractionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeWorkspaceUpdateInteractionPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesResultSchema
>;

export const zcodeModelIoPreferencesSchema = z
  .object({
    fullRetentionEnabled: z.boolean(),
  })
  .strict();
export type ZCodeModelIoPreferences = z.infer<typeof zcodeModelIoPreferencesSchema>;

export const zcodeWorkspaceUpdateModelIoPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeModelIoPreferencesSchema,
  })
  .strict();
export type ZCodeWorkspaceUpdateModelIoPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesParamsSchema
>;

export const zcodeWorkspaceUpdateModelIoPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    fullRetentionEnabled: z.boolean(),
    updatedSessionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeWorkspaceUpdateModelIoPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesResultSchema
>;

export const zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateOffPeakToolPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema
>;

export const zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateOffPeakToolPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema
>;

// Dynamic workflow grayscale access control: workspace-level facts,
// Same host→CLI synchronization mode as Off-Peak; old CLI method-not-found→host downgrade ignored.
export const zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema
>;

export const zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema
>;

export const zcodePermissionRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
  })
  .strict();
export type ZCodePermissionRequestParams = z.infer<typeof zcodePermissionRequestParamsSchema>;

/** The Agent asks the app to enumerate the browser backends reachable from the current workspace/session that have completed the handshake. */
export const zcodeBrowserListParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type ZCodeBrowserListParams = z.infer<typeof zcodeBrowserListParamsSchema>;

export const zcodeBrowserListResultSchema = browserBackendListResultSchema;
export type ZCodeBrowserListResult = z.infer<typeof zcodeBrowserListResultSchema>;

/** The Agent sends one browser-use command to the app for execution. */
export const zcodeBrowserExecuteParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    browserId: nonEmptyString.optional(),
    browserGeneration: z.number().int().nonnegative().optional(),
    workspaceKey: nonEmptyString.optional(),
    workspacePath: nonEmptyString.optional(),
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema.optional(),
    sessionContext: browserSessionContextKindSchema.optional(),
    command: browserCommandSchema,
  })
  .strict();
export type ZCodeBrowserExecuteParams = z.infer<typeof zcodeBrowserExecuteParamsSchema>;

// browser command result is the same origin protocol result of app/agent; where duplicate_request_id is used for real maintenance
// The boundary of the pending/running life cycle rejects correlation key conflicts and cannot rely on the upstream UUID probability guarantee.
export const zcodeBrowserExecuteResultSchema = browserCommandResultSchema;
export type ZCodeBrowserExecuteResult = z.infer<typeof zcodeBrowserExecuteResultSchema>;

export const zcodeUserInputOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();
export const zcodeUserInputQuestionSchema = z
  .object({
    question: nonEmptyString,
    header: nonEmptyString,
    options: z.array(zcodeUserInputOptionSchema).min(1),
    multiSelect: z.boolean().optional(),
  })
  .strict();
export type ZCodeUserInputQuestion = z.infer<typeof zcodeUserInputQuestionSchema>;

export const zcodeUserInputRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    prompt: z.string().optional(),
    questions: z.array(zcodeUserInputQuestionSchema).min(1).optional(),
    input: z.unknown().optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    schema: z.unknown().optional(),
  })
  .strict();
export type ZCodeUserInputRequestParams = z.infer<typeof zcodeUserInputRequestParamsSchema>;

export const zcodeUserInputResponseSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: jsonObjectSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ZCodeUserInputResponse = z.infer<typeof zcodeUserInputResponseSchema>;

export const zcodeProviderRuntimeHeadersRequestReasonSchema = z.enum(["model-request"]);
export const zcodeProviderRuntimeHeadersRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    modelSelection: modelSelectionSchema,
    providerId: nonEmptyString,
    accountAccess: zcodeProviderAccountAccessSchema.optional(),
    reason: zcodeProviderRuntimeHeadersRequestReasonSchema,
  })
  .strict();
export type ZCodeProviderRuntimeHeadersRequestParams = z.infer<
  typeof zcodeProviderRuntimeHeadersRequestParamsSchema
>;

/** Cancelling the request only affects this one round of credential refresh within the same workspace/session. */
export const zcodeProviderRuntimeHeadersCancelledSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema,
  })
  .strict();
export type ZCodeProviderRuntimeHeadersCancelled = z.infer<
  typeof zcodeProviderRuntimeHeadersCancelledSchema
>;

export const zcodeProviderRuntimeHeadersResponseSchema = z.discriminatedUnion("headersApplied", [
  z
    .object({
      headersApplied: z.literal(true),
      // Merge reconnection: Success must carry the authentication material of the current request and does not rely on the old Registry being written.
      requestAuth: z
        .object({
          apiKey: nonEmptyString.optional(),
          headers: z.record(nonEmptyString, nonEmptyString).optional(),
        })
        .strict(),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      headersApplied: z.literal(false),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
]);
export type ZCodeProviderRuntimeHeadersResponse = z.infer<
  typeof zcodeProviderRuntimeHeadersResponseSchema
>;

// ── Official Server MCP authentication──
// The Agent process is not the user identity authority: it reports (pluginId, mcpKey, targetOrigin) to the host, who
// Parse the current Coding Plan credentials and return the identity header of this request. The request side does not contain any secrets.
// Similar to interaction/requestProviderRuntimeHeaders: Agent initiated, host automatically responded, and zero UI.
export const zcodeOfficialMcpAuthHeadersRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    mcpKey: nonEmptyString,
    targetOrigin: nonEmptyString,
  })
  .strict();
export type ZCodeOfficialMcpAuthHeadersRequestParams = z.infer<
  typeof zcodeOfficialMcpAuthHeadersRequestParamsSchema
>;

/**
 * The failure reason must be enumerable, so that callers never have to route on free text;
 * that is why the response carries no errorMessage.
 *
 * `official_mcp_origin_untrusted` is the rejection reason from the host-side second
 * validation: `targetOrigin` is not equal to the current ZCode API origin. The decision
 * only looks at the origin; `pluginId` / `mcpKey` are used solely for log attribution.
 * Keeping it separate from "not logged in / no credentials" is what lets troubleshooting
 * tell "rejected" apart from "no identity".
 */
export const zcodeOfficialMcpAuthFailureReasonSchema = z.enum(
  OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS,
);

export const zcodeOfficialMcpAuthHeadersResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      headers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: zcodeOfficialMcpAuthFailureReasonSchema,
    })
    .strict(),
]);
export type ZCodeOfficialMcpAuthHeadersResponse = z.infer<
  typeof zcodeOfficialMcpAuthHeadersResponseSchema
>;

// ── Plugin management (list + enable/disable) ──
// Mirrors the PluginMetadata of @zcode/contracts, retaining only the serializable fields required by the UI.
export const zcodePluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type ZCodePluginOptionValue = z.infer<typeof zcodePluginOptionValueSchema>;
export const zcodePluginScopeSchema = z.enum(["user", "workspace"]);
export type ZCodePluginScope = z.infer<typeof zcodePluginScopeSchema>;
export const zcodePluginHookDetailSchema = z
  .object({
    event: nonEmptyString,
    matcher: z.string().optional(),
    type: z.enum(["command", "process"]),
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string()]).optional(),
    timeout: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    statusMessage: z.string().optional(),
    sourcePath: z.string(),
    runnable: z.boolean(),
  })
  .strict();
export const zcodePluginUserConfigOptionSchema = z
  .object({
    default: zcodePluginOptionValueSchema.optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    title: z.string().optional(),
    type: z.enum(["string", "number", "boolean", "directory", "file"]).optional(),
  })
  .strict();
export type ZCodePluginUserConfigOption = z.infer<typeof zcodePluginUserConfigOptionSchema>;

// The component type is consistent with the grouping order shared by detail pop-ups/market details: agent/command/skill/hook/mcp.
// Note: These three schemas must be defined before zcodePluginInfoSchema, because the components field of the latter (.strict()) refers to them.
export const zcodePluginComponentKindSchema = z.enum(["agent", "command", "skill", "hook", "mcp"]);
export type ZCodePluginComponentKind = z.infer<typeof zcodePluginComponentKindSchema>;

export const zcodePluginComponentItemSchema = z
  .object({
    name: nonEmptyString,
    // Description comes from component frontmatter (SKILL.md/command/agent) or manifest; omitted when missing, not forged.
    description: z.string().optional(),
  })
  .strict();
export const zcodePluginComponentGroupSchema = z
  .object({
    kind: zcodePluginComponentKindSchema,
    items: z.array(zcodePluginComponentItemSchema),
  })
  .strict();
export type ZCodePluginComponentGroup = z.infer<typeof zcodePluginComponentGroupSchema>;

export const zcodePluginInfoSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    source: nonEmptyString,
    marketplace: nonEmptyString,
    // The author/homepage fallback field of the manifest (plugin.json); it is used in the details page information area when the store listing is missing.
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    skillCount: z.number().int().nonnegative().optional(),
    skillRootCount: z.number().int().nonnegative(),
    commandRootCount: z.number().int().nonnegative(),
    // The authoritative component list (name + optional description), derived from the CLI enumeration of the plugin root directory, regardless of the enabled state.
    // The details are displayed directly on the UI, replacing the old fragile solution of "the quantity is taken from the protocol, and the name is joined on the UI side". optional Compatible with old payloads.
    components: z.array(zcodePluginComponentGroupSchema).optional(),
    declaredMcpServerNames: z.array(z.string()).optional(),
    hostMcpServerNames: z.array(z.string()).optional(),
    mcpServerNames: z.array(z.string()),
    hookDetails: z.array(zcodePluginHookDetailSchema).optional(),
    rootPath: z.string(),
    userConfig: z.record(z.string(), zcodePluginUserConfigOptionSchema).optional(),
    configuredOptions: z.record(z.string(), zcodePluginOptionValueSchema).optional(),
    // The default indicates that the package is available; missing is used to retain configuration lines that have been declared but the target Host has not yet been materialized.
    packageStatus: z.literal("missing").optional(),
    rootSource: zcodePluginScopeSchema.optional(),
    enabledSource: zcodePluginScopeSchema.optional(),
    optionSources: z.record(z.string(), zcodePluginScopeSchema).optional(),
  })
  .strict();
export type ZCodePluginInfo = z.infer<typeof zcodePluginInfoSchema>;

export const zcodePluginDiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(["warning", "error"]).optional(),
    pluginId: z.string().optional(),
  })
  .strict();
export type ZCodePluginDiagnostic = z.infer<typeof zcodePluginDiagnosticSchema>;

export const zcodePluginsListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    configScope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export const zcodePluginsListResultSchema = z
  .object({
    plugins: z.array(zcodePluginInfoSchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsListResult = z.infer<typeof zcodePluginsListResultSchema>;

// ── Plugin dialogue reference catalog──
// Session-scoped read-only projection: with sessionId → the identity catalog frozen when the Session was created;
// Without → workspace current catalog (new draft Picker). Identity and capability fields maintained
// identifiers-only, does not carry rootPath/configuration, etc.; optional icon/displayName(I18n)/description(I18n)
// It is only for UI display and Picker search, and does not participate in identity, permissions or runtime reminders.
export const zcodePluginReferenceCatalogEntrySchema = z
  .object({
    // Only referenceCatalogWithCategory is returned; the old entry retains its original structure.
    category: nonEmptyString.optional(),
    pluginId: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    icon: z.string().optional(),
    // Display-only localized display name projection for store listings (following icon precedent): Make Picker clickable
    // Chinese display name search/display; locale parsing and reuse shared plugin-display-name helper.
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    // For Picker display only, does not enter capability status or model-only reminder.
    description: z.string().optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    // non-null = conflict with V1 fail closed that shares manifest name with other enabled plugins:
    // Picker is disabled and the reason is displayed, and runtime analysis is skipped by ambiguous.
    conflictingPluginIds: z.array(nonEmptyString),
    skillQualifiedNames: z.array(nonEmptyString),
    mcpServerNames: z.array(nonEmptyString),
    // Old Hosts are compatible with empty arrays when not projecting this field; only new Agents will use it for reminder live intersections.
    subagentNames: z.array(nonEmptyString).default([]),
  })
  .strict();
export type ZCodePluginReferenceCatalogEntry = z.infer<
  typeof zcodePluginReferenceCatalogEntrySchema
>;

export const zcodePluginsReferenceCatalogParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // A Picker that already has a Session must bring sessionId to get the session-owned catalog;
    // When the session does not exist, the protocol error fails closed, and silent rollback of the workspace authority is prohibited.
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodePluginsReferenceCatalogParams = z.infer<
  typeof zcodePluginsReferenceCatalogParamsSchema
>;
export const zcodePluginsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    plugins: z.array(zcodePluginReferenceCatalogEntrySchema),
  })
  .strict();
export type ZCodePluginsReferenceCatalogResult = z.infer<
  typeof zcodePluginsReferenceCatalogResultSchema
>;

// ── Skill dialogue reference catalog──
// The new draft reads the current directory of the workspace; the existing Session reads the AgentRuntime first context
// Discovery results frozen on initialization. This protocol only carries Composer's read-only reference projection and does not replace Settings
// The Skill management interface does not persist runtime snapshots.
export const zcodeSkillReferenceCatalogEntrySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string(),
    path: nonEmptyString,
    scope: z.enum(["workspace", "user", "plugin"]),
    enabled: z.literal(true),
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeSkillReferenceCatalogEntry = z.infer<typeof zcodeSkillReferenceCatalogEntrySchema>;

export const zcodeSkillsReferenceCatalogParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // With sessionId, the resident Session in the process must be hit; unknown Session fail closed,
    // It is forbidden to fall back to the current workspace directory and leak new skills into old sessions.
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeSkillsReferenceCatalogParams = z.infer<
  typeof zcodeSkillsReferenceCatalogParamsSchema
>;
export const zcodeSkillsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    skills: z.array(zcodeSkillReferenceCatalogEntrySchema),
  })
  .strict();
export type ZCodeSkillsReferenceCatalogResult = z.infer<
  typeof zcodeSkillsReferenceCatalogResultSchema
>;

// ── GUI hub for saved workflows──
// Five workspace-level, session-less methods, following the precedent of skills/referenceCatalog: scan every time
// `<cwd>/.zcode/workflows/` (the snapshot will miss manually modified files when mounting). Shapes with @zcode/contracts
// saved-workflow.ts is aligned verbatim - the dependency direction is contracts → shared, so it is declared again in a structured manner,
// Instead of import; the strict shapes on both sides are pinned to each other by the protocol tests on the bootstrap side.
export const zcodeSavedWorkflowArgTypeSchema = z.enum(["string", "number", "boolean", "json"]);
export type ZCodeSavedWorkflowArgType = z.infer<typeof zcodeSavedWorkflowArgTypeSchema>;
export const zcodeSavedWorkflowArgDeclarationSchema = z
  .object({
    type: zcodeSavedWorkflowArgTypeSchema,
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();
export type ZCodeSavedWorkflowArgDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgDeclarationSchema
>;
export const zcodeSavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  zcodeSavedWorkflowArgDeclarationSchema,
);
export type ZCodeSavedWorkflowArgsDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgsDeclarationSchema
>;
export const zcodeSavedWorkflowMetaSchema = z
  .object({
    description: nonEmptyString,
    whenToUse: nonEmptyString.optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();
export type ZCodeSavedWorkflowMeta = z.infer<typeof zcodeSavedWorkflowMetaSchema>;
// There are two scope files: the project file is located in `<cwd>/.zcode/workflows/`, and the global file is located in the agent machine's `~/.zcode/workflows/`. The scope is inferred from the directory where the file is located, and frontmatter does not have scope.
export const zcodeSavedWorkflowScopeSchema = z.enum(["project", "global"]);
export type ZCodeSavedWorkflowScope = z.infer<typeof zcodeSavedWorkflowScopeSchema>;
export const zcodeSavedWorkflowEntrySchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    whenToUse: z.string().optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
    scope: zcodeSavedWorkflowScopeSchema,
    path: nonEmptyString,
  })
  .strict();
export type ZCodeSavedWorkflowEntry = z.infer<typeof zcodeSavedWorkflowEntrySchema>;
export const zcodeSavedWorkflowInvalidEntrySchema = z
  .object({ path: nonEmptyString, reason: nonEmptyString })
  .strict();
export type ZCodeSavedWorkflowInvalidEntry = z.infer<typeof zcodeSavedWorkflowInvalidEntrySchema>;
/** Invalid name / not found / broken frontmatter / read error — the four states correspond one-to-one, word for word, to the core store's resolve failures. */
export const zcodeSavedWorkflowFailureReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "parse_error",
  "read_error",
]);
export type ZCodeSavedWorkflowFailureReason = z.infer<typeof zcodeSavedWorkflowFailureReasonSchema>;
const zcodeSavedWorkflowFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: zcodeSavedWorkflowFailureReasonSchema,
    detail: z.string().optional(),
  })
  .strict();

export const zcodeWorkflowsListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // The default is `project` (this project file). When giving `global`, change the local `~/.zcode/workflows/`; at this time, `workspace`
    // Still required, but only **vector runtime** - the protocol handler does not read the path to the global file.
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsListParams = z.infer<typeof zcodeWorkflowsListParamsSchema>;
export const zcodeWorkflowsListResultSchema = z
  .object({
    workflows: z.array(zcodeSavedWorkflowEntrySchema),
    invalid: z.array(zcodeSavedWorkflowInvalidEntrySchema),
    // The scanned directory (local absolute path) will be returned even if the directory does not exist yet: GUI's file monitoring relies on watch.
    dir: nonEmptyString,
  })
  .strict();
export type ZCodeWorkflowsListResult = z.infer<typeof zcodeWorkflowsListResultSchema>;

export const zcodeWorkflowsGetParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // By default, `project`; in `global`, only the global root of the local machine is checked. `workspace` has the same semantics as list (global files are only used as carriers).
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsGetParams = z.infer<typeof zcodeWorkflowsGetParamsSchema>;
export const zcodeWorkflowsGetResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      path: nonEmptyString,
      scope: zcodeSavedWorkflowScopeSchema,
      meta: zcodeSavedWorkflowMetaSchema,
      /** The script body (byte-for-byte after the frontmatter), i.e. the very copy that is type-checked and executed. */
      script: z.string(),
    })
    .strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsGetResult = z.infer<typeof zcodeWorkflowsGetResultSchema>;

export const zcodeWorkflowsUpdateMetaParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    meta: zcodeSavedWorkflowMetaSchema,
    // By default `project`; `global` only writes the copy of the local global root. `workspace` has the same semantics as list.
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsUpdateMetaParams = z.infer<typeof zcodeWorkflowsUpdateMetaParamsSchema>;
export const zcodeWorkflowsUpdateMetaResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsUpdateMetaResult = z.infer<typeof zcodeWorkflowsUpdateMetaResultSchema>;

export const zcodeWorkflowsDeleteParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // The default is `project`; in `global`, press scope to select the root and delete it (roots[0] is no longer hard-coded). `workspace` has the same semantics as list.
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsDeleteParams = z.infer<typeof zcodeWorkflowsDeleteParamsSchema>;
export const zcodeWorkflowsDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsDeleteResult = z.infer<typeof zcodeWorkflowsDeleteResultSchema>;

export const ZCODE_WORKFLOWS_RUNS_MAX_LIMIT = 50;
export const zcodeWorkflowsRunsParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** Only the runs with this name (a literal equality match on `dwf_run.name`); when omitted, all runs of this project. */
    name: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT),
    // Default `project`: only check the run of `dwf_run.cwd === workspacePath`. **not** filter by cwd when using `global`,
    // Take the running history of this name across all projects (the global workflow runs in any project, so the history spans cwd); the result line contains `cwd`
    // Provides GUI icon items. `workspace` has the same semantics as list (global files are only used as carriers).
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsRunsParams = z.infer<typeof zcodeWorkflowsRunsParamsSchema>;
// Three final state vocabulary: errored = script error, stopped = stopped (recoverable).
export const zcodeSavedWorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
]);
export type ZCodeSavedWorkflowRunStatus = z.infer<typeof zcodeSavedWorkflowRunStatusSchema>;
export const zcodeSavedWorkflowRunStopReasonSchema = z.enum([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);
export const zcodeSavedWorkflowRunSchema = z
  .object({
    runId: nonEmptyString,
    name: z.string().optional(),
    status: zcodeSavedWorkflowRunStatusSchema,
    // `status === "stopped"` is only present.
    stopReason: zcodeSavedWorkflowRunStopReasonSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
    /** The session that started it and the CreateWorkflow tool call: with both of them the instance details can be opened from the hub. Older rows may lack them. */
    parentSessionId: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    // The actual running project directory (`dwf_run.cwd`). The `workflows/runs` of the global file is queried across cwd, and the GUI uses it to
    // Each line identifies the project; in the project file variant it is always equal to the workspacePath and can be ignored by the GUI. Lao Xing is in short supply.
    cwd: z.string().optional(),
    // The **user interface product** released in this run: the hub’s running history is
    // After the status word, draw a string of kind chips. The "Recent Products" bar at the head of the details page takes the most recent completed run.
    // ⚠ Terminology: The artifact here is the output of the script published to the user through `artifact.*`, not the top-level return value of the script.
    // Only fields that can be drawn by chip are included (≤ 8 pieces, get the latest version of metadata); bytes and entries are read on demand through v4 query.
    // Optional, following the precedent of `cwd` above: the old CLI is not released, and one missing key is a degeneration, not an error.
    artifacts: z
      .array(
        z
          .object({
            id: nonEmptyString,
            kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
            title: z.string().optional(),
            version: z.number(),
            contentType: z.string().optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type ZCodeSavedWorkflowRun = z.infer<typeof zcodeSavedWorkflowRunSchema>;
export const zcodeWorkflowsRunsResultSchema = z
  .object({
    runs: z.array(zcodeSavedWorkflowRunSchema),
    /** Only present when true: more runs did not fit into this page (decided by fetching one extra, not by `length === limit`). */
    truncated: z.literal(true).optional(),
  })
  .strict();
export type ZCodeWorkflowsRunsResult = z.infer<typeof zcodeWorkflowsRunsResultSchema>;

// workflows/move: Move the file with the same name of the local global root to the `workspace` project root. **This is the only way**: Project → The overall situation is not to move files but to summarize the model ("promoted to
// Global" Open a new session in the project and save it via SaveWorkflow), so there is no `to` parameter. Same computer and same user, rename takes priority, EXDEV
// Fall back to copy+unlink; move byte by byte without changing the content (frontmatter does not have scope); `move` does not overwrite - the target is rejected if it already exists
// (Overwriting is an action that SaveWorkflow only has through the confirmation window, invariant 7). `workspace` is both the carrier runtime and the target project.
export const zcodeWorkflowsMoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
  })
  .strict();
export type ZCodeWorkflowsMoveParams = z.infer<typeof zcodeWorkflowsMoveParamsSchema>;
export const zcodeWorkflowsMoveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      /** The source landing path (the global root, before the move). */
      from: nonEmptyString,
      /** The destination landing path (the project root, where it landed). */
      to: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // target_exists: the target file already has the same name (move does not overwrite it); not_found: the source file does not have this name;
      // read_error / write_error: I/O failure during transfer; invalid_name: The name has not been passed a priori.
      reason: z.enum(["invalid_name", "not_found", "target_exists", "read_error", "write_error"]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type ZCodeWorkflowsMoveResult = z.infer<typeof zcodeWorkflowsMoveResultSchema>;

// Trusted plugin resolution for Prompt is recommended: the UI does not disassemble the stableId, nor does it infer installability from old directory snapshots.
export const zcodePluginSuggestedReferenceStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing",
  "conflict",
  "unavailable",
]);
export type ZCodePluginSuggestedReferenceStatus = z.infer<
  typeof zcodePluginSuggestedReferenceStatusSchema
>;
export const zcodePluginOperationStateSchema = z.enum([
  "checking",
  "refreshing",
  "installing",
  "enabling",
  "cancelling",
  "cancelled",
  "complete",
  "failed",
]);
export type ZCodePluginOperationState = z.infer<typeof zcodePluginOperationStateSchema>;
export const zcodePluginOperationProgressNotificationSchema = z
  .object({
    operationId: nonEmptyString,
    state: z.literal("refreshing"),
  })
  .strict();
export type ZCodePluginOperationProgressNotification = z.infer<
  typeof zcodePluginOperationProgressNotificationSchema
>;
export const zcodePluginsResolveSuggestedReferenceParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    stableId: nonEmptyString,
    operationId: nonEmptyString,
    clientMode: zcodeDeliveryKindSchema,
    deliveryKind: zcodeDeliveryKindSchema,
  })
  .strict();
export type ZCodePluginsResolveSuggestedReferenceParams = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceParamsSchema
>;
export const zcodePluginsSetEnabledParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    enabled: z.boolean(),
    operationId: nonEmptyString.optional(),
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export const zcodePluginsSetEnabledResultSchema = z
  .object({
    plugin: zcodePluginInfoSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodePluginsSetEnabledResult = z.infer<typeof zcodePluginsSetEnabledResultSchema>;

// Store Listing: Display metadata carried by directory entries (display name/icon/category/author/link/hero/
// Example prompt words), all are optional, and when the UI is missing, it will be processed according to the degradation matrix (letter avatar/hidden block/omitted information line).
// i18n uses the `<field>I18n` map, and locale parsing reuses the shared plugin-display-name helper.
export const zcodePluginStoreListingSchema = z
  .object({
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    privacyPolicy: z.string().optional(),
    termsOfService: z.string().optional(),
    heroImage: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    examplePromptsI18n: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * A plugin that is only usable with a paid plan: the marketplace catalog entry declares
     * `requiresPaidPlan: true`, and the UI shows a hint icon to the right of the title. It
     * describes a "condition of use", not "the plugin is a paid product" — it takes no part
     * in install gating or billing, and the name is not tied to any specific plan product.
     */
    requiresPaidPlan: z.boolean().optional(),
  })
  .strict();
export type ZCodePluginStoreListing = z.infer<typeof zcodePluginStoreListingSchema>;

export const zcodePluginsResolveSuggestedReferenceResultSchema = z
  .object({
    stableId: nonEmptyString,
    status: zcodePluginSuggestedReferenceStatusSchema,
    marketplace: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    sourceTrust: z.literal("official").optional(),
    // Optional display projection of official Marketplace listing; does not participate in identity, installation or permission determination.
    icon: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "ready" && value.status !== "disabled" && value.status !== "missing") {
      return;
    }
    if (!value.marketplace || !value.pluginName || value.sourceTrust !== "official") {
      context.addIssue({
        code: "custom",
        message: "actionable suggested Plugin results require trusted install identity",
      });
    }
  });
export type ZCodePluginsResolveSuggestedReferenceResult = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceResultSchema
>;

export const zcodePluginMarketplaceSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    source: jsonObjectSchema,
    description: z.string().optional(),
    lastUpdated: z.string().optional(),
    pluginCount: z.number().int().nonnegative(),
    isOfficial: z.boolean().optional(),
    // Featured curated list at the top of the directory (Featured section of the store's "Public" section).
    featured: z.array(z.string()).optional(),
    refreshFailure: z
      .object({
        code: z.string(),
        failedAt: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodePluginMarketplaceSummary = z.infer<typeof zcodePluginMarketplaceSummarySchema>;

export const zcodeAvailablePluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    installed: z.boolean(),
    componentTypes: z.array(z.string()).optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();
export type ZCodeAvailablePluginSummary = z.infer<typeof zcodeAvailablePluginSummarySchema>;

export const zcodeInstalledPluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    scope: zcodePluginScopeSchema,
    installPath: z.string().optional(),
    installedAt: z.string().optional(),
    componentTypes: z.array(z.string()).optional(),
    hookDetails: z.array(zcodePluginHookDetailSchema).optional(),
    updateStatus: z.enum(["none", "update-available", "version-changed"]).optional(),
    latestVersion: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();
export type ZCodeInstalledPluginSummary = z.infer<typeof zcodeInstalledPluginSummarySchema>;

export const zcodePluginsOverviewParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    configScope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export const zcodePluginsOverviewResultSchema = z
  .object({
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema),
    availablePlugins: z.array(zcodeAvailablePluginSummarySchema),
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    restorableBuiltins: z.array(zcodeAvailablePluginSummarySchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    capability: z
      .object({
        supported: z.boolean(),
        reason: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodePluginsOverviewResult = z.infer<typeof zcodePluginsOverviewResultSchema>;

export const zcodePluginsMarketplaceAddParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    source: nonEmptyString,
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsMarketplaceRemoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString,
  })
  .strict();
export const zcodePluginsMarketplaceUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString.optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsMarketplaceMutationResultSchema = z
  .object({
    marketplace: zcodePluginMarketplaceSummarySchema.optional(),
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema).optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
  })
  .strict();
export type ZCodePluginsMarketplaceMutationResult = z.infer<
  typeof zcodePluginsMarketplaceMutationResultSchema
>;

export const zcodePluginsInstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsCancelOperationParamsSchema = z
  .object({
    operationId: nonEmptyString,
  })
  .strict();
export type ZCodePluginsCancelOperationParams = z.infer<
  typeof zcodePluginsCancelOperationParamsSchema
>;

export const zcodePluginsCancelOperationResultSchema = z
  .object({
    operationId: nonEmptyString,
    cancelled: z.boolean(),
  })
  .strict();
export type ZCodePluginsCancelOperationResult = z.infer<
  typeof zcodePluginsCancelOperationResultSchema
>;
export const zcodePluginsUninstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    removeCache: z.boolean().optional(),
  })
  .strict();
export const zcodePluginsInstallResultSchema = z
  .object({
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    dependencyClosure: z.array(z.string()),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsInstallResult = z.infer<typeof zcodePluginsInstallResultSchema>;

export const zcodePluginsUninstallResultSchema = z
  .object({
    removedPlugin: zcodeInstalledPluginSummarySchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsUninstallResult = z.infer<typeof zcodePluginsUninstallResultSchema>;

export const zcodePluginsUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsRestoreBuiltinParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
  })
  .strict();
export const zcodePluginsRestoreBuiltinResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsRestoreBuiltinResult = z.infer<
  typeof zcodePluginsRestoreBuiltinResultSchema
>;

export const zcodePluginsConfigureParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    options: jsonObjectSchema,
    clearOptionKeys: z.array(nonEmptyString).optional(),
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export const zcodePluginsConfigureResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsConfigureResult = z.infer<typeof zcodePluginsConfigureResultSchema>;

export const zcodePluginsResetConfigParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export type ZCodePluginsResetConfigParams = z.infer<typeof zcodePluginsResetConfigParamsSchema>;

export const zcodePluginsValidateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    source: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsValidateResultSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    compatibility: z
      .object({
        runnable: z.array(z.string()),
        diagnosticOnly: z.array(z.string()),
        unsupported: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type ZCodePluginsValidateResult = z.infer<typeof zcodePluginsValidateResultSchema>;

// plugins/describe: Enumerate the component "name + description" of a single plugin on demand.
// The installed plug-in reads the local cache directory; the uninstalled candidate parses/temporarily clones the source on demand and then enumerates and cleans it.
export const zcodePluginsDescribeParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
  })
  .strict();
export const zcodePluginsDescribeResultSchema = z
  .object({
    components: z.array(zcodePluginComponentGroupSchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
    // The display fallback field of plugin.json in the plug-in package; the information area of ​​the uninstalled candidate details page provides a cover when the store listing is missing.
    metadata: z
      .object({
        author: z.string().optional(),
        authorUrl: z.string().optional(),
        homepage: z.string().optional(),
        version: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodePluginsDescribeResult = z.infer<typeof zcodePluginsDescribeResultSchema>;

export const zcodeAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** Used by yearly: 1-12, the human month numbers. When omitted, falls back to the month of anchorAt (compatible with older records that lack this field). */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
export type ZCodeAutomationScheduleRuleProtocol = z.infer<typeof zcodeAutomationScheduleRuleSchema>;

/** The unit enum of the session-side long-interval periodic carrier (the same set as scheduleRule.unit). */
export const zcodeAutomationIntervalUnitSchema = z.enum([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

export const zcodeAutomationProtocolSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: timestampMsSchema.optional(),
    lastRunAt: timestampMsSchema.optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    // Customize repetition rules; by default, scheduling falls back to parsing cronExpr. Conversation cards must read this field before they can be displayed.
    // cron cannot express real intervals (e.g. every 50 hours, every 40 days, compatible with cronExpr just 0 * * * *).
    scheduleRule: zcodeAutomationScheduleRuleSchema.optional(),
  })
  .strict();
export type ZCodeAutomationProtocol = z.infer<typeof zcodeAutomationProtocolSchema>;

export const zcodeAutomationCreateParamsSchema = z
  .object({
    title: z.string().optional(),
    cronExpr: nonEmptyString,
    relativeDelayMinutes: z.number().int().positive().max(525_600).optional(),
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().optional(),
    // Session-side custom repeat carrier: every N minutes/hours/days/weeks/months/years are normalized to the authoritative scheduleRule through this field,
    // cronExpr is for legal compliance display only.
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  // intervalUnit and interval must be submitted in pairs (passing only one cannot determine the real interval).
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // The periodic carrier conflicts with the one-time relative delay semantics and prohibits simultaneous interpretation.
  .refine((input) => input.intervalUnit === undefined || input.relativeDelayMinutes === undefined, {
    message: "intervalUnit cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
export type ZCodeAutomationCreateProtocolParams = z.infer<typeof zcodeAutomationCreateParamsSchema>;

export const zcodeAutomationCreateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();
export type ZCodeAutomationCreateProtocolResult = z.infer<typeof zcodeAutomationCreateResultSchema>;

export const zcodeAutomationUpdateParamsSchema = z
  .object({
    automationId: nonEmptyString,
    title: nonEmptyString.optional(),
    cronExpr: nonEmptyString.optional(),
    prompt: nonEmptyString.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    // Customize the repeat carrier on the session side (same semantics as create side).
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.cronExpr !== undefined ||
      input.prompt !== undefined ||
      input.recurring !== undefined ||
      input.maxRuns !== undefined ||
      input.intervalUnit !== undefined,
    { message: "automation update requires at least one field" },
  )
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "clearing maxRuns requires recurring=true",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit and interval must be submitted in pairs (same semantics as create).
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
export type ZCodeAutomationUpdateProtocolParams = z.infer<typeof zcodeAutomationUpdateParamsSchema>;
export const zcodeAutomationUpdateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();
export type ZCodeAutomationUpdateProtocolResult = z.infer<typeof zcodeAutomationUpdateResultSchema>;

export const zcodeAutomationListParamsSchema = z.object({}).strict();
export type ZCodeAutomationListProtocolParams = z.infer<typeof zcodeAutomationListParamsSchema>;
export const zcodeAutomationListResultSchema = z
  .object({ automations: z.array(zcodeAutomationProtocolSchema) })
  .strict();
export type ZCodeAutomationListProtocolResult = z.infer<typeof zcodeAutomationListResultSchema>;

export const zcodeAutomationCheckTaskBindingParamsSchema = z
  .object({ targetTaskId: nonEmptyString })
  .strict();
export type ZCodeAutomationCheckTaskBindingProtocolParams = z.infer<
  typeof zcodeAutomationCheckTaskBindingParamsSchema
>;
export const zcodeAutomationCheckTaskBindingResultSchema = z
  .object({ bound: z.boolean() })
  .strict();
export type ZCodeAutomationCheckTaskBindingProtocolResult = z.infer<
  typeof zcodeAutomationCheckTaskBindingResultSchema
>;

export const zcodeAutomationDeleteParamsSchema = z
  .object({ automationId: nonEmptyString })
  .strict();
export type ZCodeAutomationDeleteProtocolParams = z.infer<typeof zcodeAutomationDeleteParamsSchema>;
export const zcodeAutomationDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
export type ZCodeAutomationDeleteProtocolResult = z.infer<typeof zcodeAutomationDeleteResultSchema>;

// ----Off-Peak (idle time task) intra-session creation protocol----
// Parallel with automation brothers (independent domain, no reuse of tags/tables with each other). The workspace is slaved by the host
// Current session injection, no protocol parameters (symmetric automation/create). permissionMode only opens products
// Four-level vocabulary list; the default resolution is on the host side (yolo / allowed_models last position / highest inference file).
export const zcodeOffPeakPermissionModeSchema = z.enum(["build", "edit", "plan", "yolo"]);
export type ZCodeOffPeakProtocolPermissionMode = z.infer<typeof zcodeOffPeakPermissionModeSchema>;

export const zcodeOffPeakCreateParamsSchema = z
  .object({
    title: nonEmptyString,
    prompt: nonEmptyString,
    permissionMode: zcodeOffPeakPermissionModeSchema.optional(),
    model: nonEmptyString.optional(),
    thoughtLevel: nonEmptyString.optional(),
    // In-session creation binds the current session (aligned with the targetTaskId of automation/create), populated by the CLI port.
    boundSessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeOffPeakCreateProtocolParams = z.infer<typeof zcodeOffPeakCreateParamsSchema>;

// Snapshot of the protocol side task: the minimum field surface of the tail card and OffPeakList.
// Do not expose serverTicketId (cross-border no-go).
export const zcodeOffPeakTaskSnapshotSchema = z
  .object({
    offPeakTaskId: nonEmptyString,
    title: z.string(),
    status: z.enum(["queued", "paused", "running", "completed", "failed", "cancelled"]),
    queuePosition: z.number().int().positive().optional(),
    sessionId: nonEmptyString.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeOffPeakTaskProtocolSnapshot = z.infer<typeof zcodeOffPeakTaskSnapshotSchema>;

// Failure classification cross-protocol fidelity (mirror discriminant union of shared OffPeakTaskCreateResult, errors not downgraded to strings).
// If the model whitelist pre-calibration fails, the client_validation category + errorCode "model_not_allowed" will be reused, and the category enumeration will not be expanded.
export const zcodeOffPeakCreateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: zcodeOffPeakTaskSnapshotSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      failureStage: z.enum(["client_validation", "ticket_request", "local_persist"]),
      errorCategory: z.enum([
        "client_validation",
        "eligibility_3101",
        "quota_3103",
        "network",
        "invalid_response",
        "local_persist",
        "unknown",
      ]),
      errorCode: z.string(),
    })
    .strict(),
]);
export type ZCodeOffPeakCreateProtocolResult = z.infer<typeof zcodeOffPeakCreateResultSchema>;

export const zcodeOffPeakListParamsSchema = z.object({}).strict();
export type ZCodeOffPeakListProtocolParams = z.infer<typeof zcodeOffPeakListParamsSchema>;
export const zcodeOffPeakListResultSchema = z
  .object({ tasks: z.array(zcodeOffPeakTaskSnapshotSchema) })
  .strict();
export type ZCodeOffPeakListProtocolResult = z.infer<typeof zcodeOffPeakListResultSchema>;

export const zcodeProtocolMethods = {
  runtimeCapabilities: "runtime/capabilities",
  computerUseOperationEvent: "computer-use/operation-event",
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionSubagents: "session/subagents",
  sessionRequestRuntimePreferences: "session/requestRuntimePreferences",
  sessionRead: "session/read",
  sessionMessages: "session/messages",
  sessionEvents: "session/events",
  sessionDebug: "session/debug",
  sessionSubscribe: "session/subscribe",
  // @deprecated (partial): send main path has converged v4 sendText; only adapter attachment remains
  // Roll back branch consumption (v4 attachmentRef upload/deposit command plane is not modeled) and will be removed after the attachment command plane is implemented.
  sessionSend: "session/send",
  // @deprecated: The host client method has been deleted (stop has converged v4 stop command).
  // wire case remains compatible (the transport bypass list is still referenced) and will be removed when the old words are deleted as a whole.
  sessionStop: "session/stop",
  // @deprecated: The host client method has been deleted (the v4 cancelBackgroundWork command has been converged).
  // The wire case remains compatible and will be removed when the old words are deleted as a whole.
  sessionCancelBackgroundTask: "session/cancelBackgroundTask",
  // @deprecated: The host client method has been deleted (v4 forkAssistant native handler has
  // forkSessionAtMessage hook directly calls server-operations.forkSession op). wire case with
  // fork params/result schema retains = op survival surface; fork record returns to v4 native rewrite.
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionGoal: "session/goal",
  sessionClose: "session/close",
  // setModel is still consumed by the desktop old link of zcodeSessionService; replayable
  // switchModelConfig has Selection resolved directly by the target Environment Registry.
  sessionSetModel: "session/setModel",
  // The depth of thinking of replayable facade/mode has converged v4 switchModelConfig/
  // switchCollaborationMode; remaining consumption = zcodeSessionService (desktop old link, with
  // Desktop v4 UI closing is cleared) and the auto value of setMode remains (v4 value range deliberately excludes auto).
  sessionSetThoughtLevel: "session/setThoughtLevel",
  sessionSetMode: "session/setMode",
  workspaceReadPresentation: "workspace/readPresentation",
  workspaceHookTrustGrant: "workspace/hooks/trustGrant",
  // Process-level Account Provider Config is separated from the workspace running directory.
  providerUpdateAccountConfig: "provider/updateAccountConfig",
  workspaceUpdateInteractionPreferences: "workspace/updateInteractionPreferences",
  workspaceUpdateModelIoPreferences: "workspace/updateModelIoPreferences",
  // Off-Peak tool plane access is a workspace level fact (grayscale + local/remote) synchronized by the host when the agent is ready;
  // The CLI reads uniformly for legacy create/resume and v4 cold recovery. Old CLI method-not-found → host downgrade ignored.
  workspaceUpdateOffPeakToolPolicy: "workspace/updateOffPeakToolPolicy",
  // Dynamic workflow grayscale access control: the same as Off-Peak’s synchronization mode.
  workspaceUpdateDynamicWorkflowPolicy: "workspace/updateDynamicWorkflowPolicy",
  // LLM execution surface is in CLI, direct connection is not feasible; consumption is only within services
  // (commit message), which will be removed after the v4 workspace query/command surface is covered.
  workspaceGenerateText: "workspace/generateText",
  workspaceCancelGenerateText: "workspace/cancelGenerateText",
  providerTestModelConnectivity: "provider/testModelConnectivity",
  mcpList: "mcp/list",
  pluginsList: "plugins/list",
  pluginsReferenceCatalog: "plugins/referenceCatalog",
  pluginsReferenceCatalogWithCategory: "plugins/referenceCatalogWithCategory",
  skillsReferenceCatalog: "skills/referenceCatalog",
  // GUI hub for saved workflows: workspace level, no sessions.
  workflowsList: "workflows/list",
  workflowsGet: "workflows/get",
  workflowsUpdateMeta: "workflows/updateMeta",
  workflowsDelete: "workflows/delete",
  workflowsRuns: "workflows/runs",
  // Move files with the same name between project files/global files.
  workflowsMove: "workflows/move",
  pluginsResolveSuggestedReference: "plugins/resolveSuggestedReference",
  pluginsSetEnabled: "plugins/setEnabled",
  pluginsOverview: "plugins/overview",
  pluginsMarketplaceAdd: "plugins/marketplace/add",
  pluginsMarketplaceRemove: "plugins/marketplace/remove",
  pluginsMarketplaceUpdate: "plugins/marketplace/update",
  pluginsInstall: "plugins/install",
  pluginsCancelOperation: "plugins/cancelOperation",
  pluginsUninstall: "plugins/uninstall",
  pluginsUpdate: "plugins/update",
  pluginsRestoreBuiltin: "plugins/restoreBuiltin",
  pluginsConfigure: "plugins/configure",
  pluginsResetConfig: "plugins/resetConfig",
  pluginsValidate: "plugins/validate",
  pluginsDescribe: "plugins/describe",
  automationCreate: "automation/create",
  automationUpdate: "automation/update",
  automationCheckTaskBinding: "automation/checkTaskBinding",
  automationList: "automation/list",
  automationDelete: "automation/delete",
  // Off-Peak in-session creation: a separate family of methods alongside the automation brothers.
  offPeakCreate: "offPeak/create",
  offPeakList: "offPeak/list",
  // @deprecated: Host consumption has been cleared (zcodeAgentService is changed to v4/usage/stats).
  // Only the wire-compatible case of the CLI server remains; it will be removed when the old words are deleted as a whole.
  usageStats: "usage/stats",
  // ZCode Protocol only exposes session-first methods to agents; task is a UI projection concept and cannot be leaked into the protocol method name.
  // @deprecated: The host has been changed to v4/conversation/usage; it will be removed together with usage/stats later.
  sessionUsage: "session/usage",
  // Resource Manager: CLI reports its MCP subprocess pid and plug-in ownership (pure memory, no I/O), and sampling is completed on the Host side.
  processChildProcesses: "process/childProcesses",
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
  interactionRequestOfficialMcpAuthHeaders: "interaction/requestOfficialMcpAuthHeaders",
  // The browser-use reverse request is initiated by the agent, and the host is transferred to the CDP executor in main.
  interactionBrowserList: "interaction/browserList",
  interactionBrowserExecute: "interaction/browserExecute",
} as const;

export type ZCodeProtocolMethod = (typeof zcodeProtocolMethods)[keyof typeof zcodeProtocolMethods];

export const zcodeProtocolEmptyResultSchema = z.object({}).strict();

// The latest V4 main chain no longer relies on the old version of the full method table; only compatibility tests and browser brokers are retained here
// A minimal set of contracts for consumption to avoid reintroducing removed legacy methods.
export const zcodeProtocolSessionMethodContracts = {
  [zcodeProtocolMethods.workspaceHookTrustGrant]: {
    params: zcodeWorkspaceHookTrustGrantParamsSchema,
    result: zcodeWorkspaceHookTrustGrantResultSchema,
  },
  [zcodeProtocolMethods.mcpList]: {
    params: zcodeMcpListParamsSchema,
    result: zcodeMcpListResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserList]: {
    params: zcodeBrowserListParamsSchema,
    result: zcodeBrowserListResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserExecute]: {
    params: zcodeBrowserExecuteParamsSchema,
    result: zcodeBrowserExecuteResultSchema,
  },
} as const satisfies Partial<
  Record<ZCodeProtocolMethod, { params: z.ZodTypeAny; result: z.ZodTypeAny }>
>;

export type ZCodeProtocolSessionMethodContract =
  (typeof zcodeProtocolSessionMethodContracts)[keyof typeof zcodeProtocolSessionMethodContracts];

/** Private control frames for the storage-preparation subprocess only; raw paths never enter business events or telemetry. */
export const zcodeStoragePreparationFrameSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("startup/storagePath"),
      params: z.object({ path: z.string().min(1).max(32768) }).strict(),
    })
    .strict(),
  z
    .object({ method: z.literal("startup/storagePrepared"), params: z.object({}).strict() })
    .strict(),
  z
    .object({ method: z.literal("startup/storageState"), params: zcodeStorageStartupStateSchema })
    .strict(),
]);
export const zcodeStoragePathReadySchema = z
  .object({ method: z.literal("startup/storagePathReady"), reuse: z.boolean().optional() })
  .strict();
export * from "../localTtft.js";

// Strict de facto contract for desktop-native TTFT; checkpoints are not a substitute for actual content frames.
export { localTtftFactsSchema } from "../localTtft.js";
