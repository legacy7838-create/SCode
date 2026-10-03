import { LocalTtftRecorder } from "./local-ttft.js";
import { localTtftNow, localTtftFactsSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  type BackgroundBashOutputResult,
} from "@zcode/shared/zcode-protocol-v4";
// V4 conversation gateway (host channel layer CLI side).
// Responsibilities: per-session ConversationTopicPublisher registry + flushWindowMs scheduled scheduling
// + v4/command → CommandInbox → The inbox of the host executor.
//
// Layered Discipline:
// - This class does not do network IO: the physical frame is handed over to the host via host.emitWireFrame (stdio notification/test collector).
// - Command side effects are not implemented in this class: after the inbox ruling is passed, the host operation is called via host.executeCommand
//   Unimplemented commands are returned via structured errors.
// - The flush timer is the only time source, and the publisher itself remains pure pushing (boundaries unchanged).
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunSessionSummary,
  MessageWithParts,
  SessionEvent,
  TargetChangedPayload,
  TurnId,
  FileSystemErrorCode,
} from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType, isFileSystemPortError } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import type {
  CommandAck,
  AttachmentRef,
  CommandEnvelope,
  CommandKey,
  CommandResult,
  ConversationRowTarget,
  CommandsQueryResult,
  ConversationInputIntent,
  ConversationTopicFrame,
  QueueItem,
  RoutedTopicFrame,
  RoutedTopicWireFrame,
  SessionSummary,
  SessionsIndexTopicFrame,
  SubscribeAck,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationOpenTiming,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  readZCodeAttachmentFaultCode,
  encodeTopicWireFrames,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  parseCommandEnvelope,
  measureTopicNotificationEnvelopeBytes,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowParamsSchema,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationPlansParamsSchema,
  WORKFLOW_ARTIFACT_LIMITS,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  WORKFLOW_WORKSPACE_LIMITS,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import {
  ColdSessionResumeCoordinator,
  type ColdSessionResumeOutcome,
} from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import type {
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
} from "./product-projection.js";
import type { ConversationRowTargetAction } from "./product-projection.js";
import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";

function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // conversation projection saves product turnId as string for row index;
  // When leaving the gateway to adjust runtime file digest/fallback capabilities, the brand type of contracts needs to be restored.
  return turnId as TurnId | null;
}

function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
      return type;
    default:
      return null;
  }
}

interface PersistedEventsLoadResult {
  events: SessionEvent[];
  synthesized: boolean;
  /** The store-verified child manifest, injected after the durable transcript replay and before the live buffer is refilled. */
  subagentsSeed?: SessionSubagentsSeed;
  /** shared_context produces no visible row; only redacted handover metadata is delivered. */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** The raw sequence watermark already included when the memory eventStore took its snapshot. */
  sourceEventSeq?: number;
  /** A seed sharing the same capacity as this batch of history events; null means it was queried but has no history watermark. */
  usageSeed?: SessionUsageSeed | null;
}

type V4GatewayErrorContext = Record<string, unknown>;

/**
 * The **entire** payload of one read-back, kept for reuse by chunked reads.
 *
 * Two families share this table: the previews of sent attachments (`attachmentRead`) and the bytes
 * of dwf user-facing artifacts (`workflowRunArtifactRead`). The sharing is deliberate — their
 * invalidation rules are literally identical (TTL, byte budget, oldest-first eviction, clearing by
 * `sessionId` when a session is destroyed), while splitting them into two tables would yield two
 * **separate** byte budgets, after which the "at most how many bytes may be cached" constraint could
 * no longer be stated at all.
 *
 * The two key spaces are separated by the **leading tag** (`att` / `dwfart`), not by the field count
 * or the content — the keys of both families are NUL-separated four- or five-segment strings, the
 * segment counts are the same and the content can even collide (an artifact id of "1" looks exactly
 * like an attachmentIndex of 1); only a leading segment that can never be equal proves the isolation.
 *
 * `bytes` being null means the read is still in flight: it then does not count against the budget and
 * is not evicted by budget either (evicting an entry that is currently being awaited would only make
 * the next chunk re-read the whole file, which is exactly what this table exists to eliminate).
 */
interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export interface V4GatewayHost {
  cliVersion?: string;
  /** Whether the session is active in the host registry (the basis for the inbox's sessionNotFound verdict). */
  sessionExists(sessionId: string): boolean;
  /**
   * The V4 cold-restore hook. The gateway wraps runtime activation and projection hydration in one
   * and the same READY promise; the host is only responsible for restoring the record.
   */
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  /**
   * The egress for downstream physical frames (the host is responsible for delivery: stdio notification /
   * MessagePort / ws).
   *
   * A logical-frame fallback would bypass the 1MiB limit, fragmentation, and the receiver's atomic
   * assembly boundary; therefore both production hosts and test hosts must explicitly receive the
   * physical wire, and the type layer no longer allows falling back to logical frames.
   */
  emitWireFrame(frame: RoutedTopicWireFrame): void;
  /** The body-less facts of live ingest in the current process; not cached and not part of topic replay. */
  emitConversationTelemetryFact?(fact: ConversationTelemetryFact): void;
  emitLocalTtftFacts?(facts: import("@zcode/shared").LocalTtftFacts): void;
  /** The live request_access permission facts of the current process; not cached and not part of topic replay. */
  emitCuaPermissionObservation?(observation: CuaPermissionObservation): void;
  /**
   * sessions-index: session → its owning workspaceId (the bucketing key of the list topic).
   * Not implemented (older host) → the entire sessions-index path stays inactive (a no-op), which does
   * not affect conversation.
   */
  getSessionWorkspaceId?(sessionId: string): string | null;
  /** sessions-index: a session's listing metadata (createdAt / parent session / last activity time). */
  getSessionIndexMeta?(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    parentSessionId?: string;
  } | null;
  /**
   * config seed: the current truth of the session runtime (model selection / thinking depth /
   * collaboration mode).
   * The projection's initial values cannot be hardcoded to empty — the runtime's startup default
   * model, the project's persisted mode preference, and the last selection restored when a historical
   * session resumes all live only inside the runtime (ModelSelected is re-emitted only after
   * switchModelConfig, and may not appear in the log at all), so the seed is the only channel through
   * which they enter the projection.
   * Returns null when the session is not registered (the gateway skips it, keeping the empty initial
   * value); the same applies when not implemented (older host / test stub).
   */
  getSessionConfigSeed?(sessionId: string): SessionConfigSeed | null;
  /**
   * Cold-restore usage seed: the transcript synthesis path may only be able to produce a placeholder
   * ModelComplete with 0 / the default window; the host can supply the real watermark from the
   * persisted assistant tokens / runtime snapshot.
   * When not implemented, the reduced result of the event log is kept.
   */
  getSessionUsageSeed?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<SessionUsageSeed | null> | SessionUsageSeed | null;
  /** sessions-index: the ids of the sessions currently registered under a workspace (for the cold-start snapshot). */
  listWorkspaceSessionIds?(workspaceId: string): string[];
  /**
   * sessions-index: draft determination — a session that is persisted deferred and has not sent its
   * first input does not enter the list.
   * The old workspace prepare path pre-creates deferred sessions (historically the list read sqlite,
   * and deferred sessions were never written to disk, hence invisible); once sessions-index is derived
   * from the live registry, these ghost drafts show up in the sidebar as "new tasks". After the first
   * sendText promotes persistence to immediate, the event stream naturally triggers fanOutToIndex and
   * the session enters the list. Not implemented (older host / test stub) → no filtering.
   */
  isDraftSession?(sessionId: string): boolean;
  /**
   * sessions-index: builds lightweight summaries for all sessions of a workspace directly from the
   * persisted store (the cold-start seed).
   * Sessions that are not loaded (no live publisher) enter the list through it; loaded sessions are
   * overwritten by the gateway with the live projection.
   * Reading the store is asynchronous, so a Promise is allowed here (the gateway awaits it when
   * subscribing; a synchronous stub simply returns the array).
   */
  getStoredSessionSummaries?(workspaceId: string): Promise<SessionSummary[]> | SessionSummary[];
  /**
   * 3.3.6 remote history compatibility: after idempotently claiming through the exact task allowlist,
   * returns a strict identity summary.
   * Returns null for a non-remote workspace; a failure may degrade to an empty array, and a later
   * subscription carrying the allowlist will retry.
   */
  refreshLegacySessionSummaries?(
    workspaceId: string,
    legacyTaskIds: readonly string[],
  ): Promise<SessionSummary[] | null> | SessionSummary[] | null;
  /**
   * workspace-config: the config catalog of a workspace (config options + slash commands).
   * Both the seed taken on subscribe and the refetch by invalidateWorkspaceConfig go through here.
   * Not implemented (older host / test stub) → the workspace-config path degrades to an empty
   * catalog snapshot.
   */
  getWorkspaceConfig?(
    workspaceId: string,
  ): Promise<WorkspaceConfigState | null> | WorkspaceConfigState | null;
  readBackgroundBashOutput?(sessionId: string, workId: string): Promise<BackgroundBashOutputResult>;
  /** The side effect of executing an accepted command; the return value goes into ACK.result (fork/createSession carry sessionId). */
  executeCommand(
    envelope: CommandEnvelope,
    admission?: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<CommandResult | undefined>;
  /** A durable admission is written before an inbound command executes; the same complete intent is returned for the inbox to pin. */
  admitCommandInput?(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelCommandInput?(
    envelope: CommandEnvelope,
    queueItemId: string,
    reason: string,
  ): Promise<void>;
  /** Terminates the current turn when the running projection exceeds 16MiB; the gateway guarantees only one call per fault cycle. */
  terminateTurnForProjectionFault?(
    sessionId: string,
    reasonCode: "proto.payloadTooLarge",
  ): Promise<void> | void;
  /** The persisted fallback for commands/query; all four sources must be matched exactly by sourceCommandId. */
  lookupTranscriptCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupTimelineCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupChildCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupDiscardedCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  /** After the atomic transcript promotion the old lazy seed is invalidated synchronously, and then the CommandInbox live pin is released. */
  invalidatePersistentCommandFacts?(sessionId: string): void;
  /** The canonical goal complete has already entered the projection; host side effects must be detached and must never block ingest. */
  onTargetCompleted?(sessionId: string, event: SessionEvent): void;
  /** The session artifact is written in one go after the complete chunk transaction commits. */
  putSessionAttachment?(
    sessionId: string,
    input: { fileName: string; mime: string; bytes: Uint8Array },
  ): Promise<{ ref: string }>;
  /** A read-only query about a sent image/video/PDF; it may only reach the host after the gateway completes row/ref authorization. */
  readSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      maxBytes: number;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** A metadata stat for a userInput attachment during the Share selection phase; the gateway completes row/index authorization first. */
  statSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** The path of a sent video on Desktop local; it may only reach the host after the gateway completes row/index authorization. */
  resolveSessionAttachmentPreviewSource?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<V4AttachmentPreviewSourceResult>;
  getConversationFileChanges?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileChangesResult>;
  previewConversationFileRewind?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /**
   * Pagination over a workflow run's event log (the audit surface of the details page). Absence = the
   * session's runtime does not have this capability (the dwf journal is unavailable → the run service
   * was never constructed), and the gateway answers with a structured capability-not-supported error.
   */
  listDynamicWorkflowRunEvents?(
    sessionId: string,
    input: { runId: string; afterSequence?: number; limit?: number },
  ): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * The enumeration surface of dwf runs (the discovery query after a restart).
   * The absence condition is the same as in {@link listDynamicWorkflowRunEvents}.
   */
  listDynamicWorkflowRuns?(
    sessionId: string,
    input: { limit?: number },
  ): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * The read surface for a workflow run's **user-facing artifacts**. All three are present together and
   * absent together (they are registered under one and the same condition on the app side). The absence
   * condition is the same as in {@link listDynamicWorkflowRunEvents}.
   *
   * ⚠ Terminology: an artifact = an output a script publishes to the user via `artifact.*`, not the
   * top-level return value of the run.
   */
  listDynamicWorkflowRunArtifacts?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  listDynamicWorkflowRunArtifactItems?(
    sessionId: string,
    input: { runId: string; artifactId: string; afterSequence?: number; limit: number },
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  readDynamicWorkflowRunArtifact?(
    sessionId: string,
    input: { runId: string; artifactId: string; version: number },
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * The workspace transcript of a workflow run: both are present together and absent together.
   * Authorization lives on the host side (the run belongs to this session); both a rejection and an
   * unknown return `undefined`.
   */
  listDynamicWorkflowRunWorkspaceNodes?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(
    sessionId: string,
    input: { runId: string; siteId: string; ordinal: number; maxBytes: number },
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  /**
   * hydration: reads a session's persisted events to rebuild the projection for a cold subscription
   * (fork child / resume / app-restart). `synthesized=true` means the event log cannot cover the
   * transcript and the events are synthesized backwards from the transcript — in that case the
   * projection must be **rebuilt** even when a cold publisher already exists (one created ahead of
   * time by the ingest of a fork resume), otherwise the history would not enter the projection.
   * `synthesized=false` (a complete event log) keeps the existing live publisher (streaming must not
   * be interrupted by a rebuild). Not implemented (older host) → a cold subscription degrades to an
   * empty projection.
   */
  loadPersistedEvents?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<PersistedEventsLoadResult>;
  /** For low-frequency lifecycle and restore decisions only; high-frequency event/stream traces are forbidden in the production log. */
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: V4GatewayErrorContext): void;
}

interface ConversationV4GatewayOptions {
  now?: () => number;
  /** The logEpoch generator (random within the process by default; tests inject a fixed value to stay deterministic). */
  createLogEpoch?: (sessionId: string) => string;
}

interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

interface RawSequenceState {
  /** The runtime raw cursor already consumed by a cold snapshot or a live replay. */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset; it is corrected forward when it runs into sequence=0. */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** The events the publisher has applied successfully; events the runtime sink has already seen but that are still in the gap buffer are not in this set. */
  appliedEventIds: Set<string>;
  /** The fact that a publisher apply failed; a waiter registering late on a temporary sink must also be rejected immediately. */
  failedEventById: Map<string, Error>;
  /** The notify sink may deliver out of order; draining into the projection is only allowed when the sequence is continuous from sourceEventSeq+1. */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** When a synthesized hydration rebuilds the projection, the raw facts that already arrived after the persisted read boundary are filled back in. */
  recentRawEventsById: Map<string, SessionEvent>;
}

interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}

const PROJECTION_EVENT_COMMIT_TIMEOUT_MS = 25_000;
const MAX_TELEMETRY_EVENT_IDS = 2_000;
/** How long a publisher is retained before a low-frequency tick releases it, once a detached subagent child has reached its terminal state and has no subscribers. */
const DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000;

class ProjectionEventCommitWaitError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.projectionEventCommit.aborted"
      | "fault.projectionEventCommit.applyFailed"
      | "fault.projectionEventCommit.disposed"
      | "fault.projectionEventCommit.gatewayDisposed"
      | "fault.projectionEventCommit.rehydrated"
      | "fault.projectionEventCommit.timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionEventCommitWaitError";
  }
}

/**
 * The server-internal dispatch result: the initial frame is consumed only by the request-scoped
 * post-response outbox, and the public JSON-RPC result schema is always strictly `{ ack }`.
 */
interface V4SubscribeDispatchResult<TFrame> {
  ack: SubscribeAck & { openTiming?: ConversationOpenTiming };
  initialFrame: TFrame | null;
  initialWires: RoutedTopicWireFrame[];
  commit(): boolean;
}

function encodeReservedTopicFrame(
  reservation: TopicFrameReservation<RoutedTopicFrame>,
): RoutedTopicWireFrame[] {
  return encodeTopicWireFrames(reservation.frame, {
    deliveryKind: reservation.deliveryKind,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    logicalFrameId: reservation.logicalFrameId,
    logicalFrameOrdinal: reservation.logicalFrameOrdinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }) as RoutedTopicWireFrame[];
}

function subscriptionRouteKey(topic: string, subscriptionId: string, connectionId: string): string {
  return `${topic}\0${subscriptionId}\0${connectionId}`;
}

function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`zcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/** The set of error codes meaning an attachment "definitely does not exist" at the file system layer. */
const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * Normalizes an error thrown by the host / FileSystemPort into an attachment fault carrying a stable code.
 * When the host already supplies a structured fault code it is passed through verbatim, the rest are
 * decided by FileSystemPortError.code; when neither matches, the original error is kept so the layer
 * above handles it as "unknown" instead of guessing it into a definite category.
 */
function toShareStatFault(error: unknown): unknown {
  if (readZCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}

export class ConversationV4Gateway {
  private readonly publishers = new Map<string, ConversationTopicPublisher>();
  /** sessions-index: workspaceId → list publisher (alongside conversation, with an independent seq/logEpoch). */
  private readonly indexPublishers = new SessionsIndexPublisherRegistry();
  /** workspace-config: workspaceId → config catalog publisher (a conflated, wholly replaced state). */
  private readonly configPublishers = new Map<string, WorkspaceConfigPublisher>();
  /** Sessions that have completed their first hydration (avoiding a repeated rebuild / double counting; see hydratePublisher). */
  private readonly hydratedSessions = new Set<string>();
  /** The first hydration is single-flighted per session; concurrent panes share the same rebuild result. */
  private readonly hydrationInFlight = new Map<string, Promise<ConversationTopicPublisher>>();
  /** The READY watermark from cold activation to hydration; it blocks only the command/query during this restore. */
  private readonly readyFlights = new Map<string, Promise<ConversationTopicPublisher>>();
  /** The raw accepted events inside the load await window; after the rebuild they are filled back in by cursor/eventId. */
  private readonly hydrationBuffers = new Map<string, HydrationBuffer>();
  /** A per-session monotonic mapping between the transcript synthesis sequence and the runtime raw sequence. */
  private readonly rawSequenceStates = new Map<string, RawSequenceState>();
  /** connection-independent; the lifecycle of a transport subscription is decoupled from command admission. */
  private readonly projectionEventCommitWaiters = new Map<
    string,
    Map<string, Set<ProjectionEventCommitWaiter>>
  >();
  /** A live child with no bootstrap record of its own whose raw events are continuously forwarded by the parent runtime. */
  private readonly detachedLiveSessions = new Set<string>();
  /**
   * The parent record ownership and terminal time of a detached subagent child. A child has no record
   * of its own, so its publisher can only be released together with the parent record, or by a
   * low-frequency tick once the turn has ended, there are no subscribers, and the grace period has
   * passed; otherwise it would linger until the process exits.
   */
  private readonly detachedChildParent = new Map<string, string>();
  private readonly detachedChildrenByParent = new Map<string, Set<string>>();
  private readonly detachedTerminalAt = new Map<string, number>();
  /** The cold-restore coordinator (the existing activation single-flight plus error typing). */
  private readonly coldResume: ColdSessionResumeCoordinator;
  /** Subscription → flush scheduling state (the publisher itself holds no timer; scheduling belongs to the gateway). */
  private readonly flushStates = new Map<string, FlushState>();
  /** A control reservation that has not yet been admitted by the ACK/outbox must not be sent ahead of time by an online flush. */
  private readonly controlReservations = new WeakSet<object>();
  /** A transport high-water pause is isolated only by trusted connectionId and does not change the ingest/publisher truth. */
  private readonly pausedConnections = new Set<string>();
  /** An over-limit cycle triggers a runtime stop only once; it is cleared once the terminal event arrives. */
  private readonly projectionFaultedSessions = new Set<string>();
  private readonly inbox: CommandInbox;
  private readonly attachmentUploads: AttachmentUploadRegistry;
  private readonly binaryReadCache = new Map<string, BinaryReadCacheEntry>();
  private binaryReadCacheBytes = 0;
  private readonly localTtft = new LocalTtftRecorder(
    localTtftNow,
    () => {
      this.host.onError?.(
        "v4.localTtft.completedCapacity",
        new Error("TTFT completed record capacity exceeded"),
      );
    },
    (facts) => {
      const parsed = localTtftFactsSchema.safeParse(facts);
      if (parsed.success) this.host.emitLocalTtftFacts?.(parsed.data);
    },
  );
  /** Throttling of the index fan-out for high-frequency progress events (14-sessions-index "event fan-out rhythm"). */
  private readonly indexFanoutThrottle = new SessionsIndexFanoutThrottle({
    publish: (sessionId) => this.publishCurrentSummaryToIndex(sessionId),
  });
  private readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly createLogEpoch: (sessionId: string) => string;
  private readonly telemetryNormalizer = new ConversationTelemetryFactNormalizer();
  private readonly cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();
  private readonly telemetryEventIds = new Set<string>();
  private disposed = false;

  /** A lightweight metadata update after a session entry status change; no conversation event is replayed. */
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void {
    const publisher = this.publishers.get(sessionId);
    if (!publisher) return;
    publisher.seedSharedContextImport(source);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
    }
  }

  constructor(
    private readonly host: V4GatewayHost,
    options: ConversationV4GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
    this.coldResume = new ColdSessionResumeCoordinator(host);
    this.inbox = new CommandInbox({
      getRevision: (sessionId) => {
        if (!this.host.sessionExists(sessionId)) return null;
        // Session is known but no events yet → projection is not built, revision is considered 0 (draft starting point).
        return this.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => this.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = this.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      lookupTranscriptCommand: (key) => this.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => this.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => this.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => this.host.lookupDiscardedCommand?.(key) ?? null,
      now: this.now,
    });
    this.attachmentUploads = new AttachmentUploadRegistry({
      now: this.now,
      putSessionAttachment: async (sessionId, input) => {
        if (!this.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return this.host.putSessionAttachment(sessionId, input);
      },
    });
    this.attachmentPruneTimer = setInterval(
      () => this.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    );
    (
      this.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
  }

  setConnectionFlowState(rawParams: unknown): void {
    const params = v4ConnectionFlowParamsSchema.parse(rawParams);
    if (params.state === "closed") {
      this.pausedConnections.delete(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      this.attachmentUploads.clearConnection(params.connectionId);
      return;
    }
    if (params.state === "saturated") {
      if (this.pausedConnections.has(params.connectionId)) return;
      this.pausedConnections.add(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      return;
    }
    if (!this.pausedConnections.delete(params.connectionId)) return;
    this.flushConnection(params.connectionId);
  }

  private clearConnectionFlushTimers(connectionId: string): void {
    for (const state of this.flushStates.values()) {
      if (state.connectionId !== connectionId || state.timer === null) continue;
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private flushConnection(connectionId: string): void {
    for (const [routeKey, state] of this.flushStates) {
      if (state.connectionId !== connectionId) continue;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      const publisher = this.publishers.get(state.sessionId);
      if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
        this.flushStates.delete(routeKey);
        continue;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }
    for (const workspaceId of this.indexPublishers.keys()) {
      this.flushIndex(workspaceId, connectionId);
    }
    for (const workspaceId of this.configPublishers.keys()) {
      this.flushConfig(workspaceId, connectionId);
    }
  }

  /** The authoritative event entry point: projection advance + each subscriber scheduling its frames according to profile.flushWindowMs. */
  ingest(sessionId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) {
      const eventId = String(event.id);
      if (hydrationBuffer.eventIds.has(eventId)) return;
      // Remember the raw fact first; it may not be included in the publisher temporarily because the preamble has not yet arrived.
      hydrationBuffer.eventIds.add(eventId);
      hydrationBuffer.rawEvents.push(event);
    }
    this.emitLiveTelemetryFact(sessionId, event);
    for (const normalizedEvent of this.normalizeRuntimeEventSequence(sessionId, event)) {
      try {
        this.localTtft.event(sessionId, normalizedEvent);
      } catch (error) {
        try {
          this.host.onError?.("v4.localTtft.observe", error);
        } catch {
          /* A diagnostic callback must not block the actual content either. */
        }
      }
      this.ingestNormalizedEvent(sessionId, normalizedEvent);
    }
  }

  private emitLiveTelemetryFact(sessionId: string, event: SessionEvent): void {
    const eventId = String(event.id);
    // The main session and detached child maintain event sequences respectively, and eventId cannot be assumed to span
    // session is globally unique. The old deduplication only uses eventId, which will misjudge the child's event with the same number as the main session replay.
    // Causes the frontend Subagent's true turn fact to be silently discarded.
    const telemetryEventKey = `${sessionId}\0${eventId}`;
    if (this.telemetryEventIds.has(telemetryEventKey)) return;
    this.telemetryEventIds.add(telemetryEventKey);
    if (this.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
      const oldest = this.telemetryEventIds.values().next().value;
      if (typeof oldest === "string") this.telemetryEventIds.delete(oldest);
    }
    try {
      const config =
        this.publishers.get(sessionId)?.getSnapshot().config ??
        this.host.getSessionConfigSeed?.(sessionId) ??
        undefined;
      const fact = this.telemetryNormalizer.normalize(sessionId, event, {
        modelName: config?.model,
        modelProvider: config?.provider,
      });
      if (fact) {
        this.host.emitConversationTelemetryFact?.(fact);
      }
    } catch (error) {
      // Turn facts must not back-block conversation projections; strict schema failures only log diagnostics.
      this.host.onError?.("v4.telemetry.normalize", error);
    }
    try {
      const observation = this.cuaPermissionNormalizer.normalize(sessionId, event);
      if (observation) this.host.emitCuaPermissionObservation?.(observation);
    } catch (error) {
      // Permission observation is only a live UI prompt, and schema or projection exceptions cannot block the conversation main link.
      this.host.onError?.("v4.cuaPermissionObservation.normalize", error);
    }
  }

  /** Waits until a given raw event has truly completed the reorder drain + the publisher's projection apply. */
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway is disposed",
        ),
      );
    }
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.appliedEventIds.has(eventId)) return Promise.resolve();
    const failed = state.failedEventById.get(eventId);
    if (failed) return Promise.reject(failed);
    if (options.signal?.aborted) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal.reason },
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const byEvent = this.projectionEventCommitWaiters.get(sessionId) ?? new Map();
      this.projectionEventCommitWaiters.set(sessionId, byEvent);
      const waiters = byEvent.get(eventId) ?? new Set();
      byEvent.set(eventId, waiters);
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) byEvent.delete(eventId);
        if (byEvent.size === 0) this.projectionEventCommitWaiters.delete(sessionId);
      };
      const waiter: ProjectionEventCommitWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        // Only rejecting the current waiter will keep the TurnStarted in the raw gap alive;
        // If the command is canceled and the gap is filled, late events will still enter the canonical projection.
        // The event failure must be solidified into the sequence state. Subsequent drain will only advance the cursor and no longer apply.
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.aborted",
            `projection event commit wait aborted: ${eventId}`,
            { cause: options.signal?.reason },
          ),
        );
      };
      const timeout = setTimeout(() => {
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.timeout",
            `projection event commit wait timed out: ${eventId}`,
          ),
        );
      }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
      timeout.unref?.();
      waiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The authorization has already been committed to the task transaction; a failed retry must replay the authoritative log and may neither escalate privileges again nor discard the commit fact. */
  async waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void> {
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.failedEventById.has(eventId)) {
      const event = state.recentRawEventsById.get(eventId);
      if (
        event?.type !== SessionEventType.SessionModeChanged ||
        !(event.payload as { permissionGrant?: unknown }).permissionGrant
      ) {
        throw new Error("Permission grant event unavailable for recovery");
      }
      await this.hydrationInFlight.get(sessionId);
      this.hydratedSessions.delete(sessionId);
      await this.hydratePublisher(sessionId, undefined, true);
    }
    await this.waitForProjectionEventCommit(sessionId, eventId);
  }

  private ingestNormalizedEvent(sessionId: string, event: SessionEvent): void {
    const publisher = this.ensurePublisher(sessionId);
    const promotedQueueRemoval =
      event.type === SessionEventType.TurnSteerDiscarded &&
      (event.payload as { reason?: string }).reason === "promoted";
    const removedQueueItems =
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded
        ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
            (queueItemId) => {
              const item = publisher
                .getSnapshot()
                .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
              return item ? [item] : [];
            },
          )
        : [];
    try {
      publisher.ingest(event);
    } catch (error) {
      const commitError =
        error instanceof ProjectionEventCommitWaitError
          ? error
          : new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply event ${String(event.id)}`,
              { cause: error },
            );
      this.rejectProjectionEventCommit(sessionId, String(event.id), commitError);
      if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
      this.host.onError?.("v4.projection.payloadTooLarge", error);
      if (!this.projectionFaultedSessions.has(sessionId)) {
        this.projectionFaultedSessions.add(sessionId);
        void Promise.resolve(
          this.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
        ).catch((terminateError) => {
          this.host.onError?.("v4.projection.terminate", terminateError);
        });
      }
      return;
    }
    this.resolveProjectionEventCommit(sessionId, String(event.id));
    if (
      event.type === SessionEventType.TargetChanged &&
      (event.payload as TargetChangedPayload).target?.status === "complete"
    ) {
      try {
        this.host.onTargetCompleted?.(sessionId, event);
      } catch (error) {
        this.host.onError?.("v4.projection.targetCompleted", error);
      }
    }
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.projectionFaultedSessions.delete(sessionId);
    }
    if (event.type === SessionEventType.TurnSteerQueued) {
      const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
      const item = queueItemId
        ? publisher
            .getSnapshot()
            .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
        : undefined;
      if (item) this.inbox.pinLiveInput(sessionId, item);
    }
    if (!promotedQueueRemoval) {
      if (removedQueueItems.length > 0) {
        // delete/clear has first written durable session_input as canceled, but this session
        // The persistent command index may have cached old empty results. You must first invalidate the live pin before releasing it.
        // Otherwise, the same commandId query may still be unknown and be executed repeatedly after LRU is eliminated.
        this.host.invalidatePersistentCommandFacts?.(sessionId);
      }
      for (const item of removedQueueItems) {
        this.inbox.releaseLiveInput({
          sessionId,
          commandId: item.sourceCommandId,
        });
      }
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
      if (sourceCommandId) {
        // The persistent index may have been queried earlier than this user message; it must be invalidated first and then unpinned.
        // Only when the subsequent LRU is eliminated and returned to the source can the newly submitted transcript be re-read, instead of hitting the old empty seed.
        this.host.invalidatePersistentCommandFacts?.(sessionId);
        this.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
      }
    }
    // assistant conservation: the projection rejected the text stream (publisher was created mid-subscription, missed
    // Typical form of TurnStarted) → revoke the hydrated mark, and the next subscription is forced to restart from the persistent fact
    // Hydration fills in missing segments - Silent loss will cause the content to be missing until the user manually refreshes it.
    if (publisher.getDroppedContentStreamEventCount() > 0 && this.hydratedSessions.has(sessionId)) {
      this.hydratedSessions.delete(sessionId);
      this.host.onError?.(
        "v4.assistantConservation",
        new Error(
          `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
        ),
      );
    }
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      this.scheduleFlush(routeKey, state, publisher);
    }
    // sessions-index fan-out (defensive: any exception cannot interrupt the main conversation path).
    this.fanOutToIndex(sessionId, event);
  }

  /**
   * A subagent child uses the parent record's external sink but keeps its own session topic. Such
   * detached live sessions are registered explicitly, so that an arbitrary cold publisher that merely
   * happens to exist is not misjudged as a running child.
   */
  ingestDetachedLiveSession(
    sessionId: string,
    event: SessionEvent,
    parentSessionId?: string,
  ): void {
    if (!this.detachedLiveSessions.has(sessionId)) {
      this.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
    }
    this.detachedLiveSessions.add(sessionId);
    if (parentSessionId && parentSessionId !== sessionId) {
      this.detachedChildParent.set(sessionId, parentSessionId);
      let children = this.detachedChildrenByParent.get(parentSessionId);
      if (!children) {
        children = new Set();
        this.detachedChildrenByParent.set(parentSessionId, children);
      }
      children.add(sessionId);
    }
    // Child is a one-time session with no record and no subsequent turn. The publisher stayed until the process exited.
    // Record the final state time for pruneDetachedChildPublishers to release after grace; if the child turns again, it will be cancelled.
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.detachedTerminalAt.set(sessionId, Date.now());
    } else if (event.type === SessionEventType.TurnStarted) {
      this.detachedTerminalAt.delete(sessionId);
    }
    this.ingest(sessionId, event);
  }

  /**
   * A low-frequency tick backstop: release the publishers of detached children that have reached their
   * terminal state, have no subscribers, and have no record of their own.
   * Subscribing after such a release goes through the existing cold resume (the child is persisted in
   * the session store as subagent_child). Returns the number released.
   */
  pruneDetachedChildPublishers(
    nowMs: number = Date.now(),
    graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
  ): number {
    let released = 0;
    for (const [childId, terminalAt] of [...this.detachedTerminalAt]) {
      if (nowMs - terminalAt < graceMs) continue;
      if (this.host.sessionExists(childId)) continue;
      if (this.publishers.get(childId)?.hasSubscribers()) continue;
      this.releaseDetachedChild(childId);
      released += 1;
    }
    return released;
  }

  private releaseDetachedChild(childId: string): void {
    this.host.onDebug?.(`release detached live child publisher session=${childId}`);
    this.cleanupSessionRuntime(childId, { clearCommandInbox: false, notifyIndexRemoved: false });
  }

  /**
   * Advance a session's latest summary into its workspace's sessions-index publisher and flush it to
   * the list subscribers.
   * The projection must keep advancing even when there are no list subscribers, so that the next
   * snapshot read gets the authoritative current state;
   * high-frequency streaming deltas (ModelStreaming) do not trigger a list recomputation, to avoid
   * flapping (the preview updates when a turn closes / on other events).
   * An older host without getSessionWorkspaceId → an overall no-op.
   */
  private fanOutToIndex(sessionId: string, event: SessionEvent): void {
    if (event.type === SessionEventType.ModelStreaming) return;
    // The workflow progress is also a high-frequency flow (actually measured 4000 items in 8s), but the list continues to move, so it is not discarded but
    // leading + trailing window throttling: the window is merged into the last frame of the window, and the final state is still delivered in one window.
    if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
      this.indexFanoutThrottle.request(sessionId);
      return;
    }
    this.publishCurrentSummaryToIndex(sessionId);
  }

  /**
   * Publishes the current full projection to sessions-index.
   *
   * The resume of a fork child first builds a transient draft publisher out of a few live events, and
   * only the subsequent synthesized hydration fills in the inherited history. If the fan-out happens
   * only on ingest(event), then after hydration completes with no next runtime event the child stays
   * at the draft baseline forever, the task-index syncer cannot observe the draft→visible transition,
   * and no sidebar task row is ever created.
   */
  private publishCurrentSummaryToIndex(sessionId: string): void {
    // What is released this time is the current summary after merging within the window: the trailing to be sent is satisfied at this point, and frames will not be sent again.
    this.indexFanoutThrottle.notePublished(sessionId);
    const getWorkspaceId = this.host.getSessionWorkspaceId;
    if (!getWorkspaceId) return;
    try {
      const workspaceId = getWorkspaceId.call(this.host, sessionId);
      if (!workspaceId) return;
      if (this.host.isDraftSession?.(sessionId)) return;
      const indexPublisher = this.indexPublishers.get(workspaceId);
      if (!indexPublisher) return;
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) return;
      const changed = indexPublisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
      if (changed) this.flushIndex(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.sessionsIndex.ingest", error);
    }
  }

  /** Session list metadata (the fallback when the host hook is absent: createdAt=0, lastActivityAt=now). */
  private resolveIndexMeta(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    parentSessionId?: string;
  } {
    const meta = this.host.getSessionIndexMeta?.(sessionId);
    return {
      createdAt: meta?.createdAt ?? 0,
      lastActivityAt: meta?.lastActivityAt ?? this.now(),
      ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    };
  }

  /** Pushes a workspace index publisher's unsent delta frames to all list subscribers. */
  private flushIndex(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.indexPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.emit", error);
      }
    }
  }

  /**
   * sessions-index subscription: subscribe to a workspace's session list (alongside conversation
   * subscribe, the same RPC method dispatches by topic prefix). Cold start: store summary seed +
   * the live projection overwriting it for already-loaded sessions.
   */
  async subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const dispatch = await this.subscribeSessionsIndexReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a sessions-index topic: ${params.topic}`);
    }
    const publisher = await this.ensureIndexPublisher(workspaceId, params.legacyTaskIds);
    // ensure may internally span asynchronous store/claim; dispose occurs before await returns and prohibits continued registration of subscriptions.
    this.indexPublishers.ensureActive();
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushIndex(workspaceId),
      );
    } catch (error) {
      // The initial logical frame can fail due to the 16MiB upper limit in the physical encode stage;
      // If the registered subscription/in-flight reservation fails, it must be rolled back, otherwise it will leave a ghost owner who can never unsubscribe.
      result.rollback();
      throw error;
    }
  }

  /** Creates/gets a workspace's index publisher; on creation, a store summary seed + live projection overwrite. */
  private async ensureIndexPublisher(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const existing = this.indexPublishers.get(workspaceId);
    const shouldRefreshLegacy =
      Boolean(legacyTaskIds?.length) && Boolean(this.host.refreshLegacySessionSummaries);
    if (existing && !shouldRefreshLegacy) return existing;

    return this.indexPublishers.runExclusive(workspaceId, () =>
      this.ensureIndexPublisherExclusive(workspaceId, legacyTaskIds),
    );
  }

  /** The serialization region of one workspace: a retriable claim / re-read and the publisher construction must observe the same final snapshot. */
  private async ensureIndexPublisherExclusive(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const refreshed =
      legacyTaskIds && legacyTaskIds.length > 0
        ? ((await this.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
        : null;
    const existing = this.indexPublishers.get(workspaceId);
    if (existing) {
      // The claim cannot be bound to the first construction: an empty seed permanently blocks retries once it enters the Map.
      // Rereading only fills in missing items to prevent the cold storage default state from overwriting the existing live projection.
      if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
        this.flushIndex(workspaceId);
      }
      return existing;
    }
    const publisher = new SessionsIndexPublisher(
      workspaceId,
      this.createLogEpoch(`sessions-index/${workspaceId}`),
      this.now,
    );
    // Seed 1: A lightweight summary of all sessions in the store (unloaded ones are listed by this).
    const stored = refreshed ?? (await this.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
    for (const summary of stored) publisher.seed(summary);
    // Seed 2: Loaded session overlaid with live projection (more accurate phase/preview/backgroundWork).
    const liveIds = this.host.listWorkspaceSessionIds?.(workspaceId) ?? [...this.publishers.keys()];
    for (const sessionId of liveIds) {
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) continue;
      // Draft (the first deferred is not issued) does not enter the cold start seed, which is consistent with the filtering of fanOutToIndex.
      if (this.host.isDraftSession?.(sessionId)) continue;
      publisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
    }
    this.indexPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /**
   * workspace-config subscription: subscribe to a workspace's config catalog (alongside conversation
   * subscribe, the same RPC method dispatches by topic prefix). On subscribing, the current config is
   * fetched through the host hook as the seed.
   */
  async subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const dispatch = await this.subscribeWorkspaceConfigReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseWorkspaceConfigTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a workspace-config topic: ${params.topic}`);
    }
    const publisher = await this.ensureConfigPublisher(workspaceId);
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushConfig(workspaceId),
      );
    } catch (error) {
      // Same atomic boundary as sessions-index: encode failed = subscribe not admitted.
      result.rollback();
      throw error;
    }
  }

  /**
   * The entry point for publishing the config catalog (the host calls it after applying the provider
   * registry / changing workspace defaults, carrying the already-built catalog directly instead of
   * asking the host again, which avoids paying the temporary app cost of building workspace state a
   * second time).
   * Conflation happens inside the publisher (an unchanged catalog produces no frame); when there is no
   * publisher yet, an empty-seeded publisher is created synchronously to hold the latest state, so
   * that later subscribers get a full snapshot from it.
   */
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void {
    if (this.disposed) return;
    let publisher = this.configPublishers.get(workspaceId);
    if (!publisher) {
      publisher = new WorkspaceConfigPublisher(
        workspaceId,
        this.createLogEpoch(`workspace-config/${workspaceId}`),
        this.now,
      );
      this.configPublishers.set(workspaceId, publisher);
    }
    try {
      if (publisher.publish(state)) this.flushConfig(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.workspaceConfig.publish", error);
    }
  }

  private async pullWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfigState | null> {
    if (!this.host.getWorkspaceConfig) return null;
    return (await this.host.getWorkspaceConfig(workspaceId)) ?? null;
  }

  /** Creates/gets a workspace's config publisher; on creation the current catalog is fetched through the host hook as the seed. */
  private async ensureConfigPublisher(workspaceId: string): Promise<WorkspaceConfigPublisher> {
    const existing = this.configPublishers.get(workspaceId);
    if (existing) return existing;
    const publisher = new WorkspaceConfigPublisher(
      workspaceId,
      this.createLogEpoch(`workspace-config/${workspaceId}`),
      this.now,
    );
    const seed = await this.pullWorkspaceConfig(workspaceId).catch((error) => {
      this.host.onError?.("v4.workspaceConfig.seed", error);
      return null;
    });
    if (seed) publisher.publish(seed);
    // Concurrent subscriptions during await may have been registered with the workspace publisher → whichever is registered first.
    const raced = this.configPublishers.get(workspaceId);
    if (raced) return raced;
    this.configPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /** Pushes a workspace config publisher's unsent delta frames to all subscribers. */
  private flushConfig(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.configPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.workspaceConfig.emit", error);
      }
    }
  }

  /** v4/conversation/subscribe: adjudication + the server-internal initial frame; for the public response the server takes only the ACK. */
  async subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    const dispatch = await this.subscribeReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      throw new Error(`Unsupported topic: ${params.topic}`);
    }
    const isLiveConversation = this.hasLiveConversation(sessionId);
    this.host.onDebug?.(
      `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
    );
    // Hydration: Reconstruct projections from authoritative sources when first subscribing.
    // - no publisher (cold) → build + replay.
    // - There is a publisher but the event log cannot cover the transcript (fork child: resume’s ingest takes precedence
    //   Created a cold publisher containing only fork events) → Use transcript synthesis to **rebuild**.
    // - With publisher and event log complete (streaming live) → reserved, replay will double count and interrupt the stream.
    const restoreStartedAt = performance.now();
    const existingReady = this.readyFlights.get(sessionId);
    const publisher = existingReady
      ? await existingReady
      : !isLiveConversation
        ? await this.ensureColdReadyPublisher(
            sessionId,
            params.resumeThoughtLevel,
            params.workspace,
          )
        : await this.hydratePublisher(sessionId);
    const cliSessionRestoreMs = !isLiveConversation
      ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
      : undefined;
    // The old entrance allows the UI to select deliveryProfile, and will default to it when the desktop call is missed.
    // replayable. Now only trusted clientMode injected by host attachment is recognized.
    const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    // subscribeReserved wire projection has been constructed; if timing starts after it, the large session's
    // Line filtering/window truncation will fall outside the restore and encode sections. The starting point must cover the build with physical encode.
    const initialFrameEncodeStartedAt = performance.now();
    const result = publisher.subscribeReserved({
      connectionId: params.connectionId,
      base: params.base,
      deliveryProfile: profileName,
      // Trusted injection of the same family as clientMode: the capability bit comes from the clientHello of the connection. If it is absent, it will be treated as the old consumer.
      // (integer patch + old bounds crop). resync / rehydrate uses the bit already recorded on the subscription and does not retrieve it again.
      workflowRunDeltas: params.workflowRunDeltas === true,
    });
    const routeKey = subscriptionRouteKey(
      params.topic,
      result.ack.subscriptionId,
      params.connectionId,
    );
    let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
    try {
      dispatch = this.subscribeDispatch(result.ack, result.reservation, () => {
        const state = this.flushStates.get(routeKey);
        if (state) this.scheduleFlush(routeKey, state, publisher);
      });
      dispatch.ack = {
        ...dispatch.ack,
        openTiming: {
          version: 1,
          ...(cliSessionRestoreMs !== undefined ? { cliSessionRestoreMs } : {}),
          initialFrameEncodeMs: Math.max(
            0,
            Math.round(performance.now() - initialFrameEncodeStartedAt),
          ),
          sessionRuntimeState: isLiveConversation ? "warm" : "cold",
          snapshotRowCount: publisher.getSnapshot().rows.window.length,
        },
      };
    } catch (error) {
      // When reordering initial encode fails, the client still holds the old subId; replacement is required
      // Atomic rollback, old publisher subscription and flush timer are still valid.
      result.rollback();
      throw error;
    }
    // Replacement is admitted only after encode succeeds; at this time, the old scheduling status is cleared, and the failed path does not touch the old owner.
    for (const [staleRouteKey, staleState] of this.flushStates) {
      if (staleState.sessionId !== sessionId) continue;
      if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
        continue;
      }
      if (staleState.timer) clearTimeout(staleState.timer);
      this.flushStates.delete(staleRouteKey);
    }
    this.flushStates.set(routeKey, {
      sessionId,
      topic: params.topic,
      subscriptionId: result.ack.subscriptionId,
      connectionId: params.connectionId,
      deliveryProfile: profileName,
      flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
      timer: null,
    });
    return dispatch;
  }

  /**
   * v4/conversation/resync: hit the existing subscription exactly by owned topic/connection, keep the
   * subId/profile unchanged, and re-adjudicate resume/snapshot from the client's base.
   */
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame> {
    const params = v4ConversationResyncParamsSchema.parse(rawParams);
    const request = {
      base: params.base,
      ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
    };
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId !== null) {
      const publisher = this.publishers.get(sessionId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const routeKey = subscriptionRouteKey(
        params.topic,
        params.subscriptionId,
        params.connectionId,
      );
      const flushState = this.flushStates.get(routeKey);
      if (flushState?.timer) {
        clearTimeout(flushState.timer);
        flushState.timer = null;
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(result.ack, result.reservation, () => {
          const state = this.flushStates.get(routeKey);
          if (state) this.scheduleFlush(routeKey, state, publisher);
        });
      } catch (error) {
        // When physical encode fails before ACK admission, same-sub recovery
        // Cannot leave new inFlight or cancel old online flush; rehang timer after atomic restoration of old state.
        result.rollback();
        if (flushState) this.scheduleFlush(routeKey, flushState, publisher);
        throw error;
      }
    }

    const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
    if (indexWorkspaceId !== null) {
      const publisher = this.indexPublishers.get(indexWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushIndex(indexWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }

    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      const publisher = this.configPublishers.get(configWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushConfig(configWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }
    throw new Error(`Unsupported topic: ${params.topic}`);
  }

  /**
   * v4/conversation/rowsRange: with a beforeRowId cursor, take one window of history rows going
   * upward. A read-only query that creates no subscription; the data source = all rows of that
   * session's projection — a cold session (opening history directly after a restart) first reuses
   * exactly the same cold-restore + hydration pipeline as subscribe to build the projection.
   */
  async rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult> {
    const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    return publisher.getRowsRange(
      {
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      },
      // clientMode determines the row visibility filtering gear: desktop continuous (default) / disconnection recovery replayable.
      params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
    );
  }

  /** The final plan catalog of a complete, valid projection; a cold session reuses the subscription's hydration. */
  async plans(rawParams: unknown): Promise<V4ConversationPlansResult> {
    const params = v4ConversationPlansParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    return publisher.getPlans();
  }

  /**
   * Paginated reading of a workflow run's event log (cursor = journal sequence).
   *
   * It belongs to the same family as rows/range and plans: read-only, stateless, and safe to resend
   * after a timeout. It is deliberately **not** a v4 command — the ACK result of a command is that
   * closed "change result" discriminated union, and a page of read-only events does not belong to that
   * vocabulary.
   *
   * `hasMore` is decided by "fetched the full limit": reading one extra entry to confirm that more
   * follow is more reliable than letting the renderer guess from "this page happened to be full"
   * (when exactly the last entry was fetched, no empty page is wasted).
   */
  async workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult> {
    const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunEvents) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const limit = params.limit;
    const events = await this.host.listDynamicWorkflowRunEvents(params.sessionId, {
      runId: params.runId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      // The extra one is only used to determine hasMore; it does not enter the results page.
      ...(limit === undefined ? {} : { limit: limit + 1 }),
    });
    const hasMore = limit !== undefined && events.length > limit;
    return v4ConversationWorkflowRunEventsResultSchema.parse({
      events: hasMore ? events.slice(0, limit) : events,
      hasMore,
    });
  }

  /**
   * The enumeration query for dwf runs. It belongs to the same
   * family as workflowRunEvents: read-only, stateless, and safe to resend after a timeout. The default
   * and the clamping of `limit` live on the CLI side
   * (the run service) and are only passed through here; `resumable` is computed by the CLI from the
   * very same predicate as the resume gate.
   */
  async workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult> {
    const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRuns) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const runs = await this.host.listDynamicWorkflowRuns(params.sessionId, {
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return v4ConversationWorkflowRunsResultSchema.parse({ runs });
  }

  /**
   * The listing of a workflow run's **user-facing artifacts**.
   * It belongs to the same family as workflowRunEvents: read-only, stateless, and safe to resend
   * after a timeout.
   *
   * ⚠ Terminology: the artifact here is an output a script publishes to the user via `artifact.*`, not
   * the top-level return value of the run (which the engine internals happen to call the same thing).
   *
   * An unknown runId returns an empty listing instead of an error: a run that was already evicted /
   * never existed has no artifacts — that is a fact, not a failure, the same posture the event log
   * takes with an out-of-range cursor.
   */
  async workflowRunArtifacts(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactsResult> {
    const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifacts) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const artifacts = await this.host.listDynamicWorkflowRunArtifacts(params.sessionId, {
      runId: params.runId,
    });
    return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
  }

  /**
   * The data-fetching surface for preset dashboards: pagination over the `report` entries feeding a
   * given artifact.
   *
   * The **default and the clamping of `limit` both live here** (the storage layer fulfils them exactly,
   * never inventing a page size and never clamping again); `hasMore` follows the workflowRunEvents
   * convention of reading one extra entry to decide — the criterion must never be "this page happened
   * to be full", because that reports a false positive exactly when the entry count equals limit and
   * sends the dashboard paging for data that does not exist.
   */
  async workflowRunArtifactData(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
    const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifactItems) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunArtifactItems",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const limit = Math.max(
      1,
      Math.min(
        params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
        WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
      ),
    );
    const items = await this.host.listDynamicWorkflowRunArtifactItems(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      // The extra one is only used to determine hasMore; it does not enter the results page.
      limit: limit + 1,
    });
    const hasMore = items.length > limit;
    return v4ConversationWorkflowRunArtifactDataResultSchema.parse({
      items: hasMore ? items.slice(0, limit) : items,
      hasMore,
    });
  }

  /**
   * The bytes of a content artifact, **verbatim modeled on attachmentRead**: one chunk at a time,
   * ≤ 512 KiB (the schema already pins the upper bound of limit), and `nextOffset` being null means
   * the read has reached the end.
   *
   * **Authorization is entirely on the host side** (the port implementation): the run must belong to
   * the session `sessionId` ∧ the journal must contain a completed row for
   * `(artifactId, version)`; only then is the uri **on the row** used to read from the store. The
   * gateway only validates parameters and chunks — it has no journal, and it must not grow a second
   * authorization criterion (deciding once on each side means the same id will eventually be
   * interpreted differently on the two layers). The host returning `undefined` = no such version /
   * not your run / this is a dashboard (it has no bytes); all three are one and the same business
   * fact for the caller and are normalized here into a structured not found.
   *
   * An out-of-range `offset` is not an error: an empty chunk plus `nextOffset: null` is returned, the
   * same shape as reaching the end.
   */
  async workflowRunArtifactRead(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
    const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunArtifact) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const artifact = await this.readWorkflowArtifactPayload(params);
    const totalBytes = artifact.bytes.byteLength;
    const start = Math.min(params.offset, totalBytes);
    const end = Math.min(start + params.limit, totalBytes);
    const chunk = artifact.bytes.subarray(start, end);
    return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: artifact.mediaType,
      totalBytes,
      nextOffset: end < totalBytes ? end : null,
    });
  }

  /**
   * The listing of a workspace transcript: a run's `files.*` / `git.*` / `world.run` rows, without
   * their bodies.
   *
   * The host returning `undefined` (unknown run / not your run) yields an empty listing instead of an
   * error: the same posture as the artifact listing, and also a requirement of the authorization
   * chain — "do not tell an unauthorized caller which half of the guess was right". A listing longer
   * than maxNodes is truncated with `truncated` set — a run that executed `world.run` three thousand
   * times inside a loop must not blow up the side panel.
   */
  async workflowRunWorkspace(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
    const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunWorkspaceNodes) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunWorkspaceNodes",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const nodes =
      (await this.host.listDynamicWorkflowRunWorkspaceNodes(params.sessionId, {
        runId: params.runId,
      })) ?? [];
    const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
    return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
      nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  /**
   * The body of one workspace node, shape-preservingly bounded by `maxBytes` (both the default and
   * the limit are resultMaxBytes, and the clamping happens here).
   * Authorization is entirely on the host side; the host returning `undefined` = no such node / not
   * your run / not a world row, normalized into a structured not found.
   */
  async workflowRunNodeResult(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunNodeResultResult> {
    const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunNodeResult) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const maxBytes = Math.max(
      1,
      Math.min(
        params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
        WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
      ),
    );
    const result = await this.host.readDynamicWorkflowRunNodeResult(params.sessionId, {
      runId: params.runId,
      siteId: params.siteId,
      ordinal: params.ordinal,
      maxBytes,
    });
    if (result === undefined) {
      throw new Error(
        `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
      );
    }
    return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
  }

  /**
   * The **entire** payload of one artifact version, cached.
   *
   * The port's `readArtifact` returns the whole payload, while
   * `workflowRunArtifactRead` is a **chunked** query — without caching, fetching a 20 MiB PDF in
   * 512 KiB chunks over 40 requests would read the whole file from the store 40 times (800 MiB of
   * I/O), and every chunk would walk the journal authorization chain again. `attachmentRead` already
   * has this table, so it is reused here (see the argument in {@link BinaryReadCacheEntry} for why the
   * two families share one table).
   *
   * What is cached is the **promise, not the result**, and it is written into the table before the
   * read starts: concurrent chunks therefore share one and the same read, instead of each starting
   * its own and each writing the cache again.
   *
   * The cache never bypasses authorization: the key carries `sessionId`, and `sessionId` is exactly
   * what the port's authorization chain compares (the run's parentSessionId must equal it) — another
   * session is another key, so the port is necessarily consulted again. When a session is destroyed
   * the whole slice is cleared by `sessionId`, the same rule as for attachments.
   *
   * The host returning `undefined` (not your run / no such version / it is a dashboard) **throws**
   * here instead of being cached: it takes the existing catch branch, which deletes the entry, so a
   * race where "the publish has just landed but the read is slightly early" is not pinned down by a
   * negative cache for 30 seconds.
   */
  private readWorkflowArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // The first paragraph tag `dwfart`: shares the same table with the attachment preview and is isolated by the first paragraph (see BinaryReadCacheEntry).
    const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    const payload = this.host.readDynamicWorkflowRunArtifact!(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      version: params.version,
    })
      .then((artifact) => {
        if (artifact === undefined) {
          throw new Error(
            `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
          );
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = artifact.bytes.byteLength;
          this.binaryReadCacheBytes += artifact.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        // contentType is normalized to the mediaType vocabulary in the table; the value is still the one in the journal record
        // (The exact matching contract of the UI dispatch renderer), not the one pushed by the store by file name.
        return { bytes: artifact.bytes, mediaType: artifact.contentType };
      })
      .catch((error: unknown) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, {
      sessionId: params.sessionId,
      accessedAt: now,
      bytes: null,
      payload,
    });
    return payload;
  }

  /**
   * The host record prerequisite for the two dwf journal read surfaces.
   *
   * Both queries read the journal through an app capability, while the host looks up the record by
   * sessionId — and a historical session's record is activated only by the **subscribe** path. The
   * discovery query's effect is declared before the lease/subscribe effect in the renderer, and the
   * CLI dispatches requests strictly serially (`zcode-protocol/transport.ts`, where only session/stop
   * jumps the queue), so when "a historical session is opened after a restart" it is necessarily
   * processed before the subscription and necessarily gets sessionNotFound: the tool card's join
   * fallback disappears entirely, the card falls back to its compiled state, and an interrupted run
   * does not even have an entry point.
   *
   * Only the record is pulled, and **no** READY publisher is created: the journal is unrelated to the
   * conversation log, and reading one page of a run needs no projection (the same judgement is why
   * these two queries deliberately carry no atSeq/atLogEpoch). The idiom is literally identical to
   * attachmentBegin; `ensureResumed` is single-flighted per session itself and shares one and the
   * same activation with a concurrent subscription.
   *
   * The liveness determination must be the same
   * `hasLiveConversation` as in subscribe, and must not look at `sessionExists` alone. A dwf actor
   * transcript is a detached live session — the real runtime lives in the run service and the host
   * deliberately has no record for it; the discovery query of a nested SessionPane arrives here
   * carrying the actor id, and the old determination materializes a second (ghost) runtime for a
   * session that is **actually running**: it appends SessionResumed to the same event log, drops
   * pending steers and replays resume hooks, the double write scrambles the sequence ledger, and the
   * transcript freezes from then on (the symptom is the live view freezing at "working for xx
   * seconds").
   */
  private async ensureHostRecordForJournalRead(sessionId: string): Promise<void> {
    if (this.hasLiveConversation(sessionId)) return;
    await this.coldResume.ensureResumed(sessionId);
  }

  async fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult> {
    const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
    if (!this.host.getConversationFileChanges) {
      throw new Error("fault.fileChanges.unsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileChanges");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.getConversationFileChanges(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  async backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult> {
    const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
    // Observed queries cannot hydrate/restore cold sessions; tasks are authorized by the existing runtime.
    if (!this.host.readBackgroundBashOutput) return { kind: "unsupported", workId };
    return backgroundBashOutputResultSchema.parse(
      await this.host.readBackgroundBashOutput(sessionId, workId),
    );
  }

  async fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult> {
    const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
    if (!this.host.previewConversationFileRewind) {
      throw new Error("fault.fileRewindPreview.unsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileRewindPreview");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.previewConversationFileRewind(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  private resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
    const snapshot = publisher.getSnapshot();
    if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
    if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
    const resolution = publisher.resolveRowActionTarget(params.target, action);
    if (!resolution.ok) throw new Error(resolution.reasonCode);
    return resolution;
  }

  /** begin only admits metadata; it does not decode or buffer the full payload. */
  async attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult> {
    const params = v4AttachmentBeginParamsSchema.parse(rawParams);
    if (!this.host.putSessionAttachment) {
      throw new Error("fault.attachment.putUnsupported");
    }
    if (!this.host.sessionExists(params.sessionId)) {
      await this.coldResume.ensureResumed(params.sessionId);
    }
    return this.attachmentUploads.begin(params);
  }

  async attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult> {
    return this.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
  }

  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult> {
    return this.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
  }

  async attachmentAbort(rawParams: unknown): Promise<void> {
    await this.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
  }

  async attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult> {
    const params = v4AttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new Error("fault.attachment.readUnsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      // The ref passed by renderer cannot directly become a file path; it must first be passed by the current session
      // The authoritative user row proves ownership and avoids reading across sessions or arbitrary paths.
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }

    const payload = await this.readAttachmentPayload(
      params.sessionId,
      params.ref,
      resolution.attachment.mime,
      resolution.messageId,
      resolution.attachmentIndex,
    );
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return {
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    };
  }

  async conversationAttachmentRead(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentReadResult> {
    const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let payload: { bytes: Uint8Array; mediaType: string };
    try {
      payload = await this.readAttachmentPayload(
        params.sessionId,
        params.ref,
        attachment.mime,
        messageId,
        params.attachmentIndex,
        true,
      );
    } catch (error) {
      throw toShareStatFault(error);
    }
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return v4ConversationAttachmentReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    });
  }

  async conversationAttachmentStat(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentStatResult> {
    const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
    if (!this.host.statSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let result: { totalBytes: number; mediaType: string; mtimeMs?: number };
    try {
      result = await this.host.statSessionAttachment(params.sessionId, {
        ref: params.ref,
        mime: attachment.mime,
        ...(messageId ? { messageId } : {}),
        attachmentIndex: params.attachmentIndex,
      });
    } catch (error) {
      // "The attachment is indeed no longer there" is the only category that the share pre-check can definitely determine as skipped, and it must be thrown up with a stable code;
      // Otherwise the service can only guess the error text.
      throw toShareStatFault(error);
    }
    // The stat result was once stuck by the schema upper limit of 30MiB, and a ZodError was thrown here for oversized attachments.
    // Therefore, the share preflight downgrades the "known capacity exceeded" definite block to deferred and silently discards the content.
    // After the upper limit is relaxed, an explicit exit is still needed: a stable code is given when it really exceeds the expressible range of the protocol.
    if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
    }
    return v4ConversationAttachmentStatResultSchema.parse(result);
  }

  async attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult> {
    const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }
    if (
      params.clientMode !== "desktop-continuous" ||
      !resolution.attachment.mime.startsWith("video/") ||
      !this.host.resolveSessionAttachmentPreviewSource
    ) {
      return { kind: "chunked" };
    }
    const result = await this.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
      ref: params.ref,
      mime: resolution.attachment.mime,
      ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
      ...(resolution.attachmentIndex !== undefined
        ? { attachmentIndex: resolution.attachmentIndex }
        : {}),
    });
    return v4AttachmentPreviewSourceResultSchema.parse(result);
  }

  private resolveReadableMediaAttachment(
    publisher: ConversationTopicPublisher,
    sessionId: string,
    ref: string,
    target?: { rowId: number; entityId: string },
    attachmentIndex?: number,
  ): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
    const isPreviewable = (attachment: AttachmentRef) => {
      const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      return mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf";
    };
    const matchesRef = (attachment: AttachmentRef) =>
      attachment.ref === ref || attachment.previewRef === ref;
    if (target && attachmentIndex !== undefined) {
      const row = publisher
        .getSnapshot()
        .rows.window.find(
          (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
        );
      if (row?.kind !== "userInput") return null;
      const attachment = row.attachments?.[attachmentIndex];
      if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
        return null;
      }
      // The hot renderer may still hold the original ref, while the hydrated authoritative row has been filled in
      // previewRef; both belong to the same row/index, and the authorization cannot be misjudged as cross-row reading due to different projection timings.
      const messageId = publisher.getMessageIdForRow(row.rowId);
      return {
        attachment,
        attachmentIndex,
        ...(messageId ? { messageId } : {}),
      };
    }

    // The old renderer does not have a row target and cannot locate persistent artifacts by message; once
    // If previewRef exists, only the durable ref can be authorized, and the variable original path cannot be re-released.
    for (const row of publisher.getSnapshot().rows.window) {
      if (row.kind === "userInput") {
        for (const attachment of row.attachments ?? []) {
          if (!isPreviewable(attachment)) continue;
          if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
        }
      }
      if (
        row.kind === "assistantText" &&
        artifactRefBelongsToSession(ref, sessionId) &&
        extractMarkdownArtifactImageRefs(row.text).includes(ref)
      ) {
        // assistant Markdown can reference the session artifact produced by the tool,
        // However, the old authorization only viewed userInput.attachments, causing legitimate images to be harden after entering the UI.
        // Interception. Still use the authoritative projection of the current session for accurate ref authorization, never accept renderer
        // Self-reported arbitrary artifact/path. Markdown is model-controllable text, so URI authority
        // It must also exactly match the current request session; just "appearing in the current projection" does not prove that it has the right
        // Read artifacts from another session.
        return {
          attachment: {
            ref,
            fileName: "assistant-image",
            mime: "image/*",
            bytes: 0,
          },
        };
      }
    }
    return null;
  }

  /**
   * Reads all the bytes of an attachment (with a TTL / capacity cache).
   *
   * Mind the semantics: the offset/limit of conversationAttachmentRead is a **slice**, not a streaming
   * read — every first request materializes the whole attachment into memory and then slices it, and
   * later chunks hit the same cached copy.
   * Integrators must not plan huge files around the chunk protocol as if it were "fetch segment by
   * segment on demand"; a real range read needs offset support in the host-side readBinaryFile (not
   * implemented yet).
   */
  private readAttachmentPayload(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric = false,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // First section tag `att`: This table is shared with dwf product bytes (see BinaryReadCacheEntry), two key spaces
    // Can only be isolated by an impossible first segment.
    const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    // The preview read has a total limit of 20MiB that has been reused and uploaded; video use has a global input limit.
    // image and upload transactions continue to maintain the original boundaries.
    const maxBytes = allowGeneric
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : mime.startsWith("video/")
        ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
        : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
    const payload = this.host.readSessionAttachment!(sessionId, {
      ref,
      mime,
      maxBytes,
      ...(messageId ? { messageId } : {}),
      ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
    })
      .then((result) => {
        const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          !allowGeneric &&
          !resultMime.startsWith("image/") &&
          !resultMime.startsWith("video/") &&
          resultMime !== "application/pdf"
        ) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
        }
        if (result.bytes.byteLength > maxBytes) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = result.bytes.byteLength;
          this.binaryReadCacheBytes += result.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        return result;
      })
      .catch((error) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, { sessionId, accessedAt: now, bytes: null, payload });
    return payload;
  }

  private pruneBinaryReadCache(now = this.now()): void {
    for (const [key, entry] of this.binaryReadCache) {
      if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
        this.deleteBinaryReadCacheEntry(key);
      }
    }
    if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
    const oldest = [...this.binaryReadCache.entries()]
      .filter(([, entry]) => entry.bytes !== null)
      .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    for (const [key] of oldest) {
      this.deleteBinaryReadCacheEntry(key);
      if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
    }
  }

  private deleteBinaryReadCacheEntry(key: string): void {
    const entry = this.binaryReadCache.get(key);
    if (!entry) return;
    this.binaryReadCache.delete(key);
    this.binaryReadCacheBytes = Math.max(0, this.binaryReadCacheBytes - (entry.bytes ?? 0));
  }

  /** v4/conversation/unsubscribe. */
  unsubscribe(rawParams: unknown): void {
    const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      const workspaceId = parseSessionsIndexTopic(params.topic);
      if (workspaceId !== null) {
        this.indexPublishers
          .get(workspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
        return;
      }
      const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
      if (configWorkspaceId !== null) {
        this.configPublishers
          .get(configWorkspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
      }
      return;
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const state = this.flushStates.get(routeKey);
    if (!state) return;
    if (state?.timer) clearTimeout(state.timer);
    this.flushStates.delete(routeKey);
    // Naked subscriptionId can collide in different topics/connections; the old gateway first presses the subId
    // If the counter-inspection casts a wide net on the three types of publishers, other links will be deleted. topic + connection must hit at the same time.
    this.publishers.get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
  }

  /**
   * v4/command: the six-state adjudication of the inbox; when accepted, the side effect is executed
   * and the terminal state is returned together with the response.
   *
   * This used to "return the initial ACK immediately and settle in the background", which meant the
   * callers of createSession/forkAssistant could not get result.sessionId (settle only backfills the
   * idempotency table, readable only by retrying the same commandId) — violating
   * "accepted carries its result immediately". The command side effect itself returns fast (sendPrompt
   * starts the turn in the background), so awaiting does not hang the RPC until the whole turn ends,
   * hence the synchronous wait for the terminal state.
   * Settle still freezes the result for duplicate replay.
   */
  async handleCommand(rawParams: unknown): Promise<CommandAck> {
    let ttftCapacityRejected = false;
    const ttftCommand =
      typeof rawParams === "object" && rawParams !== null && "ttft" in rawParams
        ? parseCommandEnvelope(rawParams)
        : undefined;
    if (ttftCommand?.ok && ttftCommand.envelope.ttft) {
      const sessionId = ttftCommand.envelope.sessionId;
      const control = sessionId ? this.publishers.get(sessionId)?.getSnapshot().control : undefined;
      ttftCapacityRejected = !this.localTtft.receive(
        ttftCommand.envelope,
        control?.canStop === true,
      );
    }
    // READY only exists in the cold recovery window; normal commands enter the inbox directly to avoid repeated parsing of envelopes.
    if (this.readyFlights.size > 0) {
      const parsed = parseCommandEnvelope(rawParams);
      const sessionId = parsed.ok ? parsed.envelope.sessionId : null;
      const ready = sessionId === null ? undefined : this.readyFlights.get(sessionId);
      if (ready) await ready;
    }

    const outcome = await this.inbox.handle(rawParams);
    if (outcome.kind === "ack")
      return {
        ...outcome.ack,
        ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
      };
    this.localTtft.admitted(outcome.envelope.commandId);
    let durableInputIntent: ConversationInputIntent | null = null;
    let settledAck: CommandAck | null = null;
    type CommandFinal = Parameters<typeof outcome.settle>[0];
    const reportError = (scope: string, error: unknown): void => {
      try {
        this.host.onError?.(scope, error);
      } catch {
        // Error observers cannot reversely destroy command final and session FIFO closures.
      }
    };
    const settleOnce = (final: CommandFinal): CommandAck => {
      if (settledAck) return settledAck;
      const ack = {
        ...outcome.ack,
        ...final,
        ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
      };
      outcome.settle(final);
      settledAck = ack;
      return ack;
    };
    const cancelDurableInput = async (reason: string): Promise<void> => {
      if (!durableInputIntent) return;
      try {
        await this.host.cancelCommandInput?.(outcome.envelope, outcome.queueItemId, reason);
      } catch (cancelError) {
        // The original command ACK must retain the actual execution result; if the ledger cancel fails, a separate alarm will be issued and the original error cannot be overwritten.
        reportError("v4.command.input.cancel", cancelError);
      }
    };
    const releaseDurableInput = (
      final: Pick<CommandAck, "status" | "reasonCode" | "message" | "result">,
    ) => {
      if (!durableInputIntent || outcome.envelope.sessionId === null) return;
      try {
        this.inbox.releaseLiveInput(
          {
            sessionId: outcome.envelope.sessionId,
            commandId: durableInputIntent.sourceCommandId,
          },
          { ...outcome.ack, ...final },
        );
      } catch (releaseError) {
        reportError("v4.command.input.release", releaseError);
      }
    };
    try {
      const admission = {
        admissionSeq: outcome.admissionSeq,
        admittedAt: outcome.admittedAt,
        queueItemId: outcome.queueItemId,
      };
      const admissionPublisher =
        outcome.envelope.type === "createSession"
          ? new ConversationTopicPublisher(`pending-${outcome.envelope.commandId}`, "admission", {
              now: this.now,
            })
          : outcome.envelope.sessionId === null
            ? null
            : this.ensurePublisher(outcome.envelope.sessionId);
      const admissionProjectionBytes = admissionPublisher?.measureInputAdmissionProjectionBytes(
        outcome.envelope,
        admission,
      );
      if (
        admissionProjectionBytes !== null &&
        admissionProjectionBytes !== undefined &&
        admissionProjectionBytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      ) {
        return settleOnce({
          status: "failed",
          reasonCode: "proto.payloadTooLarge",
          message: `conversation projection would exceed ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
        });
      }
      durableInputIntent =
        (await this.host.admitCommandInput?.(outcome.envelope, admission)) ?? null;
      if (durableInputIntent && outcome.envelope.sessionId !== null) {
        this.inbox.pinLiveInput(outcome.envelope.sessionId, durableInputIntent);
      }
      const result = await this.host.executeCommand(outcome.envelope, admission);
      const final = {
        status: "accepted" as const,
        ...(result ? { result } : {}),
      };
      return settleOnce(final);
    } catch (error) {
      // Noop is not a failure (the same value switch is closed): no onError is entered, and noop ACK is returned.
      if (error instanceof V4CommandNoopError) {
        await cancelDurableInput(error.reasonCode);
        const final = {
          status: "noop" as const,
          reasonCode: error.reasonCode,
        };
        releaseDurableInput(final);
        return settleOnce(final);
      }
      reportError("v4.command.execute", error);
      // Domain error carrying reasonCode (V4PromptRejectedError / heldQueueDispositionRequired, etc.)
      // Upstream as it is, the client can be diverted according to the guard error code; otherwise, it will be normalized to executionFailed.
      const domainReasonCode =
        typeof (error as { reasonCode?: unknown } | null)?.reasonCode === "string"
          ? String((error as { reasonCode: string }).reasonCode)
          : null;
      const final = {
        status: "failed" as const,
        reasonCode:
          error instanceof V4CommandNotImplementedError
            ? "fault.command.notImplemented"
            : (domainReasonCode ?? "fault.command.executionFailed"),
        message: error instanceof Error ? error.message : String(error),
      };
      await cancelDurableInput(final.reasonCode);
      releaseDurableInput(final);
      return settleOnce(final);
    } finally {
      if (!settledAck) {
        // publisher/measure/admission Any sync exception used to skip settle,
        // As a result, the same command will wait forever and the same session FIFO will not be able to continue admission.
        const final = {
          status: "failed" as const,
          reasonCode: "fault.command.executionFailed",
          message: "command admission terminated before a durable final was recorded",
        };
        releaseDurableInput(final);
        settleOnce(final);
      }
    }
  }

  /** v4/commands/query: shares the CommandInbox gate with handleCommand under the same key. */
  async queryCommands(rawParams: unknown): Promise<CommandsQueryResult> {
    const receivedAt = localTtftNow();
    const params = commandsQueryParamsSchema.parse(rawParams);
    // Calibration is a pure clock probe and cannot trigger command ledger queries, recovery, or admission gates.
    if (params.clock)
      return {
        results: params.commands.map((key) => ({ key, result: "unknown" as const })),
        clock: { instanceId: this.localTtft.instanceId, receivedAt, sentAt: localTtftNow() },
      };
    await Promise.all(
      params.commands.map((key) => {
        const ready = key.sessionId === null ? undefined : this.readyFlights.get(key.sessionId);
        return ready;
      }),
    );
    return commandsQueryResultSchema.parse({
      results: await this.inbox.query(params.commands),
    });
  }

  getQueueItem(sessionId: string, queueItemId: string): QueueItem | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
    return item ?? null;
  }

  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.kind === kind),
    );
  }

  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue"): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
    );
  }

  getQueueLength(sessionId: string): number {
    return this.publishers.get(sessionId)?.getSnapshot().queue.items.length ?? 0;
  }

  /** Resident reclamation guard: it must not be closed while either the publisher queue or the pinned CommandInbox facts exist. */
  hasResidencyBlockingCommands(sessionId: string): boolean {
    return this.getQueueLength(sessionId) > 0 || this.inbox.hasPinnedSessionState(sessionId);
  }

  getQueueHead(sessionId: string): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items[0];
    if (!snapshot || !item) return null;
    return {
      autoDrain: snapshot.queue.autoDrain,
      dispatchState: item.dispatch.state,
      kind: item.kind,
      queueItemId: item.queueItemId,
      text: item.text,
    };
  }

  /**
   * The current input routing mode (a native v4 capability, used by the command layer's
   * host.getInputRoutingMode):
   * the held choice adjudication (heldQueueInputRequiresChoice) reads the projection's
   * inputRouting.mode.
   */
  getInputRoutingMode(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
    return this.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
  }

  getSessionFollowupMode(sessionId: string): "queue" | "guide" | null {
    return this.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
  }

  /**
   * rowId → the authoritative messageId (a native v4 capability, used by forkAssistant/retryTurn to
   * locate the assistant row).
   * No publisher for the session / the row does not exist / not an assistant row → null (the command
   * layer rejects on that basis and never falls back silently).
   */
  getMessageIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
  }

  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ) {
    return this.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
  }

  /** rowId → all transcript messageIds within the owning product turn (file summary revocation / diff queries). */
  getMessageIdsForTurnRow(sessionId: string, rowId: number): string[] {
    return this.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
  }

  /** The fork target must be the last assistantText of its own turn (no projection → null, treated as unknown). */
  isLatestAssistantSegmentRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
  }

  resolveStableForkCandidate(sessionId: string, rowId: number) {
    return this.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
  }

  /** latestAssistantRetryOnly: the retry target must be the newest assistantText across the whole timeline that has a realUser cause. */
  isLatestRetryAssistantRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
  }

  /** latestQueryEditOnly: the edit target must be the last realUser userInput row in the current projection. */
  isLatestEditableUserRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
  }

  /** rowId → product turnId (editUserQuery looks up the user messageId when there is no assistant anchor). */
  getTurnIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
  }

  /**
   * rowId → the rewind anchor messageId of the owning turn (for editUserQuery: a user row has no
   * messageId, so the messageId of the assistant row in the same turn is used as the `/rewind` target).
   */
  getTurnRewindAnchor(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
  }

  /**
   * Session close: clears the publisher and all of its subscription scheduling; the hydration flag is
   * cleared as well (reopening goes through a cold-start rebuild);
   * and it removes the session from its workspace index (session.removed is pushed to the list subscribers).
   */
  disposeSession(sessionId: string): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: false,
      notifyIndexRemoved: true,
    });
  }

  /**
   * Resident capacity deactivation: the same in-memory runtime cleanup as disposeSession, but the
   * session is **not** removed from sessions-index (no session.removed is sent) — deactivation is a
   * pure memory optimization, the sidebar list entry must be preserved as is, and subscribing again
   * transparently rebuilds it through the cold restore.
   */
  deactivateSession(sessionId: string): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: true,
      notifyIndexRemoved: false,
    });
  }

  /**
   * A pure precheck for Resident reclamation: the caller may refuse an unsafe reclamation before
   * tearing down the runtime event subscription.
   * deactivateSession still reuses the same check, so that future callers cannot bypass the
   * execution-side preflight.
   */
  assertSessionRuntimeDeactivatable(sessionId: string): void {
    if (!this.inbox.hasPinnedSessionState(sessionId)) return;
    throw new Error(`Session command inbox is still pinned: ${sessionId}`);
  }

  /** The Resident reclamation decision: does this session still have conversation subscribers (desktop tab / phone remote). */
  hasConversationSubscribers(sessionId: string): boolean {
    return this.publishers.get(sessionId)?.hasSubscribers() ?? false;
  }

  /**
   * In-memory diagnostic counters. Reads size only and does not touch any state.
   * detachedLive is used to observe whether a child session's publisher is released together with its
   * parent session.
   */
  collectMemoryDiagnostics(): Record<string, number> {
    return {
      publishers: this.publishers.size,
      detachedLive: this.detachedLiveSessions.size,
      detachedTerminal: this.detachedTerminalAt.size,
      rawSeqStates: this.rawSequenceStates.size,
    };
  }

  private cleanupSessionRuntime(
    sessionId: string,
    options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
  ): void {
    if (options.clearCommandInbox) {
      // Clearing the in-flight/live command breaks idempotence and FIFO. resident facts already before recycling
      // Interception; if it still hits here, it must fail before removing the publisher, and cannot leave a half-clear state.
      this.assertSessionRuntimeDeactivatable(sessionId);
    }
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.disposed",
        `conversation session disposed while waiting for projection event commit: ${sessionId}`,
      ),
    );
    this.attachmentUploads.clearSession(sessionId);
    for (const [key, entry] of this.binaryReadCache) {
      if (entry.sessionId === sessionId) this.deleteBinaryReadCacheEntry(key);
    }
    if (options.notifyIndexRemoved) {
      // First get the workspaceId (while the session record is still there) and push session.removed to the list subscribers.
      try {
        const workspaceId = this.host.getSessionWorkspaceId?.(sessionId) ?? null;
        if (workspaceId !== null) {
          const indexPublisher = this.indexPublishers.get(workspaceId);
          // When there are no subscribers, the projection must be updated first to avoid existing publishers from
          // Resurrection of deleted sessions in subscribe's snapshot; flushIndex is naturally no-op for empty subscriptions.
          if (indexPublisher?.removeSession(sessionId)) {
            this.flushIndex(workspaceId);
          }
        }
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.remove", error);
      }
    }
    this.indexFanoutThrottle.clearSession(sessionId);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (state.timer) clearTimeout(state.timer);
      this.flushStates.delete(routeKey);
    }
    this.publishers.delete(sessionId);
    this.hydratedSessions.delete(sessionId);
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) hydrationBuffer.cancelled = true;
    this.hydrationBuffers.delete(sessionId);
    this.hydrationInFlight.delete(sessionId);
    this.readyFlights.delete(sessionId);
    this.rawSequenceStates.delete(sessionId);
    if (options.clearCommandInbox) this.inbox.clearSession(sessionId);
    this.telemetryNormalizer.clearSession(sessionId);
    this.detachedLiveSessions.delete(sessionId);
    this.projectionFaultedSessions.delete(sessionId);
    // detached child ownership cleanup: as a child, remove yourself from the parent table; as a parent, you will also release the child without a record.
    this.detachedTerminalAt.delete(sessionId);
    const parentId = this.detachedChildParent.get(sessionId);
    if (parentId !== undefined) {
      this.detachedChildParent.delete(sessionId);
      const siblings = this.detachedChildrenByParent.get(parentId);
      siblings?.delete(sessionId);
      if (siblings && siblings.size === 0) this.detachedChildrenByParent.delete(parentId);
    }
    const children = this.detachedChildrenByParent.get(sessionId);
    if (children) {
      this.detachedChildrenByParent.delete(sessionId);
      for (const childId of children) {
        this.detachedChildParent.delete(childId);
        if (this.host.sessionExists(childId)) continue;
        this.releaseDetachedChild(childId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.localTtft.clear();
    for (const sessionId of this.projectionEventCommitWaiters.keys()) {
      this.rejectProjectionEventWaiters(
        sessionId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway disposed while waiting for projection event commit",
        ),
      );
    }
    clearInterval(this.attachmentPruneTimer);
    this.indexFanoutThrottle.clear();
    this.attachmentUploads.clear();
    this.binaryReadCache.clear();
    this.binaryReadCacheBytes = 0;
    for (const state of this.flushStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.flushStates.clear();
    this.publishers.clear();
    this.hydratedSessions.clear();
    for (const buffer of this.hydrationBuffers.values()) buffer.cancelled = true;
    this.hydrationBuffers.clear();
    this.hydrationInFlight.clear();
    this.readyFlights.clear();
    this.rawSequenceStates.clear();
    this.telemetryEventIds.clear();
    this.detachedLiveSessions.clear();
    this.detachedChildParent.clear();
    this.detachedChildrenByParent.clear();
    this.detachedTerminalAt.clear();
    this.projectionFaultedSessions.clear();
    this.coldResume.clear();
    this.indexPublishers.dispose();
    this.configPublishers.clear();
    this.pausedConnections.clear();
  }

  /** A test probe: drains a subscription immediately (bypassing the timer). */
  flushNow(subscriptionId: string): ConversationTopicFrame | null {
    const match = [...this.flushStates.entries()].find(
      ([, state]) => state.subscriptionId === subscriptionId,
    );
    const state = match?.[1];
    if (!state) return null;
    if (this.pausedConnections.has(state.connectionId)) return null;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const publisher = this.publishers.get(state.sessionId);
    if (!publisher) return null;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  private ensurePublisher(sessionId: string): ConversationTopicPublisher {
    let publisher = this.publishers.get(sessionId);
    if (!publisher) {
      publisher = new ConversationTopicPublisher(sessionId, this.createLogEpoch(sessionId), {
        now: this.now,
      });
      this.publishers.set(sessionId, publisher);
      // config seed: Create and inject runtime true values ​​(no delta / no bump revision).
      this.seedPublisherConfig(sessionId, publisher);
    }
    return publisher;
  }

  /**
   * config seed injection (defensive: a failing seed does not break the main conversation path).
   * It is idempotent and event-first (seedConfig skips the fields already touched by events), so it is
   * called both at publisher creation and at the end of hydration — the creation moment can precede
   * the record being fully in place (during createSessionRecord event wiring), and the hydration-side
   * call closes that window.
   */
  private seedPublisherConfig(sessionId: string, publisher: ConversationTopicPublisher): void {
    const getSeed = this.host.getSessionConfigSeed;
    if (!getSeed) return;
    try {
      const seed = getSeed.call(this.host, sessionId);
      if (seed) publisher.seedConfig(seed);
    } catch (error) {
      this.host.onError?.("v4.configSeed", error);
    }
  }

  /**
   * The cold-restore READY is created only at entries that explicitly need activation; hydratePublisher
   * stays projection-only.
   * The registration promise precedes activation, so that once the record is registered early,
   * concurrent command/query cannot overtake the restore watermark.
   */
  private ensureColdReadyPublisher(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ConversationTopicPublisher> {
    const existingFlight = this.readyFlights.get(sessionId);
    if (existingFlight) return existingFlight;
    // Register the same READY before starting all the time-consuming work.
    const operation = Promise.resolve().then(async () => {
      const persistedMessages = await this.coldResume.ensureResumed(
        sessionId,
        resumeThoughtLevel,
        workspace,
      );
      return this.hydratePublisher(sessionId, persistedMessages);
    });
    this.readyFlights.set(sessionId, operation);
    // Both success and failure are released by the same cleanup function; no derived promises are created that would propagate rejection repeatedly.
    const clear = () => {
      if (this.readyFlights.get(sessionId) === operation) this.readyFlights.delete(sessionId);
    };
    void operation.then(clear, clear);
    return operation;
  }

  /**
   * The projection rebuild on the first subscription (hydration). The semantics are in the subscribe
   * comment;
   * synthesized events are deduplicated by sequenceNumber (live events the publisher already ingested
   * are not replayed).
   */
  private hydratePublisher(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existing = this.publishers.get(sessionId);
    // Hydrated live publisher: direct reuse (avoiding repeated rebuilds/double counting).
    if (existing && this.hydratedSessions.has(sessionId)) return Promise.resolve(existing);

    const inFlight = this.hydrationInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const buffer: HydrationBuffer = {
      cancelled: false,
      eventIds: new Set<string>(),
      rawEvents: [],
    };
    this.hydrationBuffers.set(sessionId, buffer);
    const hydration = this.performHydration(
      sessionId,
      buffer,
      persistedMessages,
      forceRebuild,
    ).finally(() => {
      if (this.hydrationBuffers.get(sessionId) === buffer) {
        this.hydrationBuffers.delete(sessionId);
      }
      if (this.hydrationInFlight.get(sessionId) === hydration) {
        this.hydrationInFlight.delete(sessionId);
      }
    });
    this.hydrationInFlight.set(sessionId, hydration);
    return hydration;
  }

  private async performHydration(
    sessionId: string,
    buffer: HydrationBuffer,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existingAtStart = this.publishers.get(sessionId);
    const liveSessionAtStart = this.host.sessionExists(sessionId);
    const hydrationStartedAt = performance.now();
    this.host.onDebug?.(
      `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
        `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
        `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
    );
    const loaded: PersistedEventsLoadResult = this.host.loadPersistedEvents
      ? await this.host.loadPersistedEvents(sessionId, persistedMessages).catch((error) => {
          this.host.onError?.("v4.hydrate", error, {
            durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
            existingPublisherAtStart: existingAtStart !== undefined,
            liveSessionAtStart,
            phase: "loadPersistedEvents",
            persistedMessages: persistedMessages?.length ?? 0,
            sessionId,
          });
          return { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
        })
      : { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };

    this.host.onDebug?.(
      `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
        `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
        `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
    );

    if (this.disposed || buffer.cancelled) {
      throw new Error(`v4 hydration cancelled for session ${sessionId}`);
    }

    // assistant conservation: publishers that have rejected text streams are not trusted - they are built on
    // After TurnStarted, missing segments cannot be filled in with append-only replay and can only be reconstructed as a whole.
    const latestPublisher = this.publishers.get(sessionId);
    const existingDroppedContent =
      latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
    // The event log is complete (synthesized=false) and has a healthy live publisher (streaming) → retained, not replayed.
    if (
      existingAtStart &&
      latestPublisher === existingAtStart &&
      !loaded.synthesized &&
      !forceRebuild &&
      !existingDroppedContent
    ) {
      // The seed may fail when created (the record has not yet been registered), and the first subscription will be replenished (idempotent, event priority).
      this.hydrationBuffers.delete(sessionId);
      this.seedPublisherConfig(sessionId, latestPublisher);
      if (loaded.sharedContextImport) {
        latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
      }
      await this.seedPublisherUsage(
        sessionId,
        latestPublisher,
        persistedMessages,
        loaded.usageSeed,
      );
      this.hydratedSessions.add(sessionId);
      this.publishCurrentSummaryToIndex(sessionId);
      return latestPublisher;
    }

    // Just remembering the existing reference before await is not enough: load waits for raw event during
    // The publisher will continue to be promoted, but it will be deleted entirely after the synthesized return, and the queue/stream will follow.
    // disappear. Rebuild using sourceEventSeq as the raw snapshot boundary, and fill in the events within the waiting window.
    const publisher = latestPublisher ?? existingAtStart ?? this.ensurePublisher(sessionId);
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.rehydrated",
        `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
      ),
    );
    publisher.rehydrate(loaded.events, {
      // When restored, the transcript/event store may still contain oversized text that was rejected at runtime. cannot let the same fact
      // After the CLI is restarted, the subscribe is stuck again; skip the non-transmissible projection event and continue the reduction.
      // Subsequent persistent TurnError/TurnComplete stops the cold snapshot at the last recoverable boundary.
      onPayloadTooLarge: (error) =>
        this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "publisher.rehydrate",
          sessionId,
        }),
    });
    if (loaded.sharedContextImport) {
      publisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
    // The seeds restored in the same time are applied first, and then the live buffer is filled; the newer usage and mode selection events always win.
    if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
    const sourceEventSeq = Math.max(
      0,
      loaded.sourceEventSeq ??
        (loaded.synthesized
          ? 0
          : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
    );
    const previousSequenceState = this.rawSequenceStates.get(sessionId);
    const sequenceState: RawSequenceState = {
      sourceEventSeq,
      offset: publisher.getSnapshot().seq - sourceEventSeq,
      lastTransportSeq: publisher.getSnapshot().seq,
      seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
      appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
      failedEventById: new Map(previousSequenceState?.failedEventById),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, sequenceState);
    // The sourceEventSeq of persistent reading is the water level at the beginning of load; hydration buffer
    // Only events after load starts can be logged. If seq=N has entered live publisher before buffer is created, and
    // When load only reads N-1, it cannot replay only N+1 after rehydrate: raw reorder will wait forever for data that has been
    // The missing N also causes the running Agent control line to disappear. Keep the raw tail the same size as publisher,
    // Merge with await window buffer and replay continuously from persistence boundary.
    const replayByEventId = new Map<string, SessionEvent>();
    for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    for (const rawEvent of buffer.rawEvents) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    const replayEvents = [...replayByEventId.values()].sort((left, right) => {
      if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
        return left.sequenceNumber - right.sequenceNumber;
      }
      if (left.sequenceNumber > 0) return -1;
      if (right.sequenceNumber > 0) return 1;
      return 0;
    });
    for (const rawEvent of replayEvents) {
      for (const normalized of this.normalizeRuntimeEventSequence(sessionId, rawEvent)) {
        try {
          publisher.ingest(normalized);
          this.resolveProjectionEventCommit(sessionId, String(normalized.id));
        } catch (error) {
          this.rejectProjectionEventCommit(
            sessionId,
            String(normalized.id),
            new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply hydrated event ${String(normalized.id)}`,
              { cause: error },
            ),
          );
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
            phase: "replayBufferedEvents",
            sessionId,
          });
        }
      }
    }
    // The publisher has been replaced and the buffer has been filled synchronously; within the asynchronous waiting window of usage seed, the new raw
    // The event directly enters the new publisher through the per-session sequence state above, without the need for a second replay.
    if (this.hydrationBuffers.get(sessionId) === buffer) {
      this.hydrationBuffers.delete(sessionId);
    }
    // Cold recovery seed (after replay): resume has written the last selection of the historical session back to the runtime
    // (reconcileResumedRuntimeSettings), and there may be no ModelSelected in the composition/persistence event——
    // The seed only fills in the fields not touched by the event. If the log has a value, the log shall prevail (cold recovery caliber).
    this.seedPublisherConfig(sessionId, publisher);
    if (loaded.usageSeed === undefined) {
      await this.seedPublisherUsage(sessionId, publisher, persistedMessages);
    }
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (this.pausedConnections.has(state.connectionId)) continue;
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.hydrate.subscriptionResync", error, {
          phase: "subscriptionResync",
          sessionId,
        });
        this.scheduleFlush(routeKey, state, publisher);
      }
    }
    this.hydratedSessions.add(sessionId);
    this.publishCurrentSummaryToIndex(sessionId);
    return publisher;
  }

  /**
   * Cold synthesis renumbers the events to 1..N, while the runtime keeps using the eventStore raw seq.
   * Here the source cursor establishes the N-C offset; a raw seq=0 (a live-only child) is carried
   * along, and the subsequent offsets are corrected in step.
   * eventId covers the race where the snapshot and the buffer see the same event at the same time, and
   * the cursor covers the events already in the snapshot.
   */
  private normalizeRuntimeEventSequence(sessionId: string, event: SessionEvent): SessionEvent[] {
    const state = this.getOrCreateRawSequenceState(sessionId);
    const eventId = String(event.id);
    if (state.seenEventIds.has(eventId)) return [];

    const rawSeq = event.sequenceNumber;
    state.recentRawEventsById.set(eventId, event);
    while (state.recentRawEventsById.size > PROTOCOL_V4_LIMITS.eventRetentionPerSession) {
      const oldestEventId = state.recentRawEventsById.keys().next().value;
      if (oldestEventId === undefined) break;
      state.recentRawEventsById.delete(oldestEventId);
    }
    if (rawSeq <= 0) {
      state.seenEventIds.add(eventId);
      state.lastTransportSeq += 1;
      return [{ ...event, sequenceNumber: state.lastTransportSeq }];
    }
    if (event.type === SessionEventType.SessionResumed) {
      // Old runtimes may miss trailing raw events when unsubscribe/rebuilding the window. new runtime
      // When the persistent eventStore reaches a high water level, the raw seq of SessionResumed will be larger than the old cursor;
      // If only seq rollback is processed, resume and subsequent TurnStarted will wait forever for the old gap that cannot be filled.
      // SessionResumed is a clear epoch boundary: discard the old pending before the boundary, while retaining the ones that may arrive out of order.
      // The subsequent events of the new epoch are continuously drained from resume itself.
      for (const pendingSeq of state.pendingByRawSeq.keys()) {
        if (pendingSeq <= rawSeq) state.pendingByRawSeq.delete(pendingSeq);
      }
      state.sourceEventSeq = rawSeq - 1;
      state.offset = state.lastTransportSeq - state.sourceEventSeq;
    }
    if (rawSeq <= state.sourceEventSeq) {
      state.seenEventIds.add(eventId);
      this.resolveProjectionEventCommit(sessionId, eventId);
      return [];
    }

    state.seenEventIds.add(eventId);
    if (!state.pendingByRawSeq.has(rawSeq)) state.pendingByRawSeq.set(rawSeq, event);
    const ready: SessionEvent[] = [];
    // The eventStore is numbered first, and each event awaits persistence before notifying.
    // So N+1 can arrive before N. High water level filtering will misjudge late N as duplicate;
    // It must be temporarily stored according to raw seq and only drained continuously to maintain the queue/stream total order.
    for (;;) {
      const nextRawSeq = state.sourceEventSeq + 1;
      const next = state.pendingByRawSeq.get(nextRawSeq);
      if (!next) break;
      state.pendingByRawSeq.delete(nextRawSeq);
      let transportSeq = nextRawSeq + state.offset;
      if (transportSeq <= state.lastTransportSeq) {
        transportSeq = state.lastTransportSeq + 1;
        state.offset = transportSeq - nextRawSeq;
      }
      state.sourceEventSeq = nextRawSeq;
      state.lastTransportSeq = transportSeq;
      // waiter timeout/abort It is not enough to clear the listener, but also to terminate the ones already in the raw gap.
      // event. After command returns failed, the same TurnStarted will still be projected when the missing seq arrives.
      // The failed event still consumes the raw sequence number to unblock subsequent events, but it must no longer become a canonical fact.
      if (state.failedEventById.has(String(next.id))) {
        continue;
      }
      ready.push(
        transportSeq === next.sequenceNumber ? next : { ...next, sequenceNumber: transportSeq },
      );
    }
    return ready;
  }

  private getOrCreateRawSequenceState(sessionId: string): RawSequenceState {
    const existing = this.rawSequenceStates.get(sessionId);
    if (existing) return existing;
    const created: RawSequenceState = {
      sourceEventSeq: 0,
      offset: 0,
      lastTransportSeq: 0,
      seenEventIds: new Set(),
      appliedEventIds: new Set(),
      failedEventById: new Map(),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, created);
    return created;
  }

  private resolveProjectionEventCommit(sessionId: string, eventId: string): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.delete(eventId);
    state.appliedEventIds.add(eventId);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.resolve();
  }

  private rejectProjectionEventCommit(sessionId: string, eventId: string, error: Error): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.set(eventId, error);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.reject(error);
  }

  private rejectProjectionEventWaiters(sessionId: string, error: Error): void {
    const byEvent = this.projectionEventCommitWaiters.get(sessionId);
    if (!byEvent) return;
    for (const waiters of byEvent.values()) {
      for (const waiter of [...waiters]) waiter.reject(error);
    }
    this.projectionEventCommitWaiters.delete(sessionId);
  }

  /**
   * A running subagent has no bootstrap record of its own, but the raw child events create a publisher
   * first.
   * The publisher already existing means the conversation is live and subscribable, so the same child
   * must not be cold resumed into a second runtime; genuinely historical sessions remain the
   * responsibility of the host record / persisted resume.
   */
  private hasLiveConversation(sessionId: string): boolean {
    return this.host.sessionExists(sessionId) || this.detachedLiveSessions.has(sessionId);
  }

  private async seedPublisherUsage(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    persistedMessages?: MessageWithParts[],
    loadedSeed?: SessionUsageSeed | null,
  ): Promise<void> {
    if (loadedSeed !== undefined) {
      if (loadedSeed) publisher.seedUsage(loadedSeed);
      return;
    }
    const getSeed = this.host.getSessionUsageSeed;
    if (!getSeed) return;
    try {
      const seed = await getSeed.call(this.host, sessionId, persistedMessages);
      if (seed) publisher.seedUsage(seed);
    } catch (error) {
      this.host.onError?.("v4.usageSeed", error);
    }
  }

  private scheduleFlush(
    routeKey: string,
    state: FlushState,
    publisher: ConversationTopicPublisher,
  ): void {
    if (this.pausedConnections.has(state.connectionId)) return;
    if (state.timer !== null) return;
    const timer = setTimeout(() => {
      state.timer = null;
      // The timer may receive SAT after queuing; it must be checked twice before reserve, and race frames cannot be generated.
      if (this.pausedConnections.has(state.connectionId)) return;
      // Lazy cleanup: The subscription has been replaced/unsubscribed → the scheduling status is deleted and no frames are generated.
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
        this.flushStates.delete(routeKey);
        return;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) return;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }, state.flushWindowMs);
    // The CLI process exit is not hung up by the flush timer.
    timer.unref?.();
    state.timer = timer;
  }

  private emitReservation<F extends RoutedTopicFrame>(
    reservation: TopicFrameReservation<F>,
  ): boolean {
    // When resync/subscribe recovery has entered request-scoped outbox, online
    // If flush reuses the same inFlight, the physical wire will rush out of the station before the ACK response.
    if (this.controlReservations.has(reservation)) return false;
    const sessionId = parseConversationTopic(reservation.frame.topic);
    const route = this.flushStates.get(
      subscriptionRouteKey(
        reservation.frame.topic,
        reservation.frame.subscriptionId,
        sessionId
          ? (this.publishers
              .get(sessionId)
              ?.connectionIdForSubscription(reservation.frame.subscriptionId) ?? "")
          : "",
      ),
    );
    if (
      sessionId &&
      route?.deliveryProfile === "continuous" &&
      reservation.deliveryKind === "online" &&
      reservation.frame.payload.kind === "deltas" &&
      this.localTtft.forSession(sessionId)
    ) {
      const rows = this.publishers.get(sessionId)?.getSnapshot().rows.window ?? [];
      const turns = new Set<string>();
      for (const delta of reservation.frame.payload.deltas) {
        if (delta.op === "row.appended" || delta.op === "row.upserted") turns.add(delta.row.turnId);
        else if (delta.op === "row.delta") {
          const row = rows.find((item) => item.rowId === delta.rowId);
          if (row) turns.add(row.turnId);
        }
      }
      const related = rows
        .filter((row) => row.kind === "turnHeader" && turns.has(row.turnId))
        .flatMap((header) =>
          header.kind === "turnHeader" && header.sourceCommandId
            ? [this.localTtft.forSession(sessionId, header.sourceCommandId)]
            : [],
        )
        .filter((facts) => facts !== undefined);
      const candidates = related.length ? related : [this.localTtft.forSession(sessionId)];
      const observations: import("@zcode/shared").LocalTtftFacts[] = [];
      for (const facts of candidates) {
        if (!facts || observations.some((item) => item.observationId === facts.observationId))
          continue;
        const header = rows.find(
          (row) => row.kind === "turnHeader" && row.sourceCommandId === facts.commandId,
        );
        const observation = localTtftFactsSchema.safeParse({
          ...facts,
          ...(this.host.cliVersion ? { cliVersion: this.host.cliVersion } : {}),
          ...(header ? { productTurnId: header.turnId } : {}),
        });
        // The content before and after the conversion may be sent in the same batch; the original input carries the fact according to the actual row, and the latest queue item cannot be taken.
        if (observation.success) observations.push(observation.data);
      }
      if (observations.length) {
        (reservation.frame as ConversationTopicFrame).ttft = observations[0];
        if (observations.length > 1)
          (reservation.frame as ConversationTopicFrame).ttftRelated = observations.slice(1, 17);
      }
    }
    const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
    for (const wire of wires) this.host.emitWireFrame(wire);
    return reservation.commit();
  }

  private subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F> {
    const initialWires = reservation
      ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
      : [];
    if (reservation) this.controlReservations.add(reservation);
    let afterCommitRan = false;
    return {
      ack,
      initialFrame: reservation?.frame ?? null,
      initialWires,
      commit: () => {
        if (!reservation) return true;
        this.controlReservations.delete(reservation);
        const committed = reservation.commit();
        if (committed && !afterCommitRan) {
          afterCommitRan = true;
          // When controlling reservation and waiting for ACK/outbox admission, there is a flush timer
          // May have been triggered and suppressed by the same inFlight. After committing, you must actively re-drive the publisher.
          // Otherwise, the delta accumulated during the period will not be visible until the next ingest/publish.
          afterCommit?.();
        }
        return committed;
      },
    };
  }
}

/** The host executor throws this error for an un-wired command → ACK failed fault.notImplemented. */
export class V4CommandNotImplementedError extends Error {
  constructor(type: string) {
    super(`v4 command not implemented in M3: ${type}`);
    this.name = "V4CommandNotImplementedError";
  }
}

/**
 * The noop channel through which a command handler closes out ("the ACK of a same-value switch must
 * be discriminable"):
 * the handler throws it when it decides the command has nothing to do (e.g. when
 * switchModelConfig/switchCollaborationMode hits the runtime's current value), and the gateway maps it
 * to ACK status="noop" + reasonCode — it must not be swallowed as accepted (without a result),
 * otherwise the client could not distinguish "it took effect" from "it was already this value".
 */
export class V4CommandNoopError extends Error {
  constructor(
    readonly reasonCode: string,
    message?: string,
  ) {
    super(message ?? `v4 command is a no-op (${reasonCode})`);
    this.name = "V4CommandNoopError";
  }
}
