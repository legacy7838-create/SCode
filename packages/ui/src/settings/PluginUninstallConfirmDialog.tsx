import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// Uninstallation is a destructive and complete cleanup (cache + data directory + config residue). Each UI entrance shares the same confirmation pop-up window.
// Keep the copywriting consistent with the behavior, and avoid writing one copy for each of the "Installed" and "Market" panels.
export function PluginUninstallConfirmDialog({
  open,
  pluginName,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="plugin-store-uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage(
              { id: "settings.plugins.uninstall.confirmTitle" },
              { name: pluginName },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirmDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            size="sm"
            data-testid="plugin-store-uninstall-cancel"
            disabled={pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            data-testid="plugin-store-uninstall-confirm"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={(event) => {
              // Prevent Radix from closing the pop-up window by default after clicking the action; uninstalling is an asynchronous operation and will be closed by the parent component after the result.
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
