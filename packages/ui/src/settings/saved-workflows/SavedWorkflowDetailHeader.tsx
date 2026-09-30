import {
  TID_WORKFLOW_DETAIL_MENU,
  TID_WORKFLOW_DETAIL_RUN,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  testId,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  AutomationMoreHorizontalIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";

interface SavedWorkflowDetailHeaderProps {
  name: string;
  description: string;
  entry: ZCodeSavedWorkflowEntry | undefined;
  busy: boolean;
  onRun: () => void;
  onRevise: () => void;
  onCopyPath: () => void;
  /**
   * Scope actions: "promote to global" for a project-scope entry (with an AI summary) / "move to
   * project…" for a global-scope entry; shown only when passed in.
   */
  onMove?: () => void;
  onDelete: () => void;
}

/**
 * The detail page header row: title + description + the "Run" action and the ⋯ menu at the top
 * right. Split out of the detail page to stay within max-lines (≤400).
 */
export function SavedWorkflowDetailHeader({
  name,
  description,
  entry,
  busy,
  onRun,
  onRevise,
  onCopyPath,
  onMove,
  onDelete,
}: SavedWorkflowDetailHeaderProps) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-ui-xl font-semibold text-foreground">{name}</h1>
        {description ? <p className="text-ui-base text-foreground-subtle">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="lg"
          data-icon="inline-start"
          data-testid={TID_WORKFLOW_DETAIL_RUN}
          disabled={busy || !entry}
          onClick={onRun}
        >
          <AutomationRunNowIcon className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "workflows.hub.detail.run" })}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              aria-label={intl.formatMessage({ id: "workflows.hub.card.menu" })}
              data-testid={TID_WORKFLOW_DETAIL_MENU}
              disabled={busy}
            >
              <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRevise}>
              {intl.formatMessage({ id: "workflows.hub.card.revise" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopyPath}>
              {intl.formatMessage({ id: "workflows.hub.card.copyPath" })}
            </DropdownMenuItem>
            {onMove ? (
              <DropdownMenuItem
                data-testid={testId(TID_WORKFLOW_ACTION_MOVE, name)}
                onSelect={onMove}
              >
                {intl.formatMessage({
                  id:
                    entry?.scope === "global"
                      ? "workflows.hub.card.moveToProject"
                      : "workflows.hub.card.promoteToGlobal",
                })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid={testId(TID_WORKFLOW_ACTION_DELETE, name)}
              className="text-destructive focus:text-destructive"
              onSelect={onDelete}
            >
              <AutomationTrashIcon />
              {intl.formatMessage({ id: "workflows.hub.card.delete" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
