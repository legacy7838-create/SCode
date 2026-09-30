import {
  cloneElement,
  isValidElement,
  useCallback,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";

interface ControlHintTooltipProps {
  children: ReactNode;
  title: ReactNode;
  description?: string;
  shortcut?: string;
  standalone?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"];
  className?: string;
  triggerClassName?: string;
  triggerRef?: Ref<HTMLElement>;
}

type TriggerChildProps = {
  className?: string;
  ref?: Ref<HTMLElement>;
};

const shortcutKbdBaseClassName =
  "rounded-md h-4 inline-flex items-center bg-tooltip-tag px-1.5 text-ui-xs font-medium text-tooltip-tag-foreground";

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

export function ControlHintTooltip({
  children,
  title,
  description,
  shortcut,
  standalone = false,
  open,
  onOpenChange,
  side = "top",
  align = "center",
  sideOffset = 2,
  className,
  triggerClassName,
  triggerRef,
}: ControlHintTooltipProps) {
  const useAppleShortcutFont = isAppleKeyboardPlatform();
  const shortcutFontClassName = useAppleShortcutFont ? "tracking-normal" : "font-mono";
  const shortcutFontStyle = useAppleShortcutFont
    ? {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif',
      }
    : undefined;
  const isTriggerElement = isValidElement<TriggerChildProps>(children);
  const childRef = isTriggerElement ? children.props.ref : undefined;
  // The asChild trigger of Radix Tooltip/Dropdown/Popper will synchronize setState when ref changes.
  // The callback ref identity must be stabilized here, otherwise ref detach/attach will be triggered every render and an update loop will be formed.
  const composedTriggerRef = useCallback(
    (value: HTMLElement | null) => {
      setRef(childRef, value);
      setRef(triggerRef, value);
    },
    [childRef, triggerRef],
  );
  const trigger = isTriggerElement ? (
    cloneElement(children, {
      // In the past, an extra layer of span was included, and when Radix Tooltip/Select/Popover combined multiple layers of asChild,
      // Events and refs will fall on different DOMs, triggering SlotClone rendering stack errors. Here it goes directly to the real trigger.
      className: cn("shrink-0", children.props.className, triggerClassName),
      ref: composedTriggerRef,
    })
  ) : (
    <span
      ref={triggerRef as Ref<HTMLSpanElement>}
      className={cn("inline-flex shrink-0", triggerClassName)}
    >
      {children}
    </span>
  );

  // A large session will render a large number of ControlHintTooltips for each message action and create Providers one by one.
  // The Radix context tree will be enlarged to the message level; the shared Provider will be placed at the Root.
  const tooltip = (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          description
            ? "max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
            : "max-w-[min(28rem,calc(100vw-1rem))] items-center gap-2 px-2.5 py-1 text-left has-data-[slot=kbd]:pr-1",
          className,
        )}
      >
        {description ? (
          <div className="flex w-full items-start justify-between gap-3">
            <span className="text-ui-sm font-medium leading-4 text-tooltip-foreground">
              {title}
            </span>
            {shortcut ? (
              <kbd
                data-slot="kbd"
                className={cn(shortcutKbdBaseClassName, shortcutFontClassName, "shrink-0")}
                style={shortcutFontStyle}
              >
                {shortcut}
              </kbd>
            ) : null}
          </div>
        ) : (
          // In the past, prompts without description were subject to both max-w-xs and nowrap, and long Chinese and English copy would be cropped out of bounds.
          // Short prompts continue to be displayed according to the content width, and natural line breaks are allowed when the safe width of the viewport is exceeded; explicit line breaks are used for structured prompts.
          <span className="text-ui-sm font-medium whitespace-pre-line break-words text-tooltip-foreground">
            {title}
          </span>
        )}
        {description ? (
          <span className="max-w-64 text-ui-sm/relaxed text-tooltip-foreground/80">
            {description}
          </span>
        ) : null}
        {!description && shortcut ? (
          <kbd
            data-slot="kbd"
            className={cn(shortcutKbdBaseClassName, shortcutFontClassName, "shrink-0")}
            style={shortcutFontStyle}
          >
            {shortcut}
          </kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );

  // A few components need to support SSR/single test rendering without Root; the provider is provided by the package as needed.
  // Prevent the business layer from reassembling Tooltip primitives without duplicating context creation for regular prompts in the list.
  return standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip;
}
