import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  buildTaskContextUsageFromUsageUpdate,
  recordTaskContextUsageUpdate,
} from "@/lib/zcodeTaskUsageFallback.js";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  resolveBotTaskBroadcastRefresh,
  resolveBotTaskBroadcastRuntimeStatus,
} from "@/root/botsTaskBroadcast.js";
import { resolveBotTaskStreamBroadcast } from "@/root/botsTaskStreamBroadcast.js";
import {
  insertTaskIntoTaskCaches,
  syncTaskMetaToTaskCaches,
} from "@/lib/taskListMetaSync.js";

export function syncBotTaskConfigOptionsToStore(params: {
  zcodeSessionStore: Pick<
    ReturnType<typeof useZCodeSessionStore.getState>,
    "setTaskConfigOptions"
  >;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  configOptions: ZCodeConfigOption[];
}) {
  // Bugfix: Bot /mode does not pass ChatInputToolbar/useTaskStreamEvents.
  // setTaskConfigOptions will determine whether to synchronize to workspace configOptions based on activeTaskId.
  // The current mode is then derived from configOptions to prevent the UI from maintaining a second copy of the mode state.
  params.zcodeSessionStore.setTaskConfigOptions(
    params.workspacePath,
    params.taskId,
    params.configOptions,
    params.workspaceIdentity,
  );
}

export function shouldRefreshBotTaskList(
  event: string,
  hasTaskMeta: boolean,
): boolean {
  // Bugfix: When Bot creates a new task, it will carry task meta with the created broadcast. The current implementation therefore skips refreshing the entire table.
  // However, if the task query cache corresponding to the workspace has not yet been established and there is no landing point for incremental writing, the sidebar list will not actively pull in this new task.
  // The frequency of the created event is low, and a version bump is retained as a backup; other high-frequency events are still prioritized for incremental cache updates to avoid list flickering and regression.
  if (event === "created") {
    return true;
  }
  if (hasTaskMeta) {
    return false;
  }
  return event === "created" || event === "updated" || event === "completed" || event === "error";
}

export function shouldMirrorBotTaskStreamToStore(params: {
  activeTaskId: string | null;
  taskId: string;
  workspaceIdentity?: string;
}): boolean {
  if (params.activeTaskId !== params.taskId) {
    return true;
  }

  // Bugfix: The stream of the remote Bot task comes from the bot runtime host and may not be received by the ZCode Agent stream subscription of the current ChatView.
  // Previously, the active task directly skipped the bot broadcast, causing the message content to be displayed after switching tasks and pulling the snapshot again.
  return Boolean(params.workspaceIdentity?.trim());
}

export function useBotBroadcastEffects(
  services: IServiceAccessor,
  tabStoreApi: ReturnType<typeof useTabStoreApi>,
) {
  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      const stream = resolveBotTaskStreamBroadcast(
        message,
        tabStoreApi.getState().tabs,
      );
      if (stream) {
        const zcodeSessionStore = useZCodeSessionStore.getState();
        const workspaceState = zcodeSessionStore.getWorkspaceState(
          stream.workspacePath,
          stream.workspaceIdentity,
        );
        if (
          !shouldMirrorBotTaskStreamToStore({
            activeTaskId: workspaceState.activeTaskId,
            taskId: stream.taskId,
            workspaceIdentity: stream.workspaceIdentity,
          })
        ) {
          return;
        }

        // When the Bot task is running in the background or in the remote runtime, this window may not necessarily be subscribed to the same stream.
        // The message body is no longer played back into the renderer local store - the prompt sent by the bot
        // After running the v4 command, the message is naturally presented by the conversation projection (subscribing to the pane of the session);
        // Here, only the status of Area A such as running status/permissions/usage are synchronized for sidebar and pop-up window consumption.
        const event = stream.event;
        switch (event.type) {
          case "agent_message_chunk":
          case "agent_thought_chunk":
          case "tool_call":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "permission_request":
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, event, stream.workspaceIdentity);
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "task_complete":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "completed",
              undefined,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            break;
          case "task_error": {
            const normalizedError = normalizeZCodeUiError(
              {
                message: event.error,
                detail: event.detail,
                code: event.code,
              },
              {
                fallbackCode: event.code ?? "UNKNOWN",
                traceId: event.traceId,
                taskId: event.taskId,
              },
            );
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "failed",
              normalizedError.message,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, normalizedError, stream.workspaceIdentity);
            break;
          }
          case "task_warning":
            zcodeSessionStore.setTaskError(
              stream.workspacePath,
              stream.taskId,
              normalizeZCodeUiError(
                {
                  message: event.warning,
                  detail: event.detail,
                  code: event.code,
                },
                {
                  fallbackCode: event.code ?? "WARNING",
                  traceId: event.traceId,
                  taskId: event.taskId,
                },
              ),
              stream.workspaceIdentity,
            );
            break;
          case "usage_update":
            {
              const workspaceState = zcodeSessionStore.getWorkspaceState(
                stream.workspacePath,
                stream.workspaceIdentity,
              );
              const previousUsage =
                workspaceState.taskRuntimeByTaskId[stream.taskId]?.usage ?? null;
              // taskMessagesByTaskId has been retired along with message playback. It is estimated that the latest one will not be used.
              // Use fallback estimation when the user inputs (this branch only affects the proportional display of the usage pop-up window).
              const incomingUsage = {
                size: event.size,
                used: event.used,
                cost: event.cost,
                ...(event.cache ? { cache: event.cache } : {}),
                ...(event.breakdown ? { breakdown: event.breakdown } : {}),
              };
              const nextUsage = buildTaskContextUsageFromUsageUpdate({
                currentUsage: previousUsage,
                incomingUsage,
              });
              recordTaskContextUsageUpdate({
                workspacePath: stream.workspacePath,
                workspaceIdentity: stream.workspaceIdentity,
                taskId: stream.taskId,
                size: event.size,
                used: event.used,
              });
              zcodeSessionStore.setTaskContextWindow(
                stream.workspacePath,
                stream.taskId,
                event.size,
                stream.workspaceIdentity,
              );
              zcodeSessionStore.setTaskUsage(
                stream.workspacePath,
                stream.taskId,
                nextUsage,
                stream.workspaceIdentity,
              );
            }
            break;
          case "session_info_update":
            if (event.apiRetry !== undefined) {
              zcodeSessionStore.setTaskApiRetryStatus(
                stream.workspacePath,
                stream.taskId,
                event.apiRetry ?? null,
                stream.workspaceIdentity,
              );
            }
            break;
        }
        return;
      }

      const refresh = resolveBotTaskBroadcastRefresh(
        message,
        tabStoreApi.getState().tabs,
      );
      if (!refresh) {
        return;
      }
      // Bots create/advance tasks on the host side and will not mount the stream subscription in the chat view.
      // Therefore, in addition to refreshing the list, the task running status must also be synchronized; otherwise, the sidebar can see the new task, but will not display the in-progress status.
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const workspaceState = zcodeSessionStore.getWorkspaceState(
        refresh.workspacePath,
        refresh.workspaceIdentity,
      );
      const provider = refresh.task?.provider ?? refresh.provider;
      const shouldSyncVisibleTaskConfig = workspaceState.activeTaskId === refresh.taskId;
      if (provider && shouldSyncVisibleTaskConfig) {
        // Bugfix: /model, /mode can modify the real ZCode Agent status of the current task from a third-party Bot.
        // These operations do not go through the ChatInputToolbar, and the local store will not synchronize provider/configOptions before.
        // Causes the Bot reply to be toggled but the UI dropdown still shows the old state.
        zcodeSessionStore.bindRuntimeProvider(
          refresh.workspacePath,
          provider,
          refresh.workspaceIdentity,
        );
      }
      if (refresh.configOptions) {
        syncBotTaskConfigOptionsToStore({
          zcodeSessionStore,
          workspacePath: refresh.workspacePath,
          workspaceIdentity: refresh.workspaceIdentity,
          taskId: refresh.taskId,
          configOptions: refresh.configOptions,
        });
      }
      zcodeSessionStore.setTaskRuntimeState(
        refresh.workspacePath,
        refresh.taskId,
        resolveBotTaskBroadcastRuntimeStatus(refresh.event),
        undefined,
        refresh.workspaceIdentity,
      );
      if (refresh.task) {
        // Bugfix: Before Bot status changes, rely on bumpTaskListVersion to recheck the entire table.
        // Continuous events such as prompt_sent / completed will cause the sidebar queryKey to be updated repeatedly, and the old cache will temporarily become invalid, causing the task list to flicker.
        // When there is task meta here, it is written incrementally to the task/query cache directly, and only the old broadcast that lacks meta is retained for the entire table to be refreshed.
        const membership = { pinned: false, archived: false };
        if (refresh.event === "created") {
          insertTaskIntoTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
          });
        } else {
          syncTaskMetaToTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
            ensureInWorkspaceTaskCache: true,
          });
        }
      }
      // prompt_sent no longer writes user messages locally to the renderer—sent by the bot
      // prompt enters the session event log via the v4 command and subscribes to the conversation projection of the session
      // This message will appear naturally; the local assembly surface (zcodeChatMessages) is retired with the old ChatView.
      if (refresh.event === "permission_request" && refresh.permissionRequest) {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.permissionRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "permission_resolved" && refresh.requestId) {
        zcodeSessionStore.removeTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_request" && refresh.elicitationRequest) {
        // Bugfix: After Bot channel consumes AskUserQuestion, the next question will only arrive in Bot runtime first.
        // The current UI window does not necessarily have the same ZCode Agent stream subscription, and the new elicitation_request must be explicitly written back to the store.
        zcodeSessionStore.setTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.elicitationRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_resolved" && refresh.requestId) {
        // Bugfix: When Bot submits AskUserQuestion on behalf of the user, the current UI window may not receive the ZCode Agent stream.
        // elicitation_response. Explicitly synchronize the requestId out of the queue through bots:task to avoid the Q&A pop-up window from hanging all the time.
        zcodeSessionStore.removeTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "completed" || refresh.event === "error") {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          null,
          refresh.workspaceIdentity,
        );
      }
      if (shouldRefreshBotTaskList(refresh.event, Boolean(refresh.task))) {
        zcodeSessionStore.bumpTaskListVersion(refresh.workspacePath, refresh.workspaceIdentity);
      }
    });
    return () => disposable.dispose();
  }, [services.broadcastService, tabStoreApi]);
}
