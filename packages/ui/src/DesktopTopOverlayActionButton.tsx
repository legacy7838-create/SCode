import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

interface DesktopTopOverlayActionButtonProps {
  title: string;
  ariaLabel: string;
  children: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  side?: ComponentProps<typeof ControlHintTooltip>["side"];
  buttonClassName?: string;
  testId?: string;
}

export function DesktopTopOverlayActionButton({
  title,
  ariaLabel,
  children,
  shortcut,
  disabled,
  onClick,
  onMouseEnter,
  side = "bottom",
  buttonClassName,
  testId,
}: DesktopTopOverlayActionButtonProps) {
  return (
    <ControlHintTooltip title={title} shortcut={shortcut} side={side}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        // Basic Button defaults to transition-all. When scaling the window, the size/position changes of the title bar button will also be animated.
        // When Windows continuously zooms, the button will reset first and then follow; the floating button here only needs hover color transition.
        className={cn("[app-region:no-drag] transition-colors", buttonClassName)}
        data-testid={testId}
        aria-label={ariaLabel}
        disabled={disabled}
        // The new task entry in the top floating layer will reuse the business function with optional provider parameters.
        // If passed directly to React onClick, MouseEvent will be passed as provider and an error will be thrown when logging IPC clone.
        // Here, DOM events are discarded uniformly, and only the parameter-free actions agreed upon by the component are called.
        onClick={() => onClick()}
        onMouseEnter={onMouseEnter}
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}
