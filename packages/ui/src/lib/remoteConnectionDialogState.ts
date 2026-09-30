import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

interface RemoteConnectionDialogSnapshot {
  currentStep: RemoteWizardStep;
  loading: boolean;
  connectedSessionId: string | null;
}

type RemoteConnectionCompletionStatus = "success" | "error";

interface RemoteConnectionCompletionDialogState {
  open: boolean;
  step: RemoteWizardStep;
}

interface RemoteConnectionDirectoryFailureState {
  connectedSessionId: string | null;
  step: RemoteWizardStep;
}

export function isRemoteConnectionFlowActive(snapshot: RemoteConnectionDialogSnapshot): boolean {
  return snapshot.loading || Boolean(snapshot.connectedSessionId);
}

export function shouldResetRemoteConnectionOnOpen(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return !isRemoteConnectionFlowActive(snapshot);
}

export function getRemoteConnectionCompletionDialogState(
  status: RemoteConnectionCompletionStatus,
): RemoteConnectionCompletionDialogState {
  return {
    // After the remote connection pop-up window is closed, only the internal steps are updated when the connection is completed but the pop-up window is not re-displayed.
    // The user will stay on other pages and cannot see the directory selection or failure reason. After the connection is completed, a pop-up window will pop up to go to the result step.
    open: true,
    step: status === "success" ? "directory" : "connecting",
  };
}

export function getRemoteConnectionDirectoryFailureState(params: {
  connectedSessionId: string;
  sessionStillRegistered: boolean;
}): RemoteConnectionDirectoryFailureState {
  if (params.sessionStillRegistered) {
    return {
      connectedSessionId: params.connectedSessionId,
      step: "directory",
    };
  }

  // If the workspace initialization fails, the unconfirmed logical session will be recycled.
  // When the directory step continues to hold the old sessionId, it can only get empty services and displays "Loading" permanently.
  return {
    connectedSessionId: null,
    step: "settings",
  };
}
