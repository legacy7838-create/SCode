import { useEffect, useState } from "react";
import {
  TID_WORKFLOW_MOVE_DIALOG,
  TID_WORKFLOW_MOVE_DIALOG_SUBMIT,
  TID_WORKFLOW_MOVE_DIALOG_TARGET,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";

interface SavedWorkflowMoveDialogProps {
  open: boolean;
  /**
   * The name of the workflow being moved (used in the dialog description); when null, no title
   * context is rendered.
   */
  entryName: string | null;
  /**
   * Candidate target projects (the destinations of "Move to project…", the same set as the "Run on"
   * candidates).
   */
  targets: readonly AutomationWorkspaceOption[];
  defaultTargetKey?: string | null;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (target: AutomationWorkspaceOption) => void;
}

/**
 * The "Move to project" dialog: moving a global workflow back into a local project. A project
 * selector plus submit; when there is no local project, submit is disabled and a hint is shown. The
 * structure and styling follow the move dialog.
 */
export function SavedWorkflowMoveDialog({
  open,
  entryName,
  targets,
  defaultTargetKey,
  busy = false,
  onOpenChange,
  onSubmit,
}: SavedWorkflowMoveDialogProps) {
  const { intl } = useZCodeIntl();
  const [targetKey, setTargetKey] = useState<string | null>(null);

  // Retains still valid selections when candidates change, otherwise falls back to default item, first candidate, or null.
  useEffect(() => {
    const defaultOption = defaultTargetKey
      ? findAutomationWorkspaceOptionByKey(targets, defaultTargetKey)
      : undefined;
    setTargetKey((current) =>
      reconcileAutomationWorkspaceSelectionKey(targets, current, defaultOption),
    );
  }, [targets, defaultTargetKey]);

  const noTargets = targets.length === 0;

  const handleSubmit = () => {
    if (noTargets || busy) return;
    const target = findAutomationWorkspaceOptionByKey(targets, targetKey);
    if (!target) return;
    onSubmit(target);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid={TID_WORKFLOW_MOVE_DIALOG}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "workflows.hub.moveDialog.title" })}</DialogTitle>
          {entryName ? (
            <DialogDescription>
              {intl.formatMessage({ id: "workflows.hub.launch.title" }, { name: entryName })}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "workflows.hub.detail.projectColumn" })}
            </span>
            {noTargets ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "workflows.hub.moveDialog.noLocalProject" })}
              </p>
            ) : (
              <Select value={targetKey ?? undefined} onValueChange={setTargetKey}>
                <SelectTrigger data-testid={TID_WORKFLOW_MOVE_DIALOG_TARGET}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((option) => {
                    const key = resolveAutomationWorkspaceSelectionKey(option);
                    return (
                      <SelectItem key={key} value={key}>
                        {option.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              {intl.formatMessage({ id: "workflows.hub.launch.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              data-testid={TID_WORKFLOW_MOVE_DIALOG_SUBMIT}
              disabled={noTargets || busy}
            >
              {intl.formatMessage({ id: "workflows.hub.moveDialog.submit" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
