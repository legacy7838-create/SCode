import {
  BOT_TASK_BROADCAST_CHANNEL,
  type ZCodeTaskRuntimeStatus,
  type BotTaskBroadcastPayload,
} from "@zcode/shared";
import type { BroadcastMessage } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WindowTabState } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

function isBotTaskBroadcastPayload(
  payload: unknown,
): payload is BotTaskBroadcastPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const value = payload as Partial<BotTaskBroadcastPayload>;
  const validEvents = new Set<BotTaskBroadcastPayload["event"]>([
    "created",
    "prompt_sent",
    "resumed",
    "streaming",
    "permission_request",
    "permission_resolved",
    "elicitation_request",
    "elicitation_resolved",
    "updated",
    "completed",
    "error",
  ]);
  return (
    typeof value.workspacePath === "string" &&
    typeof value.taskId === "string" &&
    typeof value.updatedAt === "number" &&
    (value.workspaceIdentity === undefined ||
      typeof value.workspaceIdentity === "string") &&
    typeof value.event === "string" &&
    validEvents.has(value.event) &&
    (value.task === undefined ||
      (typeof value.task === "object" &&
        value.task !== null &&
        typeof value.task.taskId === "string" &&
        typeof value.task.workspacePath === "string")) &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.configOptions === undefined || Array.isArray(value.configOptions)) &&
    (value.permissionRequest === undefined ||
      (typeof value.permissionRequest === "object" && value.permissionRequest !== null)) &&
    (value.elicitationRequest === undefined ||
      (typeof value.elicitationRequest === "object" && value.elicitationRequest !== null)) &&
    (value.prompt === undefined ||
      (typeof value.prompt === "object" &&
        value.prompt !== null &&
        typeof value.prompt.content === "string" &&
        typeof value.prompt.messageId === "string" &&
        typeof value.prompt.sentAt === "number")) &&
    (value.requestId === undefined || typeof value.requestId === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function resolveBotTaskBroadcastRefresh(
  message: BroadcastMessage,
  tabs: WindowTabState[],
): BotTaskBroadcastPayload | null {
  if (message.channel !== BOT_TASK_BROADCAST_CHANNEL) {
    return null;
  }
  if (!isBotTaskBroadcastPayload(message.payload)) {
    return null;
  }
  const targetWorkspaceKey = buildTaskWorkspaceKey(
    message.payload.workspacePath,
    message.payload.workspaceIdentity,
  );
  const hasOpenWorkspace = tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
        targetWorkspaceKey,
  );
  return hasOpenWorkspace ? message.payload : null;
}

export function resolveBotTaskBroadcastRuntimeStatus(
  event: BotTaskBroadcastPayload["event"],
): ZCodeTaskRuntimeStatus {
  switch (event) {
    case "created":
      return "creating";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "prompt_sent":
    case "resumed":
    case "streaming":
    case "permission_request":
    case "permission_resolved":
    case "elicitation_request":
    case "elicitation_resolved":
      return "streaming";
    case "updated":
      // Bugfix: Bot configuration updates such as /model, /mode, /think only synchronize task metadata/configOptions.
      // Assistant streaming is not started once. Previously, updated was mapped to streaming.
      // Will keep the current conversation showing loading.
      return "ready";
  }
}
