import { ShareIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConversationShareSelectionStore } from "@/store/conversationShareSelectionStore.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

export function ConversationShareMenu({
  taskId,
  useWindowsCaptionSpacing = false,
}: {
  taskId: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const setScope = useConversationShareSelectionStore((state) => state.setScope);
  const finishSelection = useConversationShareSelectionStore((state) => state.finishSelection);
  const publishing = useConversationShareSelectionStore(
    (state) => state.dockStates[taskId]?.publishing ?? false,
  );
  const showTimeline = useConversationShareSelectionStore((state) => state.showTimeline);
  const active = useConversationShareSelectionStore(
    (state) => state.drafts[taskId]?.scope === "partial",
  );

  const handleClick = () => {
    const currentState = useConversationShareSelectionStore.getState();
    const currentlyActive = currentState.drafts[taskId]?.scope === "partial";
    if (currentState.dockStates[taskId]?.publishing) return;
    logger.debug("[conversation-share] top bar entry toggles sharing", {
      taskId,
      alreadyActive: currentlyActive,
    });
    if (currentlyActive) {
      // Clicking again cannot only switch panels: sharing cannot be exited; reusing the cancel operation clears the draft and dock of the current session.
      finishSelection(taskId);
    } else {
      // The default is to select all when entering for the first time; the panel is retracted to the timeline, and the user can adjust the range through the reopen entry on the left.
      setScope(taskId, "partial");
      showTimeline(taskId);
    }
  };

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      // Share uses larger hotspots and independent mask scaling; reuses size and icon specifications for adjacent toolbar buttons.
      size="icon-md"
      className={cn(
        "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
        useWindowsCaptionSpacing ? "ml-3" : "ml-2.5",
        useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        active && "bg-selected",
      )}
      aria-label={intl.formatMessage({ id: "conversationShare.trigger" })}
      data-testid="conversation-share-trigger"
      aria-pressed={active}
      disabled={publishing}
      onClick={handleClick}
    >
      <ShareIcon className="size-4" />
    </Button>
  );

  return active ? (
    trigger
  ) : (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "conversationShare.trigger" })}
      side="bottom"
    >
      {trigger}
    </ControlHintTooltip>
  );
}
