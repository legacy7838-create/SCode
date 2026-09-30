import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import {
  deriveUpdateStatusViewModel,
  isUpdateActionCompleted,
  type UpdateActionInFlight,
  type UpdateStatusViewModel,
} from "@/updateStatusModel.js";

export function UpdateStatusDialogController({
  platform,
  version,
  updateState,
  open,
  onOpenChange,
  edgeToEdge = false,
  showOverlay = true,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edgeToEdge?: boolean;
  showOverlay?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [updateActionInFlight, setUpdateActionInFlightState] = useState<UpdateActionInFlight>(null);
  const updateActionInFlightRef = useRef<typeof updateActionInFlight>(null);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const setUpdateActionInFlight = useCallback((nextAction: typeof updateActionInFlight) => {
    updateActionInFlightRef.current = nextAction;
    setUpdateActionInFlightState(nextAction);
  }, []);
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const lastVisibleUpdateStatusViewModelSelection = useRef<UpdateStatusViewModel | null>(null);
  const renderedUpdateStatusViewModel =
    updateStatusViewModel.displayVersion || updateActionInFlight === null
      ? updateStatusViewModel
      : (lastVisibleUpdateStatusViewModelSelection.current ?? updateStatusViewModel);
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    progressValue,
    releaseNotesPayload: updateReleaseNotesPayload,
    skippableVersion,
  } = renderedUpdateStatusViewModel;
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;

  useEffect(() => {
    if (!updateStatusViewModel.displayVersion) {
      return;
    }

    // After clicking "Download Update", the actual download progress depends on the asynchronous broadcast on the main side.
    // If a transitional state without version such as checking/idle is temporarily received in the middle, the entry cannot be returned null.
    // Also uninstall the opened pop-up window; while the command is in progress, reuse the visible model of the previous frame and wait for the progress status to close.
    lastVisibleUpdateStatusViewModelSelection.current = updateStatusViewModel;
  }, [updateStatusViewModel]);

  useEffect(() => {
    let disposed = false;

    const refreshAutoUpdatePreferences = () => {
      void platform
        .getAutoUpdatePreferences?.()
        .then((preferences) => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(preferences.autoDownloadAndInstallUpdates);
          }
        })
        .catch(() => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(false);
          }
        });
    };

    refreshAutoUpdatePreferences();
    const disposeSettingsChanged =
      platform.onSettingsChanged?.(refreshAutoUpdatePreferences) ?? (() => {});

    return () => {
      disposed = true;
      disposeSettingsChanged();
    };
  }, [platform]);

  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // The update log will be hidden during the download, but the update-downloaded of electron-updater
    // Events are only stable with version on some platforms. Cache the description of the current version and it will be ready after the download is completed
    // If the status lacks releaseNotes, the content that was just hidden can also be restored to display.
    releaseNotesCacheRef.current.set(releaseNotesCacheKey, {
      releaseDateLabel: formattedReleaseDate,
      releaseNotes: localizedUpdateReleaseNotes,
    });
    if (releaseNotesCacheRef.current.size > 8) {
      const oldestCacheKey = releaseNotesCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseNotesCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, localizedUpdateReleaseNotes, releaseNotesCacheKey]);

  const cachedReleaseNotes = releaseNotesCacheKey
    ? releaseNotesCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredUpdateReleaseNotes =
    localizedUpdateReleaseNotes ?? cachedReleaseNotes?.releaseNotes ?? null;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseNotes?.releaseDateLabel ?? null;
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleDownloadUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // If electron-updater hits the local downloaded cache, the main side will directly broadcast
    // update-downloaded. The renderer cannot optimistically switch to "Downloading" before and after IPC ACK, otherwise it will flash
    // A frame of meaningless 0%/download state; here only the button is locked, and the real phase completely follows the status broadcast of main.
    setUpdateActionInFlight("download");
    try {
      await platform.downloadUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      setAutoDownloadAndInstallUpdates(enabled);
      await platform.setAutoDownloadAndInstallUpdates?.(enabled);
      if (enabled && updateState?.kind === "update-available") {
        // Reason for the function: When users check automatic download in the "Updates Found" pop-up window, they expect the current version to also enter the automatic process.
        // Only the same download entry is triggered here; the actual download, cache hit and status broadcast are still determined by the main process.
        await handleDownloadUpdate();
      }
    },
    [handleDownloadUpdate, platform, updateState?.kind],
  );
  const handleCancelDownload = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    setUpdateActionInFlight("cancel");
    try {
      await platform.cancelUpdateDownload();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleSkipUpdate = useCallback(async () => {
    if (!skippableVersion || updateActionInFlightRef.current) {
      return;
    }
    setUpdateActionInFlight("skip");
    try {
      await platform.skipUpdateVersion(skippableVersion);
      onOpenChange(false);
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [onOpenChange, platform, setUpdateActionInFlight, skippableVersion]);
  const handleRestartUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    const activity = await platform.getDesktopSessionActivity?.();
    const runningTaskCount = activity?.runningAgentSessionCount ?? 0;
    if (runningTaskCount > 0) {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage(
          { id: "updateReady.confirm.title" },
          {
            version: displayVersion ?? "",
          },
        ),
        description: intl.formatMessage({
          id: "updateReady.confirm.description",
        }),
        confirmLabel: intl.formatMessage({ id: "updateReady.confirm.ok" }),
        cancelLabel: intl.formatMessage({ id: "updateReady.confirm.cancel" }),
      });
      if (!confirmed) {
        return;
      }
    }

    // Before restarting the installation, it was fire-and-forget. The renderer closed the pop-up window after sending the IPC.
    // If the updater under dev/mock does not take over the installation, the user will only see the pop-up window disappear and mistakenly think that the button does not respond.
    setUpdateActionInFlight("restart");
    try {
      await platform.quitAndInstallUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [displayVersion, intl, platform, requestConfirmation, setUpdateActionInFlight]);

  useEffect(() => {
    if (!displayVersion && updateState !== null) {
      onOpenChange(false);
    }
  }, [displayVersion, onOpenChange, updateState]);

  useEffect(() => {
    if (!updateActionInFlight) {
      return;
    }

    if (isUpdateActionCompleted(updateActionInFlight, updateState)) {
      setUpdateActionInFlight(null);
      return;
    }

    // Exit preparation and Windows installer handover may take longer than 5 seconds; the old unified ACK timer will
    // Restore "Restart to update" before the app actually exits, causing users to misjudge failure and click repeatedly. restart successful path retention
    // pending until the application exits, and only when the IPC explicitly fails is the caller's catch button restored.
    if (updateActionInFlight === "restart") {
      if (updateState !== null && updateState.kind !== "update-downloaded") {
        // main will broadcast error/idle when exit preparation fails. Even if IPC rejects due to window
        // The life cycle is lost, and the button must be released even after the state has left ready, and the previous frame cannot be kept pending permanently.
        setUpdateActionInFlight(null);
      }
      return;
    }

    // Download/cancel IPC will be ACKed immediately in the main process, and the actual status will be closed by subsequent broadcasts.
    // When connecting points, you need to lock the button first; if the broadcast is lost or there is no-op on the main side, it must be released with a short timeout to prevent the UI from getting stuck.
    const timeout = globalThis.setTimeout(() => {
      setUpdateActionInFlight(null);
    }, 1500);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [setUpdateActionInFlight, updateActionInFlight, updateState?.kind]);

  if (!displayVersion) return null;

  const releaseDateLabel = restoredReleaseDate
    ? intl.formatMessage({ id: "updateDialog.releaseDate" }, { date: restoredReleaseDate })
    : null;

  return (
    <UpdateStatusDialog
      autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
      displayVersion={displayVersion}
      edgeToEdge={edgeToEdge}
      intl={intl}
      isUpdateActionPending={updateActionInFlight !== null}
      localizedUpdateReleaseNotes={visibleUpdateReleaseNotes}
      onAutoDownloadAndInstallUpdatesChange={handleAutoDownloadAndInstallUpdatesChange}
      onCancelDownload={handleCancelDownload}
      onDownloadUpdate={handleDownloadUpdate}
      onOpenChange={onOpenChange}
      onOpenReleaseNotesExternalUrl={handleOpenReleaseNotesExternalUrl}
      onRestartUpdate={handleRestartUpdate}
      onSkipUpdate={handleSkipUpdate}
      open={open}
      phase={dialogPhase}
      progressLabel={progressLabel}
      progressValue={progressValue}
      releaseDateLabel={releaseDateLabel}
      showOverlay={showOverlay}
      skippableVersion={skippableVersion}
    />
  );
}
