/* oxlint-disable eslint(max-lines) -- the task realtime shared contract is maintained in one place; types and schemas need to stay close together. */
// ── Old protocol compatibility (transition period)─────────────────────────────
// The remaining 18 exports: realtime events/lease/owner-command interface type.
// Consumer: desktop taskRealtimeBus/taskRealtimeBridge, services sessionRealtimePort,
// shared channels.ts (old host channel table).
// Runtime zod schema and resolveWorkspaceKey have been migrated to task-realtime-core.ts (survival side);
// Basic transfer types (TaskRealtimeReason/TaskStreamMirrorOp/TaskStreamWatermark, etc.) have been migrated
// zcode-task-types-core.ts. This file has the same life cycle as the old realtime bus group.
import type {
  ZCodeTaskClientMode,
  ZCodeTaskRuntimeCommand,
  ZCodeTaskMeta,
  TraceId,
  TaskRealtimeReason,
  TaskStreamWatermark,
  TaskStreamMirrorUserMessageOp,
  TaskStreamMirrorStreamEventOp,
  TaskStreamMirrorOp,
} from "./zcode-task-types-core.js";
import type { ZCodePermissionResponse } from "./zcode-protocol-legacy-types.js";
import type { WorkspaceHookReviewDecision } from "./zcode-protocol-v4/workspace-hook-review.js";

export interface TaskRealtimeEnvelope {
  eventId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  traceId: TraceId;
  createdAt: number;
}

export interface TaskRealtimeInvalidationBaseEvent extends TaskRealtimeEnvelope {
  reason: TaskRealtimeReason;
  streamWatermark?: TaskStreamWatermark;
}

export interface TaskSnapshotInvalidatedEvent extends TaskRealtimeInvalidationBaseEvent {
  type: "task_snapshot_invalidated";
  taskId: string;
}

export interface WorkspaceTaskListInvalidatedEvent extends TaskRealtimeInvalidationBaseEvent {
  type: "workspace_task_list_invalidated";
  taskId?: string;
  taskMeta?: ZCodeTaskMeta;
}

export interface TaskStreamMirrorTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  runId: string;
  traceId: TraceId;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
}

export type TaskStreamMirrorPublishOp =
  | TaskStreamMirrorUserMessageOp
  | TaskStreamMirrorStreamEventOp;

export interface TaskStreamMirrorBatchEvent extends TaskRealtimeEnvelope {
  type: "task_stream_mirror_batch";
  taskId: string;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}

export type TaskRealtimeDeliveryPurpose = "observer" | "relay_owner";

export type TaskRealtimeHostDeliveryKind = "desktop_window" | "relay_bridge";

export interface TaskRunLeaseTarget extends TaskStreamMirrorTarget {}

export interface TaskRunLeaseAcquireRequest extends TaskRunLeaseTarget {
  leaseRequestId: string;
}

export type TaskRunLeaseResult =
  | { leaseRequestId: string; acquired: true; ownerHostId: string }
  | {
      leaseRequestId: string;
      acquired: false;
      ownerHostId: string;
      reason: "owned_by_other_host";
    };

export type TaskOwnerCommandRequest =
  | {
      commandRequestId: string;
      type: "stop_generation";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
    }
  | {
      commandRequestId: string;
      type: "respond_permission";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      permissionRequestId: string;
      optionId: string;
      response: ZCodePermissionResponse;
    }
  | {
      commandRequestId: string;
      type: "respond_elicitation";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      elicitationRequestId: string;
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    }
  | {
      commandRequestId: string;
      type: "respond_workspace_hook_review";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      remoteSessionId?: string;
      taskId: string;
      runId: string;
      sessionId: string;
      bundleDigest: string;
      reviewFlowId: string;
      generation: number;
      interactionId: string;
      decision: WorkspaceHookReviewDecision;
    }
  | {
      commandRequestId: string;
      type: "enqueue_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      taskCommand: Extract<ZCodeTaskRuntimeCommand, { type: "send_prompt" }>;
    }
  | {
      commandRequestId: string;
      type: "promote_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      commandId: string;
      clientMode: Extract<ZCodeTaskClientMode, "web-remote-replayable">;
    }
  | {
      commandRequestId: string;
      type: "cancel_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      commandId: string;
      clientMode: Extract<ZCodeTaskClientMode, "web-remote-replayable">;
    };

export type TaskOwnerCommandDelivery = TaskOwnerCommandRequest & {
  requesterHostId: string;
};

export type TaskOwnerCommandErrorCode =
  | "NO_ACTIVE_TASK_OWNER"
  | "STALE_TASK_OWNER_COMMAND"
  | "OWNER_COMMAND_FAILED";

export type TaskOwnerCommandResult =
  | { commandRequestId: string; success: true; taskCommand?: ZCodeTaskRuntimeCommand }
  | {
      commandRequestId: string;
      success: false;
      error: string;
      code?: TaskOwnerCommandErrorCode;
    };

export type TaskRealtimeEvent =
  | TaskSnapshotInvalidatedEvent
  | WorkspaceTaskListInvalidatedEvent
  | TaskStreamMirrorBatchEvent;

export type TaskRealtimeDeliveredEvent = TaskRealtimeEvent & {
  originHostId: string;
  deliveryPurpose?: TaskRealtimeDeliveryPurpose;
};
