// re-home product (to pave the way for deletion of zcodeChatMessages, the mode is the same as zcode-task-types-core).
// This file carries the surviving stack in the old message conversion layer (zcodeChatMessages/zcodeChatMessageHelpers)
// Type-only consumption type: TaskChatMessage / TaskChatToolCall / TaskChatMessagePart.
// Consumer: ToolCallBlocks(toolCallTree) / PermissionDialog / taskChangeSummary /
// treemappingActivity / codeViewer / toolDisplay / toolError / app-shell test injection channel.
// After the old message assembly runtime (zcodeChatMessages.ts) was removed, this is the only source of truth for this type of surface.
import type {
  ZCodeAssistantMessagePart,
  ZCodeAssistantMessageFeedback,
  ZCodePromptAttachment,
  ZCodeTimelineMeta,
  ZCodeTaskSnapshotBodyRef,
  ZCodeTaskSnapshotToolFieldRef,
  ZCodeTaskSnapshotToolSlice,
} from "@zcode/shared";

export interface TaskChatToolCall {
  toolId: string;
  /** Superior toolCallId; null means the main agent, non-null means it comes from a Task/Agent sub-tool. */
  parentToolUseId?: string | null;
  /** ZCode fixed tool name; kind still reserved for compatibility with old ZCode Agent snapshots and UI aggregation categories. */
  toolName?: string;
  kind: string;
  title?: string;
  input: unknown;
  status: string;
  /** ParentToolUseId belongs to the sub-agent text output. */
  content?: string;
  /** parentToolUseId belongs to the child agent thinking output. */
  thought?: string;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** A reference to the tool's large field after it has been clipped by the snapshot budget; used to backfill the tool's complete input/output/raw on demand. */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
  /** tool call The local time when the current message flow is first entered. It is only used to identify long-running tool calls. */
  startedAt?: number;
}

export type TaskChatMessagePart = ZCodeAssistantMessagePart;

export interface TaskModelChangeUiTimeline {
  type: "model_change";
  fromModelLabel: string;
  toModelLabel: string;
}

export type TaskUiTimelineMeta = TaskModelChangeUiTimeline;

export interface TaskChatMessage {
  id: string;
  /** Stable protocol messageId in session snapshot; live streaming id may only temporarily reveal identity. */
  protocolMessageId?: string;
  /** The original messageId set retained after snapshot merges assistant, used for timeline anchor to hit sub-messages before merging. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** The legacy goal belonging to the assistant displays the iteration; it is only used for the historical area status copy and does not participate in the verifier round determination. */
  goalIteration?: number;
  /** UI-only streaming grouping; used to cut off model-only goal continuation and does not participate in goal round semantics. */
  streamGroupId?: string;
  mailboxMessage?: {
    content: string;
    createdAt?: string;
    fromSessionId: string;
    messageId: string;
  };
  /** The assistant's history area eventually takes time; it is only written after the end of the current round to avoid re-guessing the UI every time it resumes. */
  durationMs?: number;
  /** Whether assistant ends with active stop/interruption; used for UI to suppress latest area misjudgment as "natural completion". */
  interrupted?: boolean;
  /** The user's local feedback on the assistant's reply; it is only displayed/persisted and does not enter the subsequent model context. */
  feedback?: ZCodeAssistantMessageFeedback;
  attachments?: ZCodePromptAttachment[];
  toolCalls?: TaskChatToolCall[];
  thought?: string;
  /**
   * Previously, assistant messages were only rendered based on the three aggregation fields of thought/tool/content.
   * Once there are both text and tool calls in the same round, the UI can only be fixed with "tools on top and text on the bottom".
   * Here, the actual arrival order of streaming events is additionally recorded, so that the rendering layer can play back in the order of events instead of hard typesetting by field grouping.
   */
  parts?: TaskChatMessagePart[];
  /** The conversation turn this message belongs to, used to correlate per-turn file change summaries and rollbacks */
  turnIndex?: number;
  /** Full text quote of the above-the-fold preview of the big news. When present the UI must treat the body as incompletely loaded. */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** The cursor information when tools is returned by slicing by number of items; used for "View more tool calls" supplementary pull. */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** Whether it is still streaming output, it is only used for UI recovery during the current runtime and does not participate in persistence. */
  streaming?: boolean;
  /** ZCode Agent synthetic timeline message does not participate in assistant body, tool call and fork. */
  syntheticTimeline?: ZCodeTimelineMeta;
  /** UI-only synthetic timeline messages, do not enter protocol snapshots or local history. */
  uiTimeline?: TaskUiTimelineMeta;
  /** ZCode CLI turn steering status mark, only used for user message display. */
  turnSteer?: {
    status: "guided";
  };
}
