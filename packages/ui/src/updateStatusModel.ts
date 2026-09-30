import type {
  ElectronReleaseChannel,
  PostUpdateReleaseNotesPayload,
  UpdateStatePayload,
} from "@zcode/shared";

export type UpdateStatusDialogPhase = "before-download" | "downloading" | "downloaded";

export type UpdateActionInFlight = "download" | "cancel" | "skip" | "restart" | null;

export type UpdateStatusViewModel = {
  dialogPhase: UpdateStatusDialogPhase;
  displayVersion: string | null;
  progressLabel: string | null;
  progressValue: number;
  releaseNotesPayload: PostUpdateReleaseNotesPayload | undefined;
  skippableVersion: string | null;
  updateChannel: ElectronReleaseChannel | undefined;
};

export function deriveUpdateStatusViewModel({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}): UpdateStatusViewModel {
  const isDownloadingUpdate = updateState?.kind === "download-progress";
  const readyVersion = resolveReadyVersion({ legacyReadyVersion, updateState });
  const progressVersion = isDownloadingUpdate ? updateState.version : null;
  const availableVersion = updateState?.kind === "update-available" ? updateState.version : null;
  const displayVersion =
    readyVersion ??
    progressVersion ??
    availableVersion ??
    // download-progress.version is a protocol optional field. The download state must maintain the UI by kind.
    // Otherwise, the lack of a version number in a certain frame will cause the portal to uninstall and close the open pop-up window.
    (isDownloadingUpdate ? "…" : null);

  return {
    dialogPhase: readyVersion
      ? "downloaded"
      : isDownloadingUpdate
        ? "downloading"
        : "before-download",
    displayVersion,
    progressLabel: getUpdateDownloadProgressLabel(updateState),
    progressValue: getUpdateDownloadProgressValue(updateState),
    releaseNotesPayload: getUpdateReleaseNotesPayload(updateState),
    skippableVersion:
      updateState?.kind === "update-available" || updateState?.kind === "download-progress"
        ? (updateState.version ?? null)
        : null,
    updateChannel:
      updateState?.kind === "update-available" ||
      updateState?.kind === "download-progress" ||
      updateState?.kind === "update-downloaded"
        ? updateState.channel
        : undefined,
  };
}

export function isUpdateActionCompleted(
  action: UpdateActionInFlight,
  updateState: UpdateStatePayload | null,
) {
  return (
    // After clicking download, the main side may first broadcast transition states such as checking/idle.
    // These states do not mean that the download has entered the observable stage, and the button lock cannot be released and the pop-up window cannot be uninstalled;
    // The download command is completed only when the download progress is actually entered or the download is completed.
    (action === "download" &&
      (updateState?.kind === "download-progress" || updateState?.kind === "update-downloaded")) ||
    (action === "cancel" && updateState?.kind !== "download-progress") ||
    (action === "skip" &&
      updateState?.kind !== "update-available" &&
      updateState?.kind !== "download-progress")
  );
}

function getUpdateDownloadProgressLabel(updateState: UpdateStatePayload | null) {
  if (updateState?.kind !== "download-progress") {
    return null;
  }

  const { totalBytes, transferredBytes } = updateState;
  if (
    typeof transferredBytes === "number" &&
    Number.isFinite(transferredBytes) &&
    transferredBytes >= 0 &&
    typeof totalBytes === "number" &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0
  ) {
    return `${formatMegabytes(transferredBytes)} / ${formatMegabytes(totalBytes)}`;
  }

  // The download progress text has been changed to display downloaded/total size. Continue to display only percentages
  // "0% / 42%" will conflict with the new size and caliber, and a 0% will remain in the temporary state when starting the download.
  return null;
}

function resolveReadyVersion({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}) {
  if (updateState?.kind === "update-downloaded") {
    return updateState.version;
  }

  // legacy UpdateReady is just a cache of "once ready".
  // Once the new UpdateState has been explicitly synced to the renderer, idle/checking/error should all be based on the new state,
  // You cannot continue to use the old version to support the "Restart to update" button.
  return updateState === null ? legacyReadyVersion : null;
}

function getUpdateDownloadProgressValue(updateState: UpdateStatePayload | null) {
  const rawProgressValue =
    updateState?.kind === "download-progress" ? Number(updateState.progress) : 0;
  return Number.isFinite(rawProgressValue) ? Math.max(0, Math.min(100, rawProgressValue)) : 0;
}

function getUpdateReleaseNotesPayload(updateState: UpdateStatePayload | null) {
  return updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded"
    ? updateState.releaseNotes
    : undefined;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
