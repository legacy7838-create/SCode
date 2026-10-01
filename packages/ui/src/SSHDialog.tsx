/* eslint-disable max-lines -- the remote connection wizard's state orchestration is temporarily
 * kept in one component, with a separate split planned later.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createUuid, type RemoteTarget, type RemoteWorkspaceSessionEntry } from "@zcode/shared";
import {
  TID_SSH_CONNECT_TRIGGER,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
} from "@zcode/shared";
import { AlertTriangleIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  buildRemoteTarget,
  getRemoteWizardStepCopy,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  isRemoteConnectionFlowActive,
  shouldResetRemoteConnectionOnOpen,
} from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import {
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionKindStep,
  RemoteConnectionSettingsStep,
} from "@/RemoteConnectionDialogContent.js";
import {
  RemoteConnectionWizardHeader,
  RemoteConnectionWizardSidebar,
  type RemoteWizardStep,
} from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { VariantProps } from "class-variance-authority";

interface RemoteConnectionDialogProps {
  onConnect: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectProject: (sessionId: string, path: string, localWorkspacePath?: string) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  localWorkspacePath?: string;
  trigger?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTriggerWhenClosed?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  preferredKind?: RemoteTarget["kind"];
}

export function RemoteConnectionDialog({
  onConnect,
  onSelectProject,
  onCancelSession,
  localWorkspacePath,
  trigger,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  hideTriggerWhenClosed = false,
  remoteWorkspaceSessions = [],
  onFlowActiveChange,
  onFlowRequestIdChange,
  preferredKind,
}: RemoteConnectionDialogProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [currentStep, setCurrentStep] = useState<RemoteWizardStep>("kind");
  const [connectedSessionId, setConnectedSessionId] = useState<string | null>(null);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const { connectionLogs, resetConnectionLogs } = useRemoteConnectionLogs(connectingRequestId);
  const open = controlledOpen ?? uncontrolledOpen;
  const {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsError,
  } = useRemoteConnectionForm({
    open,
    preferredKind,
  });
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  const flowActive = isRemoteConnectionFlowActive(flowSnapshot);

  useEffect(() => {
    onFlowActiveChange?.(flowActive);
  }, [flowActive, onFlowActiveChange]);

  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [onFlowRequestIdChange],
  );

  const applyOpenState = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
  };

  const resetFeedback = () => {
    setError("");
    setValidationMessage("");
  };

  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, []);

  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      try {
        await onCancelSession(sessionId);
      } catch (sessionError) {
        logger.warn("[SSHDialog] failed to release unconfirmed remote session:", {
          sessionId,
          error: sessionError,
        });
      }
    },
    [onCancelSession],
  );

  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean }) => {
      const sessionId = connectedSessionId;
      if (!options?.preserveSession && sessionId) {
        void handleCancelSession(sessionId);
      } else if (!options?.preserveSession && loading && currentStep === "connecting") {
        // When the sessionId has not been returned during the connection process, closing the pop-up window will only reset the UI; add explicit cancellation here to ensure that the background download stops synchronously.
        void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
      }
      resetFeedback();
      setLoading(false);
      resetDirectorySelectionState();
      resetConnectionLogs();
      setCurrentStep("kind");
      setConnectedSessionId(null);
      setPendingRemoteTarget(null);
      updateConnectingRequestId(null);
      applyOpenState(false);
    },
    [
      cancelPendingRemoteConnection,
      connectedSessionId,
      connectingRequestId,
      currentStep,
      handleCancelSession,
      loading,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const confirmRemoteFlowDiscard = useCallback(async () => {
    if (currentStep === "connecting" && loading) {
      return confirmDialog({
        title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
        description: intl.formatMessage({
          id: "remote.connectingConfirmDescription",
        }),
        confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
    }
    if (!connectedSessionId) {
      return true;
    }
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectedConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }, [confirmDialog, connectedSessionId, currentStep, intl, loading]);

  const handleCloseRequest = useCallback(async () => {
    const confirmed = await confirmRemoteFlowDiscard();
    if (!confirmed) {
      return;
    }
    closeDialog();
  }, [closeDialog, confirmRemoteFlowDiscard]);

  const startRemoteConnection = async (target: RemoteTarget) => {
    const nextTarget = withDefaultRemoteResourcePackages(target);

    if (loading) {
      // Before React has time to set the button to disabled, rapid repeated clicks will start multiple SSH host processes.
      // Here, concurrency protection is implemented again at the event entry to prevent the same dialog from generating multiple deployment flows and mixing the upload progress.
      return;
    }

    setPendingRemoteTarget(nextTarget);
    setLoading(true);
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    resetConnectionLogs();
    setCurrentStep("connecting");
    const trace = startUserAction({
      featureId: "workspace.remote.lifecycle",
      action: "connect",
      trigger: "button",
      workspaceKind: "remote",
      remoteKind: nextTarget.kind,
    });
    try {
      const sessionId = await onConnect(nextTarget, requestId);
      const completionState = getRemoteConnectionCompletionDialogState("success");
      setConnectedSessionId(sessionId);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
      trace.complete({ resultSource: "platform_result" });
    } catch (connectError) {
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const errorMessage = getErrorMessage(connectError);
      setError(errorMessage);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
      trace.fail({ failureStage: "remote_connect" });
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    if (loading) {
      // Before React has time to set the button to disabled, rapid repeated clicks will start multiple SSH host processes.
      // Here, concurrency protection is implemented again at the event entry to prevent the same dialog from generating multiple deployment flows and mixing the upload progress.
      return;
    }

    const { target: nextTarget, errorMessage } = buildRemoteTarget(intl, {
      kind,
      host,
      port,
      username,
      sshAuthMethod,
      assetInstallMode,
      password,
      privateKeyPath,
      privateKeyPassphrase,
      selectedSshConfigAlias,
    });
    if (!nextTarget) {
      // Missing required fields belong to form validation and should not share the destructive error style with real connection failures.
      // The warning prompt in the settings step is here alone. Users can understand more quickly that it is "lack of input" rather than "connection error".
      setValidationMessage(errorMessage ?? "Connection failed");
      return;
    }

    resetFeedback();
    setPendingRemoteTarget(nextTarget);
    await startRemoteConnection(nextTarget);
  };

  const handleStartPendingRemoteConnection = useCallback(() => {
    if (!pendingRemoteTarget) {
      void handleConnect();
      return;
    }

    void startRemoteConnection(pendingRemoteTarget);
  }, [handleConnect, pendingRemoteTarget, startRemoteConnection]);

  const handleBackToConnection = useCallback(async () => {
    if (!connectedSessionId) {
      return;
    }

    resetFeedback();
    try {
      await onCancelSession(connectedSessionId);
      setConnectedSessionId(null);
      updateConnectingRequestId(null);
      resetConnectionLogs();
      setCurrentStep("settings");
    } catch (sessionError) {
      setError(getErrorMessage(sessionError));
    }
  }, [connectedSessionId, onCancelSession, updateConnectingRequestId]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      if (!connectedSessionId || selectingDirectoryRef.current) {
        return;
      }

      // After selecting the remote directory, realpath, provider synchronization, session persistence and task list refresh must be performed.
      // These asynchronous steps did not have an independent submission state before, and the user will see that the button is unresponsive; here, the state is set at the entrance and ref is used to prevent repeated submissions.
      selectingDirectoryRef.current = true;
      setSelectingDirectory(true);
      resetFeedback();
      try {
        await onSelectProject(connectedSessionId, path, localWorkspacePath);
        resetConnectionLogs();
        setCurrentStep("kind");
        setConnectedSessionId(null);
        setPendingRemoteTarget(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      } catch (selectionError) {
        const failureState = getRemoteConnectionDirectoryFailureState({
          connectedSessionId,
          // The event processor only reads the latest snapshot once upon failure to avoid adding duplicate Zustand subscriptions for callback judgment.
          sessionStillRegistered: Boolean(
            useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
          ),
        });
        if (!failureState.connectedSessionId) {
          setConnectedSessionId(null);
          setCurrentStep(failureState.step);
          updateConnectingRequestId(null);
        }
        setError(getErrorMessage(selectionError));
      } finally {
        resetDirectorySelectionState();
      }
    },
    [
      connectedSessionId,
      localWorkspacePath,
      onSelectProject,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
        resetFeedback();
        resetConnectionLogs();
        setCurrentStep("kind");
        setPendingRemoteTarget(null);
      }
      applyOpenState(true);
      return;
    }

    void handleCloseRequest();
  };

  const stepCopy = getRemoteWizardStepCopy(intl, currentStep, kind);

  return (
    <>
      {!hideTriggerWhenClosed ? (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          onClick={() => {
            if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
              resetFeedback();
              resetConnectionLogs();
              setCurrentStep("kind");
              setPendingRemoteTarget(null);
            }
            applyOpenState(true);
          }}
          data-testid={TID_SSH_CONNECT_TRIGGER}
          className={triggerClassName}
        >
          {trigger ?? intl.formatMessage({ id: "remote.trigger" })}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100dvh-1rem)] max-h-168 w-[calc(100vw-1rem)] max-w-4xl overflow-hidden rounded-2xl p-0 md:h-[calc(100vh-6rem)]"
        >
          <div
            data-testid={TID_SSH_DIALOG}
            className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row"
          >
            <RemoteConnectionWizardSidebar currentStep={currentStep} />

            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:gap-4 sm:p-6">
              <DialogHeader className="space-y-2">
                <RemoteConnectionWizardHeader
                  title={stepCopy.title}
                  description={stepCopy.description}
                  onMinimize={
                    flowActive
                      ? () => {
                          // When the connection is slow, the user can only close the pop-up window. Closing it will cancel the pending connection and lose the current step.
                          // Here, "Collapse" is clearly broken down to only hide the dialog, without resetting the status or canceling the background connection. Subsequent entries can be restored to the current step.
                          applyOpenState(false);
                        }
                      : undefined
                  }
                  onClose={() => {
                    // The semantics of closing and collapsing are different. Close the confirmation and cancellation logic to avoid leakage of sessions that are connected but have not selected a directory.
                    void handleCloseRequest();
                  }}
                />
              </DialogHeader>

              {error && currentStep !== "connecting" ? (
                <div
                  data-testid={TID_SSH_ERROR}
                  // The remote connection error prompt used to directly splice color tokens, which was inconsistent with the global status feedback style.
                  // Here, the colors are changed to destructive semantic color pairs to avoid different visual errors in SSH mode.
                  className="flex items-start gap-3 rounded-xl bg-destructive px-4 py-3 text-ui-base text-destructive-foreground"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  {error}
                </div>
              ) : null}

              <div className="w-full min-h-0 flex-1">
                {currentStep === "kind" ? (
                  <RemoteConnectionKindStep
                    kind={kind}
                    availableKinds={availableKinds}
                    onKindChange={setKind}
                    onCancel={() => closeDialog()}
                    onNext={() => {
                      resetFeedback();
                      setCurrentStep("settings");
                    }}
                  />
                ) : null}

                {currentStep === "settings" ? (
                  <RemoteConnectionSettingsStep
                    kind={kind}
                    host={host}
                    port={port}
                    username={username}
                    sshAuthMethod={sshAuthMethod}
                    assetInstallMode={assetInstallMode}
                    password={password}
                    privateKeyPath={privateKeyPath}
                    privateKeyPassphrase={privateKeyPassphrase}
                    sshConfigAliases={sshConfigAliases}
                    sshConfigAliasesLoading={sshConfigAliasesLoading}
                    sshConfigAliasesError={sshConfigAliasesError}
                    selectedSshConfigAlias={selectedSshConfigAlias}
                    currentRuntimeOptionsError={currentRuntimeOptionsError}
                    remoteWorkspaceSessions={remoteWorkspaceSessions}
                    validationMessage={validationMessage}
                    loading={loading}
                    onBack={() => {
                      resetFeedback();
                      setCurrentStep("kind");
                    }}
                    onHostChange={setHost}
                    onPortChange={setPort}
                    onUsernameChange={setUsername}
                    onSshAuthMethodChange={setSshAuthMethod}
                    onAssetInstallModeChange={setAssetInstallMode}
                    onPasswordChange={setPassword}
                    onPrivateKeyPathChange={setPrivateKeyPath}
                    onPrivateKeyPassphraseChange={setPrivateKeyPassphrase}
                    onApplySshConfigAlias={applySshConfigAlias}
                    onClearSelectedSshConfigAlias={clearSelectedSshConfigAlias}
                    onConnect={() => {
                      void handleConnect();
                    }}
                  />
                ) : null}

                {currentStep === "connecting" ? (
                  <RemoteConnectionConnectingStep
                    kind={kind}
                    logs={connectionLogs}
                    errorMessage={error}
                    loading={loading}
                    onBack={() => {
                      void (async () => {
                        const confirmed = await confirmRemoteFlowDiscard();
                        if (!confirmed) {
                          return;
                        }

                        if (loading) {
                          await cancelPendingRemoteConnection(connectingRequestId ?? undefined);
                          setLoading(false);
                        }
                        resetFeedback();
                        updateConnectingRequestId(null);
                        setCurrentStep("settings");
                      })();
                    }}
                    onRetry={() => {
                      handleStartPendingRemoteConnection();
                    }}
                  />
                ) : null}

                {currentStep === "directory" ? (
                  <div data-testid={TID_SSH_SUCCESS} className="h-full">
                    <RemoteConnectionDirectoryStep
                      services={directoryBrowserServices}
                      remoteTarget={pendingRemoteTarget}
                      localSkillSyncService={baseServices.skillSyncService}
                      remoteSkillSyncService={directoryBrowserServices?.skillSyncService ?? null}
                      localMcpSyncService={baseServices.mcpSyncService}
                      remoteMcpSyncService={directoryBrowserServices?.mcpSyncService ?? null}
                      localPluginSyncService={baseServices.pluginSyncService}
                      remotePluginSyncService={directoryBrowserServices?.pluginSyncService ?? null}
                      localZCodeAgentService={baseServices.zcodeAgentService}
                      remoteZCodeAgentService={directoryBrowserServices?.zcodeAgentService ?? null}
                      localWorkspacePath={localWorkspacePath}
                      selecting={selectingDirectory}
                      onSelect={(path) => {
                        void handleSelectDirectory(path);
                      }}
                      onBack={() => {
                        void (async () => {
                          const confirmed = await confirmRemoteFlowDiscard();
                          if (!confirmed) {
                            return;
                          }

                          await handleBackToConnection();
                        })();
                      }}
                      onCancel={() => {
                        void handleCloseRequest();
                      }}
                      onSkillsSynced={async () => undefined}
                      onMcpSynced={async () => undefined}
                      onPluginsSynced={async () => undefined}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const SSHDialog = RemoteConnectionDialog;
