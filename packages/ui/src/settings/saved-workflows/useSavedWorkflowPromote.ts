// "Promote to global" initiative arrangement.
//
// Project file → global file is not about moving files: most project workflows refer to the path/command/convention of this warehouse, and moving there byte by byte is just one
// A global definition that will inevitably break in other projects. This step is a **summary** of the model: the GUI creates a new session in the project, and the first user
// The message is a summary prompt (`createSession.firstInput`, automatically sent). The model reads the file, extracts the parameters, and passes the SaveWorkflow
// (`scope: "global"`) Save another copy; the source file remains unchanged and the confirmation window remains.
//
// Why not take the `onCreateViaChat` of "revision/create through conversation": that path only prefills the composer draft and does not send it.
// What the user clicked here is an action, and he should not be asked to click send again. Why not use the direct launcher: what it sends is
// startSavedWorkflow command (run workflow), what is sent here is a normal user input. create with firstInput
// It is either accepted or rejected as a whole. There is no intermediate state of "the session is established but the message is not sent", so there is no need for recycling logic.
import { useCallback, useRef, useState } from "react";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { WorkspaceConnectionAgentService } from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";
import { buildSavedWorkflowPromotePrompt } from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  acquireLaunchLease,
  launchWorkspaceId,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

/**
 * The project-scope entry being promoted: its name and path go into the prompt (the model reads the
 * file itself), plus the copy for the selected locale.
 */
interface SavedWorkflowPromoteRequest {
  name: string;
  path: string;
  locale: string;
}

type SavedWorkflowPromoteResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      /** The raw fault code / ACK status; used by the log and by the toast fallback copy. */
      code: string;
      /** The server's human-readable reason (shown first when present). */
      message?: string;
    };

interface UseSavedWorkflowPromoteResult {
  promote: (
    target: SavedWorkflowLaunchTarget,
    request: SavedWorkflowPromoteRequest,
  ) => Promise<SavedWorkflowPromoteResult>;
  /** A promotion is in flight: the card / detail menu are disabled to prevent duplicate clicks. */
  pending: boolean;
}

/**
 * The carrier `agentService` = the agent service resolved for that project (the project group
 * already has one); `onNavigate` switches to the new session once accepted (sharing
 * `onNavigateToLaunchedRun` with a direct launch). The model / mode default at run time, and the
 * composer draft settings are not reused — the same trade-off as a direct launch.
 */
export function useSavedWorkflowPromote(params: {
  agentService: WorkspaceConnectionAgentService;
  onNavigate?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}): UseSavedWorkflowPromoteResult {
  const { agentService, onNavigate } = params;
  const [pending, setPending] = useState(false);
  // Synchronous fact source to prevent re-entry within the same frame (setPending is asynchronous, state alone cannot block double-click).
  const pendingRef = useRef(false);

  const promote = useCallback(
    async (
      target: SavedWorkflowLaunchTarget,
      request: SavedWorkflowPromoteRequest,
    ): Promise<SavedWorkflowPromoteResult> => {
      if (pendingRef.current) {
        return { ok: false, code: "promote_in_flight" };
      }
      pendingRef.current = true;
      setPending(true);
      const lease = acquireLaunchLease(target, agentService);
      try {
        const ack = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: {
              workspaceId: launchWorkspaceId(target),
              firstInput: { text: buildSavedWorkflowPromotePrompt(request) },
            },
            sessionId: null,
          }),
        );
        if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
          logger.warn("[saved-workflow-promote] createSession(firstInput) rejected", {
            workspacePath: target.workspacePath,
            name: request.name,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
          return {
            ok: false,
            code: ack.reasonCode ?? ack.status,
            ...(ack.message ? { message: ack.message } : {}),
          };
        }
        onNavigate?.(target, ack.result.sessionId);
        return { ok: true, sessionId: ack.result.sessionId };
      } catch (thrown) {
        return {
          ok: false,
          code: "exception",
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [agentService, onNavigate],
  );

  return { promote, pending };
}
