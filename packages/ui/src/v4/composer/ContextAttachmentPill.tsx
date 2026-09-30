import type { HTMLAttributes, ReactNode } from "react";
import { XIcon } from "lucide-react";
import {
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  type AttachmentHoverCardContentProps,
} from "@/components/ai-elements/attachments.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

interface ContextAttachmentPillProps {
  children: ReactNode;
  contentAlign?: AttachmentHoverCardContentProps["align"];
  icon: ReactNode;
  label: string;
  onRemoveAll?: () => void;
  removeLabel: string;
  triggerProps?: Omit<HTMLAttributes<HTMLDivElement>, "children"> &
    Partial<Record<`data-${string}`, string | number>>;
}

/**
 * Context attachments share one pill and one detail overlay shell, so that each type does not
 * duplicate the layout and interaction styling. The Trigger uses asChild and the details use
 * Portal, so only a single pill node is left in the message attachment container.
 */
export function ContextAttachmentPill({
  children,
  contentAlign = "start",
  icon,
  label,
  onRemoveAll,
  removeLabel,
  triggerProps,
}: ContextAttachmentPillProps) {
  return (
    <AttachmentHoverCard>
      <AttachmentHoverCardTrigger asChild>
        <div
          {...triggerProps}
          aria-label={label}
          className={cn(
            "group flex h-8 max-w-full cursor-pointer select-none items-center gap-1.5 rounded-full border-0 bg-surface py-1.5 text-ui-base font-medium text-foreground transition-all hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
            // The input box shares the shell with the dialog flow, but only the input box has a close button.
            // Unconditionally compressing the right padding will make the dialogue flow pill visually to the right, so press the delete entry to divert the spacing.
            onRemoveAll ? "pl-3 pr-1.5" : "px-3",
          )}
          role="button"
          tabIndex={0}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <span className="truncate">{label}</span>
          </span>
          {onRemoveAll ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0 rounded-full text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemoveAll();
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </AttachmentHoverCardTrigger>
      <AttachmentHoverCardContent
        align={contentAlign}
        side="top"
        className="w-80 rounded-xl border border-border bg-tooltip p-1 text-tooltip-foreground shadow-md ring-0"
      >
        <div className="max-h-64 overflow-y-auto">{children}</div>
      </AttachmentHoverCardContent>
    </AttachmentHoverCard>
  );
}
