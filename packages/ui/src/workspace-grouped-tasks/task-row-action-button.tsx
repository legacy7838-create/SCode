import type { MouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

function TaskRowActionButton({
  label,
  children,
  className,
  onClick,
  showTooltip = false,
  disabledReason,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  showTooltip?: boolean;
  disabledReason?: string;
  testId?: string;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      disabled={Boolean(disabledReason)}
      data-testid={testId}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (!disabledReason) {
          onClick(event);
        }
      }}
      aria-label={label}
    >
      {children}
    </Button>
  );
  if (!showTooltip) {
    return button;
  }
  return (
    <ControlHintTooltip title={disabledReason ?? label} side="top" sideOffset={2}>
      {/* The local absolute tooltip will be clipped by the overflow-hidden of the grouped collapse container;
          Use a real trigger that can receive a pointer to wrap the disabled button, and then the shared portal renders the prompt. */}
      <span className="inline-flex shrink-0">{button}</span>
    </ControlHintTooltip>
  );
}

export { TaskRowActionButton };
