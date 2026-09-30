import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";

export function UpdateStatusWindowRoot({
  platform,
  onRequestClose,
}: {
  platform: IPlatformService;
  onRequestClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        onRequestClose();
      }
    },
    [onRequestClose],
  );

  useEffect(() => {
    const disposers: Array<() => void> = [];
    const eventRevision = () => {
      revisionRef.current += 1;
      return revisionRef.current;
    };

    // The independent update window does not have the app chrome state of the main window, so you must do it yourself.
    // getUpdateState snapshot compensation; also use revision to prevent old snapshots from overwriting later real-time events.
    const snapshotRevision = revisionRef.current;
    void platform.getUpdateState?.().then((payload) => {
      if (revisionRef.current !== snapshotRevision) {
        return;
      }
      setUpdateState(payload);
    });

    disposers.push(
      platform.onUpdateStateChanged?.((payload) => {
        eventRevision();
        setUpdateState(payload);
      }) ?? (() => {}),
    );
    disposers.push(
      platform.onUpdateReady((version) => {
        setReadyVersion(version);
      }),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [platform]);

  return (
    <div className="min-h-screen bg-transparent text-foreground">
      {/* The independent update window does not hang on the workspace setting/broadcast service and cannot only rely on the startup locale.
          After the main window switches languages, the main process pushes the latest parsing language. The Provider is rebuilt here to allow the pop-up window copy to follow in real time. */}
      <ZCodeIntlProvider>
        <UpdateStatusDialogController
          platform={platform}
          version={readyVersion}
          updateState={updateState}
          open={open}
          onOpenChange={handleOpenChange}
          edgeToEdge
          showOverlay={false}
        />
        <ConfirmDialogHost />
      </ZCodeIntlProvider>
    </div>
  );
}
