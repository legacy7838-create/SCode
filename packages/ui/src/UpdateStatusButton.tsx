import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { UpdateReleaseNotesTooltip } from "@/UpdateReleaseNotesTooltip.js";
import { ArrowDownToLine, LoaderCircle } from "lucide-react";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import { resolveUpdateButtonResponsiveClasses } from "@/updateStatusButtonLayout.js";
import { deriveUpdateStatusViewModel } from "@/updateStatusModel.js";

export function UpdateStatusButton({
  platform,
  version,
  updateState,
  isMacDesktop = false,
  isWindowsDesktop = false,
  className,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [dialogOpen, setDialogOpen] = useState(false);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const { expandWidthClass, hideIconClass, revealTextClass } = resolveUpdateButtonResponsiveClasses(
    { isMacDesktop, isWindowsDesktop },
  );
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    releaseNotesPayload: updateReleaseNotesPayload,
  } = updateStatusViewModel;
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
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // The download completion event is only stable with version on some platforms. Entry hover continues caching
    // Instructions when I first discovered the update, make sure that the behavior of the main entrance remains the same after the pop-up window is moved.
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
  // After the user starts downloading, the main task of the pop-up window has been switched from "Understanding version content" to "Observing download progress".
  // Continuing to display the update log will occupy the progress area, and will also cause the main button hover and pop-up window to repeatedly display the log during the download.
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleUpdateEntryClick = useCallback(() => {
    if (platform.openUpdateStatusWindow) {
      void platform.openUpdateStatusWindow();
      return;
    }

    setDialogOpen(true);
  }, [platform]);

  if (!displayVersion) return null;

  // The update pop-up window and the button hover share the same update log title to avoid duplication of the releaseName in the feed and the title of the text.
  const releaseNotesTitle = intl.formatMessage(
    { id: "updateReady.releaseNotesTitle" },
    { version: displayVersion },
  );
  const tooltipTitle =
    dialogPhase === "downloading"
      ? progressLabel
        ? intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateProgress" },
            { progress: progressLabel },
          )
        : intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateVersion" },
            { version: displayVersion },
          )
      : dialogPhase === "downloaded"
        ? intl.formatMessage({ id: "updateReady.tooltip" }, { version: displayVersion })
        : intl.formatMessage({ id: "updateAvailable.tooltip" }, { version: displayVersion });

  const readyButton = (
    <Button
      size={"xs"}
      variant={"secondary"}
      aria-label={tooltipTitle}
      onClick={handleUpdateEntryClick}
      className={cn(
        // Only change the update pop-up window to a neutral visual, and keep the success color block at the main page update entrance to avoid weakening the status prompt at the top.
        // Automatic download will not actively open the update window; the download status entrance must remain clickable before the user can enter the window to cancel the download.
        // The fixed h-5 and expanded fixed width of xs button only adapt to the default font size. When the UI font size is increased, the copy will be cropped.
        // Instead, use the minimum height to match the content width. The default is still compact, and larger font sizes allow the text to naturally expand the button.
        "h-auto min-h-5 gap-1 rounded-full py-0.5 font-medium leading-none text-ui-xs w-6 border-transparent bg-success text-success-foreground hover:bg-success/80 transition-all",
        dialogPhase !== "downloading" && expandWidthClass,
        className,
      )}
    >
      {dialogPhase === "downloading" ? (
        <LoaderCircle
          // The download state itself relies on spinner to express loading, and the expansion and hiding rules of ordinary update icons cannot be reused.
          className="size-3 shrink-0 animate-spin"
        />
      ) : (
        <ArrowDownToLine className={cn("size-3 shrink-0 inline", hideIconClass)} />
      )}
      {dialogPhase !== "downloading" ? (
        <span
          className={cn(
            "w-0 overflow-hidden absolute opacity-0 transition-all",
            ...revealTextClass,
          )}
        >
          {intl.formatMessage({ id: "updateReady.shortTitle" })}
        </span>
      ) : null}
    </Button>
  );

  const updateButton = visibleUpdateReleaseNotes ? (
    <UpdateReleaseNotesTooltip
      locale={locale}
      onOpenExternalUrl={handleOpenReleaseNotesExternalUrl}
      releaseDateLabel={restoredReleaseDate}
      releaseNotesMarkdown={visibleUpdateReleaseNotes.markdown}
      releaseNotesTitle={releaseNotesTitle}
    >
      {readyButton}
    </UpdateReleaseNotesTooltip>
  ) : (
    <ControlHintTooltip title={tooltipTitle} side="bottom">
      {readyButton}
    </ControlHintTooltip>
  );

  return (
    <>
      {updateButton}
      <UpdateStatusDialogController
        platform={platform}
        version={version}
        updateState={updateState}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
