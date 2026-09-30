// The direct start arrangement of the central "operation".
// No longer synthesize dialogue copy: create an empty session in the target project → issue the startSavedWorkflow command to it →
// Accepted will navigate to the new session (the startup card is already at the top); rejected / throw an error and delete the empty session and return the error to the caller.
// (argument window inline / toast), the user remains in the hub. "Failure before session exists" (invariant 2): createSession
// If start is rejected, no start will be issued and no session will be left; if start is rejected, deleteSession will be immediately restored to take back the newly created empty session.
import { useCallback, useRef, useState } from "react";
import {
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  savedWorkflowStartRejectionReasonSchema,
  type CommandAck,
  type SavedWorkflowStartRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
} from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";

/**
 * Target project coordinates (the project the workflow belongs to, never the active project;
 * invariant 7); remoteSessionId decides the connection endpoint.
 */
export interface SavedWorkflowLaunchTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * Launch request: name is guaranteed by the resolution result (invariant 6), scope is looked up
 * explicitly, and args have already been collected by the argument window.
 */
interface SavedWorkflowLaunchRequest {
  name: string;
  scope: "project" | "global";
  args: Record<string, unknown>;
}

/**
 * Error reason = rejection vocabulary ∪ missing capability ∪ fallback; maps directly to the i18n
 * key `workflows.hub.launch.error.<reason>`.
 */
export type SavedWorkflowLaunchErrorReason =
  | SavedWorkflowStartRejectionReason
  | "unsupported"
  | "generic";

export interface SavedWorkflowLaunchError {
  reason: SavedWorkflowLaunchErrorReason;
  /**
   * Raw fault code / ACK status; used only for logging and troubleshooting, never displayed
   * directly.
   */
  code: string;
  /**
   * Server-side human-readable reason (already bounded and truncated after merging the compile
   * diagnostics); rendered in an inline mono block when present.
   */
  message?: string;
}

type SavedWorkflowLaunchResult =
  | { ok: true; sessionId: string; runId: string; toolCallId: string }
  | { ok: false; error: SavedWorkflowLaunchError };

interface UseSavedWorkflowLauncherResult {
  launch: (
    target: SavedWorkflowLaunchTarget,
    request: SavedWorkflowLaunchRequest,
  ) => Promise<SavedWorkflowLaunchResult>;
  /**
   * Launching: the argument window's primary button is loading and disabled, preventing repeated
   * clicks.
   */
  pending: boolean;
  /** Most recent launch failure (cleared on success / before a new launch). */
  error: SavedWorkflowLaunchError | null;
  clearError: () => void;
}

// The fault code (interaction-background.ts) returned by the v4 handler when the capability is absent (no dwf port).
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";

/**
 * createSession's workspaceId follows the same convention as the conversation connection: identity
 * first, otherwise the path.
 */
export function launchWorkspaceId(target: SavedWorkflowLaunchTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

/**
 * Acquires a connection lease for the target project (remoteSessionId decides the endpoint). Shared
 * by the direct launcher and "promote to global" (useSavedWorkflowPromote): both create the session
 * inside the target project, they only differ in the first command.
 */
export function acquireLaunchLease(
  target: SavedWorkflowLaunchTarget,
  agentService: WorkspaceConnectionAgentService,
) {
  return acquireWorkspaceConnection(
    {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    },
    agentService,
  );
}

/**
 * Maps a rejected ACK into a structured error: missing capability → unsupported; rejection
 * vocabulary → the matching reason; everything else → generic.
 */
function mapLaunchError(ack: CommandAck): SavedWorkflowLaunchError {
  const code = ack.reasonCode ?? ack.status;
  const message = ack.message;
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) {
    return { reason: "unsupported", code, ...(message ? { message } : {}) };
  }
  if (ack.reasonCode?.startsWith(SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX)) {
    const suffix = ack.reasonCode.slice(SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX.length);
    const parsed = savedWorkflowStartRejectionReasonSchema.safeParse(suffix);
    if (parsed.success) return { reason: parsed.data, code, ...(message ? { message } : {}) };
  }
  // Unknown fault / non-rejection vocabulary (including new codes encountered by old clients) are displayed as common errors.
  return { reason: "generic", code, ...(message ? { message } : {}) };
}

/**
 * The hub launcher hook. The carrier `agentService` is resolved by the calling group (the project
 * group = the resolved service of the target project; the global group = the local base service,
 * with the target = the local project selected in "Run in"). After accepted, `onNavigate` switches
 * to the new session (a mirror of `handleSelectTaskInChat`, including `showChatMainView`).
 */
export function useSavedWorkflowLauncher(params: {
  agentService: WorkspaceConnectionAgentService;
  onNavigate?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}): UseSavedWorkflowLauncherResult {
  const { agentService, onNavigate } = params;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SavedWorkflowLaunchError | null>(null);
  // The synchronization fact source of pending: prevents repeated triggering in the same frame (setPending is asynchronous and cannot be stopped by state alone).
  const pendingRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const launch = useCallback(
    async (
      target: SavedWorkflowLaunchTarget,
      request: SavedWorkflowLaunchRequest,
    ): Promise<SavedWorkflowLaunchResult> => {
      if (pendingRef.current) {
        return { ok: false, error: { reason: "generic", code: "launch_in_flight" } };
      }
      pendingRef.current = true;
      setPending(true);
      setError(null);

      const workspaceId = launchWorkspaceId(target);
      const lease = acquireLaunchLease(target, agentService);

      const deleteCreatedSession = (sessionId: string) => {
        void lease.transport
          .sendCommand(createCommandEnvelope({ type: "deleteSession", payload: {}, sessionId }))
          .then((ack) => {
            if (ack.status !== "accepted" && ack.status !== "noop") {
              logger.warn("[saved-workflow-launch] recycle empty session rejected", {
                sessionId,
                status: ack.status,
                reasonCode: ack.reasonCode ?? null,
              });
            }
          })
          .catch(() => {
            // Failure to recycle is harmless: the memory session disappears when the CLI exits, and it does not appear in the transcript (no lines).
          });
      };

      let createdSessionId: string | null = null;
      try {
        // ① Empty session: no firstInput, no config, use the runtime default model/mode (no composer draft configuration is reused).
        const createAck = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: { workspaceId },
            sessionId: null,
          }),
        );
        if (createAck.status !== "accepted" || createAck.result?.type !== "createSession") {
          // The session is not completed: start is not sent, session is not saved, general error.
          logger.warn("[saved-workflow-launch] createSession rejected", {
            workspaceId,
            status: createAck.status,
            reasonCode: createAck.reasonCode ?? null,
          });
          const err: SavedWorkflowLaunchError = {
            reason: "generic",
            code: createAck.reasonCode ?? createAck.status,
            ...(createAck.message ? { message: createAck.message } : {}),
          };
          setError(err);
          return { ok: false, error: err };
        }
        createdSessionId = createAck.result.sessionId;

        // ② startSavedWorkflow: name / scope directed search + actual parameters; no actual parameters without args key.
        const startAck = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "startSavedWorkflow",
            payload: {
              name: request.name,
              scope: request.scope,
              ...(Object.keys(request.args).length > 0 ? { args: request.args } : {}),
            },
            sessionId: createdSessionId,
          }),
        );
        if (startAck.status === "accepted" && startAck.result?.type === "startSavedWorkflow") {
          // accepted: The startup card is already at the top of the new session, switch to it to make it come alive (it starts silently when there is no navigation carrier, and does not switch pages).
          onNavigate?.(target, createdSessionId);
          return {
            ok: true,
            sessionId: createdSessionId,
            runId: startAck.result.runId,
            toolCallId: startAck.result.toolCallId,
          };
        }
        // Startup rejected/failed: Take back the newly created empty session (invariant 2) and return the reason to the actual parameter window/toast.
        deleteCreatedSession(createdSessionId);
        const err = mapLaunchError(startAck);
        setError(err);
        return { ok: false, error: err };
      } catch (thrown) {
        if (createdSessionId) deleteCreatedSession(createdSessionId);
        const err: SavedWorkflowLaunchError = {
          reason: "generic",
          code: "exception",
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
        setError(err);
        return { ok: false, error: err };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [agentService, onNavigate],
  );

  return { launch, pending, error, clearError };
}
