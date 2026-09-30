import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";

export function AutomationScheduleBadge({
  dimmed = false,
  icon,
  text,
}: {
  dimmed?: boolean;
  icon: ReactNode;
  text: string;
}) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const textElement = textRef.current;
    if (!textElement) return;

    const updateOverflow = () => {
      // The original implementation of unconditional display of Tooltips, and repeated prompts will also appear for complete and visible short text.
      // The actual typesetting result of the browser shall prevail. The complete copy will only be provided when the ellipses are in effect.
      const nextIsOverflowing = textElement.scrollWidth > textElement.clientWidth;
      setIsOverflowing((current) => (current === nextIsOverflowing ? current : nextIsOverflowing));
    };

    updateOverflow();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(textElement);
    return () => resizeObserver.disconnect();
  }, [text]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex w-fit min-w-0 max-w-full items-center gap-0.5 overflow-hidden rounded-lg bg-success/10 py-0.5 pl-1 pr-2 font-normal text-success",
              dimmed && "opacity-40",
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
            <span
              ref={textRef}
              data-testid="automation-schedule-text"
              className="min-w-0 truncate whitespace-nowrap"
            >
              {text}
            </span>
          </span>
        </TooltipTrigger>
        {isOverflowing ? (
          <TooltipContent side="top" sideOffset={6}>
            {text}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  );
}
