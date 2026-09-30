import type {
  BackgroundResultOriginMeta,
  ModelStreamingPayload,
  SessionEvent,
  SyntheticUserMessageSource,
  TurnAttachmentMeta,
  TurnInputIntentMetadata,
  TurnStartedPayload,
  WorkflowLaunchMeta,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";

type CanonicalConversationVisibility = "visible" | "modelOnly" | "stateOnly";
type CanonicalConversationOrigin =
  | "realUser"
  | "backgroundResult"
  | "goalContinuation"
  | "mailbox"
  | "synthetic"
  | "workflowLaunch"
  | "assistant"
  | "system";

interface CanonicalConversationPlacement {
  lane: "trigger" | "assistantWork" | "stateOnly";
  relation: "withinProductTurn" | "none";
}

export interface ConversationNormalizationDiagnostic {
  code:
    | "normalizer.user.missingTranscriptMessageId"
    | "normalizer.assistant.missingTranscriptMessageId";
  eventId: string;
}

interface CanonicalConversationFactBase {
  event: SessionEvent;
  entityId: string;
  productTurnId: string;
  runtimeTurnId: string;
  transcriptMessageId: string | null;
  visibility: CanonicalConversationVisibility;
  origin: CanonicalConversationOrigin;
  placement: CanonicalConversationPlacement;
  diagnostics: readonly ConversationNormalizationDiagnostic[];
}

export interface CanonicalUserIntentFact extends CanonicalConversationFactBase {
  semanticKind: "userIntent";
  visibility: "visible" | "modelOnly";
  origin:
    | "realUser"
    | "backgroundResult"
    | "goalContinuation"
    | "mailbox"
    | "synthetic"
    | "workflowLaunch";
  input: string;
  intentText: string;
  intentKind: "sendText" | "sendGoalCommand";
  turnNumber: number;
  executionKind: "agent" | "controlOnly";
  turnHeaderOrigin:
    | "userInput"
    | "backgroundResult"
    | "goalContinuation"
    | "editRerun"
    | "workflowLaunch";
  originMeta?: BackgroundResultOriginMeta;
  /**
   * Launch-turn metadata for a saved workflow started directly by the hub (present when `inputSource === "workflow_launch"`).
   * The live projection uses it to draw the launch card on the turnHeader / userInput rows; it is aligned with the very same copy in the message metadata (same shape hot and cold).
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** From this index on, `input` is engine-appended text. */
  epilogueStart?: number;
  sourceCommandId?: string;
  foregroundExecutionId?: string;
  clientId?: string;
  attachments?: readonly CanonicalTurnAttachment[];
  queueItemId?: string;
  admissionSeq?: number;
  admittedAt?: number;
  requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: readonly { kind: "shared_context_import"; context_id: string }[];
  fallbackReasonCode?: string;
  modelSelection?: TurnInputIntentMetadata["modelSelection"];
  mode?: TurnInputIntentMetadata["mode"];
  planEnabled?: boolean;
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
}

export interface CanonicalTurnAttachment {
  ref?: string;
  fileName: string;
  mime: string;
  bytes: number;
  previewRef?: string;
}

export interface CanonicalModelStream {
  kind: ModelStreamingPayload["kind"];
  delta: string;
  done: boolean;
  assistantResponseId?: string;
  transcriptPartId?: string;
  toolCallId?: ModelStreamingPayload["toolCallId"];
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export interface CanonicalAssistantSegmentFact extends CanonicalConversationFactBase {
  semanticKind: "assistantSegment";
  visibility: "visible";
  origin: "assistant";
  stream: CanonicalModelStream;
}

export interface CanonicalPassthroughFact extends CanonicalConversationFactBase {
  semanticKind: "passthrough";
  sourceCommandId?: string;
}

export type CanonicalConversationFact =
  | CanonicalUserIntentFact
  | CanonicalAssistantSegmentFact
  | CanonicalPassthroughFact;

interface NormalizeConversationEventContext {
  productTurnId?: string;
  openAssistantSegments?: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>>;
}

export interface CanonicalOpenSegmentIdentity {
  entityId: string;
  transcriptMessageId: string | null;
}

/**
 * The single place that interprets the fields of live SessionEvent and cold hydration synthesized events alike.
 *
 * ProductProjection used to guess messageId, origin and visibility separately straight from the raw payload; when cold
 * was missing one field the visible row was still produced but the command target was lost. The normalizer
 * first produces a self-contained canonical fact, so rows, targets and actions all use the same identity fact.
 */
export function normalizeConversationEvent(
  event: SessionEvent,
  context: NormalizeConversationEventContext = {},
): CanonicalConversationFact {
  const runtimeTurnId = runtimeTurnIdOf(event);
  const productTurnId = context.productTurnId ?? runtimeTurnId;
  if (event.type === SessionEventType.TurnStarted) {
    return normalizeTurnStarted(event, event.payload as TurnStartedPayload, {
      runtimeTurnId,
      productTurnId,
    });
  }
  if (event.type === SessionEventType.ModelStreaming) {
    return normalizeModelStreaming(event, event.payload as ModelStreamingPayload, {
      runtimeTurnId,
      productTurnId,
      openAssistantSegments: context.openAssistantSegments,
    });
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    const payload = event.payload as Record<string, unknown>;
    const operationId =
      typeof payload.operationId === "string" && payload.operationId.length > 0
        ? payload.operationId
        : String(event.id);
    const transcriptMessageId =
      typeof payload.messageId === "string" && payload.messageId.length > 0
        ? payload.messageId
        : null;
    return {
      semanticKind: "passthrough",
      event,
      entityId: operationId,
      productTurnId,
      runtimeTurnId,
      transcriptMessageId,
      visibility: "visible",
      origin: "system",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      diagnostics: [],
      ...(typeof payload.sourceCommandId === "string"
        ? { sourceCommandId: payload.sourceCommandId }
        : {}),
    };
  }
  return {
    semanticKind: "passthrough",
    event,
    entityId: String(event.id),
    productTurnId,
    runtimeTurnId,
    transcriptMessageId: null,
    visibility: "stateOnly",
    origin: "system",
    placement: { lane: "stateOnly", relation: "none" },
    diagnostics: [],
  };
}

function normalizeTurnStarted(
  event: SessionEvent,
  payload: TurnStartedPayload,
  ids: { runtimeTurnId: string; productTurnId: string },
): CanonicalUserIntentFact {
  const transcriptMessageId = payload.messageId ? String(payload.messageId) : null;
  const origin = userInputOrigin(payload.inputSource);
  // live uses runtime turnId, cold uses hydrate-turn-N; even if both point to
  // The same persistent user message still generated different productTurnIds in the past, resulting in line grouping and command boundaries.
  // Drift before and after recovery. The real user turn uses the persistent user messageId as the stable product turn identity;
  // Legacy only retains the runtime fallback when messageId is missing, and exposes downgrades through diagnostics.
  // It can be seen that user, goal continuation, and background wake are all product-turn triggers;
  // As long as there is a persistent messageId it must be shared, not just realUser.
  const productTurnId = transcriptMessageId ?? ids.productTurnId;
  const diagnostics: ConversationNormalizationDiagnostic[] = transcriptMessageId
    ? []
    : [
        {
          code: "normalizer.user.missingTranscriptMessageId",
          eventId: String(event.id),
        },
      ];
  return {
    semanticKind: "userIntent",
    event,
    entityId:
      transcriptMessageId ??
      `legacy:user:${String(event.sessionId)}:${ids.runtimeTurnId}:${String(event.id)}`,
    productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: payload.inputVisibility === "model-only" ? "modelOnly" : "visible",
    origin,
    placement: { lane: "trigger", relation: "withinProductTurn" },
    diagnostics,
    input: payload.input,
    intentText: payload.intent?.text ?? payload.input,
    intentKind: payload.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
    turnNumber: payload.turnNumber,
    executionKind: payload.executionKind ?? "agent",
    turnHeaderOrigin: turnHeaderOrigin(payload.inputSource),
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    ...(payload.workflowLaunch ? { workflowLaunch: payload.workflowLaunch } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...((payload.intent?.sourceCommandId ?? payload.inputId)
      ? { sourceCommandId: payload.intent?.sourceCommandId ?? payload.inputId }
      : {}),
    ...(payload.foregroundExecutionId
      ? { foregroundExecutionId: payload.foregroundExecutionId }
      : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(payload.intent?.queueItemId ? { queueItemId: payload.intent.queueItemId } : {}),
    ...(payload.intent?.admissionSeq !== undefined
      ? { admissionSeq: payload.intent.admissionSeq }
      : {}),
    ...(payload.intent?.admittedAt !== undefined ? { admittedAt: payload.intent.admittedAt } : {}),
    ...(payload.intent?.requestedDelivery
      ? { requestedDelivery: payload.intent.requestedDelivery }
      : {}),
    ...(payload.intent?.admittedDelivery
      ? { admittedDelivery: payload.intent.admittedDelivery }
      : {}),
    ...(payload.intent?.sharedContextRefs
      ? { sharedContextRefs: payload.intent.sharedContextRefs }
      : {}),
    ...(payload.intent?.fallbackReasonCode
      ? { fallbackReasonCode: payload.intent.fallbackReasonCode }
      : {}),
    ...(payload.intent?.modelSelection ? { modelSelection: payload.intent.modelSelection } : {}),
    ...(payload.intent?.mode ? { mode: payload.intent.mode } : {}),
    ...(payload.intent?.planEnabled !== undefined
      ? { planEnabled: payload.intent.planEnabled }
      : {}),
    ...(payload.intent?.provenance ? { provenance: payload.intent.provenance } : {}),
    ...normalizeAttachments(payload),
  };
}

function normalizeModelStreaming(
  event: SessionEvent,
  payload: ModelStreamingPayload,
  ids: {
    runtimeTurnId: string;
    productTurnId: string;
    openAssistantSegments: NormalizeConversationEventContext["openAssistantSegments"];
  },
): CanonicalAssistantSegmentFact {
  const lane = assistantStreamLane(payload.kind);
  const openSegment =
    lane === "text" || lane === "reasoning" ? ids.openAssistantSegments?.[lane] : undefined;
  const inheritsOpenSegment = !isAssistantStreamStart(payload.kind);
  const inheritedSegment = inheritsOpenSegment ? openSegment : undefined;
  const transcriptMessageId = payload.assistantMessageId
    ? String(payload.assistantMessageId)
    : (inheritedSegment?.transcriptMessageId ?? null);
  const identityRequired =
    payload.kind === "text_start" || (payload.kind === "text_delta" && !transcriptMessageId);
  const diagnostics: ConversationNormalizationDiagnostic[] =
    identityRequired && !transcriptMessageId
      ? [
          {
            code: "normalizer.assistant.missingTranscriptMessageId",
            eventId: String(event.id),
          },
        ]
      : [];
  const transcriptPartId = payload.partId ? String(payload.partId) : undefined;
  const toolEntityId = payload.toolCallId ? String(payload.toolCallId) : undefined;
  const intrinsicEntityId =
    lane === "tool" ? (toolEntityId ?? transcriptPartId) : (transcriptPartId ?? toolEntityId);
  return {
    semanticKind: "assistantSegment",
    event,
    entityId:
      transcriptMessageId ??
      inheritedSegment?.entityId ??
      intrinsicEntityId ??
      `legacy:assistant:${String(event.sessionId)}:${ids.runtimeTurnId}:${transcriptPartId ?? String(event.id)}`,
    productTurnId: ids.productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: "visible",
    origin: "assistant",
    placement: { lane: "assistantWork", relation: "withinProductTurn" },
    diagnostics,
    stream: {
      kind: payload.kind,
      delta: payload.delta,
      done: payload.done,
      ...(transcriptMessageId ? { assistantResponseId: transcriptMessageId } : {}),
      ...(transcriptPartId ? { transcriptPartId } : {}),
      ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
      // The empty string is a valid raw fact restored by an empty tool name; truthy judgment will erase it to
      // undefined, causing subsequent product status filtering to mistakenly materialize the call into an empty tool row.
      ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.providerExecuted !== undefined
        ? { providerExecuted: payload.providerExecuted }
        : {}),
    },
  };
}

function assistantStreamLane(
  kind: ModelStreamingPayload["kind"],
): "text" | "reasoning" | "tool" | "other" {
  if (kind?.startsWith("text_")) return "text";
  if (kind?.startsWith("reasoning_")) return "reasoning";
  if (kind?.startsWith("tool_") || kind === "tool_call") return "tool";
  return "other";
}

function isAssistantStreamStart(kind: ModelStreamingPayload["kind"]): boolean {
  return kind === "text_start" || kind === "reasoning_start" || kind === "tool_input_start";
}

function runtimeTurnIdOf(event: SessionEvent): string {
  if (event.turnId) return String(event.turnId);
  if (event.type === SessionEventType.TurnStarted) {
    const payload = event.payload as TurnStartedPayload;
    return `turn-${payload.turnNumber}`;
  }
  return "turn-unknown";
}

function normalizeAttachments(payload: TurnStartedPayload): {
  attachments?: readonly CanonicalTurnAttachment[];
} {
  if (payload.intent?.attachmentRefs && payload.intent.attachmentRefs.length > 0) {
    return { attachments: payload.intent.attachmentRefs.map((attachment) => ({ ...attachment })) };
  }
  if (!payload.attachments || payload.attachments.length === 0) return {};
  return { attachments: payload.attachments.map(normalizeAttachment) };
}

function normalizeAttachment(attachment: TurnAttachmentMeta): CanonicalTurnAttachment {
  return {
    ...(attachment.ref ? { ref: attachment.ref } : {}),
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
  };
}

function turnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["turnHeaderOrigin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    // Hub direct launch: turnHeader and userInput share the workflowLaunch origin, and the UI draws the launch card instead of the user bubble accordingly.
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "userInput";
  }
}

function userInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      // The child reply is a mailbox runtime carrier, not real user input;
      // live/cold must retain the same canonical origin even if both hide it.
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    // Hub direct launch: The user's real actions in the hub are visible in the user row but presented as a launch card (origin distinguishes it from ordinary bubbles).
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "realUser";
  }
}
