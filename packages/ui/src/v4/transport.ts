// Transport seam (dependency injection) for the V4 session data layer.
// Desktop uses preload/MessagePort, and web uses ws relay—the data layer has zero awareness of both.
// This is where the principle of "dependency injection to solve desktop/web compatibility" lies in the v4 data layer.
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationRowTarget,
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
  SubscribeParams,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansParams,
  V4ConversationPlansResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  ConversationResyncParams,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

/**
 * The v4 conversation transport surface on a single host connection. Splitting across workspaces =
 * the UI shell holds a Map<workspaceKey, ConversationTransport>, each connection paired with its
 * own SessionDataLayer.
 */
export interface ConversationTransport {
  /**
   * v4/conversation/subscribe. The transport implementation fills in connectionId; it never reaches
   * the UI layer.
   */
  subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult>;
  /**
   * Activated once the store writes the ACK subscriptionId, and pre-ACK notifications are released
   * in their original order.
   */
  activate(subscriptionId: string): void;
  /**
   * Same-sub recovery for live subscriptions; topic/connection/profile are looked up back through
   * the host-owned registry.
   */
  resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  /** v4/conversation/unsubscribe. */
  unsubscribe(subscriptionId: string): Promise<void>;
  /** v4/command. */
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  /**
   * v4/commands/query: after a reconnect, reconciles by commandId against the CLI's authoritative
   * facts.
   */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult>;
  /** v4/conversation/rowsRange (loadOlder): fetches one window of history rows upwards by cursor. */
  rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>;
  /** v4/conversation/plans: every terminal-state plan in the currently effective branch. */
  plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult>;
  /**
   * v4/conversation/workflowRunEvents: paginated event log of a workflow run (cursor = journal
   * sequence).
   */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /**
   * v4/conversation/workflowRuns: workflow run enumeration (the journal-backed discovery surface
   * after a restart).
   */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * v4/conversation/workflowRunArtifacts: the list of **user-facing artifacts** of a workflow run
   * (the durable read path for cold recovery).
   *
   * ⚠ Terminology: artifact = an output the script publishes to the user via `artifact.*` (file /
   * markdown / prebuilt dashboard), not the run's top-level return value.
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /**
   * v4/conversation/workflowRunArtifactData: paginated entries of a prebuilt dashboard (cursor =
   * journal sequence).
   */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /**
   * v4/conversation/workflowRunArtifactRead: bytes of a content artifact, one chunk at a time (≤
   * 512 KiB).
   */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /**
   * v4/conversation/workflowRunWorkspace: the script transcript inventory of a workflow run
   * (journal rows of files.* / git.* / world.run, without the bodies).
   */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /**
   * v4/conversation/workflowRunNodeResult: the bounded body of one workspace node (only fetched
   * when expanded).
   */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /** v4/conversation/fileChanges: expand a file summary's details and read-only diff by turn row. */
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  /** v4/conversation/fileRewindPreview: preview a workspace-only file rewind by turn row. */
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** High-level attachment upload on the UI side; the production wire is begin/chunk/commit/abort. */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  /**
   * High-level read of a sent image/video; Desktop local video may return an authorized URL,
   * everything else loops over small chunks.
   */
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
  /** Authorized range read of a sent PDF; it never reads the whole file into the renderer first. */
  attachmentReadRange(
    params: ConversationAttachmentReadParams & { offset: number; limit: number },
  ): Promise<{
    bytes: Uint8Array;
    mediaType: string;
    totalBytes: number;
    nextOffset: number | null;
  }>;
  /**
   * Registers a downstream frame listener (v4/conversation/frame) and returns the unsubscribe
   * function.
   */
  onFrame(
    listener: (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void;
  /**
   * Physical assembly fails atomically; the projection stays unchanged and the store starts a
   * single-flight resync.
   */
  onAssemblyFault(
    listener: (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void,
  ): () => void;
  /**
   * The CLI runtime or its hosting proxy is replaced; the transport has already cleared
   * ownership/barrier/assembler.
   */
  onRuntimeRestart(listener: (reason?: "runtimeRestart" | "transportReplaced") => void): () => void;
  /**
   * CLI runtime liveness. unavailable arrives on the spot at workspace-dispose (no new runtime
   * exists yet at that point, so a resubscribe is impossible); available arrives when the new
   * process spawns, at the same moment and meaning as onRuntimeRestart.
   *
   * onRuntimeRestart only fires when a new process spawns, and the agent starts lazily — once a
   * ready CUA Helper triggers dispose, nobody brings the agent back up, so the replacement
   * notification never arrives: the prewarmed draft session is not rebuilt and attachments stay
   * stuck in waitingSession until the user manually clicks send once to kick it alive. The only
   * thing observable on the spot at dispose is this event.
   *
   * Consumers subscribe to one or the other following the established sessionsIndexStore pattern
   * (if this method exists, do not subscribe to onRuntimeRestart), so a single replacement is not
   * handled once through each of two channels. This method does not exist when the host does not
   * expose a runtime lifecycle.
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

export interface ConversationAttachmentReadParams {
  sessionId: string;
  ref: string;
  /**
   * Only used to decide whether to query the Desktop local video source; the final MIME type is
   * still returned authoritatively by the CLI.
   */
  mediaType?: string;
  /**
   * New rows have a stable identity; ref-only compatibility is kept when an old snapshot lacks one.
   */
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  /** Stops further chunked requests when the dialog closes, switches, or unmounts. */
  signal?: AbortSignal;
}

/**
 * Conversation topic key (dual to parseConversationTopic on the CLI side), re-exported from the
 * protocol package.
 */
export { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
