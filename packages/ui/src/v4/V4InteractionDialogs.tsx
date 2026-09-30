import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeElicitationRequest, ZCodePermissionOption, ZCodeProvider } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePendingInteractionTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { logger } from "@/logger.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  getTaskUiState,
  getWorkspaceState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";
import {
  pendingPermissionToLegacyRequest,
  pendingUserInputToElicitationRequest,
  pendingUserInputToViewModel,
} from "@/v4/pendingInteractionAdapter.js";
import { V4UserInputDialog } from "@/v4/V4UserInputDialog.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

interface V4InteractionDialogsProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  provider?: ZCodeProvider;
  snapshot: ConversationSnapshot | null;
  onCommandSettled?: (commandId: string) => void;
  onPlanInteractionAccepted?: (interactionId: string) => void;
}

function getCurrentSessionInteractionSnapshot(
  sessionId: string,
  snapshot: ConversationSnapshot | null,
): ConversationSnapshot | null {
  return snapshot?.sessionId === sessionId ? snapshot : null;
}

function resolveV4ElicitationRequest(
  projected: ZCodeElicitationRequest | null,
  botProgress: ZCodeElicitationRequest | null,
): ZCodeElicitationRequest | null {
  // Bugfix: V4 snapshot only retains the original blocking request, and the question-by-question progress after the Bot answers must cover the projection of the same request.
  if (projected && botProgress?.requestId === projected.requestId) {
    return botProgress;
  }
  return projected;
}

function buildV4ElicitationProgressKey(request: ZCodeElicitationRequest): string {
  return `${request.requestId}:${request.currentQuestionIndex ?? 0}:${JSON.stringify(request.answerDrafts ?? {})}`;
}

interface InteractionAutoResolutionIntentTracker {
  markInteracted(interactionId: string): void;
  consumeSnooze(interactionId: string, autoResolutionReady: boolean): boolean;
  releaseSnooze(interactionId: string): void;
}

function createInteractionAutoResolutionIntentTracker(): InteractionAutoResolutionIntentTracker {
  const interactedIds = new Set<string>();
  const sentIds = new Set<string>();
  return {
    markInteracted(interactionId) {
      interactedIds.add(interactionId);
    },
    consumeSnooze(interactionId, autoResolutionReady) {
      if (!autoResolutionReady || !interactedIds.has(interactionId) || sentIds.has(interactionId)) {
        return false;
      }
      sentIds.add(interactionId);
      return true;
    },
    releaseSnooze(interactionId) {
      sentIds.delete(interactionId);
    },
  };
}

/**
 * Vertical slice: wires projection.pendingInteractions to the PermissionDialog / userInput dialogs.
 * Without this component, once ChatView is deleted, sessions with tool permissions block forever.
 */
export function V4InteractionDialogs({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  provider,
  snapshot,
  onCommandSettled,
  onPlanInteractionAccepted,
}: V4InteractionDialogsProps) {
  const { sendCommand } = useV4Conversation();
  const connectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.connect);
  const disconnectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.disconnect);
  const upsertWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.upsert);
  const clearWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.clear);
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  // When the task switches, the sessionId will be updated first, and the old task snapshot may be retained for one more frame.
  // If you use the old snapshot directly, the renderer-local Q&A draft of the current task will be mistakenly judged as expired and cleaned up.
  const currentSnapshot = getCurrentSessionInteractionSnapshot(sessionId, snapshot);
  // workspaceHookReview is a special interaction handled by Settings/Hooks and cannot be rendered by a general Dialog;
  // But it can coexist with permission/userInput, and fixed reading [0] will block subsequent interactions that really require pop-up windows.
  // Here only the first interaction that can be rendered by this component is selected, while retaining the queue order of permission/userInput.
  const pending =
    currentSnapshot?.pendingInteractions.find(
      (interaction) =>
        interaction.payload.kind === "permission" || interaction.payload.kind === "userInput",
    ) ?? null;
  const workspaceHookReview = currentSnapshot?.pendingInteractions.find(
    (interaction) => interaction.payload.kind === "workspaceHookReview",
  );
  const notificationEnabled = useZCodeStoreWithDefault((state) => state.notificationEnabled, true);
  const botElicitationProgress = useZCodeSessionStore(
    (state) =>
      getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
        .elicitationRequest,
  );
  const localElicitationDraft = useZCodeSessionStore((state) => {
    if (!pending || pending.payload.kind !== "userInput") return undefined;
    return getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
      .elicitationFormDraftsByRequestId[pending.interactionId];
  });
  usePendingInteractionTaskNotifications({
    snapshot: currentSnapshot,
    enabled: notificationEnabled,
    platform,
    formatMessage: intl.formatMessage,
  });
  useEffect(() => {
    connectWorkspaceHookCommands(sessionId, {
      sessionId,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      sendCommand,
      onCommandSettled,
    });
    return () => disconnectWorkspaceHookCommands(sessionId, sendCommand);
  }, [
    connectWorkspaceHookCommands,
    disconnectWorkspaceHookCommands,
    onCommandSettled,
    sendCommand,
    sessionId,
    workspaceIdentity,
    remoteSessionId,
    workspacePath,
  ]);
  useEffect(() => {
    if (!workspaceHookReview || workspaceHookReview.payload.kind !== "workspaceHookReview") {
      clearWorkspaceHookReview(sessionId);
      return;
    }
    upsertWorkspaceHookReview(sessionId, {
      request: workspaceHookReview.payload,
      workspacePath,
      sendCommand,
      onCommandSettled,
    });
    // Soft access control: No longer forced to jump to Settings/Hooks.
    // The user actively opens Hooks settings through the [Go to Review] button of WorkspaceHookPendingBanner.
  }, [
    clearWorkspaceHookReview,
    onCommandSettled,
    sendCommand,
    sessionId,
    upsertWorkspaceHookReview,
    workspaceHookReview,
    workspacePath,
  ]);
  const autoResolutionIntentRef = useRef(createInteractionAutoResolutionIntentTracker());
  const loggedSnoozeSourceIdsRef = useRef(new Set<string>());
  const [permissionResponse, setPermissionResponse] = useState<{
    interactionId: string;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  const permissionResponseFlight = useRef<string | null>(null);

  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      answer: {
        optionId?: string;
        freeText?: string;
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      },
    ) => {
      const envelope = createCommandEnvelope({
        type: "resolveInteraction",
        sessionId,
        payload: { interactionId, answer },
      });
      // The permissions/freeText/content are not saved; the registry only holds the summary, which is used for query reconciliation after ACK is lost.
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        const accepted =
          ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
        if (!accepted) {
          logger.warn("[v4-interaction] resolveInteraction rejected", {
            interactionId,
            status: ack.status,
            reasonCode: ack.reasonCode,
          });
        }
        return accepted;
      } catch (error) {
        logger.error("[v4-interaction] resolveInteraction failed", { interactionId, error });
        return false;
      } finally {
        onCommandSettled?.(envelope.commandId);
      }
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const snoozeAutoResolution = useCallback(
    async (interactionId: string) => {
      return sendInteractionAutoResolutionSnooze({
        sessionId,
        interactionId,
        sendCommand,
        source: "dialog",
        onCommandSettled,
      });
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const persistElicitationDraft = useCallback(
    (requestId: string, draft: ElicitationFormDraft) => {
      useZCodeSessionStore
        .getState()
        .setTaskElicitationFormDraft(workspacePath, sessionId, requestId, draft, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  const removeElicitationDraft = useCallback(
    (requestId: string) => {
      useZCodeSessionStore
        .getState()
        .removeTaskElicitationFormDraft(workspacePath, sessionId, requestId, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    if (!currentSnapshot) return;
    const activeRequestIds = new Set(
      currentSnapshot.pendingInteractions
        .filter((interaction) => interaction.payload.kind === "userInput")
        .map((interaction) => interaction.interactionId),
    );
    const taskUiState = getTaskUiState(
      getWorkspaceState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity),
      sessionId,
    );
    for (const requestId of Object.keys(taskUiState.elicitationFormDraftsByRequestId)) {
      if (!activeRequestIds.has(requestId)) {
        // The request may be answered by the other end or ended automatically while the task is invisible; after returning to the task
        // The pendingInteractions of snapshot cleans up expired renderer drafts for the authority.
        removeElicitationDraft(requestId);
      }
    }
  }, [currentSnapshot, removeElicitationDraft, sessionId, workspaceIdentity, workspacePath]);

  const sendSnoozeOnce = useCallback(
    async (interactionId: string, autoResolutionReady: boolean) => {
      // The first userInput and autoResolution durable events may arrive two adjacent frames. Reserved when not ready
      // tracker intent, but returns false to the pop-up window so that subsequent actual operations can still be retried; the effect will be reissued after it is ready.
      if (!autoResolutionReady) return false;
      if (!autoResolutionIntentRef.current.consumeSnooze(interactionId, autoResolutionReady)) {
        return true;
      }
      try {
        const accepted = await snoozeAutoResolution(interactionId);
        if (!accepted) autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return accepted;
      } catch {
        autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return false;
      }
    },
    [snoozeAutoResolution],
  );

  useEffect(() => {
    // PermissionRequested may emit userInput first, followed by the autoResolution durable event.
    // If the user completes the first sub-question operation between these two frames, the local intention will be recorded first, and a reissue will be issued immediately after the registry is ready.
    if (pending) {
      void sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
    }
  }, [pending?.autoResolution, pending?.interactionId, sendSnoozeOnce]);

  if (!pending) {
    return null;
  }

  // workspaceHookReview can only be handled by the Settings/Hooks inline Trust; never downgraded to a generic Dialog.
  if (pending.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (pending.payload.kind === "permission") {
    const request = pendingPermissionToLegacyRequest(sessionId, {
      ...pending,
      payload: pending.payload,
    });
    return (
      // Continuous permission will reuse the input box focus state and rebuild according to interaction.
      <PermissionDialog
        key={pending.interactionId}
        request={request}
        workspacePath={workspacePath}
        provider={provider}
        responding={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.pending
        }
        responseError={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.failed
            ? intl.formatMessage({ id: "chat.permission.responseFailed" })
            : undefined
        }
        onRespond={(_requestId, option: ZCodePermissionOption, feedback?: string) => {
          if (permissionResponseFlight.current === pending.interactionId) return;
          const interactionId = pending.interactionId;
          permissionResponseFlight.current = interactionId;
          setPermissionResponse({ interactionId, pending: true, failed: false });
          void resolveInteraction(interactionId, {
            optionId: option.optionId,
            ...(feedback ? { freeText: feedback } : {}),
          }).then((accepted) => {
            if (permissionResponseFlight.current !== interactionId) return;
            permissionResponseFlight.current = null;
            setPermissionResponse({ interactionId, pending: false, failed: !accepted });
          });
        }}
      />
    );
  }

  const projectedElicitationRequest = pendingUserInputToElicitationRequest(sessionId, {
    ...pending,
    payload: pending.payload,
  });
  const elicitationRequest = resolveV4ElicitationRequest(
    projectedElicitationRequest,
    botElicitationProgress,
  );
  if (elicitationRequest) {
    const isExitPlanMode = pending.payload.toolName?.trim().toLowerCase() === "exitplanmode";
    const isAskUserQuestion =
      pending.payload.toolName?.trim().toLowerCase() === "askuserquestion" ||
      pending.autoResolution !== undefined;
    return (
      <ElicitationDialog
        key={buildV4ElicitationProgressKey(elicitationRequest)}
        request={elicitationRequest}
        initialFormDraft={
          botElicitationProgress?.requestId === elicitationRequest.requestId
            ? undefined
            : localElicitationDraft
        }
        onFormDraftChange={persistElicitationDraft}
        autoResolution={isAskUserQuestion ? pending.autoResolution : undefined}
        onFirstInteraction={
          isAskUserQuestion
            ? (source) => {
                if (!loggedSnoozeSourceIdsRef.current.has(pending.interactionId)) {
                  loggedSnoozeSourceIdsRef.current.add(pending.interactionId);
                  logger.debug(
                    "[v4-interaction] AskUserQuestion requested auto-resolution snooze",
                    {
                      interactionId: pending.interactionId,
                      source,
                    },
                  );
                }
                autoResolutionIntentRef.current.markInteracted(pending.interactionId);
                return sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
              }
            : undefined
        }
        onRespond={(_requestId, action, content) => {
          void resolveInteraction(pending.interactionId, {
            action,
            ...(content ? { content } : {}),
          }).then((accepted) => {
            if (!accepted) return;
            removeElicitationDraft(pending.interactionId);
            if (isExitPlanMode) {
              // Plan receipt ACK and replayable pending clearing are two asynchronous paths.
              // Only accepted Plan interactions are reported here, and the recovery is triggered by the mobile pane when the old authoritative state is still read.
              onPlanInteractionAccepted?.(pending.interactionId);
            }
          });
        }}
      />
    );
  }

  const model = pendingUserInputToViewModel({
    ...pending,
    payload: pending.payload,
  });
  return (
    <V4UserInputDialog
      model={model}
      onSubmit={(answer) => {
        void resolveInteraction(pending.interactionId, answer);
      }}
    />
  );
}
