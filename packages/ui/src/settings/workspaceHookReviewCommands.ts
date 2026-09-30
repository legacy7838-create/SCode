import type {
  CommandPayloadMap,
  CommandType,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type { Hook } from "@zcode/shared";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBindingForItem,
  useWorkspaceHookReviewStore,
  waitForWorkspaceHookReviewBindingForItem,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

export async function sendWorkspaceHookCommand<T extends CommandType>(
  binding: Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
  sessionId: string,
  type: T,
  payload: CommandPayloadMap[T],
): Promise<{ accepted: boolean; reasonCode?: string }> {
  const envelope = createCommandEnvelope({ type, sessionId, payload } as never);
  pendingCommandRegistry.record(envelope);
  try {
    const ack = await binding.sendCommand(envelope);
    pendingCommandRegistry.applyAck(envelope, ack);
    return {
      accepted: ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop",
      ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
    };
  } finally {
    binding.onCommandSettled?.(envelope.commandId);
  }
}

function toWorkspaceHookReviewCommandTarget(request: WorkspaceHookReviewRequestPayload) {
  return {
    sessionId: request.sessionId,
    taskId: request.taskId,
    runId: request.runId,
    ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
    workspaceIdentity: request.workspaceIdentity,
    bundleDigest: request.bundleDigest,
    reviewFlowId: request.reviewFlowId,
    generation: request.generation,
    interactionId: request.interactionId,
  };
}

const DEFAULT_REVIEW_WAIT_TIMEOUT_MS = 5_000;

function shouldGrantCurrentWorkspaceSnapshot(reasonCode: string | undefined): boolean {
  return (
    reasonCode === "workspace_hooks_require_trust_capable_host" ||
    reasonCode === "workspace_hooks_snapshot_mismatch" ||
    reasonCode === "workspace_hooks_bundle_changed"
  );
}

/**
 * The one-shot user action behind inline Trust in Settings: when an exact flow already exists,
 * respond directly; otherwise first request the flow through the current session command binding,
 * then wait for the immutable request projected by the Runtime. When the current session's
 * immutable snapshot cannot review the Settings bundle, the workspace Agent authority rediscovers
 * the canonical snapshot; the UI static snapshot always supplies only the exact target.
 */
export async function trustWorkspaceHookWithReview(input: {
  hook: Hook;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  reviewWaitTimeoutMs?: number;
  grantWithoutSession?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }) => Promise<{ accepted: boolean; reasonCode?: string }>;
}): Promise<{ accepted: boolean; reasonCode?: string }> {
  const workspaceHook = input.hook.workspaceHook;
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceHook || !workspaceKey || workspaceHook.workspaceIdentity !== workspaceKey) {
    return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  }
  const grantCurrentWorkspaceSnapshot = () => {
    if (!input.grantWithoutSession || !input.workspacePath) return undefined;
    return input.grantWithoutSession({
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      bundleDigest: workspaceHook.bundleDigest,
      hookDeclarationDigest: workspaceHook.hookDeclarationDigest,
    });
  };
  const reviewTarget = {
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    bundleDigest: workspaceHook.bundleDigest,
    reviewItemId: workspaceHook.reviewItemId,
  };
  let reviewBinding = findWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    reviewTarget,
  );

  if (!reviewBinding) {
    const commandBinding = findWorkspaceHookCommandBinding(
      useWorkspaceHookReviewStore.getState().commandBindings,
      input.workspacePath,
      input.workspaceIdentity,
    );
    if (!commandBinding) {
      const granted = grantCurrentWorkspaceSnapshot();
      if (granted) return granted;
      return {
        accepted: false,
        reasonCode: "workspace_hooks_require_trust_capable_host",
      };
    }
    const requested = await sendWorkspaceHookCommand(
      commandBinding,
      commandBinding.sessionId,
      "requestWorkspaceHookReview",
      {
        sessionId: commandBinding.sessionId,
        ...(commandBinding.remoteSessionId
          ? { remoteSessionId: commandBinding.remoteSessionId }
          : {}),
        workspaceIdentity: workspaceHook.workspaceIdentity,
        bundleDigest: workspaceHook.bundleDigest,
      },
    );
    if (!requested.accepted) {
      // As long as there is an active session binding, the Trust is fixedly routed to the
      // session; Settings After saving the new Hook, the active session still holds the immutable snapshot at startup.
      // Therefore, the current bundle cannot be audited, but the originally safe and available workspace pretrust is also blocked.
      if (shouldGrantCurrentWorkspaceSnapshot(requested.reasonCode)) {
        const granted = grantCurrentWorkspaceSnapshot();
        if (granted) return granted;
      }
      return requested;
    }

    reviewBinding = await waitForWorkspaceHookReviewBindingForItem(
      reviewTarget,
      input.reviewWaitTimeoutMs ?? DEFAULT_REVIEW_WAIT_TIMEOUT_MS,
    );
    if (!reviewBinding) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_interaction_timeout",
      };
    }
  }

  const request = reviewBinding.request;
  return sendWorkspaceHookCommand(reviewBinding, request.sessionId, "respondWorkspaceHookReview", {
    ...toWorkspaceHookReviewCommandTarget(request),
    decision: {
      action: "trust_selected",
      reviewItemIds: [workspaceHook.reviewItemId],
    },
  });
}
