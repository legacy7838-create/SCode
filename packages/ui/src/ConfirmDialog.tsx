import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.js";
import { XIcon } from "lucide-react";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { cn } from "@/components/lib/utils.js";
import {
  AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS,
  AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
} from "@/settings/automationConfirmDialogPresentation.js";

export function ConfirmDialogHost() {
  const { intl } = useZCodeIntl();
  const pendingRequest = useConfirmDialogStore((state) => state.pendingRequest);
  const settleConfirmation = useConfirmDialogStore((state) => state.settleConfirmation);

  const settleChoice = useConfirmDialogStore((state) => state.settleChoice);

  const displayedRequestRef = useRef(pendingRequest);
  if (pendingRequest) {
    // After the Promise is settled, the store will clear the pendingRequest immediately, but the Radix closing animation will still retain one frame of the content layer.
    // If the pendingRequest is read directly here, the title/description will first become empty during the exit animation, leaving only the "Confirm/Cancel" button flashing.
    // Therefore, the last visible content will continue to be used before closing, and only the open state control pop-up window will exit.
    displayedRequestRef.current = pendingRequest;
  }
  const displayedRequest = pendingRequest ?? displayedRequestRef.current;
  const [checkboxSelection, setCheckboxSelection] = useState<{
    request: typeof displayedRequest;
    checked: boolean;
  }>({ request: undefined, checked: false });
  const open = Boolean(pendingRequest);
  const isAutomationConfirmation = displayedRequest?.presentation === "automation-confirmation";
  const confirmLabel =
    displayedRequest?.confirmLabel ?? intl.formatMessage({ id: "common.confirm" });
  const cancelLabel = displayedRequest?.cancelLabel ?? intl.formatMessage({ id: "common.cancel" });
  const compact = displayedRequest?.compact === true;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Radix only calls back onOpenChange(false) when the mask is clicked or Esc is pressed.
      // If you do not actively resolve the Promise to false here, the calling side will always hang, and subsequent deletion operations will also be stuck.
      if (!nextOpen) {
        settleChoice("dismiss");
      }
    },
    [settleChoice],
  );

  const handleConfirm = useCallback(() => {
    settleConfirmation(true);
  }, [settleConfirmation]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter") {
        return;
      }

      // Selection dialogs with checkboxes retain the keyboard semantics of the focus button, preventing "unable" pressing Enter from turning into a toggle.
      if (
        displayedRequest?.checkbox &&
        event.target instanceof HTMLElement &&
        event.target.closest("button,input")
      )
        return;
      // If you do not answer Enter in the secondary confirmation scenario, keyboard users will have to switch to the button and then trigger it.
      // The experience is inconsistent with the confirmation pop-up window on the desktop. Here, hold Enter when the pop-up window opens to maintain a predictable confirmation gesture.
      event.preventDefault();
      event.stopPropagation();
      settleConfirmation(true);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, settleConfirmation, displayedRequest]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid={displayedRequest?.testId}
        showCloseButton={false}
        overlayClassName={
          compact ? "bg-black/20 supports-backdrop-filter:backdrop-blur-[2px]" : undefined
        }
        className={cn(
          "gap-5 rounded-2xl border-none bg-popover/98 p-5 ring-border shadow-2xl",
          // When relying only on the responsive max-width of the shared pop-up box, the viewports of different entrances will
          // The same delete confirmation box looks inconsistent in size. Scheduled task deletion fixes the same presentation by design.
          isAutomationConfirmation ? AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS : "sm:max-w-md",
          displayedRequest?.compact && "top-[44%] min-h-[161px] gap-4 sm:max-w-[400px]",
        )}
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {displayedRequest?.title}
          </DialogTitle>
          {displayedRequest?.description ? (
            <DialogDescription
              className={cn(
                "whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle",
                isAutomationConfirmation && AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
              )}
            >
              {displayedRequest.description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter
          className={cn(
            "gap-2 sm:justify-end",
            displayedRequest?.checkbox && "flex-row flex-wrap items-center",
            // The minimum height of the Automation pop-up window will stretch the Grid footer row, and the button will stop at the top of the row, causing the visual bottom margin to exceed 20px.
            isAutomationConfirmation && "mt-auto",
          )}
        >
          {displayedRequest?.checkbox ? (
            <label className="mr-auto flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
              <Checkbox
                checked={
                  checkboxSelection.request === displayedRequest && checkboxSelection.checked
                }
                onCheckedChange={(value) => {
                  setCheckboxSelection({ request: displayedRequest, checked: value === true });
                  displayedRequest.checkbox?.onCheckedChange(value === true);
                }}
              />
              {displayedRequest.checkbox.label}
            </label>
          ) : null}
          <div
            className={displayedRequest?.checkbox ? "ml-auto flex items-center gap-2" : "contents"}
          >
            <Button
              type="button"
              variant={compact ? "outline" : "secondary"}
              size={"lg"}
              onClick={() => settleConfirmation(false)}
              className={cn(
                "h-9 gap-3 px-4",
                displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-28",
              )}
            >
              <span>{cancelLabel}</span>
              {displayedRequest?.showKeyboardHints !== false ? (
                <span className="font-mono text-ui-base text-foreground-subtle">esc</span>
              ) : null}
            </Button>
            <Button
              type="button"
              autoFocus
              // Ordinary confirmations use the main button; only non-recoverable actions that explicitly declare destructive use danger colors.
              variant={displayedRequest?.confirmVariant ?? "default"}
              size={"lg"}
              data-testid={TID_CONFIRM_DIALOG_CONFIRM}
              onClick={handleConfirm}
              className={cn(
                "h-9 gap-3 px-4",
                displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-32",
              )}
            >
              <span>{confirmLabel}</span>
              {displayedRequest?.showKeyboardHints !== false ? (
                <span
                  className={
                    displayedRequest?.confirmVariant === "destructive"
                      ? "text-ui-base text-destructive-foreground/60"
                      : "text-ui-base text-primary-foreground/60"
                  }
                >
                  ⏎
                </span>
              ) : null}
            </Button>
          </div>
        </DialogFooter>
        {displayedRequest?.showCloseButton ? (
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 z-20 text-foreground-subtle hover:bg-surface-hover hover:text-foreground [app-region:no-drag]"
            >
              <XIcon className="size-4" strokeWidth={4 / 3} />
            </Button>
          </DialogClose>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
