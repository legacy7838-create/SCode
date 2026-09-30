import {
  DesktopCommandIds,
  TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
  TID_WORKSPACE_HELP_MENU_TRIGGER,
} from "@zcode/shared";
import {
  ActivityIcon,
  BookOpenIcon,
  CircleHelpIcon,
  LightbulbIcon,
  InfoIcon,
  MessageSquareIcon,
  UsersIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createHelpMenuActionHandlers } from "@/lib/helpMenuActions.js";

export function WorkspaceHelpMenuButton({
  className,
  isDesktop = false,
}: {
  className?: string;
  /**
   * Whether it is desktop version. Injected by the mount instead of sniffing within the component: Web's IPlatformService stub also implements
   * executeDesktopCommand (no-op), it is judged that a "resource manager" that will not respond when clicked will appear on the web side.
   */
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const updateMenu = useDesktopUpdateMenu(isDesktop);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeatureRequest = useFeedbackStore((state) => state.openFeatureRequest);
  const helpMenuLabel = intl.formatMessage({ id: "workspaceHeader.help.menu" });
  const helpMenuActions = createHelpMenuActionHandlers({
    platform,
    intl,
    openSubmit: openFeedbackSubmit,
  });
  const handleOpenCommunity = () => {
    void platform.openCommunity();
  };
  const handleOpenResourceManager = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager);
  };

  const handleShowAbout = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout);
  };

  return (
    <DropdownMenu>
      <ControlHintTooltip title={helpMenuLabel} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            // The Settings page will position the help button absolutely above the drag area at the top of Electron.
            // When only relying on no-drag of the outer container, the real trigger may still be swallowed by the click in the drag area of ​​the title bar.
            className={cn(
              "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
              className,
            )}
            aria-label={helpMenuLabel}
            data-testid={TID_WORKSPACE_HELP_MENU_TRIGGER}
          >
            <CircleHelpIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        align="end"
        className="min-w-0 w-max [&_[data-slot=dropdown-menu-item]]:pr-6"
      >
        <DropdownMenuItem onSelect={helpMenuActions.openProductDocs}>
          <BookOpenIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.docs" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleOpenCommunity}>
          <UsersIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.community" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={helpMenuActions.openIssueReport}>
          <MessageSquareIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.issueReport" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openFeatureRequest}>
          <LightbulbIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.productRequest" })}
        </DropdownMenuItem>
        {/* Windows/Linux does not have a native menu bar, and the self-drawn title bar arrow menu has also been offline.
            The resource manager can only be entered from here; the web side does not have this window and will not render. */}
        {isDesktop ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid={TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER}
              onSelect={handleOpenResourceManager}
            >
              <ActivityIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
            </DropdownMenuItem>
            {updateMenu.visible ? (
              <DropdownMenuItem
                disabled={updateMenu.disabled}
                onSelect={updateMenu.checkForUpdates}
              >
                <RefreshCwIcon className="size-4" />
                {updateMenu.labelId === "desktopMenu.help.restartToUpdate" ? (
                  <>
                    <span className="whitespace-nowrap">
                      {intl.formatMessage({ id: "desktopMenu.help.restartUpdateAction" })}
                    </span>
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 py-0 bg-success/10 text-success"
                    >
                      {updateMenu.labelValues?.version}
                    </Badge>
                  </>
                ) : (
                  intl.formatMessage({ id: updateMenu.labelId }, updateMenu.labelValues)
                )}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={handleShowAbout}>
              <InfoIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.about" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
