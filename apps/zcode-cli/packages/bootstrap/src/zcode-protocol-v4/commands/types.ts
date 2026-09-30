// Core capability contract of v4 native command layer (native reworked version).
//
// Layered discipline (no bridging):
// - This directory is the native implementation of the command: decision logic (steer diversion / draft promotion / abort life cycle /
//   goal-pause barrier) directly drives core (ZCodeApp/runtime) in the handler without going through the old protocol op.
// - The session registry is still owned by the host: transparently transmitting the old
//   ZCodeProtocolSessionRecord (the same object reference, field changes are visible in both directions, and a second registration form is not generated).
// - Environment capabilities (model ready/legacy broadcast/shell parsing) are injected hooks: legacy protocol binder in transition period
//   Provide implementation and have the same life cycle as the old protocol - each hook is marked with a transition destination, and new hooks must be marked.
import type {
  SessionTaskType,
  StableForkGoalBoundaryMetadata,
  TraceContext,
} from "@zcode/contracts";
import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
  ConversationInputIntent,
  QueueItem,
  StableForkTarget,
  StableForkTargetResolution,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";
import type { V4InteractionRegistry } from "../interaction-registry.js";
import type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
} from "../product-projection.js";

/** The minimal logging surface (structured fields go straight to the host logger). */
export interface V4CommandLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export type V4QueueItemCommand = QueueItem;

export type V4StableForkTargetResolution =
  | {
      ok: true;
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
    }
  | Extract<StableForkTargetResolution, { ok: false }>;

/**
 * A structured narrow view of the legacy ZCodeProtocolSessionRecord (declares only the fields the command layer needs).
 * Structurally compatible: the binder passes the legacy record object straight through; once v4 owns its session registry, that registry supplies an isomorphic object.
 */
export interface V4SessionRecordView {
  app: ZCodeApp;
  /**
   * The session's root traceContext (traceId sits above sessionId and corresponds to the whole task chain).
   * The command layer passes it through when calling runtime methods / re-emitting core events; it must not start a new trace midway.
   * The legacy record already carries this field, so the narrow view passes it straight through.
   */
  traceContext: TraceContext;
  workspace: { workspacePath: string };
  /** draft semantics: deferred = no first message sent yet, not persisted into sqlite; promoted to immediate on the first send. */
  persistence: "immediate" | "deferred";
  /** The active turn lock: present = a turn is running (sendText takes the steer branch, stop has a target). */
  activeAbortController?: AbortController;
  /** The ready lock has been released, but the tail of the state mutation still uses references to the record/runtime. */
  residencyFinalizationCount?: number;
  /** The currently executing automation dispatch turn; it exists only while a turn is running. */
  activeAutomationId?: string;
  /** The currently executing off-peak dispatch turn; it exists only while a turn is running. */
  activeOffPeakTaskId?: string;
  /** The stable push-back address of the current inbound Bot turn; it must be restored after the turn ends. */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  /** A restore-failure warning: while it is present, new turns are rejected (corrupted history must not be silently written on). */
  restoreWarning?: { message: string; type: string };
  taskType?: SessionTaskType;
}

export interface V4CommandCoreHost {
  /** Session lookup (the same registry object identity; it returns undefined when absent → the handler rejects). */
  getRecord(sessionId: string): V4SessionRecordView | undefined;
  logger?: V4CommandLogger;

  // ── v4 native ability (non-transition hook)───────────────────────────────
  /** The complete authoritative intent of a queue item; sendQueuedNow must not degrade into a text-only resend. */
  getQueueItem?(sessionId: string, queueItemId: string): V4QueueItemCommand | null;
  /** Deduplication for typed maintenance commands; the criterion comes from the same projection queue, no side set is maintained. */
  hasQueueItemKind?(sessionId: string, kind: QueueItem["kind"]): boolean;
  /** guide eligibility: it only blocks when an ordinary queue already exists; an existing guide is still allowed to continue under FIFO admission. */
  hasQueuedDelivery?(sessionId: string, delivery: "guide" | "queue"): boolean;
  getQueueLength?(sessionId: string): number;
  /** Persisted dedupe facts for successful side effects that have no user message, such as timeline/child. */
  recordPersistentCommandFact?(
    sessionId: string,
    source: "timeline" | "child",
    ack: CommandAck,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** The durable admission boundary shared by createSession.firstInput / selection-side firstInput and an ordinary send. */
  admitInputCommand?(
    envelope: CommandEnvelope,
    sessionId: string,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelInputCommand?(sessionId: string, queueItemId: string, reason: string): Promise<void>;
  discardSharedContext?(sessionId: string, contextId: string): Promise<boolean>;
  /**
   * The current input routing mode (data source = the v4 projection's inputRouting.mode).
   * The held-choice decision of sendText/sendGoalCommand (heldQueueInputRequiresChoice) depends on it to decide whether heldQueueDisposition must be carried.
   * No projection for the session (no events yet) → null (treated as non-held).
   */
  getInputRoutingMode?(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null;
  /** After a runtime event notification, waits until the target event has really finished reorder drain + projection apply. */
  waitForProjectionEventCommit?(
    sessionId: string,
    eventId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /**
   * rowId → the authoritative messageId (data source = the v4 projection's rowId→messageId translation table).
   * A historical compatibility lookup: it translates a projection rowId (an assistant row) into
   * the transcript's messageId. Untranslatable (a non-assistant row / a late rowId) → null → the handler
   * rejects, and it never silently falls back to latestCheckpoint (which would fork/rewind at the wrong point).
   */
  getMessageIdForRow?(sessionId: string, rowId: number): string | null;
  /** The only row target resolver shared by row.actions/CommandInbox/handler. */
  resolveRowActionTarget?(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution | null;
  /**
   * rowId → every transcript messageId inside the owning product turn (for withdrawing file summaries).
   * Multi-segment assistant output / multiple checkpoints must be handed to core in one go, so that only the last segment's files are never withdrawn.
   */
  getMessageIdsForTurnRow?(sessionId: string, rowId: number): string[];
  /**
   * Strict core-side check: a fork may only attach the last segment at the end of a turn.
   * true = it is the tail segment; false = a middle segment (reject); null = no projection / unknown (handled as a translation failure).
   */
  isLatestAssistantSegmentRow?(sessionId: string, rowId: number): boolean | null;
  /** The only stable fork resolver: the projection gate plus a durable transcript anchor/fallback. */
  resolveStableForkTarget?(sessionId: string, rowId: number): Promise<V4StableForkTargetResolution>;
  /**
   * latestAssistantRetryOnly core-side defense: retryTurn may only point at the last
   * assistantText row in the current projection. Both false and null are rejected by the handler, so old clients cannot bypass the UI.
   */
  isLatestRetryAssistantRow?(sessionId: string, rowId: number): boolean | null;
  /**
   * latestQueryEditOnly core-side defense: editUserQuery may only point at the last
   * realUser userInput row in the current projection. Both false and null are rejected by the handler, so old clients cannot bypass the UI.
   */
  isLatestEditableUserRow?(sessionId: string, rowId: number): boolean | null;
  /** rowId → product turnId (used to look the turn back up in the store when editUserQuery has no assistant anchor). */
  getTurnIdForRow?(sessionId: string, rowId: number): string | null;
  /**
   * Timing self-healing probe for restoreWarning: has the current process Registry already published an available model.
   * Implemented by the binder; when the host does not support it → no self-healing, the rejection stands.
   */
  hasUsableRuntimeModelTarget?(record: V4SessionRecordView): boolean;
  /**
   * rowId → the rewind anchor messageId of the owning turn (same data source as above).
   * editUserQuery targets a user row (user rows have no messageId) while rewind needs a messageId —
   * so the messageId of an assistant row in the same turn is used as the anchor.
   */
  getTurnRewindAnchor?(sessionId: string, rowId: number): string | null;
  /**
   * The fallback for a running-latest edit when the assistant anchor has not appeared yet:
   * after stop, the real user messageId is looked up again in the sessionStore by the row's owning turn.
   */
  resolveUserMessageIdForRow?(sessionId: string, rowId: number): Promise<string | null>;
  /**
   * Resolution of retryTurn's original prompt: assistant messageId → parentID (the user message) → text.
   * Data source = the core sessionStore (the transcript's authority), not the legacy protocol — the binder implementation exists only
   * because the deps injection point is in the host; once v4 owns its session registry it will hold it natively as the host does.
   * Not found (no parent / no store) → null → the handler only truncates and does not resend.
   */
  resolveTurnUserPrompt?(sessionId: string, assistantMessageId: string): Promise<string | null>;
  /** Assistant feedback first persists the transcript metadata, then publishes the projection event of that same entity. */
  setAssistantFeedback?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      feedback: "like" | "dislike" | null;
    },
  ): Promise<void>;
  /**
   * The interactive-reply registry (native v4 infrastructure, not a transitional hook): when the interaction-broker issues
   * a reverse request (permission/AskUserQuestion) it registers a deferred, and the resolveInteraction command
   * delivers the reply through it. The binder injects the very same instance as the broker; it is optional in the type only for test-fixture convenience —
   * when nothing is injected it is treated as a miss (an idempotent, successful close-out).
   */
  interactions?: V4InteractionRegistry;

  // ── Transition hook (legacy compatibility window)─────────────────────────
  /**
   * The model readiness check before a turn starts (credential/catalog resolution).
   * Currently implemented by the legacy protocol binder (ensureSessionModelAvailableForNextTurn);
   * destination: once the core app layer owns model resolution itself, it replaces this hook.
   */
  ensureModelReady?(record: V4SessionRecordView): Promise<void>;
  /**
   * The Agent process Registry validates the target Provider before a model switch. An ordinary model command only carries a Selection,
   * so nothing here may receive or install a Host runtime snapshot.
   */
  ensureProviderAvailable?(
    sessionId: string,
    providerId: string,
  ): Promise<{ available: boolean; reason?: string }>;
  /**
   * The legacy broadcast (state.updated + record.stateRevision): legacy protocol consumers (the sidebar / the task index)
   * still rely on it to perceive state changes until the sidebar migration is finished. v4's own projection goes through gateway event ingest
   * and does not depend on this hook; when the old broadcast mechanism is closed out, this hook closes out with it.
   */
  afterLegacyStateMutation?(record: V4SessionRecordView, reason: string): Promise<void>;
  /**
   * Session close (the execution surface of deleteSession: unsubscribe from events → app.close → removal from the registry → the gateway clears its channels).
   * Transitional shape: the session registry still belongs to the legacy protocol host and the implementation is inlined in the binder (ordered to match the old closeSession op,
   * see zcode-protocol/server-operations.ts); once v4 owns its session registry it is absorbed as a native implementation.
   */
  closeSession?(sessionId: string): Promise<void>;
  /**
   * Session record creation (the execution surface of createSession: record setup / event wiring / model catalog sync /
   * failure cleanup, all of it entangled with the legacy protocol host). The binder implementation calls the old createSession op;
   * once v4 owns its session registry a native implementation replaces this hook.
   * The semantic decisions (draft persistence / firstInput submission) stay in the native handler and do not enter the hook.
   */
  createSessionRecord?(params: {
    workspaceId: string;
    mcpServers?: CommandPayloadMap["createSession"]["mcpServers"];
    /** The host-decided Off-Peak tool surface gate; by default no tools are registered. */
    offPeakToolEnabled?: boolean;
    /**
     * The host-decided dynamic workflow rollout gate;
     * it falls back by default to the process-level workspace conclusion, and is still fail-closed.
     */
    dynamicWorkflowEnabled?: boolean;
  }): Promise<{ sessionId: string }>;
  /** Creates a hidden selection_side_chat child from the parent session's durable boundary. */
  createSelectionSideSession?(
    sessionId: string,
    options: {
      sourceCommandId: string;
      revisionAtDecision: number;
      modelSelection?: NonNullable<
        CommandPayloadMap["createSelectionSideSession"]["firstInput"]
      >["modelSelection"];
    },
  ): Promise<{ sessionId: string }>;
  /** A conversation-only stable fork; it must not stop the parent, rewind the workspace, or copy active work/queue. */
  forkStableConversation?(
    sessionId: string,
    options: {
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
      sourceCommandId: string;
      revisionAtDecision: number;
    },
  ): Promise<{ forkedSessionId: string }>;
  /** @deprecated Only for legacy host structural compatibility; the new editUserQuery never calls it, and explicit forkAssistant is unaffected. */
  forkConversationBeforeInput?(
    sessionId: string,
    options: {
      editTarget: ConversationEditTarget;
      envelope: CommandEnvelope;
      admission: { admissionSeq: number; admittedAt: number; queueItemId: string };
    },
  ): Promise<{ forkedSessionId: string }>;
  /** The runtime fails to start synchronously after the bundle was submitted: only a child failure is recorded, and the parent fork ACK stays accepted. */
  recordForkStartFailure?(
    sessionId: string,
    envelope: CommandEnvelope,
    error: unknown,
  ): Promise<void>;
}
