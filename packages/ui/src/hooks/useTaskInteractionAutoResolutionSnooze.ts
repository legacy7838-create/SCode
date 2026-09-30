import { useCallback, useRef } from "react";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";

interface TaskInteractionAutoResolutionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

/**
 * A sidebar task may come from local, remote, the timeline, or a pinned list; the pause command
 * must find the original host by workspace identity, and must not be sent to the current window's
 * service just because the active tab differs.
 */
export function useTaskInteractionAutoResolutionSnooze(
  target: TaskInteractionAutoResolutionTarget,
) {
  const loggedInteractionIdsRef = useRef(new Set<string>());
  const contextServices = useOptionalServices();
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = target.remoteSessionId?.trim() || undefined;
  const isRemoteTarget = Boolean(workspaceIdentity || remoteSessionId);
  const selectTargetServices = useCallback(
    (state: ReturnType<typeof useRemoteWorkspaceSessionStore.getState>) => {
      if (!isRemoteTarget) {
        return state.baseServices ?? contextServices;
      }

      const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
        {
          workspacePath: target.workspacePath,
          workspaceIdentity,
          remoteSessionId,
          // This hook's target type only carries task routing fields; an existing remoteSessionId is enough to
          // show that old data can be recovered with path-compatible resolution, without faking a concrete RemoteTarget.
          remoteTarget: remoteSessionId ? true : undefined,
        },
        state,
      );
      if (resolvedRemoteSessionId) {
        return state.sessionsById[resolvedRemoteSessionId]?.services ?? null;
      }
      // Do not fall back to the local service when a remote task's original host cannot be found, otherwise the same taskId
      // could be delivered to the wrong workspace; keep a retryable failure and wait for the remote attachment to recover.
      return null;
    },
    [contextServices, isRemoteTarget, remoteSessionId, target.workspacePath, workspaceIdentity],
  );
  const targetServices = useRemoteWorkspaceSessionStore(selectTargetServices);

  return useCallback(
    async (interactionId: string): Promise<boolean> => {
      const agentService = targetServices?.zcodeAgentService;
      if (!agentService) {
        logger.warn(
          "[task-interaction] target workspace is not connected while snoozing auto-resolution",
          {
            interactionId,
            sessionId: target.sessionId,
            workspaceKey: workspaceIdentity ?? target.workspacePath,
          },
        );
        return false;
      }
      if (!loggedInteractionIdsRef.current.has(interactionId)) {
        loggedInteractionIdsRef.current.add(interactionId);
        logger.debug("[task-interaction] user requested auto-resolution snooze from the sidebar", {
          interactionId,
          sessionId: target.sessionId,
          source: "taskBadge",
        });
      }

      return sendInteractionAutoResolutionSnooze({
        sessionId: target.sessionId,
        interactionId,
        source: "taskBadge",
        sendCommand: async (envelope) => {
          await ensureAgentV4ConnectionHandshake(agentService);
          return agentService.sendConversationCommandV4({
            workspacePath: target.workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            envelope,
          });
        },
      });
    },
    [target.sessionId, target.workspacePath, targetServices, workspaceIdentity],
  );
}
