import { useEffect, useState, type ReactNode } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const SIDE_PANE_TAB_TOOLTIP_DELAY_MS = 1_500;

export function SidePaneTabTitleTooltip({
  children,
  isDragging,
  title,
}: {
  children: ReactNode;
  isDragging: boolean;
  title: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (isDragging) {
      // Clear the open status after dragging starts to avoid restoring the tooltip on the old tab when dragging ends.
      setIsOpen(false);
    }
  }, [isDragging]);

  return (
    <TooltipProvider delayDuration={SIDE_PANE_TAB_TOOLTIP_DELAY_MS} skipDelayDuration={0}>
      <ControlHintTooltip
        title={title}
        side="bottom"
        // ControlHintTooltip adds shrink-0 to ordinary buttons by default; side tabs must retain the ability to shrink with equal width.
        triggerClassName="shrink"
        open={isOpen && !isDragging}
        onOpenChange={(open) => setIsOpen(isDragging ? false : open)}
      >
        {children}
      </ControlHintTooltip>
    </TooltipProvider>
  );
}
