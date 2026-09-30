import { localTtftFactsSchema } from "../localTtft.js";
/* eslint-disable max-lines -- the logical/physical/candidate schemas of the three topics must share one common transport declaration, to avoid forking them across files. */
// Transport shell: connection handshake/subscription/frame envelope.
// The stage is a type placeholder (enabled when the second half is connected to the channel layer), and the data shape has been finalized according to the specification.
import { z } from "zod";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";
import {
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  conversationRowTargetSchema,
  timestampSchema,
} from "./core.js";
import { conversationDeltaSchema } from "./delta.js";
import { conversationRowSchema, toolCallRowSchema } from "./rows.js";
import { sessionsIndexDeltaSchema, sessionsIndexSnapshotSchema } from "./sessions-index.js";
import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import { conversationSnapshotSchema } from "./snapshot.js";
import { workspaceConfigDeltaSchema, workspaceConfigSnapshotSchema } from "./workspace-config.js";
import { createTopicWireFrameSchema, topicWireFrameCandidateSchema } from "./wire.js";

// ── Connection and handshake ──
export const hostCapabilitiesSchema = z.object({
  nativeDialogs: z.boolean(),
  localTerminal: z.boolean(),
  // ws binary (for relay link detection).
  binaryFrames: z.boolean(),
  compression: z.enum(["none", "permessage-deflate"]),
  // Wire-compatible: The absence of the old Host is equivalent to false; the caller must use === true to determine.
  workspaceHookReview: z.boolean().optional(),
  independentPlanState: z.boolean().optional(),
  /**
   * This Host sends `workflowRun.*` key-level deltas (the two ops in delta.ts), so `workflowRuns`
   * actors / nodes can go up to 1024 instead of the legacy bound of 256. Consumers without that
   * bit still receive a whole-key `state.updated`, clamped to the legacy bound by
   * `clampWorkflowRunsForLegacy` first.
   */
  workflowRunDeltas: z.boolean().optional(),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const helloMessageSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    connectionId: z.string(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    deliveryProfile: z.enum(["continuous", "replayable"]),
    // First clock calibration.
    serverTime: timestampSchema,
    capabilities: hostCapabilitiesSchema,
    // Only seats are reserved here.
    auth: z.object({ userId: z.string().optional() }),
  })
  .strict()
  .superRefine((hello, context) => {
    const expectedProfile = hello.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    if (hello.deliveryProfile !== expectedProfile) {
      context.addIssue({
        code: "custom",
        message: "trusted clientMode and deliveryProfile must match",
        path: ["deliveryProfile"],
      });
    }
  });
export type HelloMessage = z.infer<typeof helloMessageSchema>;

// clientMode is registered once at the connection level and does not enter the command envelope.
export const clientHelloSchema = z
  .object({
    kind: z.literal("clientHello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    clientId: z.string(),
    clientKind: z.enum(["desktop", "web", "mobileRemote", "mobileApp"]).optional(),
    appVersion: z.string(),
    // Missing represents the old client, which does not have the Settings-centered review UI.
    capabilities: z
      .object({
        workspaceHookReviewUi: z.boolean().optional(),
        /**
         * This client understands `workflowRun.*` deltas. ⚠ The declaration rule is **one-way**: a
         * client may only carry this key when it saw `workflowRunDeltas === true` in the Host's
         * hello — this capabilities object is `.strict()`, and an old Host seeing an unknown key
         * fails to parse the whole clientHello, so the handshake never completes.
         */
        workflowRunDeltas: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ClientHello = z.infer<typeof clientHelloSchema>;

export function hostSupportsWorkspaceHookReview(capabilities: HostCapabilities): boolean {
  return capabilities.workspaceHookReview === true;
}

export function clientSupportsWorkspaceHookReview(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workspaceHookReviewUi === true;
}

export function hostSupportsWorkflowRunDeltas(capabilities: HostCapabilities): boolean {
  return capabilities.workflowRunDeltas === true;
}

export function clientSupportsWorkflowRunDeltas(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workflowRunDeltas === true;
}

// ── §3.1 Subscription ──
export const subscribeParamsSchema = z
  .object({
    // "conversation/<sessionId>" | "sessions-index/<workspaceId>" | ...
    topic: z.string(),
    // Water level invariant: only allowed if the client really holds a consistent state at that moment.
    base: z.object({ logEpoch: z.string(), seq: z.number() }).optional(),
    // QoS hint only affects scheduling and does not affect semantics.
    visibility: z.enum(["foreground", "background"]).optional(),
  })
  .strict();
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;

export const subscribeAckSchema = z.object({
  subscriptionId: z.string(),
  // resume = base is valid, resume incremental transmission from base.seq; otherwise snapshot.
  mode: z.enum(["snapshot", "resume"]),
  logEpoch: z.string(),
});
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;

const openTimingMsSchema = z.number().int().nonnegative().optional();
const openTimingCountSchema = z.number().int().nonnegative().optional();

/**
 * Low-frequency diagnostic timing for a Desktop session's first open; attached only to the
 * conversation subscribe ACK, and never entering the snapshot, delta, sessions-index or
 * workspace-config.
 */
export const conversationOpenTimingSchema = z
  .object({
    version: z.literal(1),
    hostPrepareMs: openTimingMsSchema,
    providerRegistrySyncMs: openTimingMsSchema,
    taskMetaReadMs: openTimingMsSchema,
    cliRequestMs: openTimingMsSchema,
    cliBootstrapMs: openTimingMsSchema,
    cliSessionRestoreMs: openTimingMsSchema,
    initialFrameEncodeMs: openTimingMsSchema,
    cliProcessState: z.enum(["spawned", "reused"]).optional(),
    sessionRuntimeState: z.enum(["cold", "warm"]).optional(),
    snapshotRowCount: openTimingCountSchema,
  })
  .strict();
export type ConversationOpenTiming = z.infer<typeof conversationOpenTimingSchema>;

const conversationSubscribeAckSchema = subscribeAckSchema.extend({
  openTiming: conversationOpenTimingSchema.optional(),
});
export type ConversationSubscribeAck = z.infer<typeof conversationSubscribeAckSchema>;

// ── Frame envelope (generic frames use factories to construct schema of specific topics)──
export function createTopicFrameSchema<S extends z.ZodTypeAny, D extends z.ZodTypeAny>(
  snapshotSchema: S,
  deltaSchema: D,
) {
  return z.object({
    topic: z.string(),
    // Intergenerational identification to prevent the intersection of old and current.
    subscriptionId: z.string(),
    // Interval accounting (fromSeq, toSeq]; snapshot frame fromSeq is fixed to 0.
    fromSeq: z.number(),
    toSeq: z.number(),
    // CLI clock for clockOffset estimation.
    sentAt: timestampSchema,
    payload: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("snapshot"), snapshot: snapshotSchema }),
      z.object({ kind: z.literal("deltas"), deltas: z.array(deltaSchema) }),
    ]),
  });
}

export interface TopicFrame<S, D> {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: Timestamp;
  payload: { kind: "snapshot"; snapshot: S } | { kind: "deltas"; deltas: D[] };
}
type Timestamp = z.infer<typeof timestampSchema>;

// Concrete frame schema (five-piece instantiation) of the conversation topic.
// The transmission shell/gold test uses it for frame validity verification; the host channel layer is reused.
export const conversationTopicFrameSchema = createTopicFrameSchema(
  conversationSnapshotSchema,
  conversationDeltaSchema,
)
  .extend({
    ttft: localTtftFactsSchema.optional(),
    ttftRelated: z.array(localTtftFactsSchema).max(16).optional(),
  })
  .superRefine((frame, context) => {
    if (!frame.topic.startsWith("conversation/") || frame.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  });
export type ConversationTopicFrame = z.infer<typeof conversationTopicFrameSchema>;
export const conversationTopicWireFrameSchema = createTopicWireFrameSchema(
  conversationTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
    context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
  }
});
export type ConversationTopicWireFrame = z.infer<typeof conversationTopicWireFrameSchema>;
export const conversationTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  },
);
export type ConversationTopicWireCandidate = z.infer<typeof conversationTopicWireCandidateSchema>;

// Concrete frame schema for the sessions-index topic (five-piece instantiation; sidebar list active data source).
export const sessionsIndexTopicFrameSchema = createTopicFrameSchema(
  sessionsIndexSnapshotSchema,
  sessionsIndexDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("sessions-index/") ||
    frame.topic.length === "sessions-index/".length
  ) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicFrame = z.infer<typeof sessionsIndexTopicFrameSchema>;
export const sessionsIndexTopicWireFrameSchema = createTopicWireFrameSchema(
  sessionsIndexTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("sessions-index/") || wire.topic.length === "sessions-index/".length) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicWireFrame = z.infer<typeof sessionsIndexTopicWireFrameSchema>;
export const sessionsIndexTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("sessions-index/") ||
      wire.topic.length === "sessions-index/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid sessions-index topic",
        path: ["topic"],
      });
    }
  },
);
export type SessionsIndexTopicWireCandidate = z.infer<typeof sessionsIndexTopicWireCandidateSchema>;

// The specific frame schema of the workspace-config topic (additive change; configuration directory active data source).
export const workspaceConfigTopicFrameSchema = createTopicFrameSchema(
  workspaceConfigSnapshotSchema,
  workspaceConfigDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("workspace-config/") ||
    frame.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicFrame = z.infer<typeof workspaceConfigTopicFrameSchema>;
export const workspaceConfigTopicWireFrameSchema = createTopicWireFrameSchema(
  workspaceConfigTopicFrameSchema,
).superRefine((wire, context) => {
  if (
    !wire.topic.startsWith("workspace-config/") ||
    wire.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicWireFrame = z.infer<typeof workspaceConfigTopicWireFrameSchema>;
export const workspaceConfigTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("workspace-config/") ||
      wire.topic.length === "workspace-config/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid workspace-config topic",
        path: ["topic"],
      });
    }
  },
);
export type WorkspaceConfigTopicWireCandidate = z.infer<
  typeof workspaceConfigTopicWireCandidateSchema
>;

/** The common logical / physical routing surface of the three production topics. */
export const routedTopicFrameSchema = z.union([
  conversationTopicFrameSchema,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopicFrameSchema,
]);
export type RoutedTopicFrame = z.infer<typeof routedTopicFrameSchema>;
export const routedTopicWireFrameSchema = z.union([
  conversationTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
]);
export type RoutedTopicWireFrame = z.infer<typeof routedTopicWireFrameSchema>;
export const routedTopicWireCandidateSchema = z.union([
  conversationTopicWireCandidateSchema,
  sessionsIndexTopicWireCandidateSchema,
  workspaceConfigTopicWireCandidateSchema,
]);
export type RoutedTopicWireCandidate = z.infer<typeof routedTopicWireCandidateSchema>;

// ── v4 RPC entrance and exit (host channel layer)──
// The carrier reuses the existing JSON-RPC (stdio NDJSON/socket), and the method name has the v4/ prefix to coexist with the old protocol;
// Old session/* After the method is deleted, this is the only protocol surface.
export const V4_METHODS = {
  connectionFlow: "v4/connection/flow",
  controllerSubscribe: "v4/controller/subscribe",
  controllerResync: "v4/controller/resync",
  controllerUnsubscribe: "v4/controller/unsubscribe",
  conversationSubscribe: "v4/conversation/subscribe",
  conversationResync: "v4/conversation/resync",
  conversationUnsubscribe: "v4/conversation/unsubscribe",
  // Row paging query (rows/range): read-only, stateless, timeout retransmission safe.
  conversationRowsRange: "v4/conversation/rowsRange",
  // The final state of the current effective branch ExitPlanMode directory; read-only, stateless, timeout and retransmission safe.
  conversationPlans: "v4/conversation/plans",
  conversationFileChanges: "v4/conversation/fileChanges",
  backgroundBashOutput: "v4/conversation/backgroundBashOutput",
  conversationFileRewindPreview: "v4/conversation/fileRewindPreview",
  // Event log pagination of workflow run (details page audit page): read-only, stateless, timeout and retransmission safe.
  // The new method is naturally biased towards safety - the old desktop wouldn't call it at all.
  conversationWorkflowRunEvents: "v4/conversation/workflowRunEvents",
  conversationWorkflowRuns: "v4/conversation/workflowRuns",
  // User interface product of workflow run. Three members of the same race:
  // Read-only, stateless, timeout safe; schema in workflow-artifacts.ts (there is also terminology disambiguation there).
  //   Artifacts product list (durable pronunciation of cold recovery and hub details)
  //   ArtifactData preset kanban entry paging (cursor = journal sequence)
  //   ArtifactRead The bytes of the content product, ≤ 512 KiB in one piece, the shape is verbatim as attachmentRead
  conversationWorkflowRunArtifacts: "v4/conversation/workflowRunArtifacts",
  conversationWorkflowRunArtifactData: "v4/conversation/workflowRunArtifactData",
  conversationWorkflowRunArtifactRead: "v4/conversation/workflowRunArtifactRead",
  // Workspace transcript for workflow run. Two members of the same race,
  // According to the ①/③ disassembly method of the product: Workspace is a light line list (without text), and NodeResult is the bounded text of a node.
  conversationWorkflowRunWorkspace: "v4/conversation/workflowRunWorkspace",
  conversationWorkflowRunNodeResult: "v4/conversation/workflowRunNodeResult",
  // usage query (mode is the same as rows/range: read-only, stateless, timeout retransmission safe).
  // The usage fact source is in the CLI's session library (model_usage/turn_usage aggregation), and there is no copy on the host side.
  // Therefore, it converges to v4 query instead of host direct connection; the old words usage/stats and session/usage are cleared for consumption.
  usageStats: "v4/usage/stats",
  conversationUsage: "v4/conversation/usage",
  // Attachment Transactions: Disable full-data RPCs. decoded bytes of each chunk <=512KiB,
  // Both renderer->host Channel and host->CLI NDJSON must prove <=1MiB per request.
  attachmentBegin: "v4/attachment/begin",
  attachmentChunk: "v4/attachment/chunk",
  attachmentCommit: "v4/attachment/commit",
  attachmentAbort: "v4/attachment/abort",
  // Sent image preview: read-only, authorized by session row, response still chunked by 512KiB.
  attachmentRead: "v4/attachment/read",
  // Share reads userInput attachments: non-media types such as text/plain are allowed, and are still authorized by row/index and returned in chunks.
  conversationAttachmentRead: "v4/conversation/attachmentRead",
  // Share pre-checks userInput attachment metadata: only performs row/index authorization and stat, and does not read the complete file.
  conversationAttachmentStat: "v4/conversation/attachmentStat",
  // Desktop local sent video: Only local playback sources authorized by the same row/index are returned.
  attachmentPreviewSource: "v4/attachment/previewSource",
  commandsQuery: "v4/commands/query",
  command: "v4/command",
} as const;
export type V4Method = (typeof V4_METHODS)[keyof typeof V4_METHODS];

/** Bounded output query by tasking, does not accept arbitrary paths or caller-expanded read budgets. */
export const v4BackgroundBashOutputParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
  workId: z.string().min(1),
});
export type V4BackgroundBashOutputParams = z.infer<typeof v4BackgroundBashOutputParamsSchema>;

export const v4ConnectionFlowStateSchema = z.enum(["saturated", "drained", "closed"]);
export type V4ConnectionFlowState = z.infer<typeof v4ConnectionFlowStateSchema>;

export const v4ConnectionFlowParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    state: v4ConnectionFlowStateSchema,
  })
  .strict();
export type V4ConnectionFlowParams = z.infer<typeof v4ConnectionFlowParamsSchema>;

export const v4ConnectionFlowResultSchema = z.object({}).strict();

export const V4_NOTIFICATIONS = {
  // Downstream frame (snapshot/deltas), params = ConversationTopicFrame.
  conversationFrame: "v4/conversation/frame",
  // Textless fact for live ingest only; does not enter topic snapshot/recovery.
  conversationTelemetryFact: "v4/telemetry/event",
  localTtftFacts: "v4/telemetry/local-ttft",
  // Only the current process live ToolCallResult is generated; historical and replayable links cannot be remade.
  cuaPermissionObservation: "v4/cua/permission-observation",
} as const;

/** §3.3.6 SSH historical-task ownership proof and the sessions-index cold seed share the same bounded window. */
export const MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE = 200;

// subscribe request = generic SubscribeParams + connectionId (Resubscribe replace button
// (connectionId, topic) determination; stdio single-pipeline scenario is allocated by host for each downstream client).
export const v4ConversationSubscribeParamsSchema = subscribeParamsSchema.extend({
  connectionId: z.string(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  // The workspace of the current trusted attachment; cold resume uses it first to restore the identity, and live does not consume it.
  workspace: zcodeWorkspaceRefSchema.optional(),
  /** The allowlist of legacy task ownership that the host reads precisely from the current remote workspace's tasks-index. */
  legacyTaskIds: z.array(z.string().min(1)).max(MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE).optional(),
  // Only used by host→CLI cold resume; live conversation does not consume this hint.
  resumeThoughtLevel: z.string().trim().min(1).optional(),
  /**
   * Whether this subscription receives `workflowRun.*` key-level deltas. It is of the same family
   * as `clientMode`: injected from the clientHello of that connection by a **trusted host**, and a
   * UI-facing subscribe cannot choose it — whether a client can understand deltas is a fact about
   * the connection, not a taste a single subscription gets to pick. Absent = treat as a legacy
   * consumer (whole-key patch + legacy bound clamp).
   */
  workflowRunDeltas: z.boolean().optional(),
});
export type V4ConversationSubscribeParams = z.infer<typeof v4ConversationSubscribeParamsSchema>;

// Public subscribe response strictly contains only ACK. initial snapshot/resume by server
// The request-scoped post-response outbox is emitted as an owned notification after the response line.
export const v4ConversationSubscribeResultSchema = z
  .object({
    ack: conversationSubscribeAckSchema,
  })
  .strict();
export type V4ConversationSubscribeResult = z.infer<typeof v4ConversationSubscribeResultSchema>;

// sessions-index and conversation share the same subscribe RPC; the public response is also ACK-only.
export const v4SessionsIndexSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4SessionsIndexSubscribeResult = z.infer<typeof v4SessionsIndexSubscribeResultSchema>;

// workspace-config also only returns ACK; initial frame follows the same post-response notification sequence.
export const v4WorkspaceConfigSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4WorkspaceConfigSubscribeResult = z.infer<
  typeof v4WorkspaceConfigSubscribeResultSchema
>;

// Same-sub recovery of active subscriptions. topic/connection/profile must be owned by the host registry
// After reverse checking, the client can only declare its confirmed water level and whether to force a snapshot.
export const conversationResyncParamsSchema = z
  .object({
    subscriptionId: z.string().trim().min(1).max(1024),
    base: z
      .object({
        logEpoch: z.string().trim().min(1).max(1024),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    forceSnapshot: z.boolean().optional(),
  })
  .strict();
export type ConversationResyncParams = z.infer<typeof conversationResyncParamsSchema>;

// CLI-facing shape: topic/connectionId can only be injected by the connection facade from the owned registry.
export const v4ConversationResyncParamsSchema = conversationResyncParamsSchema
  .extend({
    topic: z.string().trim().min(1).max(2048),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationResyncParams = z.infer<typeof v4ConversationResyncParamsSchema>;

export const v4ConversationResyncResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4ConversationResyncResult = z.infer<typeof v4ConversationResyncResultSchema>;

export const v4ConversationUnsubscribeParamsSchema = z
  .object({
    topic: z.string().trim().min(1).max(2048),
    subscriptionId: z.string().trim().min(1).max(1024),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationUnsubscribeParams = z.infer<typeof v4ConversationUnsubscribeParamsSchema>;

// ── rows/range (cursor row paging, loadOlder)──
// No index semantics: total order = rowId ascending; client keyed merge by rowId.
export const v4ConversationRowsRangeParamsSchema = z.object({
  sessionId: z.string(),
  /** Host attachment injects this trusted value; renderer callers omit it. */
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  // Get rows with rowId < beforeRowId; default = forward from the current end.
  beforeRowId: z.number().optional(),
  limit: z.number().min(1).max(PROTOCOL_V4_LIMITS.rowsRangeMaxLimit),
});
export type V4ConversationRowsRangeParams = z.infer<typeof v4ConversationRowsRangeParamsSchema>;

export const v4ConversationRowsRangeResultSchema = z.object({
  // rowId ascending order.
  rows: z.array(conversationRowSchema),
  // The water level/epoch when the server obtains the value; shared with read-only queries such as fileChanges to avoid splicing and publishing data across revisions.
  atSeq: z.number(),
  atRevision: z.number().int().nonnegative(),
  atLogEpoch: z.string(),
  // beforeRowId direction whether there are earlier rows.
  hasMore: z.boolean(),
});
export type V4ConversationRowsRangeResult = z.infer<typeof v4ConversationRowsRangeResultSchema>;

// ── conversation plans directory ──
// The directory comes from the CLI's complete valid projection, which cannot be derived using the renderer's bounded tail window.
export const v4ConversationPlansParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansParams = z.infer<typeof v4ConversationPlansParamsSchema>;

export const v4ConversationPlansResultSchema = z
  .object({
    // The final state of the current valid branch ExitPlanMode, rowId descending order (latest first).
    plans: z.array(toolCallRowSchema),
    atSeq: z.number().int().nonnegative(),
    atLogEpoch: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansResult = z.infer<typeof v4ConversationPlansResultSchema>;

const readonlyDiffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileChangesParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileChangesParams = z.infer<typeof v4ConversationFileChangesParamsSchema>;

export const v4ConversationFileChangesResultSchema = z
  .object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    state: z.enum(["active", "reverted"]).optional(),
    items: z.array(
      z
        .object({
          path: z.string().min(1),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          writeCount: z.number().int().nonnegative(),
          toolNames: z.array(z.string()),
          patches: z.array(readonlyDiffHunkSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type V4ConversationFileChangesResult = z.infer<typeof v4ConversationFileChangesResultSchema>;

// ── workflow run event log──
// The form is in the same family as rows/range and plans: read-only, stateless, timeout and retransmission safe. cursor = journal sequence
// (`appendEvent` monotonic allocation), refetched when workflowRuns[].lastEventSequence is raised.
// Deliberately **not** v4 command: the ACK result of command is the closed "change result" of commandResultSchema
// Discriminant union, inserting a page of read-only events is equivalent to putting reading into the vocabulary of writing, and you have to memorize the baseRevision/idempotent mechanism in vain.
export const v4ConversationWorkflowRunEventsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    /** Takes only events whose sequence is strictly greater than this value; defaults to from the beginning. */
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunEventsParams = z.infer<
  typeof v4ConversationWorkflowRunEventsParamsSchema
>;

export const v4ConversationWorkflowRunEventsResultSchema = z
  .object({
    events: z.array(
      z
        .object({
          sequence: z.number().int().nonnegative(),
          type: z.string().min(1).max(64),
          // The payload is bounded on the CLI side via boundDynamicWorkflowRunEventPayload (same serialization
          // Also fed to workflowRuns projection). The event shape of the engine is not repeated here: the reader explains it by type.
          payload: z.record(z.string(), z.unknown()),
          truncated: z.boolean().optional(),
        })
        .strict(),
    ),
    /** This page filled the limit and more events still follow. */
    hasMore: z.boolean(),
  })
  .strict();
// **Intentionally does not include `atSeq` / `atLogEpoch`**, although rows/range and plans of the same family do.
//
// Those two fields are **stale read protected** in the same family: they read conversation projection, and projection's
// `rowId` is only meaningful within a log epoch (rebuilding / fork / rewind will renumber), so the contract on the read side is
// "atLogEpoch ≠ store current epoch → discard the entire result."
//
// This query reads **journal** (`dwf_event`), which has nothing to do with the conversation log, and the cursor never expires:
// journal's JournalStorePort contract requires that sequence only append,
// Cross-resume continues from the existing maximum value, neither resetting nor reusing, and the number of the existing entry remains unchanged. That is to say a
// `(runId, sequence)` cursor is always valid - there is no "staleness" to guard against.
//
// More importantly: bringing `atLogEpoch` is not a harmless symmetry. According to the read-end contract of the same family, a completely unrelated run
// Session rewind (epoch change) will cause the details page to discard the entire **valid** journal page. I would rather have one less field,
// Also don't carry a field that doesn't have the correct semantics defined here.
export type V4ConversationWorkflowRunEventsResult = z.infer<
  typeof v4ConversationWorkflowRunEventsResultSchema
>;

// ── dwf run enumeration ──
// After restarting journal-backed, it was found that the `workflowRuns` projection is memory-only (cold merge classification),
// Empty after restart - The availability of the toolcard join and Resume buttons can only be restored from the dwf_run line. with
// The same family as workflowRunEvents (read-only, stateless, timeout retransmission safe), also deliberately not v4 command,
// Also without atSeq/atLogEpoch (read journal, has nothing to do with conversation log, see the argument of the previous query).
// The new method is naturally biased safe: old desktops will never call it.
export const v4ConversationWorkflowRunsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    /** Upper bound on the number of returned entries; the default and the clamping live on the CLI side (the enumeration surface is bounded, it never scans the store unboundedly). */
    limit: z.number().int().positive().max(64).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunsParams = z.infer<
  typeof v4ConversationWorkflowRunsParamsSchema
>;

export const v4ConversationWorkflowRunSummarySchema = z
  .object({
    runId: z.string().min(1),
    /** Tool-call id of the CreateWorkflow that started the run (the tool card → detail page/Resume association key); absent for old runs. */
    toolCallId: z.string().min(1).optional(),
    /**
     * The display label, derived on the server at read time (`name` → the script's first line →
     * runId). Being optional is skew-safety: an old CLI does not send this key, so the read side
     * falls back to runId — a missing label is a degradation, not an error.
     * The bound is aligned with the 80 characters on the deriving side and then doubled for
     * headroom (a user-supplied `name` is not subject to the deriving side's bound).
     */
    label: z.string().min(1).max(160).optional(),
    /** Last update time (epoch milliseconds, the journal's `dwf_run.time_updated`). Absent means no time is displayed. */
    updatedAt: z.number().int().nonnegative().optional(),
    // Projects the same five-value vocabulary as workflowRuns;
    // This query uses an independent schema, and adding query status does not change the status key on the projection side.
    status: z.enum(["completed", "errored", "pending", "running", "stopped"]),
    /** Present only when `status === "stopped"`. The vocabulary is shared with the observation surface — it used to be copied separately in each place, so when the engine added
     * `superseded` this strict schema rejected the whole page of the run catalog (on the desktop
     * showing up as "failed to read the run summary", with the task list count and the catalog page
     * both blank). */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    // lineage: revised run with precursor,
    // Replaced run with successor (only with `stopReason: "superseded"`). Both optional: the old CLI is not released.
    resumedFrom: z.string().min(1).optional(),
    supersededBy: z.string().min(1).optional(),
    /** The structured failure code for errored / stopped(provider|interrupted) (`ProviderStop` / `Interrupted` …). */
    failureCode: z.string().min(1).max(64).optional(),
    failureMessage: z.string().max(2048).optional(),
    /** Whether it is resumable. The CLI computes it with the same predicate as the resume gate — the UI never derives it itself (two predicates would drift apart). */
    resumable: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunSummary = z.infer<
  typeof v4ConversationWorkflowRunSummarySchema
>;

export const v4ConversationWorkflowRunsResultSchema = z
  .object({
    /** Most recently updated first (the sorting happens in the storage layer). */
    runs: z.array(v4ConversationWorkflowRunSummarySchema),
  })
  .strict();
export type V4ConversationWorkflowRunsResult = z.infer<
  typeof v4ConversationWorkflowRunsResultSchema
>;

export const v4ConversationFileRewindPreviewParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileRewindPreviewParams = z.infer<
  typeof v4ConversationFileRewindPreviewParamsSchema
>;

const v4WorkspaceFileRewindSafeFileSchema = z
  .object({
    action: z.enum(["restore", "delete"]),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindUnsafeFileSchema = z
  .object({
    currentHash: z.string().optional(),
    expectedHash: z.string().optional(),
    message: z.string().optional(),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.enum([
      "checkpoint_missing",
      "checkpoint_unreadable",
      "external_modified",
      "file_read_failed",
      "unsupported_checkpoint",
    ]),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindIgnoredFileSchema = z
  .object({
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.literal("bash_ignored"),
    toolNames: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileRewindPreviewResultSchema = z
  .object({
    canApply: z.boolean(),
    ignoredFiles: z.array(v4WorkspaceFileRewindIgnoredFileSchema),
    safeFiles: z.array(v4WorkspaceFileRewindSafeFileSchema),
    unsafeFiles: z.array(v4WorkspaceFileRewindUnsafeFileSchema),
  })
  .strict();
export type V4ConversationFileRewindPreviewResult = z.infer<
  typeof v4ConversationFileRewindPreviewResultSchema
>;

// ── usage query──
// App-level usage aggregation: range/timeZone joins the old usage/stats isomorphism (consumer semantics remain unchanged),
// Result = AppUsageSnapshot (shape belongs to the neutral module usage-stats.ts, not coupled to the old vocabulary file).
export const v4UsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export type V4UsageStatsParams = z.infer<typeof v4UsageStatsParamsSchema>;
export const v4UsageStatsResultSchema = appUsageSnapshotSchema;
export type V4UsageStatsResult = z.infer<typeof v4UsageStatsResultSchema>;

// Session-level token usage (v4 namespace implementation of old session/usage: session is a protocol-first-class concept,
// task is a UI projection concept that does not enter the protocol vocabulary). The field has the same shape as the old result, and the old schema dies along with the word.
export const v4ConversationUsageParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationUsageParams = z.infer<typeof v4ConversationUsageParamsSchema>;
export const v4ConversationUsageResultSchema = z
  .object({
    sessionId: z.string().min(1),
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
export type V4ConversationUsageResult = z.infer<typeof v4ConversationUsageResultSchema>;

// ── Attachment uplink transaction ──
// The high-level UI still uses put(input)->ref; this full-data schema only describes the internal calls of the renderer and does not serve any purpose.
// production RPC method. wire can only use begin/chunk/commit/abort.
export const v4AttachmentPutParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    fileName: z.string().min(1),
    mime: z.string().min(1),
    // base64 (without data: prefix); number of bytes after decoding ≤ PROTOCOL_V4_LIMITS.attachmentMaxBytes.
    dataBase64: z.string().min(1),
  })
  .strict();
export type V4AttachmentPutParams = z.infer<typeof v4AttachmentPutParamsSchema>;
export const v4AttachmentPutResultSchema = z.object({
  ref: z.string().min(1),
});
export type V4AttachmentPutResult = z.infer<typeof v4AttachmentPutResultSchema>;

const v4AttachmentUploadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const v4AttachmentChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const v4AttachmentBeginParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\0\r\n]+$/),
    mime: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/),
    totalBytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks),
    checksum: v4AttachmentChecksumSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.totalBytes === 0) !== (value.totalChunks === 0)) {
      context.addIssue({
        code: "custom",
        message: "zero-byte upload must declare zero chunks",
        path: ["totalChunks"],
      });
    }
  });
export type V4AttachmentBeginParams = z.infer<typeof v4AttachmentBeginParamsSchema>;

export const v4AttachmentBeginResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("staging"),
      nextChunkIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("committed"),
      nextChunkIndex: z.number().int().nonnegative(),
      ref: z.string().min(1),
    })
    .strict(),
]);
export type V4AttachmentBeginResult = z.infer<typeof v4AttachmentBeginResultSchema>;

function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return null;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  return (value.length / 4) * 3 - padding;
}

export const v4AttachmentChunkParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    dataBase64: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
  });
export type V4AttachmentChunkParams = z.infer<typeof v4AttachmentChunkParamsSchema>;

export const v4AttachmentChunkResultSchema = z
  .object({
    uploadId: v4AttachmentUploadIdSchema,
    nextChunkIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4AttachmentChunkResult = z.infer<typeof v4AttachmentChunkResultSchema>;

const v4AttachmentTerminalParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
  })
  .strict();
export const v4AttachmentCommitParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentCommitParams = z.infer<typeof v4AttachmentCommitParamsSchema>;
export const v4AttachmentCommitResultSchema = v4AttachmentPutResultSchema.strict();
export type V4AttachmentCommitResult = z.infer<typeof v4AttachmentCommitResultSchema>;
export const v4AttachmentAbortParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentAbortParams = z.infer<typeof v4AttachmentAbortParamsSchema>;
export const v4AttachmentAbortResultSchema = z.object({}).strict();

/** The already-sent image/video/PDF preview query; the ref must be re-authorized by the CLI against the current session projection. */
export const v4AttachmentReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    // The new renderer uses stable row identity + attachment serial number to eliminate cross-wheel ambiguity on the same path; the two must appear in pairs.
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentReadParams = z.infer<typeof v4AttachmentReadParamsSchema>;

/** The Desktop local already-sent video source query; remote and Web must return chunked. PDF always goes chunked. */
export const v4AttachmentPreviewSourceParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentPreviewSourceParams = z.infer<typeof v4AttachmentPreviewSourceParamsSchema>;

export const v4AttachmentPreviewSourceResultSchema = z.union([
  z
    .object({
      kind: z.literal("local_path"),
      path: z.string().min(1),
      mediaType: z.string().refine((value) => value.startsWith("video/"), {
        message: "local attachment preview only supports video media types",
      }),
    })
    .strict(),
  z.object({ kind: z.literal("chunked") }).strict(),
]);
export type V4AttachmentPreviewSourceResult = z.infer<typeof v4AttachmentPreviewSourceResultSchema>;

export const v4AttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z
      .string()
      .refine(
        (value) =>
          value.startsWith("image/") ||
          value.startsWith("video/") ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf",
        "attachment preview only supports image/video/pdf media types",
      ),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.mediaType.startsWith("image/") &&
      value.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        origin: "number",
        inclusive: true,
        message: "image preview exceeds total byte limit",
        path: ["totalBytes"],
      });
    }
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4AttachmentReadResult = z.infer<typeof v4AttachmentReadResultSchema>;

/** Share reading a user-input attachment; any authorized MIME is allowed and the semantics of the media-preview read are unchanged. */
export const v4ConversationAttachmentReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationAttachmentReadParams = z.infer<
  typeof v4ConversationAttachmentReadParamsSchema
>;

export const v4ConversationAttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z.string().min(1),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationAttachmentReadResult = z.infer<
  typeof v4ConversationAttachmentReadResultSchema
>;

/** The metadata-only attachment check of the Share selection stage. */
export const v4ConversationAttachmentStatParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationAttachmentStatParams = z.infer<
  typeof v4ConversationAttachmentStatParamsSchema
>;

export const v4ConversationAttachmentStatResultSchema = z
  .object({
    mediaType: z.string().min(1),
    // stat is a metadata-only detection and must be able to express the true size that exceeds the transmission upper limit, otherwise
    // "Known size exceeded" cannot be rendered as a blocking item during the selection phase (see attachmentStatMaxBytes annotation).
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentStatMaxBytes),
    mtimeMs: z.number().finite().optional(),
  })
  .strict();
export type V4ConversationAttachmentStatResult = z.infer<
  typeof v4ConversationAttachmentStatResultSchema
>;

/** Builds a conversation topic key (dual to parseConversationTopic). */
export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

/** Parses a conversation topic key ("conversation/<sessionId>"). */
export function parseConversationTopic(topic: string): string | null {
  if (!topic.startsWith("conversation/")) return null;
  const sessionId = topic.slice("conversation/".length);
  return sessionId.length > 0 ? sessionId : null;
}
